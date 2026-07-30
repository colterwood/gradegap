// Pristine is TWO venues (per the user's local verification):
//   1. pristineauction.com — the auction side; lot search lives at
//      /auction/search/ (browser-driven — Cloudflare + client rendering).
//   2. pristinemarketplace.com — a separate fixed-price marketplace site;
//      probed as a Shopify storefront first (clean JSON, no scraping), with
//      the failure logged for a debug round-trip if it turns out not to be.
// One adapter returns both sides' listings. Verify locally with
// `npm run test-source pristine "jordan psa 10" --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog, toNumber, gotoStable, parkPage } from './util.js';
import { searchShopifyShop } from './shopify.js';

const SITE = 'https://www.pristineauction.com';
const MARKETPLACE = { domain: 'www.pristinemarketplace.com', currency: 'USD' };

// --- self-discovering API parse ---------------------------------------------
// The auction search renders client-side (no JSON-LD, no recognizable static
// anchors, per live captures), so the lot data must arrive as JSON over the
// wire. These pure helpers hunt ANY sniffed payload for arrays of lot-shaped
// objects — works for Algolia-style search APIs and custom ones alike.

export function extractLotArrays(node, depth = 0, out = []) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 3) {
      const sample = objs[0];
      const titled = ['title', 'name', 'item_name', 'itemName'].some(
        (k) => typeof sample[k] === 'string' && sample[k].length > 8
      );
      if (titled) out.push(objs);
    }
    for (const item of node) extractLotArrays(item, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) extractLotArrays(v, depth + 1, out);
  }
  return out;
}

export function mapPristineApiLot(o) {
  const title = o.title ?? o.name ?? o.item_name ?? o.itemName ?? null;
  const id = o.id ?? o.item_id ?? o.itemId ?? o.auction_item_id ?? o.lot_id ?? o.objectID ?? null;
  if (!title || id == null) return null;
  const price = toNumber(
    o.current_bid ?? o.currentBid ?? o.current_price ?? o.high_bid ?? o.highBid ?? o.price ?? o.amount
  );
  const urlish = o.url ?? o.item_url ?? o.link ?? null;
  const image = o.image ?? o.image_url ?? o.imageUrl ?? o.thumbnail ?? o.main_image ?? null;
  const ends = o.end_time ?? o.endTime ?? o.ends_at ?? o.end_date ?? o.close_time ?? null;
  return {
    listingId: String(id),
    canonicalKey: `pristine:${id}`,
    title: String(title),
    // Payload URL when given; otherwise a search link for the title — that
    // route is live-verified, a guessed /auction/item/<id> pattern is not.
    url: urlish
      ? new URL(urlish, SITE).href
      : `${SITE}/auction/search/?q=${encodeURIComponent(String(title).slice(0, 120))}`,
    price,
    currency: 'USD',
    listingType: 'auction',
    endsAt: typeof ends === 'number' ? new Date(ends > 1e12 ? ends : ends * 1000).toISOString() : ends,
    imageUrl: typeof image === 'string' ? image : null,
    seller: null,
  };
}

// Pure, fixture-testable: JSON-LD objects → normalized raw listings.
export function parsePristineJsonLd(blocks) {
  const out = [];
  const products = blocks.flatMap((b) => {
    if (b?.['@type'] === 'Product') return [b];
    if (Array.isArray(b?.itemListElement)) {
      return b.itemListElement.map((el) => el?.item ?? el).filter((x) => x?.['@type'] === 'Product');
    }
    return [];
  });
  for (const p of products) {
    const url = typeof p.url === 'string' ? p.url : null;
    const id = url?.split('/').filter(Boolean).pop() ?? p.sku ?? p.productID;
    if (!id || !p.name) continue;
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    out.push({
      listingId: String(id),
      canonicalKey: `pristine:${id}`,
      title: p.name,
      url: url ? new URL(url, SITE).href : null,
      price: offer?.price != null ? parseFloat(offer.price) : null,
      currency: offer?.priceCurrency ?? 'USD',
      listingType: 'auction', // Pristine is auction-format (incl. its daily "10-minute" lots)
      endsAt: offer?.priceValidUntil ?? null,
      imageUrl: typeof p.image === 'string' ? p.image : (Array.isArray(p.image) ? p.image[0] : null),
      seller: null,
    });
  }
  return out;
}

