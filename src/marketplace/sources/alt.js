// Alt (alt.xyz) — graded-card exchange: a fixed-price marketplace plus
// weekly auctions, all vault-held. The buy side is a SPA, so this adapter
// uses the pattern proven on Goldin/Pristine: drive the shared browser to
// the site's own search and sniff the JSON its API returns, with a
// shape-agnostic tile pass as backstop. Nothing about the endpoint is
// hardcoded, so a frontend redeploy doesn't break it.
// Verify locally with `npm run test-source alt "jordan psa 10" --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { toNumber, saveDebug, debugLog, gotoStable, parkPage } from './util.js';

const SITE = 'https://alt.xyz';

// Does this object look like a card listing? Alt's payloads vary, so key
// on "has a title-ish string AND an id AND something price-shaped".
const PRICE_KEYS = [
  'price', 'askingPrice', 'asking_price', 'listPrice', 'list_price',
  'currentBid', 'current_bid', 'buyNowPrice', 'buy_now_price', 'amount', 'lowestAsk', 'lowest_ask',
];

export function extractAltListings(node, depth = 0, out = []) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 2) {
      const mapped = objs.map(mapAltListing).filter(Boolean);
      if (mapped.length >= 2) out.push(mapped);
    }
    for (const item of node) extractAltListings(item, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) extractAltListings(v, depth + 1, out);
  }
  return out;
}

// Telemetry/vendor hosts whose JSON is never card data (PostHog surveys
// were the live false positive).
export const ANALYTICS_HOST_RE =
  /(^|\.)(posthog\.com|i\.posthog\.com|sentry\.io|segment\.(com|io)|google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.(com|net)|intercom\.io|datadoghq\.com|cloudflareinsights\.com|launchdarkly\.com|amplitude\.com|mixpanel\.com|hotjar\.com|fullstory\.com|stripe\.com|recaptcha\.net|gstatic\.com)$/i;

// A card listing always has a price and a card-shaped title. Live testing
// showed the naive "object with an id and a name" test also swallowing
// auction-cycle date ranges and analytics survey definitions.
const CARD_TITLE_RE = /\b(19|20)\d{2}\b|\b(psa|bgs|sgc|cgc|csg)\b|#\s*\w+/i;

// Alt surfaces other auction houses' listings alongside its own. Keep only
// Alt's: if a payload names a house and it isn't Alt, drop it (an absent
// field is fine — the auctionHouse=Alt URL filter already applied).
const HOUSE_KEYS = ['auctionHouse', 'auction_house', 'house', 'marketplace', 'platform', 'sourceName', 'source'];

export function isAltsOwnListing(o) {
  for (const k of HOUSE_KEYS) {
    const v = o?.[k];
    const name = typeof v === 'string' ? v : v?.name ?? v?.displayName;
    if (typeof name === 'string' && name.trim()) {
      return /^alt(\.xyz)?$/i.test(name.trim());
    }
  }
  return true;
}

// Pure, fixture-testable: one Alt API object → normalized listing or null.
export function mapAltListing(o) {
  if (!o || typeof o !== 'object') return null;
  if (!isAltsOwnListing(o)) return null;
  const id = o.id ?? o.listingId ?? o.assetId ?? o.uuid ?? o.slug;
  const title =
    o.title ?? o.name ?? o.cardName ?? o.card_name ?? o.displayName ?? o.description ?? null;
  if (id == null || typeof title !== 'string' || title.length < 8) return null;
  if (!CARD_TITLE_RE.test(title)) return null;

  let price = null;
  for (const k of PRICE_KEYS) {
    const v = toNumber(typeof o[k] === 'object' ? (o[k]?.amount ?? o[k]?.value) : o[k]);
    if (v != null) {
      // Alt quotes some money in cents; a bare 6-figure "price" on a card
      // list is almost always minor units.
      price = v > 100000 ? v / 100 : v;
      break;
    }
  }
  // No price at all => not a listing (date ranges, surveys, config blobs).
  if (price == null) return null;
  const isAuction = /auction/i.test(String(o.listingType ?? o.type ?? o.saleType ?? ''));
  const ends = o.endsAt ?? o.endTime ?? o.auctionEndsAt ?? o.closesAt ?? null;
  const slug = o.slug ?? id;
  return {
    listingId: String(id),
    canonicalKey: `alt:${id}`,
    title,
    url: typeof o.url === 'string' ? new URL(o.url, SITE).href : `${SITE}/marketplace/${slug}`,
    price,
    currency: o.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    endsAt: typeof ends === 'number' ? new Date(ends > 1e12 ? ends : ends * 1000).toISOString() : ends,
    imageUrl:
      o.imageUrl ?? o.image ?? o.frontImageUrl ?? o.images?.[0]?.url ?? o.images?.[0] ?? null,
    seller: null, // vault-held; no per-listing seller
  };
}

