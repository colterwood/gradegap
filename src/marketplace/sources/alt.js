// Alt (alt.xyz) — graded-card exchange: a fixed-price marketplace plus
// weekly auctions, all vault-held. The buy side is a SPA, so this adapter
// uses the pattern proven on Goldin/Pristine: drive the shared browser to
// the site's own search and sniff the JSON its API returns, with a
// shape-agnostic tile pass as backstop. Nothing about the endpoint is
// hardcoded, so a frontend redeploy doesn't break it.
// Verify locally with `npm run test-source alt "jordan psa 10" --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { toNumber, toIsoDate, saveDebug, debugLog, gotoStable, parkPage } from './util.js';

const SITE = 'https://alt.xyz';

// Alt's search runs on Typesense (seen in its own request log): the
// production_universal_search and prod_asset collections.
const SEARCH_BACKEND_RE = /typesense\.net|\/multi_search|algolia|\/search/i;

// Did this request actually carry our query? The browse page also fires
// UNFILTERED grid/trending queries to the same backend (verified live:
// merging those returned the whole high-price browse grid), so a response
// only counts as search results when every query token appears in its
// request URL or POST body. Exported for tests.
export function requestCarriesQuery(url, postData, text) {
  // POST bodies are arbitrary site data — a literal '%' not followed by two
  // hex digits ("100% authentic") makes decodeURIComponent throw, and one
  // hostile-shaped analytics body must not sink the whole item.
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const haystack = safeDecode(`${url}\n${postData ?? ''}`).toLowerCase();
  const tokens = String(text).toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
}

// The homepage search bar reads "Search by name or cert #".
const SEARCH_INPUTS = [
  'input[placeholder*="Search by name" i]',
  'input[placeholder*="cert" i]',
  'input[type="search"]',
  'input[name="search"]',
  'input[placeholder*="search" i]',
];

// Does this object look like a card listing? Alt's payloads vary, so key
// on "has a title-ish string AND an id AND something price-shaped".
const PRICE_KEYS = [
  'price', 'askingPrice', 'asking_price', 'listPrice', 'list_price',
  'currentBid', 'current_bid', 'buyNowPrice', 'buy_now_price', 'amount', 'lowestAsk', 'lowest_ask',
];

// Alt searches through Typesense, which wraps every result as
// { document: {...}, highlights: [...] } — the card fields live one level
// down, so unwrap before testing an array's items.
const unwrapHit = (o) => (o && typeof o.document === 'object' && o.document ? o.document : o);

