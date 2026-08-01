// Miller & Miller Auctions (live.millerandmillerauctions.com) — Ontario,
// periodic catalog auctions, CAD. The site is an Auction Mobility white-
// label: lot pages embed a server-rendered `viewVars = {...}` JSON blob, so
// the adapter fetches the /lots browse page with plain HTTP and parses that
// blob (no headless browser needed). The keyword parameter name is
// unconfirmed upstream, so we send the common candidates AND keyword-filter
// locally. EXPERIMENTAL until verified with
// `npm run test-source miller "jordan psa"`.

import { fetchHtml, absUrl, saveDebug, debugLog } from './util.js';

const SITE = 'https://live.millerandmillerauctions.com';

// Extract the balanced JSON object assigned to `viewVars` in a script tag.
export function extractViewVars(html) {
  const start = html.search(/viewVars\s*=\s*\{/);
  if (start === -1) return null;
  const open = html.indexOf('{', start);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(open, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Pure, fixture-testable: viewVars → normalized raw listings.
export function parseMillerLots(viewVars) {
  const lots = viewVars?.lots?.result_page ?? [];
  const out = [];
  for (const lot of lots) {
    const id = lot.row_id ?? lot.id;
    if (id == null || !lot.title) continue;
    out.push({
      listingId: String(id),
      canonicalKey: `miller:${id}`,
      title: String(lot.title).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      url: lot._detail_url ? absUrl(lot._detail_url, SITE) : null,
      price: lot.timed_auction_bid?.amount ?? lot.sold_price ?? lot.starting_price ?? null,
      currency: lot.currency_code ?? lot.auction?.currency_code ?? 'CAD',
      listingType: 'auction',
      endsAt: lot.extended_end_time ?? lot.auction?.effective_end_time ?? null,
      imageUrl: lot.cover_thumbnail ?? null,
      seller: 'Miller & Miller',
    });
  }
  return out;
}

export function createMillerSource() {
  return {
    name: 'miller',
    needsBrowser: false,
    minIntervalMs: 5000,

    async start() {},

    async search({ text }) {
      // Send both common Auction Mobility keyword params; harmless if ignored.
      const params = new URLSearchParams({ keyword: text, terms: text, sort: 'lot_number', page: '1' });
      const html = await fetchHtml(`${SITE}/lots?${params}`);
      const vv = extractViewVars(html);
      // A missing viewVars blob is a parse failure (markup change or an
      // interstitial), not an empty catalog — "between auctions" still
      // renders viewVars with an empty result_page. Fail visibly so the
      // Sources tab shows it instead of healthy zeros forever.
      if (vv == null) {
        saveDebug('miller', 'lots-page', html, 'html');
        throw new Error('miller: viewVars blob not found on /lots — markup changed?');
      }
      const lots = parseMillerLots(vv);
      debugLog('miller', `lots in page: ${lots.length}`);
      if (lots.length === 0) saveDebug('miller', 'lots-page', html, 'html');
      // If the server ignored the keyword params we get the whole catalog —
      // filter locally so the match layer isn't flooded.
      const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      return lots.filter((l) => {
        const t = l.title.toLowerCase();
        return tokens.filter((tok) => t.includes(tok)).length >= Math.min(2, tokens.length);
      });
    },

    async close() {},
  };
}
