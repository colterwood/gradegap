// CIA — Collector Investor Auctions (bid.collectorinvestorauctions.com).
// Monthly sports/TCG auctions on the AuctionWorx platform (ASP.NET,
// server-rendered): /Browse?FullTextQuery=<q>&StatusFilter=active_only
// returns plain HTML, one section[data-listingid] per lot, no auth or
// tokens. Between auctions the search simply returns nothing.
// Verify locally with `npm run test-source cia "jordan psa"`.

import { fetchHtml, toNumber, absUrl, decodeEntities, saveDebug, debugLog } from './util.js';

const SITE = 'https://bid.collectorinvestorauctions.com';

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' '));

// Pure, fixture-testable: AuctionWorx /Browse HTML → normalized raw listings.
export function parseAuctionWorxBrowse(html, site = SITE) {
  const out = [];
  // Each result is an element carrying data-listingid (a <section> in stock
  // AuctionWorx, but skins vary); capture through to the next one (or end).
  const re = /<\w+[^>]*data-listingid=["'](\d+)["'][^>]*>([\s\S]*?)(?=<\w+[^>]*data-listingid=|$)/gi;
  for (const m of html.matchAll(re)) {
    const [, id, block] = m;
    // Title anchor lives in h1.title (AuctionWorx renders "Lot N - Title").
    const titleM =
      block.match(/<h1[^>]*class=["'][^"']*title[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<a[^>]+href=["']([^"']*(?:LotDetails|Listing\/Details)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleM) continue;
    const title = stripTags(titleM[2]);
    if (!title) continue;
    const priceM = block.match(/class=["'][^"']*awe-rt-CurrentPrice[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const endsM = block.match(/data-epoch=["']ending["'][^>]*data-action-time=["']([^"']+)["']/i)
      ?? block.match(/data-action-time=["']([^"']+)["'][^>]*data-epoch=["']ending["']/i);
    const imgM = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    const isFixed = /status-type[^>]*>\s*(?:Fixed|Buy)/i.test(block);
    out.push({
      listingId: id,
      canonicalKey: `cia:${id}`,
      title,
      url: absUrl(titleM[1], site),
      price: priceM ? toNumber(stripTags(priceM[1])) : null,
      currency: 'USD',
      listingType: isFixed ? 'fixed' : 'auction',
      endsAt: endsM?.[1] ?? null,
      imageUrl: imgM ? absUrl(imgM[1], site) : null,
      seller: 'Collector Investor Auctions',
    });
  }
  return out;
}

// Fallback for skinned AuctionWorx sites whose result blocks don't match the
// stock markup: work from the lot-detail anchors themselves. One listing per
// distinct /Event/LotDetails/{id} (or /Listing/Details/{id}) link with real
// anchor text; price = first $ amount within the following stretch of HTML.
export function parseAuctionWorxLotLinks(html, site = SITE) {
  const out = new Map();
  const re = /<a[^>]+href=["']([^"']*\/(?:Event\/LotDetails|Listing\/Details)\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const [, href, id, inner] = m;
    const title = stripTags(inner);
    if (out.has(id) || title.length < 10) continue; // image/button anchors
    const tail = html.slice(m.index, m.index + 1200);
    const priceM = tail.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    const endsM = tail.match(/data-action-time=["']([^"']+)["']/i);
    out.set(id, {
      listingId: id,
      canonicalKey: `cia:${id}`,
      title,
      url: absUrl(href, site),
      price: priceM ? toNumber(priceM[1]) : null,
      currency: 'USD',
      listingType: 'auction',
      endsAt: endsM?.[1] ?? null,
      imageUrl: null,
      seller: 'Collector Investor Auctions',
    });
  }
  return [...out.values()];
}

export function createCiaSource() {
  return {
    name: 'cia',
    needsBrowser: false,
    minIntervalMs: 5000,

    async start() {},

    async search({ text }) {
      const params = new URLSearchParams({
        FullTextQuery: text,
        StatusFilter: 'active_only',
        ViewStyle: 'list',
        SortFilterOptions: '0', // ending soonest
        page: '0',
      });
      const html = await fetchHtml(`${SITE}/Browse?${params}`);
      let out = parseAuctionWorxBrowse(html);
      if (out.length === 0) {
        // Skinned markup? Fall back to the lot-detail anchors themselves.
        out = parseAuctionWorxLotLinks(html);
        debugLog('cia', `stock parse: 0, anchor fallback: ${out.length}`);
      }
      if (out.length === 0) {
        // Legit between monthly auctions, or a markup change — the marker
        // values + capture tell them apart.
        const markers = [...html.matchAll(/data-listingid=["']([^"']*)["']/g)].map((m) => m[1] || '(empty)');
        debugLog('cia', `0 parsed — data-listingid values: [${markers.slice(0, 10).join(', ')}] in ${html.length}b`);
        saveDebug('cia', 'browse', html, 'html');
      }
      return out;
    },

    async close() {},
  };
}
