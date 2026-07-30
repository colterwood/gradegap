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

// Pure, fixture-testable: one Alt API object → normalized listing or null.
export function mapAltListing(o) {
  if (!o || typeof o !== 'object') return null;
  const id = o.id ?? o.listingId ?? o.assetId ?? o.uuid ?? o.slug;
  const title =
    o.title ?? o.name ?? o.cardName ?? o.card_name ?? o.displayName ?? o.description ?? null;
  if (id == null || typeof title !== 'string' || title.length < 8) return null;

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

export function createAltSource() {
  let lease = null;
  let page = null;
  let sniffed = [];

  return {
    name: 'alt',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      page.on('response', async (res) => {
        try {
          const ct = res.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const body = await res.text().catch(() => '');
          if (!body || (body[0] !== '{' && body[0] !== '[')) return;
          sniffed.push({ url: res.url(), json: JSON.parse(body) });
        } catch {
          // aborted/detached — ignore
        }
      });
    },

    async search({ text }) {
      const q = encodeURIComponent(text);
      const candidates = [`${SITE}/buy?search=${q}`, `${SITE}/marketplace?search=${q}`, `${SITE}/buy?q=${q}`];

      for (const url of candidates) {
        await parkPage(page);
        sniffed = [];
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

      saveDebug('alt', 'page', await page.content().catch(() => ''), 'html');
      const shot = await page.screenshot().catch(() => null);
      if (shot) saveDebug('alt', 'screenshot', shot, 'png');
      for (const { url: apiUrl, json } of sniffed.slice(0, 5)) {
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
