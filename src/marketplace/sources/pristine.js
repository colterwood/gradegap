// Pristine Auction (pristineauction.com) — high-volume daily auctions.
// No anonymous JSON API is known and the site sits behind Cloudflare bot
// checks, so this adapter drives the shared visible browser (same persistent
// profile as the Card Ladder sync — clearance cookies stick). Live testing
// 404'd the guessed /search path, so instead of guessing URLs it uses the
// site's OWN search box on the homepage and parses whatever results page
// the site navigates to: schema.org JSON-LD blocks first, DOM tiles as a
// fallback. Verify locally with
// `npm run test-source pristine "jordan psa 10" --debug`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { saveDebug, debugLog } from './util.js';

const SITE = 'https://www.pristineauction.com';

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
      // Learn the search URL from the site's own form markup — the input
      // doesn't need to be VISIBLE (live testing: it's hidden behind a
      // toggle); its enclosing <form action> + input name are still there.
      await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2000); // homepage settle / CF check

      const form = await page.evaluate((selectors) => {
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (!input) continue;
          const f = input.closest('form');
          return {
            sel,
            name: input.getAttribute('name') || 'q',
            action: f?.getAttribute('action') ?? null,
            method: (f?.getAttribute('method') ?? 'get').toLowerCase(),
          };
        }
        return null;
      }, SEARCH_INPUTS).catch(() => null);

      // Candidate result URLs, best-informed first. /auction/index/... is
      // the site's own routing scheme (seen on its category pages).
      const candidates = [];
      if (form?.action && form.method === 'get') {
        candidates.push(`${new URL(form.action, SITE).href}?${encodeURIComponent(form.name)}=${encodeURIComponent(text)}`);
        debugLog('pristine', `form found via ${form.sel}: action=${form.action} name=${form.name}`);
      } else if (form) {
        debugLog('pristine', `form found via ${form.sel} but method=${form.method} action=${form.action}`);
      } else {
        debugLog('pristine', 'no search form in homepage DOM — trying known URL patterns');
      }
      const q = encodeURIComponent(text);
      candidates.push(
        `${SITE}/auction/index/search/?q=${q}`,
        `${SITE}/auction/index/search/?search=${q}`,
        `${SITE}/auction/index/search/?keyword=${q}`,
        `${SITE}/auction/index/search/keyword/${q}`
      );

      let landed = false;
      for (const url of candidates) {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
        const status = res?.status() ?? 0;
        debugLog('pristine', `GET ${url} → ${status}`);
        if (status >= 200 && status < 400) {
          landed = true;
          break;
        }
      }
      if (!landed) {
        saveDebug('pristine', 'homepage', await page.content().catch(() => ''), 'html');
        const shot = await page.screenshot().catch(() => null);
        if (shot) saveDebug('pristine', 'screenshot', shot, 'png');
        throw new Error('Pristine: every candidate search URL failed — run with --debug and send the captures');
      }
      await page.waitForTimeout(2500); // results render

      const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
        nodes.map((n) => {
          try { return JSON.parse(n.textContent); } catch { return null; }
        }).filter(Boolean)
      ).catch(() => []);
      const fromLd = parsePristineJsonLd(blocks.flat());
      debugLog('pristine', `landed on ${page.url()} — ${blocks.length} JSON-LD blocks, ${fromLd.length} products`);
      if (fromLd.length > 0) return fromLd;
      saveDebug('pristine', 'results', await page.content().catch(() => ''), 'html');

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
