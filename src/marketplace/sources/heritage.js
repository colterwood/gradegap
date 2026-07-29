// Heritage Auctions (sports.ha.com) — weekly + catalog auctions. Search is
// server-rendered (Endeca): /c/search-results.zx?Ntt=<query>, with
// mode=live restricting to open auctions. Heritage 403s datacenter IPs, so
// the adapter drives the shared visible browser from your machine; titles,
// current bids, and end times are public logged-out (the sold archive is
// what needs an account). Verify locally with
// `npm run test-source heritage "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog } from './util.js';

const SITE = 'https://sports.ha.com';

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
      const params = new URLSearchParams({ Ntt: text, mode: 'live', layout: 'list' });
      await page.goto(`${SITE}/c/search-results.zx?${params}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.waitForTimeout(2000);

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
            // e.g. "Aug 9, 2026" — parseable by Date; time-of-day granularity
            // isn't in the tile, the runner's toSqlDate handles either way.
            endsAt: endsText,
            imageUrl: li.querySelector('img.thumbnail')?.src ?? null,
            seller: null,
          };
        }).filter(Boolean)
      ).catch(() => []);

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
