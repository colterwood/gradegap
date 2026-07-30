// Goldin (goldin.co) — weekly + premier auctions. Their backend API hosts
// rotate per frontend deploy and Cloudflare dislikes plain clients (live
// testing hung), so this adapter drives the shared visible browser to the
// site's own search results and SNIFFS the lots API response off the wire —
// the same watchAuth pattern the Card Ladder scraper uses. No endpoint
// hardcoding, no bundle parsing at runtime.
// Verify locally with `npm run test-source goldin "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { toNumber, saveDebug, debugLog, gotoStable, parkPage } from './util.js';

const SITE = 'https://goldin.co';

// Kept exported for tests/reference: pulls the API map + image CDN base out
// of Goldin's client JS bundle (the discovery approach public clients use).
export function extractGoldinConfig(bundleJs) {
  const grab = (re) => bundleJs.match(re)?.[1] ?? null;
  return {
    auctionsUrl: grab(/["']?auctions["']?\s*:\s*["'](https:[^"']+)["']/),
    lotsUrl: grab(/["']?lots_v2["']?\s*:\s*["'](https:[^"']+)["']/),
    cloudFront: grab(/cloudFrontURL\s*:\s*["'](https:[^"']+)["']/),
  };
}

// Pure, fixture-testable: a lots response body → normalized raw listings.
export function parseGoldinLots(body, cloudFront, listingType = 'auction') {
  const lots = body?.searchalgolia?.lots ?? body?.lots ?? [];
  const out = [];
  for (const lot of lots) {
    const id = lot.lot_id ?? lot.id;
    if (id == null || !lot.title) continue;
    // Item pages are /item/<slug> (user-verified live, e.g.
    // /item/1986-87-fleer-57-michael-jordan-bgs-nm-mt-89p99a) — the slug
    // carries a hash suffix, so it can't be built from the title; it must
    // come from the payload. Hunt the likely keys, including a full URL.
    const slug =
      lot.slug ?? lot.url_slug ?? lot.item_slug ?? lot.seo_slug ?? lot.handle ?? lot.item_id_text ?? null;
    const directUrl = [lot.url, lot.item_url, lot.itemUrl, lot.link].find(
      (v) => typeof v === 'string' && v.includes('/item/')
    );
    let imageUrl = lot.primary_image_name ?? null;
    if (imageUrl && !/^https?:/.test(imageUrl) && cloudFront) {
      imageUrl = `${cloudFront.replace(/\/+$/, '')}/public/Lots/${id}/${imageUrl}`;
    }
    out.push({
      listingId: String(id),
      canonicalKey: `goldin:${id}`,
      title: lot.title,
      url: directUrl
        ? new URL(directUrl, SITE).href
        : slug
          ? `${SITE}/item/${slug}`
          : `${SITE}/buy?search=${encodeURIComponent(lot.title)}`,
      price: toNumber(lot.current_price ?? lot.min_bid_price ?? lot.price ?? lot.buy_now_price),
      currency: 'USD',
      listingType,
      endsAt: lot.end_time ?? lot.ends_at ?? lot.auction_end_time ?? null,
      imageUrl,
      seller: null,
    });
  }
  return out;
}

// Does a response body look like a Goldin lots payload?
const looksLikeLots = (json) =>
  Array.isArray(json?.searchalgolia?.lots) || (Array.isArray(json?.lots) && json.lots.length >= 0 && json.lots[0]?.title !== undefined);

export function createGoldinSource() {
  let lease = null;
  let page = null;
  let sniffed = [];

  return {
    name: 'goldin',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Sniff every JSON response; keep any that look like lots payloads.
      page.on('response', async (res) => {
        try {
          const ct = res.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const json = await res.json().catch(() => null);
          if (json && looksLikeLots(json)) sniffed.push({ url: res.url(), json });
        } catch {
          // detached/aborted responses — ignore
        }
      });
    },

    async search({ text }) {
      // Both Goldin venues: /buy (auctions) and /fixed-price (marketplace).
      const sniffVenue = async (path, listingType, patienceSec) => {
        await parkPage(page); // stop the previous venue's late redirects
        sniffed = [];
        const ok = await gotoStable(page, `${SITE}${path}${encodeURIComponent(text)}`)
          .then((r) => (r === null ? true : (r.status() ?? 0) < 400))
          .catch(() => false);
        if (!ok) {
          debugLog('goldin', `${path} navigation failed`);
          return [];
        }
        // Give the SPA time to fire its search request(s).
        for (let i = 0; i < patienceSec && sniffed.length === 0; i++) await page.waitForTimeout(1000);
        await page.waitForTimeout(1500); // let a late richer response land too
        debugLog('goldin', `${path} sniffed ${sniffed.length} lots-shaped responses`);
        const out = [];
        const seen = new Set();
        for (const { json } of sniffed) {
          for (const l of parseGoldinLots(json, null, listingType)) {
            if (!seen.has(l.listingId) && seen.add(l.listingId)) out.push(l);
          }
        }
        if (sniffed.length > 0) {
          saveDebug('goldin', `lots-${listingType}`, JSON.stringify(sniffed[0].json).slice(0, 20000), 'json');
        }
        // Every URL a search fallback => no slug field matched. Print the
        // first lot's actual keys so the field name is one debug run away.
        if (out.length > 0 && out.every((l) => l.url.includes('/buy?search='))) {
          const firstLots = sniffed[0]?.json?.searchalgolia?.lots ?? sniffed[0]?.json?.lots ?? [];
          if (firstLots[0]) debugLog('goldin', `no slug field found — lot keys: ${Object.keys(firstLots[0]).join(', ')}`);
        }
        return out;
      };

      const auctions = await sniffVenue('/buy?search=', 'auction', 10);
      const fixed = await sniffVenue('/fixed-price?search=', 'fixed', 6);

      if (auctions.length === 0 && fixed.length === 0) {
        saveDebug('goldin', 'page', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot({ fullPage: false }).catch(() => null);
        if (shot) saveDebug('goldin', 'screenshot', shot, 'png');
        debugLog('goldin', `page title: ${await page.title().catch(() => '?')}`);
      }
      // A listing sniffed on both venues keeps its first (auction) row.
      const seen = new Set();
      return [...auctions, ...fixed].filter((l) => !seen.has(l.listingId) && seen.add(l.listingId));
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
