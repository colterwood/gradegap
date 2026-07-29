// Catawiki (catawiki.com) — the biggest EU auction platform for graded
// cards; prices native EUR (their bidding API quotes EUR/USD/GBP at once —
// we take USD directly when offered). PerimeterX bot protection wants a
// browser-grade session, so the adapter opens the site in the shared
// browser and calls the SPA's own /buyer/api endpoints from inside the
// page: v1/search for matching lots, v3/bidding for live bid + end time.
// Verify locally with `npm run test-source catawiki "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog } from './util.js';

const SITE = 'https://www.catawiki.com';

// Pure, fixture-testable: (search lots, bidding lots by id) → normalized.
export function parseCatawikiLots(searchLots, biddingById) {
  const out = [];
  for (const lot of searchLots ?? []) {
    if (lot?.id == null || !lot.title) continue;
    const bid = biddingById?.get?.(lot.id) ?? biddingById?.[lot.id] ?? null;
    if (bid?.closed) continue;
    const amounts = bid?.current_bid_amount ?? null;
    // Prefer the platform's own USD quote; fall back to native EUR.
    const usd = amounts?.USD ?? null;
    const eur = amounts?.EUR ?? null;
    out.push({
      listingId: String(lot.id),
      canonicalKey: `catawiki:${lot.id}`,
      title: [lot.title, lot.subtitle].filter(Boolean).join(' '),
      url: lot.url ?? `${SITE}/en/l/${lot.id}`,
      price: usd ?? eur,
      currency: usd != null ? 'USD' : 'EUR',
      listingType: bid?.is_buy_now_available ? 'fixed' : 'auction',
      endsAt: bid?.bidding_end_time ?? null,
      imageUrl: lot.originalImageUrl ?? lot.original_image_url ?? lot.thumbnail2_url ?? null,
      seller: null,
    });
  }
  return out;
}

export function createCatawikiSource() {
  let lease = null;
  let page = null;

  return {
    name: 'catawiki',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Establish the PerimeterX session once; API calls then run same-origin.
      await page.goto(`${SITE}/en/c/725-trading-cards`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
    },

    async search({ text }) {
      const res = await page.evaluate(async (q) => {
        // Every in-page fetch gets a hard 10s abort — a stalled PerimeterX
        // check must fail the call, not hang the whole run.
        const getJson = async (url) => {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 10_000);
          try {
            const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
            const body = await r.text();
            if (!body.trimStart().startsWith('{')) return { status: r.status, json: null };
            return { status: r.status, json: JSON.parse(body) };
          } finally {
            clearTimeout(t);
          }
        };
        try {
          const search = await getJson(`/buyer/api/v1/search?q=${encodeURIComponent(q)}&page=1`);
          if (search.status !== 200 || !search.json) return { status: search.status, lots: null };
          const lots = (search.json.lots ?? []).slice(0, 60);
          let bidding = {};
          if (lots.length) {
            const ids = lots.map((l) => l.id).join(',');
            const b = await getJson(`/buyer/api/v3/bidding/lots?ids=${ids}`);
            for (const bl of b.json?.lots ?? []) bidding[bl.id] = bl;
          }
          return { status: 200, lots, bidding };
        } catch (e) {
          return { status: 0, lots: null, error: String(e) };
        }
      }, text);
      if (res.status === 429) throw Object.assign(new Error('Catawiki rate limited (429)'), { rateLimited: true });
      if (res.status !== 200 || !res.lots) {
        saveDebug('catawiki', 'page', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot().catch(() => null);
        if (shot) saveDebug('catawiki', 'screenshot', shot, 'png');
        throw new Error(`Catawiki search failed (HTTP ${res.status || 'none'}${res.error ? ` — ${res.error}` : ''})`);
      }
      debugLog('catawiki', `search returned ${res.lots.length} lots`);
      return parseCatawikiLots(res.lots, res.bidding);
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