export function createPristineSource() {
  let lease = null;
  let page = null;
  let sniffedJson = [];

  return {
    name: 'pristine',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Sniff every JSON response (own API or third-party search backend) —
      // the results page is client-rendered, so the lots travel as JSON.
      page.on('response', async (res) => {
        try {
          const ct = res.headers()['content-type'] ?? '';
          if (!/json|javascript/.test(ct)) return;
          const body = await res.text().catch(() => '');
          if (!body || (body[0] !== '{' && body[0] !== '[')) return;
          sniffedJson.push({ url: res.url(), json: JSON.parse(body) });
        } catch {
          // aborted/detached/non-JSON — ignore
        }
      });
    },

    async search({ text }) {
      // JSON-LD first, /auction/item/ tiles second — whatever page we're on.
      const parseCurrentPage = async () => {
        const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
          nodes.map((n) => {
            try { return JSON.parse(n.textContent); } catch { return null; }
          }).filter(Boolean)
        ).catch(() => []);
        const fromLd = parsePristineJsonLd(blocks.flat());
        if (fromLd.length > 0) return fromLd;
        return page.$$eval('a[href*="/auction/item/"]', (links) => {
          const seen = new Map();
          for (const a of links) {
            const href = a.href;
            const id = href.match(/\/auction\/item\/(\d+)/)?.[1];
            const title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
            if (!id || seen.has(id) || title.length < 10) continue;
            const tile = a.closest('div,li,article') ?? a;
            const priceText = tile.textContent.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] ?? null;
            seen.set(id, {
              listingId: id,
              canonicalKey: `pristine:${id}`,
              title,
              url: href,
              price: priceText ? parseFloat(priceText.replace(/[$,]/g, '')) : null,
              currency: 'USD',
              listingType: 'auction',
              endsAt: null,
              imageUrl: tile.querySelector('img')?.src ?? null,
              seller: null,
            });
          }
          return [...seen.values()];
        }).catch(() => []);
      };

      // --- auction side: /auction/search/ is the real results page --------
      const q = encodeURIComponent(text);
      const candidates = [
        `${SITE}/auction/search/?q=${q}`,
        `${SITE}/auction/search/?search=${q}`,
        `${SITE}/auction/search/?keyword=${q}`,
      ];
      let auctionResults = [];
      for (const url of candidates) {
        await parkPage(page);
        sniffedJson = [];
        const res = await gotoStable(page, url).catch(() => undefined);
        if (res === undefined) {
          debugLog('pristine', `GET ${url} → navigation failed`);
          continue;
        }
        const status = res === null ? 200 : res.status(); // null = arrived via an interrupted nav
        if (status < 200 || status >= 400) {
          debugLog('pristine', `GET ${url} → ${status}`);
          continue;
        }
        await page.waitForTimeout(3500); // client render + search XHRs

        // 1) static markup (JSON-LD / known anchors)
        auctionResults = await parseCurrentPage();

        // 2) sniffed JSON: whatever search API the page called
        if (auctionResults.length === 0 && sniffedJson.length > 0) {
          const seen = new Set();
          for (const { url: apiUrl, json } of sniffedJson) {
            for (const arr of extractLotArrays(json)) {
              const mapped = arr.map(mapPristineApiLot).filter(Boolean);
              if (mapped.length === 0) continue;
              debugLog('pristine', `lot-shaped JSON from ${apiUrl} → ${mapped.length}`);
              saveDebug('pristine', 'api-lots', JSON.stringify(arr.slice(0, 3), null, 2), 'json');
              for (const l of mapped) {
                if (!seen.has(l.listingId) && seen.add(l.listingId)) auctionResults.push(l);
              }
            }
          }
        }

        // 3) shape-agnostic tiles: the dominant repeated id-carrying link
        // pattern on a results page is the lot link, whatever its route.
        if (auctionResults.length === 0) {
          auctionResults = await page.evaluate(() => {
            const groups = new Map();
            for (const a of document.querySelectorAll('a[href]')) {
              const textContent = (a.textContent || '').trim().replace(/\s+/g, ' ');
              if (textContent.length < 15) continue;
              let u;
              try { u = new URL(a.href); } catch { continue; }
              if (u.hostname !== location.hostname) continue;
              const shape = u.pathname.replace(/\d+/g, 'N');
              if (!shape.includes('N')) continue; // lot links carry an id
              if (!groups.has(shape)) groups.set(shape, new Map());
              groups.get(shape).set(a.href, a);
            }
            let best = null;
            for (const [shape, links] of groups) {
              if (links.size >= 5 && (!best || links.size > best.links.size)) best = { shape, links };
            }
            if (!best) return [];
            const out = [];
            for (const [href, a] of best.links) {
              const id = href.match(/(\d{4,})/)?.[1] ?? href;
              const tile = a.closest('div,li,article') ?? a;
              const priceText = tile.textContent.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] ?? null;
              out.push({
                listingId: String(id),
                canonicalKey: `pristine:${id}`,
                title: (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' '),
                url: href,
                price: priceText ? parseFloat(priceText.replace(/[$,]/g, '')) : null,
                currency: 'USD',
                listingType: 'auction',
                endsAt: null,
                imageUrl: tile.querySelector('img')?.src ?? null,
                seller: null,
              });
            }
            return out.slice(0, 60);
          }).catch(() => []);
          if (auctionResults.length > 0) debugLog('pristine', `generic tile detection → ${auctionResults.length}`);
        }

        debugLog('pristine', `GET ${url} → ${status}, parsed ${auctionResults.length} (sniffed ${sniffedJson.length} JSON responses)`);
        if (auctionResults.length > 0) break;
      }

      if (auctionResults.length === 0) {
        saveDebug('pristine', 'auction-results', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot().catch(() => null);
        if (shot) saveDebug('pristine', 'screenshot', shot, 'png');
        for (const { url: apiUrl, json } of sniffedJson.slice(0, 5)) {
          saveDebug('pristine', 'sniffed-json', `${apiUrl}\n${JSON.stringify(json).slice(0, 8000)}`, 'txt');
        }
      }

      // --- marketplace side: pristinemarketplace.com (Shopify?) -----------
      let marketResults = [];
      try {
        marketResults = await searchShopifyShop(MARKETPLACE, text);
        debugLog('pristine', `marketplace (shopify) returned ${marketResults.length}`);
        for (const l of marketResults) l.canonicalKey = `pristine-mkt:${l.listingId}`;
      } catch (err) {
        debugLog('pristine', `marketplace side failed: ${err.message}`);
      }

      return [...auctionResults, ...marketResults];
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
