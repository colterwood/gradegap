// Pristine is TWO venues (per the user's local verification):
//   1. pristineauction.com — the auction side; lot search lives at
//      /auction/search/ (browser-driven — Cloudflare + client rendering).
//   2. pristinemarketplace.com — a separate fixed-price marketplace site;
//      probed as a Shopify storefront first (clean JSON, no scraping), with
//      the failure logged for a debug round-trip if it turns out not to be.
// One adapter returns both sides' listings. Verify locally with
// `npm run test-source pristine "jordan psa 10" --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog } from './util.js';
import { searchShopifyShop } from './shopify.js';

const SITE = 'https://www.pristineauction.com';
const MARKETPLACE = { domain: 'www.pristinemarketplace.com', currency: 'USD' };

const SEARCH_INPUTS = [
  'input[type="search"]',
  'input[name="q"]',
  'input[name="search"]',
  'input[name="query"]',
  'input[name="keyword"]',
  'input[placeholder*="earch"]',
];

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
      // JSON-LD first, /auction/item/ tiles second — whatever page we're on.
      const parseCurrentPage = async () => {
        const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
          nodes.map((n) => {
            try { return JSON.parse(n.textContent); } catch { return null; }
          }).filter(Boolean)
        ).catch(() => []);
        const fromLd = parsePristineJsonLd(blocks.flat());
        if (fromLd.length > 0) return fromLd;
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
      };

      // --- auction side: /auction/search/ is the real results page --------
      const q = encodeURIComponent(text);
      const candidates = [
        `${SITE}/auction/search/?q=${q}`,
        `${SITE}/auction/search/?search=${q}`,
        `${SITE}/auction/search/?keyword=${q}`,
      ];
      let auctionResults = [];
      for (const url of candidates) {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
        const status = res?.status() ?? 0;
        if (status < 200 || status >= 400) {
          debugLog('pristine', `GET ${url} → ${status}`);
          continue;
        }
        await page.waitForTimeout(2500); // results render
        auctionResults = await parseCurrentPage();
        debugLog('pristine', `GET ${url} → ${status}, parsed ${auctionResults.length}`);
        if (auctionResults.length > 0) break;
      }

      // Param name unknown? Use the search page's own input as the oracle.
      if (auctionResults.length === 0) {
        await page.goto(`${SITE}/auction/search/`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
        await page.waitForTimeout(1500);
        for (const sel of SEARCH_INPUTS) {
          const box = page.locator(sel).first();
          if (!(await box.isVisible().catch(() => false))) continue;
          debugLog('pristine', `filling search input ${sel} on /auction/search/`);
          await box.fill(text).catch(() => {});
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
            box.press('Enter').catch(() => {}),
          ]);
          await page.waitForTimeout(2500);
          auctionResults = await parseCurrentPage();
          debugLog('pristine', `after form search: ${page.url()} — parsed ${auctionResults.length}`);
          break;
        }
      }
      if (auctionResults.length === 0) {
        saveDebug('pristine', 'auction-results', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot().catch(() => null);
        if (shot) saveDebug('pristine', 'screenshot', shot, 'png');
      }

      // --- marketplace side: pristinemarketplace.com (Shopify?) -----------
      let marketResults = [];
      try {
        marketResults = await searchShopifyShop(MARKETPLACE, text);
        debugLog('pristine', `marketplace (shopify) returned ${marketResults.length}`);
        for (const l of marketResults) l.canonicalKey = `pristine-mkt:${l.listingId}`;
      } catch (err) {
        debugLog('pristine', `marketplace side failed: ${err.message}`);
      }

      return [...auctionResults, ...marketResults];
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
