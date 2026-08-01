// MySlabs (myslabs.com) — slab marketplace with separate fixed-price and
// auction searches. The site is JS-challenged (Cloudflare), so the adapter
// drives the shared visible browser and reads the .slab_item tiles from both
// search pages. (MySlabs also has an official OAuth API v2 — if it turns out
// to expose marketplace-wide search, this adapter should migrate to it.)
// Verify locally with `npm run test-source myslabs "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { gotoStable, parkPage, debugLog } from './util.js';

const SITE = 'https://www.myslabs.com';

export function createMySlabsSource() {
  let lease = null;
  let page = null;

  async function scrapeSearch(url, listingType) {
    // MySlabs schedules its own navigation shortly after a results page
    // loads; parking first stops it aborting ours.
    await parkPage(page);
    await gotoStable(page, url);
    await page.waitForTimeout(2500); // JS render + lazy tiles

    return page.$$eval('.slab_item', (tiles, meta) =>
      tiles.map((tile) => {
        const a = tile.querySelector('.slab_item_img_inside a') ?? tile.querySelector('a[href]');
        const href = a?.getAttribute('href') ?? null;
        const url = href ? new URL(href, meta.site).href : null;
        const id = url?.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? url;
        const title = (tile.querySelector('.slab-title')?.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (!id || !title) return null;
        // .slab-price when present; otherwise the first $ amount anywhere in
        // the tile (live testing showed the dedicated class missing).
        const priceText =
          tile.querySelector('.slab-price')?.textContent?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] ??
          tile.textContent?.match(/\$\s*[\d,]+(?:\.\d{2})?/)?.[0];
        const img = tile.querySelector('.slab_item_img_inside img') ?? tile.querySelector('img');
        return {
          listingId: String(id),
          canonicalKey: `myslabs:${id}`,
          title,
          url,
          price: priceText ? parseFloat(priceText.replace(/[$,\s]/g, '')) : null,
          currency: 'USD',
          listingType: meta.listingType,
          endsAt: null, // end time isn't on the tile; the detail page has it
          imageUrl: img?.getAttribute('data-src') ?? img?.src ?? null,
          seller: null,
        };
      }).filter(Boolean),
      { site: SITE, listingType }
    );
    // No blanket .catch(() => []) here: swallowing "execution context
    // destroyed" / "target closed" turned real page failures into
    // successful empty scrapes, which advance the staleness counter and
    // eventually delete tracked listings. Real errors now reach search()'s
    // per-venue handler and the run records a failure.
  }

  return {
    name: 'myslabs',
    needsBrowser: true,
    minIntervalMs: 5000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
    },

    async search({ text }) {
      const q = encodeURIComponent(text);
      // One venue failing (or being empty) must not lose the other's hits.
      const venues = [
        { url: `${SITE}/search/slabs/?publish_type=0&owner=&q=${q}&o=created_desc`, type: 'fixed' },
        { url: `${SITE}/auction/search/all/?publish_type=all&owner=&q=${q}&o=endtime_asc`, type: 'auction' },
      ];
      const all = [];
      const errors = [];
      for (const v of venues) {
        try {
          all.push(...(await scrapeSearch(v.url, v.type)));
        } catch (err) {
          errors.push(`${v.type}: ${String(err?.message ?? err).split('\n')[0]}`);
        }
      }
      if (errors.length === venues.length) throw new Error(`MySlabs — ${errors.join(' · ')}`);
      if (errors.length) debugLog('myslabs', `partial: ${errors.join(' · ')}`);
      const seen = new Set();
      return all.filter((l) => !seen.has(l.listingId) && seen.add(l.listingId));
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
