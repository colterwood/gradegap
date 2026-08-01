// Heritage Auctions (sports.ha.com) — weekly + catalog auctions. Search is
// server-rendered (Endeca): /c/search-results.zx?Ntt=<query>, with
// mode=live restricting to open auctions. Heritage 403s datacenter IPs, so
// the adapter drives the shared visible browser from your machine; titles,
// current bids, and end times are public logged-out (the sold archive is
// what needs an account). Verify locally with
// `npm run test-source heritage "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog, gotoStable, relativeToIso, zonedToIso } from './util.js';

const SITE = 'https://sports.ha.com';
// Heritage is in Dallas and quotes closings in US Central.
const SITE_TZ = 'America/Chicago';

// Live tiles show RELATIVE end times ("25 days", "6 hours 12 minutes") —
// convert to an approximate ISO timestamp; absolute dates are resolved
// against Heritage's own zone rather than the scraper machine's, which
// otherwise moved the stored end time by the host's offset.
// Exported for tests.
export function parseHeritageEnds(text, now = Date.now()) {
  if (!text) return null;
  const relative = relativeToIso(text, now);
  if (relative) return relative;
  const s = String(text).trim();
  // A bare "Aug 9, 2026" has no time and no zone: read it in Central and
  // bias to the end of that day, so an auction is never dropped early by
  // the ended-auction sweep.
  if (/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/.test(s)) {
    const d = new Date(`${s} 00:00:00Z`);
    if (isNaN(d.getTime())) return null;
    const [y, mo, day] = d.toISOString().slice(0, 10).split('-');
    return zonedToIso(`${y}-${mo}-${day} 23:59:00`, SITE_TZ);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The search URL Heritage actually serves. The older
// /c/search-results.zx?Ntt=… form 302s to this one, and the render happens
// only after that hop — which is what the adapter used to race. Exported so
// a regression back to the redirecting form is caught by a test.
export function heritageSearchUrl(text) {
  const params = new URLSearchParams({ term: text, mode: 'live', layout: 'list' });
  return `${SITE}/c/search/results.zx?${params}`;
}

export function createHeritageSource() {
  let lease = null;
  let page = null;

  return {
    name: 'heritage',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
    },

    async search({ text }) {
      // Heritage REDIRECTS this URL (/c/search-results.zx?Ntt=… becomes
      // /c/search/results.zx?term=…) and only then renders the tiles, so the
      // old fixed 2s wait raced the redirect + render and returned 0 for
      // essentially every watch (252 searches, 1 listing stored). Verified
      // in a real browser: the same query yields 5 lots including the
      // BGS 8 Jordan rookie. Request the post-redirect URL directly and
      // wait for a definite outcome — tiles, or Heritage's own .no-results.
      await gotoStable(page, heritageSearchUrl(text));

      const deadline = Date.now() + 20_000;
      let tiles = 0;
      while (Date.now() < deadline) {
        tiles = await page.locator('.item-block').count().catch(() => 0);
        if (tiles > 0) break;
        if (await page.locator('.no-results').count().catch(() => 0)) break; // genuinely nothing
        await page.waitForTimeout(500);
      }
      debugLog('heritage', `"${text}" -> ${tiles} tiles at ${page.url()}`);

      // One .item-block per lot (usually an <li>); id = "{saleNo}-{itemId}".
      const results = await page.$$eval('.item-block', (blocks) =>
        blocks.map((li) => {
          const titleA = li.querySelector('a.item-title');
          const title = (titleA?.textContent ?? '').trim().replace(/\s+/g, ' ');
          const id = li.id || titleA?.href?.match(/\/a\/([\d-]+)\.s/)?.[1];
          if (!id || !title) return null;
          const priceText = li.querySelector('.item-value')?.textContent?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0];
          const endsText = li.querySelector('.time-bidding-open .time-remaining')?.textContent?.trim() ?? null;
          return {
            listingId: id,
            canonicalKey: `heritage:${id}`,
            title,
            url: titleA?.href ?? null,
            price: priceText ? parseFloat(priceText.replace(/[$,]/g, '')) : null,
            currency: 'USD',
            listingType: 'auction',
            endsAt: endsText, // raw here; normalized below (browser context can't share helpers)
            imageUrl: li.querySelector('img.thumbnail')?.src ?? null,
            seller: null,
          };
        }).filter(Boolean)
      ).catch(() => []);

      for (const r of results) r.endsAt = parseHeritageEnds(r.endsAt);

      if (results.length === 0) {
        // 0 can be legit (no live lots match) or a bot-block/redirect — the
        // page title and capture tell them apart.
        debugLog('heritage', `0 item-blocks — landed on "${await page.title().catch(() => '?')}" at ${page.url()}`);
        saveDebug('heritage', 'results', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot().catch(() => null);
        if (shot) saveDebug('heritage', 'screenshot', shot, 'png');
      }
      return results;
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
