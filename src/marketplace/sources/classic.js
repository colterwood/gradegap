// Classic Auctions (classicauctions.net) — Montreal, the big hockey house,
// ~3 catalog auctions/year, prices in CAD. Plain server-rendered ASP.NET:
// the adapter fetches the current catalog pages and keyword-filters lots
// locally (the site's own search parameter isn't reliably documented, and
// at ~1,000 lots per auction a few catalog pages cover everything).
// Between auctions the catalog shows the last/next sale; no live lots then.
// EXPERIMENTAL until verified locally with
// `npm run test-source classic "jordan psa"`.

import { fetchHtml, toNumber, absUrl, decodeEntities, saveDebug, debugLog, zonedToIso } from './util.js';

const SITE = 'https://www.classicauctions.net';
const MAX_PAGES = 6;
const PAGE_TIMEOUT_MS = 12_000;
// Classic is in Montreal and states its closing date without a zone.
const SITE_TZ = 'America/Toronto';

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' '));

// The catalog states its own sale status in prose: "Auction closed on
// 6/17/2026. Final prices include buyers premium." for a finished sale.
// This matters because the catalog page KEEPS SERVING the finished sale's
// lots — 25 of them on the live page, each showing a Final Price. Emitting
// those as live auctions was doubly wrong: they aren't biddable, and with
// no end date neither cleanup pass could ever remove them (the miss
// counter never advances while the page keeps returning them), so a
// matched lot would sit in the table permanently. Exported for tests.
export function parseClassicSaleStatus(html, now = Date.now()) {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const m = text.match(/auction\s+(clos\w+|end\w+)\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!m) return { closingIso: null, closed: false };
  const [, , mo, d, y] = m;
  // Bias to the END of the closing day: the page gives a date with no
  // time, and erring late means deleteEndedAuctions can never remove a lot
  // that is still biddable.
  const closingIso = zonedToIso(`${mo}/${d}/${y} 23:59:00`, SITE_TZ);
  return { closingIso, closed: closingIso != null && Date.parse(closingIso) < now };
}

// Pure, fixture-testable: catalog HTML → lots (id, title, url, price, image).
// Lot links look like /lot-173141.aspx or /some_slug-lot150174.aspx.
export function parseClassicCatalog(html, site = SITE, endsAt = null) {
  const out = new Map();
  const re = /<a[^>]+href=["']([^"']*-?lot-?(\d+)\.aspx[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const [, href, id, inner] = m;
    const title = stripTags(inner);
    if (!title || title.length < 10) continue; // image-only anchors etc.
    if (out.has(id)) continue;
    // The current-bid figure sits near the lot anchor; scan a window after it.
    const tail = html.slice(m.index, m.index + 1500);
    const price = toNumber(tail.match(/(?:Current|High)\s*Bid[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]
      ?? tail.match(/\$\s*([\d,]+(?:\.\d{2})?)/)?.[1]);
    const img = tail.match(/<img[^>]+src=["']([^"']*pics\.classicauctions\.net[^"']+)["']/i)?.[1] ?? null;
    out.set(id, {
      listingId: id,
      canonicalKey: `classic:${id}`,
      title,
      url: absUrl(href, site),
      price,
      currency: 'CAD',
      listingType: 'auction',
      // One closing night for the whole catalog — it isn't on the lot row,
      // so the caller passes the catalog-level date in.
      endsAt,
      imageUrl: img,
      seller: 'Classic Auctions',
    });
  }
  return [...out.values()];
}

async function crawlCatalog() {
  const all = [];
  let firstPageHtml = null;
  let endsAt = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? `${SITE}/catalog.aspx?lotsperpage=100`
      : `${SITE}/catalog.aspx?lotsperpage=100&page=${page}`;
    debugLog('classic', `fetching catalog page ${page}…`);
    let html;
    try {
      html = await fetchHtml(url, { timeoutMs: PAGE_TIMEOUT_MS });
    } catch (err) {
      // A rate limit must reach the runner (it backs the source off 30
      // min), and a failed FIRST page means nothing was fetched — that
      // has to be a failed check, not a successful empty one (three
      // "successful" zeros delete every tracked listing as stale).
      if (err.rateLimited || page === 1) throw err;
      debugLog('classic', `page ${page} failed (${err.message}) — keeping pages 1..${page - 1}`);
      break; // past the end / transient failure — keep what we have
    }
    if (page === 1) {
      firstPageHtml = html;
      const status = parseClassicSaleStatus(html);
      if (status.closed) {
        // A finished sale whose lots are still on the page — not biddable,
        // and nothing to alert on. Returning them would park sold lots in
        // the listings table permanently.
        debugLog('classic', `catalog is a CLOSED sale (closed ${status.closingIso}) — no live lots`);
        return [];
      }
      endsAt = status.closingIso;
      debugLog('classic', `catalog closes ${endsAt ?? '(date not stated)'}`);
    }
    const lots = parseClassicCatalog(html, SITE, endsAt);
    debugLog('classic', `page ${page}: ${lots.length} lot anchors in ${html.length}b`);
    const fresh = lots.filter((l) => !all.some((a) => a.listingId === l.listingId));
    if (fresh.length === 0) break; // no new lots → past the last page
    all.push(...fresh);
    await new Promise((r) => setTimeout(r, 800));
  }
  if (all.length === 0 && firstPageHtml != null) {
    // No lot anchors at all: either between auctions or the markup moved.
    saveDebug('classic', 'catalog', firstPageHtml, 'html');
  }
  return all;
}

export function createClassicSource() {
  // The site has no usable search — every query filters the same catalog —
  // so fetch it ONCE per run. It used to be re-crawled per watch: N watches
  // meant N × 6 identical page fetches of the same ~1,000 lots.
  let catalog = null;

  return {
    name: 'classic',
    needsBrowser: false,
    // Politeness lives in the crawl's own inter-page delay; after the first
    // search every call is a pure in-memory filter, so no per-item pacing.
    minIntervalMs: 0,

    async start() {},

    async search({ text }) {
      // Keyword-filter locally: every query token (minus the slab tokens the
      // match layer re-checks anyway) must appear in the lot title.
      const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      if (catalog == null) catalog = await crawlCatalog();
      return catalog.filter((l) => {
        const t = l.title.toLowerCase();
        const hits = tokens.filter((tok) => t.includes(tok)).length;
        return hits >= Math.min(2, tokens.length); // loose gate; match layer decides
      });
    },

    async close() {},
  };
}
