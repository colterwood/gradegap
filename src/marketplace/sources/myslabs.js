// MySlabs (myslabs.com) — slab marketplace with separate fixed-price and
// auction searches. The site is JS-challenged (Cloudflare), so the adapter
// drives the shared visible browser and reads the .slab_item tiles from both
// search pages. (MySlabs also has an official OAuth API v2 — if it turns out
// to expose marketplace-wide search, this adapter should migrate to it.)
// Verify locally with `npm run test-source myslabs "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';

const SITE = 'https://www.myslabs.com';

export function createMySlabsSource() {
  let lease = null;
  let page = null;

  async function scrapeSearch(url, listingType) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500); // JS render + lazy tiles

    return page.$$eval('.slab_item', (tiles, meta) =>
      tiles.map((tile) => {
        const a = tile.querySelector('.slab_item_img_inside a') ?? tile.querySelector('a[href]');
        const href = a?.getAttribute('href') ?? null;
        const url = href ? new URL(href, meta.site).href : null;
        const id = url?.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? url;
        const title = (tile.querySelector('.slab-title')?.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (!id || !title) return null;
        const priceText = tile.querySelector('.slab-price')?.textContent?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0];
        const img = tile.querySelector('.slab_item_img_inside img') ?? tile.querySelector('img');
        return {
          listingId: String(id),
          canonicalKey: `myslabs:${id}`,
          title,
          url,
          price: priceText ? parseFloat(priceText.replace(/[$,]/g, '')) : null,
          currency: 'USD',
          listingType: meta.listingType,
          endsAt: null, // end time isn't on the tile; the detail page has it
          imageUrl: img?.getAttribute('data-src') ?? img?.src ?? null,
          seller: null,
        };
      }).filter(Boolean),
      { site: SITE, listingType }
    ).catch(() => []);
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
      const fixed = await scrapeSearch(
        `${SITE}/search/slabs/?publish_type=0&owner=&q=${q}&o=created_desc`,
        'fixed'
      );
      const auctions = await scrapeSearch(
        `${SITE}/auction/search/all/?publish_type=all&owner=&q=${q}&o=endtime_asc`,
        'auction'
      );
      const seen = new Set();
      return [...auctions, ...fixed].filter((l) => !seen.has(l.listingId) && seen.add(l.listingId));
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
