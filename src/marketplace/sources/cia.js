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
      const out = parseAuctionWorxBrowse(html);
      if (out.length === 0) {
        // Legit between monthly auctions, or a markup change — capture tells.
        const markers = (html.match(/data-listingid/g) ?? []).length;
        debugLog('cia', `0 parsed — ${markers} data-listingid markers in ${html.length}b of HTML`);
        saveDebug('cia', 'browse', html, 'html');
      }
      return out;
    },

    async close() {},
  };
}