// Diagnostic: objects that LOOK like cards but failed a requirement. When a
// search comes back empty this reveals the real field names (or proves no
// card data arrived at all).
export function findNearMisses(node, out = [], depth = 0) {
  if (!node || depth > 6 || out.length >= 3) return out;
  if (Array.isArray(node)) {
    for (const item of node) findNearMisses(item, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    const titled = Object.entries(node).find(
      ([, v]) => typeof v === 'string' && v.length >= 10 && CARD_TITLE_RE.test(v)
    );
    if (titled && !mapAltListing(node)) {
      out.push({ sampleTitle: titled[1].slice(0, 80), keys: Object.keys(node).slice(0, 25) });
    }
    for (const v of Object.values(node)) findNearMisses(v, out, depth + 1);
  }
  return out;
}

export function createAltSource() {
  let lease = null;
  let page = null;
  let sniffed = [];
  let requestLog = [];

  return {
    name: 'alt',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Every XHR/fetch, whether or not we can parse it — if a search
      // request exists at all, it shows up here.
      page.on('request', (req) => {
        const type = req.resourceType();
        if (type === 'xhr' || type === 'fetch') requestLog.push(`${req.method()} ${req.url()}`);
      });
      page.on('websocket', (ws) => requestLog.push(`WS ${ws.url()}`));

      page.on('response', async (res) => {
        try {
          const url = res.url();
          // Alt delegates search to an external service (its own
          // SearchServiceConfig endpoint says so), so results arrive from a
          // third-party host — an alt.xyz-only allowlist would miss them.
          // Instead, block the telemetry vendors whose payloads merely LOOK
          // listing-shaped; the price + card-title test does the rest.
          if (ANALYTICS_HOST_RE.test(new URL(url).hostname)) return;
          const ct = res.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const body = await res.text().catch(() => '');
          if (!body || (body[0] !== '{' && body[0] !== '[')) return;
          sniffed.push({ url, json: JSON.parse(body) });
        } catch {
          // aborted/detached/bad URL — ignore
        }
      });
    },

    async search({ text }) {
      const q = encodeURIComponent(text);
      // /browse with auctionHouse=Alt is the view of items listed ON Alt —
      // the site also aggregates other houses' listings, which we don't
      // want here (they're covered by their own adapters, or not at all).
      // This one view spans both auction and fixed price; each listing's
      // payload says which it is (see mapAltListing).
      const candidates = [
        `${SITE}/browse?auctionHouse=Alt&search=${q}&sortBy=ending_soonest_asc`,
        `${SITE}/browse?auctionHouse=Alt&q=${q}`,
        `${SITE}/browse?search=${q}`,
        `${SITE}/buy?search=${q}`,
      ];

      for (const url of candidates) {
        await parkPage(page);
        sniffed = [];
        requestLog = [];
        const res = await gotoStable(page, url).catch(() => undefined);
        if (res === undefined) continue;
        const status = res === null ? 200 : res.status();
        if (status < 200 || status >= 400) {
          debugLog('alt', `GET ${url} → ${status}`);
          continue;
        }
        for (let i = 0; i < 8 && sniffed.length === 0; i++) await page.waitForTimeout(1000);
        await page.waitForTimeout(1500); // let a later, richer payload land

        const seen = new Set();
        const out = [];
        for (const { url: apiUrl, json } of sniffed) {
          for (const group of extractAltListings(json)) {
            if (group.length === 0) continue;
            debugLog('alt', `listing-shaped JSON from ${apiUrl} → ${group.length}`);
            for (const l of group) {
              if (!seen.has(l.listingId) && seen.add(l.listingId)) out.push(l);
            }
          }
        }
        debugLog('alt', `GET ${url} → ${status}, parsed ${out.length} (sniffed ${sniffed.length} JSON responses)`);
        if (out.length > 0) {
          saveDebug('alt', 'api-sample', JSON.stringify(sniffed.slice(0, 2), null, 2).slice(0, 20000), 'json');
          return out;
        }
      }

      // Nothing card-shaped. Report the full request log (a missing search
      // call means the page never searched — login wall or wrong route),
      // plus any near-miss objects (which reveal the real field names).
      debugLog('alt', `no card listings. All XHR/fetch on the last attempt:\n    ${requestLog.join('\n    ') || '(none)'}`);
      const nearMisses = sniffed.flatMap((s) => findNearMisses(s.json)).slice(0, 3);
      if (nearMisses.length) {
        debugLog(
          'alt',
          `card-ish objects that were rejected:\n${nearMisses
            .map((n) => `    "${n.sampleTitle}"\n      keys: ${n.keys.join(', ')}`)
            .join('\n')}`
        );
      } else {
        debugLog('alt', 'no card-shaped text in any sniffed payload — the page returned no listings');
      }
      debugLog('alt', `page title: ${await page.title().catch(() => '?')}`);
      saveDebug('alt', 'page', await page.content().catch(() => ''), 'html');
      const shot = await page.screenshot().catch(() => null);
      if (shot) saveDebug('alt', 'screenshot', shot, 'png');
      for (const { url: apiUrl, json } of sniffed.slice(0, 8)) {
        saveDebug('alt', 'sniffed-json', `${apiUrl}\n${JSON.stringify(json).slice(0, 8000)}`, 'txt');
      }
      return [];
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
      sniffed = [];
    },
  };
}
