// JOOPITER (joopiter.com) — Pharrell Williams' digital-first auction house:
// periodic themed sales at /auctions/<sale-slug>/<lot-slug> (USD), plus a
// fixed-price /marketplace side organized the same way. The site 403s plain
// HTTP clients, so the adapter drives the shared browser. No search endpoint
// is known, and sales are small (tens of lots), so it crawls the open sales
// and marketplace collections ONCE per run and keyword-filters locally —
// same shape as the classic adapter. Lot ids are slug pairs, not numbers.
// EXPERIMENTAL until verified locally with
// `npm run test-source joopiter "rolex" --scratch-profile --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import {
  saveDebug, debugLog, toNumber, toIsoDate, absUrl, gotoStable, parkPage,
  relativeToIso, zonedToIso, sleep,
} from './util.js';
import { extractLotArrays } from './pristine.js';

const SITE = 'https://www.joopiter.com';
// How many sale/collection index links to visit per crawl — a sale's whole
// catalog renders on its one page, so this bounds page loads, not lots.
const MAX_SECTIONS = 6;
// JOOPITER is a New York house; close dates stated without a time mean
// their zone, and we bias to end-of-day so a lot is never swept while it is
// still biddable (same reasoning as the classic adapter).
const SITE_TZ = 'America/New_York';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "Ends in 2d 14h" countdowns are per-lot and zone-free, so they win;
// "Bidding closes March 5, 2026" prose is the fallback. Returns ISO or null.
export function parseJoopiterEnds(text, now = Date.now()) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const rel = s.match(
    /(?:ends?|closes?|closing)[^a-z0-9]{0,10}(?:in\s+)?((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i
  );
  const fromCountdown = relativeToIso(rel?.[1] ?? '', now);
  if (fromCountdown) return fromCountdown;
  const abs = s.match(/(?:ends?|closes?|closing|until|through)[^.]{0,30}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!abs) return null;
  const [, mon, day, year] = abs;
  return zonedToIso(`${MONTHS[mon.toLowerCase()]}/${day}/${year} 23:59:00`, SITE_TZ);
}

// A lot tile shows several dollar figures: the bid, and often an
// "Estimate $2,000 – $3,000" range. Only a LABELED bid/price counts; a bare
// figure is accepted only when the tile never says "estimate" — an estimate
// posing as a bid would bypass every max-price cap.
export function pickJoopiterPrice(text) {
  const s = String(text ?? '');
  const labeled = s.match(
    /(?:current|winning|high(?:est)?|starting|opening)\s*bid[^$€£]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i
  ) ?? s.match(/(?:price|buy\s*now)[^$€£]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (labeled) return toNumber(labeled[1]);
  if (/estimate/i.test(s)) return null;
  return toNumber(s.match(/\$\s*([\d,]+(?:\.\d{2})?)/)?.[1] ?? null);
}

// Pure, fixture-testable: one harvested tile → a normalized raw listing.
// A tile is { saleSlug, lotSlug, href, title, text, img } as scraped from a
// sale or marketplace page in the browser.
export function mapJoopiterTile(tile, { listingType, pageEndsAt = null, now = Date.now() } = {}) {
  if (!tile?.saleSlug || !tile.lotSlug) return null;
  const title = String(tile.title ?? '').replace(/\s+/g, ' ').trim();
  if (title.length < 8) return null; // image-only / CTA anchors
  // A closed sale's page keeps serving its lots with "Sold for $…" prices —
  // not biddable, nothing to alert on. Match the full label, not a bare
  // "sold": tile text includes the title, and titles say things like
  // "Sold Out Tour Jacket".
  if (/\bsold\s+(?:for|at)\b|\bwinning\s+bid\b/i.test(tile.text ?? '')) return null;
  const id = `${tile.saleSlug}/${tile.lotSlug}`;
  return {
    listingId: id,
    canonicalKey: `joopiter:${id}`,
    title,
    url: absUrl(tile.href, SITE),
    price: pickJoopiterPrice(tile.text),
    currency: 'USD',
    listingType,
    endsAt: listingType === 'auction' ? (parseJoopiterEnds(tile.text, now) ?? pageEndsAt) : null,
    imageUrl: tile.img ?? null,
    seller: 'JOOPITER',
  };
}

// Pure, fixture-testable: a lot-shaped object from __NEXT_DATA__ or a
// sniffed API response → normalized raw listing. Field names are guesses
// over the common shapes (the payload isn't observable from every network),
// so read tolerantly and reject anything without a title and id.
export function mapJoopiterApiLot(o, { listingType = 'auction' } = {}) {
  if (!o || typeof o !== 'object') return null;
  const title = o.title ?? o.name ?? o.lotTitle ?? null;
  const slug = o.slug ?? o.lotSlug ?? o.handle ?? null;
  const id = o.id ?? o.lotId ?? o._id ?? o.objectID ?? slug;
  if (!title || id == null) return null;
  // Money fields sometimes arrive as { amount } wrappers.
  const money = (v) => toNumber(v && typeof v === 'object' ? v.amount ?? v.value : v);
  const price = money(o.currentBid ?? o.current_bid ?? o.highBid ?? o.high_bid)
    ?? money(o.winningBid ?? o.startingBid ?? o.starting_bid ?? o.price ?? o.amount);
  const ends = o.endsAt ?? o.ends_at ?? o.endDate ?? o.end_date ?? o.endTime
    ?? o.end_time ?? o.closingDate ?? o.biddingEndsAt ?? null;
  const saleSlug = o.auctionSlug ?? o.auction?.slug ?? o.saleSlug ?? null;
  const urlish = o.url ?? o.permalink ?? o.href ?? null;
  const image = o.image ?? o.imageUrl ?? o.image_url ?? o.thumbnail ?? o.coverImage ?? null;
  return {
    listingId: String(id),
    canonicalKey: `joopiter:${id}`,
    title: String(title),
    url: urlish
      ? absUrl(urlish, SITE)
      : (slug && saleSlug ? `${SITE}/auctions/${saleSlug}/${slug}` : null),
    price,
    currency: 'USD',
    listingType,
    endsAt: toIsoDate(ends),
    imageUrl: typeof image === 'string' ? image : (image && typeof image === 'object' ? image.url ?? null : null),
    seller: 'JOOPITER',
  };
}

export function createJoopiterSource() {
  let lease = null;
  let page = null;
  let sniffedJson = [];
  let catalog = null; // one crawl per run; every search is an in-memory filter

  // Collect every same-host anchor under /<section>/<a>/<b> — those are lot
  // (or marketplace item) links; two-segment links are the sale/collection
  // indexes the crawl visits. Runs in the page; returns plain data only.
  const harvestTiles = (section) =>
    page.evaluate((sec) => {
      const seen = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        let u;
        try { u = new URL(a.href); } catch { continue; }
        if (u.hostname !== location.hostname) continue;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length !== 3 || segs[0] !== sec) continue;
        const key = `${segs[1]}/${segs[2]}`;
        const tile = a.closest('li,article') ?? a;
        const title = (
          a.getAttribute('aria-label') || a.getAttribute('title') ||
          a.querySelector('img')?.alt || a.textContent || ''
        ).replace(/\s+/g, ' ').trim();
        // Image anchor and title anchor often point at the same lot — keep
        // whichever carries the longer title.
        if (seen.has(key) && seen.get(key).title.length >= title.length) continue;
        seen.set(key, {
          saleSlug: segs[1],
          lotSlug: segs[2],
          href: a.href,
          title,
          text: ((tile.textContent || '') + ' ' + (a.textContent || '')).replace(/\s+/g, ' ').slice(0, 500),
          img: tile.querySelector('img')?.src ?? a.querySelector('img')?.src ?? null,
        });
      }
      return [...seen.values()];
    }, section);

  const harvestIndexLinks = (section) =>
    page.evaluate((sec) => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        let u;
        try { u = new URL(a.href); } catch { continue; }
        if (u.hostname !== location.hostname) continue;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length === 2 && segs[0] === sec && !out.includes(segs[1])) out.push(segs[1]);
      }
      return out;
    }, section);

  // Visit one sale/collection page and return its listings, trying static
  // tiles first, then whatever JSON the page shipped or fetched (pristine's
  // layering). A closed sale is skipped outright.
  const harvestSection = async (section, slug, listingType) => {
    const url = `${SITE}/${section}/${slug}`;
    await parkPage(page);
    sniffedJson = [];
    const res = await gotoStable(page, url).catch(() => undefined);
    if (res === undefined) {
      debugLog('joopiter', `GET ${url} → navigation failed`);
      return [];
    }
    const status = res === null ? 200 : res.status();
    if (status < 200 || status >= 400) {
      debugLog('joopiter', `GET ${url} → ${status}`);
      return [];
    }
    await page.waitForTimeout(3000); // client render + data XHRs
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (/(?:auction|bidding|sale)\s+(?:has\s+)?(?:ended|closed)/i.test(bodyText)) {
      debugLog('joopiter', `${section}/${slug} is a closed sale — skipping`);
      return [];
    }
    const now = Date.now();
    // One closing night for a whole sale is common — stated in the page
    // prose, not on every tile — so it backs any tile without its own.
    const pageEndsAt = listingType === 'auction' ? parseJoopiterEnds(bodyText, now) : null;

    const tiles = await harvestTiles(section).catch(() => []);
    let listings = tiles
      .map((t) => mapJoopiterTile(t, { listingType, pageEndsAt, now }))
      .filter(Boolean);

    if (listings.length === 0) {
      // Embedded Next.js data counts as a "sniffed" payload too.
      const embedded = await page
        .evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent ?? null)
        .catch(() => null);
      const payloads = [...sniffedJson];
      if (embedded) {
        try { payloads.push({ url: 'inline:__NEXT_DATA__', json: JSON.parse(embedded) }); } catch { /* not JSON */ }
      }
      const seen = new Set();
      for (const { url: apiUrl, json } of payloads) {
        for (const arr of extractLotArrays(json)) {
          const mapped = arr.map((o) => mapJoopiterApiLot(o, { listingType })).filter(Boolean);
          if (mapped.length === 0) continue;
          debugLog('joopiter', `lot-shaped JSON from ${apiUrl} → ${mapped.length}`);
          saveDebug('joopiter', 'api-lots', JSON.stringify(arr.slice(0, 3), null, 2), 'json');
          for (const l of mapped) {
            if (!seen.has(l.listingId) && seen.add(l.listingId)) listings.push(l);
          }
        }
      }
    }
    debugLog('joopiter', `${section}/${slug} → ${listings.length} listings (${tiles.length} tiles, ${sniffedJson.length} sniffed)`);
    if (listings.length === 0) {
      saveDebug('joopiter', `${section}-${slug}`, await page.content().catch(() => ''), 'html');
    }
    return listings;
  };

  const crawl = async () => {
    const all = new Map();
    const add = (listings) => {
      for (const l of listings) if (!all.has(l.listingId)) all.set(l.listingId, l);
    };
    for (const [section, listingType] of [['auctions', 'auction'], ['marketplace', 'fixed']]) {
      await parkPage(page);
      sniffedJson = [];
      // A failed AUCTIONS index means nothing was crawled — that must be a
      // failed check, not a successful empty one (three "successful" zeros
      // delete every tracked listing as stale). The marketplace side is
      // best-effort on top.
      try {
        await gotoStable(page, `${SITE}/${section}`);
      } catch (err) {
        if (section === 'auctions') throw err;
        debugLog('joopiter', `GET /${section} failed (${err.message}) — keeping auction results`);
        continue;
      }
      await page.waitForTimeout(3000);
      // Index pages sometimes place item tiles directly (marketplace) —
      // harvest them before walking into each sale/collection.
      const now = Date.now();
      add((await harvestTiles(section).catch(() => []))
        .map((t) => mapJoopiterTile(t, { listingType, now }))
        .filter(Boolean));
      const slugs = (await harvestIndexLinks(section).catch(() => [])).slice(0, MAX_SECTIONS);
      debugLog('joopiter', `/${section} index → ${slugs.length} section links: ${slugs.join(', ')}`);
      for (const slug of slugs) {
        add(await harvestSection(section, slug, listingType));
        await sleep(800);
      }
    }
    return [...all.values()];
  };

  return {
    name: 'joopiter',
    needsBrowser: true,
    // Politeness lives in the crawl's own inter-page delay; after the first
    // search every call is a pure in-memory filter, so no per-item pacing.
    minIntervalMs: 0,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Sniff every JSON response — the pages are client-rendered, so when
      // the DOM parse finds nothing the lots still traveled as JSON.
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
      if (catalog == null) catalog = await crawl();
      // Keyword-filter locally, same loose gate as classic/miller: the
      // match layer is the real judge.
      const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      return catalog.filter((l) => {
        const t = l.title.toLowerCase();
        const hits = tokens.filter((tok) => t.includes(tok)).length;
        return hits >= Math.min(2, tokens.length);
      });
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
