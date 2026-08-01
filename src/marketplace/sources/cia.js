// CIA — Collector Investor Auctions (bid.collectorinvestorauctions.com).
// Monthly sports/TCG auctions on the AuctionWorx platform (ASP.NET,
// server-rendered): /Browse?FullTextQuery=<q>&StatusFilter=active_only
// returns plain HTML, one section[data-listingid] per lot, no auth or
// tokens. Between auctions the search simply returns nothing.
// Verify locally with `npm run test-source cia "jordan psa"`.

import { fetchHtml, toNumber, absUrl, decodeEntities, saveDebug, debugLog, zonedToIso } from './util.js';

const SITE = 'https://bid.collectorinvestorauctions.com';

// AuctionWorx renders lot times WITHOUT a zone and prints the zone it means
// in the same page (`var timeZoneLabel = 'ET';`). Read them against that
// zone, or the stored end date silently becomes machine-dependent.
const SITE_TZ = 'America/New_York';

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' '));

// AuctionWorx prefixes every lot name with its catalog position
// ("Lot 001 - 1952 Topps #311 Mickey Mantle"). That is house boilerplate,
// not part of the card, and it actively hurts: "Lot" is on the match
// layer's junk-word list (it exists to catch bulk "lot of 5 cards"
// listings), so every CIA lot would take a confidence penalty for it.
const stripLotPrefix = (s) => String(s ?? '').replace(/^\s*lots?\s*#?\s*[\w-]+\s*[-–—:]\s*/i, '').trim();

// AuctionWorx's countdown spans carry CSS SELECTORS as attribute values:
//   data-end-hide-selector="[data-listingid='5593506'] .awe-rt-HideOnEnd"
// The literal text "data-listingid=" inside them looks exactly like a lot
// marker to a regex, and the live page has 200 of them against 50 real
// lots. That truncated every lot block before its countdown (so endsAt was
// null on 100% of lots) and then re-matched the leftovers as phantom lots
// whose only anchor text was the "Preview" button — which is why every CIA
// title was the word "Preview" and nothing ever matched a watch. Strip the
// selector attributes before doing anything else.
const stripSelectorAttrs = (html) =>
  String(html ?? '').replace(/\sdata-end-(?:hide|show)-selector=(["'])[\s\S]*?\1/gi, '');

// The lot's own detail id, which the fallback parser also keys on — both
// parsers must agree or a markup change would duplicate every listing.
const lotIdFromUrl = (href) => String(href ?? '').match(/\/(?:LotDetails|Details)\/(\d+)/)?.[1] ?? null;

// Pure, fixture-testable: AuctionWorx /Browse HTML → normalized raw listings.
export function parseAuctionWorxBrowse(rawHtml, site = SITE) {
  const html = stripSelectorAttrs(rawHtml);
  const out = [];
  // Each result is an element carrying data-listingid (a <section> in stock
  // AuctionWorx, but skins vary); capture through to the next one (or end).
  const re = /<\w+[^>]*data-listingid=["'](\d+)["'][^>]*>([\s\S]*?)(?=<\w+[^>]*data-listingid=|$)/gi;
  for (const m of html.matchAll(re)) {
    const [, sectionId, block] = m;
    // The title anchor sits in the heading whose class is exactly "title"
    // — h2 on this skin, h1 in stock AuctionWorx, and the adjacent
    // "subtitle" heading (the division name) must never win the match.
    const titleM = block.match(
      /<h[1-6][^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
    );
    let href = titleM?.[1] ?? null;
    let title = titleM ? stripLotPrefix(stripTags(titleM[2])) : '';
    if (!title) {
      // Skinned markup: take the first lot-detail anchor that actually has
      // text. The FIRST anchor is the thumbnail (its content is an <img>,
      // which strips to nothing), so "first anchor" alone found no title.
      for (const a of block.matchAll(
        /<a[^>]+href=["']([^"']*(?:LotDetails|Listing\/Details)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
      )) {
        const text = stripTags(a[2]);
        // "Preview" / "View Details" are the CTA buttons, never a lot name.
        if (text && !/^(?:preview|view details|bid now|details)$/i.test(text)) {
          href = a[1];
          title = stripLotPrefix(text);
          break;
        }
      }
    }
    if (!title || !href) continue;
    const priceM = block.match(/class=["'][^"']*awe-rt-CurrentPrice[^"']*["'][^>]*>([\s\S]*?)<\//i);
    // data-epoch tells the two countdowns apart: "starting" is when bidding
    // OPENS, "ending" is the close. Matching any data-action-time would
    // store the open time as the deadline.
    const endsM = block.match(/data-epoch=["']ending["'][^>]*?data-action-time=["']([^"']+)["']/i)
      ?? block.match(/data-action-time=["']([^"']+)["'][^>]*?data-epoch=["']ending["']/i);
    const imgM = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    const isFixed = /status-type[^>]*>\s*(?:Fixed|Buy)/i.test(block);
    const id = lotIdFromUrl(href) ?? sectionId;
    out.push({
      listingId: id,
      canonicalKey: `cia:${id}`,
      title,
      url: absUrl(href, site),
      price: priceM ? toNumber(stripTags(priceM[1])) : null,
      currency: 'USD',
      listingType: isFixed ? 'fixed' : 'auction',
      endsAt: isFixed ? null : zonedToIso(endsM?.[1], SITE_TZ),
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
export function parseAuctionWorxLotLinks(rawHtml, site = SITE) {
  const html = stripSelectorAttrs(rawHtml);
  const out = new Map();
  const re = /<a[^>]+href=["']([^"']*\/(?:Event\/LotDetails|Listing\/Details)\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  // Anchor offsets first, so each lot's scan window can be bounded by the
  // NEXT lot rather than a byte count. The old fixed 1200-char window
  // stopped short of the countdown on the live page (the nearest
  // data-action-time sat 1118–3762 chars past the anchor), so the fallback
  // also returned a null end date for every lot.
  const anchors = [...html.matchAll(re)];
  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i];
    const [, href, id, inner] = m;
    const title = stripLotPrefix(stripTags(inner));
    if (out.has(id) || title.length < 10) continue; // image/button anchors
    const windowEnd = anchors.find((a, j) => j > i && a[2] !== id)?.index ?? html.length;
    const tail = html.slice(m.index, Math.min(windowEnd, m.index + 8000));
    const priceM = tail.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    // Same ending-vs-starting discipline as the stock parser.
    const endsM = tail.match(/data-epoch=["']ending["'][^>]*?data-action-time=["']([^"']+)["']/i)
      ?? tail.match(/data-action-time=["']([^"']+)["'][^>]*?data-epoch=["']ending["']/i);
    out.set(id, {
      listingId: id,
      canonicalKey: `cia:${id}`,
      title,
      url: absUrl(href, site),
      price: priceM ? toNumber(priceM[1]) : null,
      currency: 'USD',
      listingType: 'auction',
      endsAt: zonedToIso(endsM?.[1], SITE_TZ),
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
