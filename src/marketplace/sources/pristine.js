// Pristine Auction (pristineauction.com) — high-volume daily auctions.
// No anonymous JSON API is known and the site sits behind Cloudflare bot
// checks, so this adapter drives the shared visible browser (same persistent
// profile as the Card Ladder sync — clearance cookies stick) and reads the
// search results page: schema.org JSON-LD blocks first, DOM tiles as a
// fallback. EXPERIMENTAL: selectors are best-effort until verified locally
// with `npm run test-source pristine "jordan psa 10"`.

import { acquireBrowser } from '../../scraper/browserLease.js';

const SITE = 'https://www.pristineauction.com';

// Pure, fixture-testable: JSON-LD objects → normalized raw listings.
export function parsePristineJsonLd(blocks) {
  const out = [];
  const products = blocks.flatMap((b) => {
    if (b?.['@type'] === 'Product') return [b];
    if (Array.isArray(b?.itemListElement)) {
      return b.itemListElement.map((el) => el?.item ?? el).filter((x) => x?.['@type'] === 'Product');
    }
    return [];
  });
  for (const p of products) {
    const url = typeof p.url === 'string' ? p.url : null;
    const id = url?.split('/').filter(Boolean).pop() ?? p.sku ?? p.productID;
    if (!id || !p.name) continue;
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    out.push({
      listingId: String(id),
      canonicalKey: `pristine:${id}`,
      title: p.name,
      url: url ? new URL(url, SITE).href : null,
      price: offer?.price != null ? parseFloat(offer.price) : null,
      currency: offer?.priceCurrency ?? 'USD',
      listingType: 'auction', // Pristine is auction-format (incl. its daily "10-minute" lots)
      endsAt: offer?.priceValidUntil ?? null,
      imageUrl: typeof p.image === 'string' ? p.image : (Array.isArray(p.image) ? p.image[0] : null),
      seller: null,
    });
  }
  return out;
}

export function createPristineSource() {
  let lease = null;
  let page = null;

  return {
    name: 'pristine',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
    },

    async search({ text }) {
      await page.goto(`${SITE}/search?q=${encodeURIComponent(text)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.waitForTimeout(2500); // let the results (and any CF check) settle

      const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
        nodes.map((n) => {
          try { return JSON.parse(n.textContent); } catch { return null; }
        }).filter(Boolean)
      ).catch(() => []);
      const fromLd = parsePristineJsonLd(blocks.flat());
      if (fromLd.length > 0) return fromLd;

      // Fallback: auction item tiles link to /auction/item/<id>-<slug>.
      return page.$$eval('a[href*="/auction/item/"]', (links) => {
        const seen = new Map();
        for (const a of links) {
          const href = a.href;
          const id = href.match(/\/auction\/item\/(\d+)/)?.[1];
          const title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
          if (!id || seen.has(id) || title.length < 10) continue;
          const tile = a.closest('div,li,article') ?? a;
          const priceText = tile.textContent.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] ?? null;
          seen.set(id, {
            listingId: id,
            canonicalKey: `pristine:${id}`,
            title,
            url: href,
            price: priceText ? parseFloat(priceText.replace(/[$,]/g, '')) : null,
            currency: 'USD',
            listingType: 'auction',
            endsAt: null,
            imageUrl: tile.querySelector('img')?.src ?? null,
            seller: null,
          });
        }
        return [...seen.values()];
      }).catch(() => []);
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