export function extractAltListings(node, depth = 0, out = []) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map(unwrapHit);
    if (objs.length >= 1) {
      const mapped = objs.map(mapAltListing).filter(Boolean);
      if (mapped.length >= 1) out.push(mapped);
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
  let title =
    o.title ?? o.name ?? o.cardName ?? o.card_name ?? o.displayName ?? o.description ?? null;
  if (id == null || typeof title !== 'string' || title.length < 8) return null;
  if (!CARD_TITLE_RE.test(title)) return null;

  // Alt is a graded-card exchange whose titles routinely OMIT the slab
  // ("1986 Fleer Michael Jordan #57") — the grade lives in metadata fields.
  // The match layer's hard slab gate only sees the title, so every such
  // listing was silently dropped (279 watches, zero Alt matches,
  // live-observed 2026-07-31). Fold grader+grade into the scored title.
  const grader = [o.gradingCompany, o.grading_company, o.grader].find((v) => typeof v === 'string' && v.trim());
  const grade = ['string', 'number'].includes(typeof o.grade) && String(o.grade).trim() !== '' ? o.grade : null;
  if (grader && grade != null && !/\b(psa|bgs|sgc|cgc|csg)\b/i.test(title)) {
    title = `${title} ${grader} ${grade}`;
  }

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
  // A price proves it's a listing. Failing that, accept explicit card
  // fields (a Typesense document names the grade/grader/cert), which keeps
  // real cards whose price field we don't recognize. Anything with neither
  // is config/analytics noise.
  const CARD_FIELDS = [
    'grade', 'gradingCompany', 'grader', 'certNumber', 'cert', 'certificationNumber',
    'playerName', 'player', 'setName', 'cardNumber', 'sport', 'year',
  ];
  const hasCardFields = CARD_FIELDS.some((k) => o[k] != null && o[k] !== '');
  if (price == null && !hasCardFields) return null;
  const isAuction = /auction/i.test(String(o.listingType ?? o.type ?? o.saleType ?? ''));
  // Alt calls the auction close "expiresAt" — NOT any of the endsAt/endTime
  // spellings every other site uses, so this read silently produced null on
  // every auction (live-verified 2026-08-01: 11 stored auctions, 0 end
  // dates). It ships both an epoch-seconds field and a
  // "YYYY-MM-DD HH:MM:SS+00:00" string; prefer the epoch, which can't be
  // misread as local time. The legacy names stay as drift insurance.
  const ends =
    o.expiresAtEpoch ?? o.expiresAt ?? o.endsAtEpoch ??
    o.endsAt ?? o.endTime ?? o.auctionEndsAt ?? o.closesAt ?? null;
  return {
    listingId: String(id),
    canonicalKey: `alt:${id}`,
    title,
    // /itm/<uuid> is the real item route — user-verified against the live
    // site (the /marketplace/<id> guess bounced to the homepage).
    url: typeof o.url === 'string' ? new URL(o.url, SITE).href : `${SITE}/itm/${id}`,
    price,
    currency: o.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    // Only auctions have a meaningful close time; a Buy It Now's expiry is
    // a listing-renewal date, and storing it would make the UI count down
    // to something that isn't a deadline.
    endsAt: isAuction ? toIsoDate(ends) : null,
    imageUrl:
      o.imageUrl ?? o.image ?? o.frontImageUrl ?? o.images?.[0]?.url ?? o.images?.[0] ?? null,
    // Alt is vault-held, but consignor usernames ARE on the listing.
    seller: typeof o.seller === 'string' && o.seller.trim() ? o.seller.trim() : null,
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
          // The query usually travels in the POST body, not the URL.
          const postData = res.request()?.postData() ?? '';
          sniffed.push({ url, postData, json: JSON.parse(body) });
        } catch {
          // aborted/detached/bad URL — ignore
        }
      });
    },

    async search({ text }) {
      // Alt's search has no deep link: navigating to /browse?search=… just
      // renders the marketing homepage (verified from a live capture), so
      // no search request ever fires. Drive the site's own search box
      // instead — the way a person would.
      await parkPage(page);
      sniffed = [];
      requestLog = [];
      await gotoStable(page, `${SITE}/`);

      // The search input renders late on slow loads (SPA hydration) — a
      // fixed 2s wait lost that race intermittently: "no search box on the
      // homepage" on one check, fine on the next. Poll for up to 15s.
      let box = null;
      const deadline = Date.now() + 15_000;
      while (!box && Date.now() < deadline) {
        for (const sel of SEARCH_INPUTS) {
          const candidate = page.locator(sel).first();
          if (await candidate.isVisible().catch(() => false)) {
            box = candidate;
            debugLog('alt', `search input: ${sel}`);
            break;
          }
        }
        if (!box) await page.waitForTimeout(500);
      }
      if (!box) {
        saveDebug('alt', 'homepage', await page.content().catch(() => ''), 'html');
        throw new Error('Alt: no search box on the homepage after 15s — run with --debug and send the capture');
      }

      await box.click().catch(() => {});
      await box.fill(text);
      await box.press('Enter').catch(() => {});
      // Wait for the SEARCH backend specifically (Alt queries Typesense) —
      // exiting on the first JSON of any kind would race the results, since
      // GraphQL/analytics chatter lands first.
      for (let i = 0; i < 12 && !sniffed.some((s) => SEARCH_BACKEND_RE.test(s.url)); i++) {
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2500); // let the full result payload arrive

      // The URL the site itself navigated to is the real search route.
      debugLog('alt', `search landed on ${page.url()}`);

      const seen = new Set();
      const out = [];
      let ignoredUnqueried = 0;
      for (const { url: apiUrl, postData, json } of sniffed) {
        // Only responses to requests that carried OUR query — the page also
        // loads its unfiltered browse/trending grid from the same backend.
        if (!requestCarriesQuery(apiUrl, postData, text)) {
          ignoredUnqueried += 1;
          continue;
        }
        for (const group of extractAltListings(json)) {
          if (group.length === 0) continue;
          debugLog('alt', `query-matched JSON from ${apiUrl.split('?')[0]} → ${group.length}`);
          for (const l of group) {
            if (!seen.has(l.listingId) && seen.add(l.listingId)) out.push(l);
          }
        }
      }
      if (ignoredUnqueried > 0) debugLog('alt', `ignored ${ignoredUnqueried} responses whose requests lacked the query`);
      const backendHits = sniffed
        .filter((s) => SEARCH_BACKEND_RE.test(s.url))
        .map((s) => {
          const found = (s.json?.results ?? []).reduce((n, r) => n + (r?.hits?.length ?? 0), 0);
          return `${new URL(s.url).hostname} → ${found} hits`;
        });
      debugLog(
        'alt',
        `parsed ${out.length} (sniffed ${sniffed.length} JSON responses; search backend: ${
          backendHits.join(', ') || 'none seen'
        })`
      );
      if (out.length > 0) {
        // Save the payloads the LISTINGS came from, not the first two
        // responses off the wire — those are always the manifest and
        // GraphQL chatter, which made every capture useless for diagnosing
        // a field-mapping problem (live-hit 2026-08-01, missing end dates).
        const matched = sniffed.filter((s) => requestCarriesQuery(s.url, s.postData, text));
        saveDebug('alt', 'api-sample', JSON.stringify(matched, null, 2).slice(0, 2_000_000), 'json');
        // mapAltListing already drops other auction houses' items, so the
        // side-bar "Alt" filter doesn't need clicking.
        return out;
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
