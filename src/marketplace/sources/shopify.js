// Generic Shopify-shop source: every Shopify storefront exposes a public
// predictive-search endpoint (/search/suggest.json), so one adapter covers
// any number of card shops — the Canadian ones (Flip Collectibles, Mintink,
// Overtime, …) being the motivating set. No scraping fragility: it's a
// stable, documented JSON endpoint.
//
// Config: SHOPIFY_SHOPS=domain[:CUR],domain[:CUR]  (currency defaults to CAD
// since the initial shop list is Canadian).

import { config } from '../../config.js';
import { fetchWithTimeout } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Search ONE Shopify storefront; also reused by other adapters whose
// marketplace side runs on Shopify (e.g. pristinemarketplace.com).
// Throws on transport errors; returns [] for a shop with no matches.
export async function searchShopifyShop({ domain, currency = 'CAD' }, text) {
  const params = new URLSearchParams({
    q: text,
    'resources[type]': 'product',
    'resources[limit]': '10',
    'resources[options][unavailable_products]': 'hide',
  });
  const res = await fetchWithTimeout(`https://${domain}/search/suggest.json?${params}`, {
    headers: { accept: 'application/json' },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`${domain} suggest.json HTTP ${res.status} (not a public Shopify storefront?)`);
  const body = await res.json();
  const out = [];
  for (const p of body?.resources?.results?.products ?? []) {
    const price = p.price != null ? parseFloat(String(p.price).replace(/[$,]/g, '')) : null;
    out.push({
      listingId: `${domain}:${p.id}`,
      canonicalKey: null,
      title: p.title ?? '',
      url: p.url ? new URL(p.url, `https://${domain}`).href : null,
      price: Number.isFinite(price) ? price : null,
      currency,
      listingType: 'fixed',
      endsAt: null,
      imageUrl: p.image ?? p.featured_image ?? null,
      seller: domain,
    });
  }
  return out;
}

export function createShopifySource() {
  const shops = config.shopifyShops.map((entry) => {
    const [domain, cur] = entry.split(':');
    return {
      domain: domain.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      currency: (cur || 'CAD').toUpperCase(),
    };
  });

  return {
    name: 'shopify',
    needsBrowser: false,
    minIntervalMs: 1500,

    configured() {
      return shops.length === 0 ? 'set SHOPIFY_SHOPS in .env (comma-separated shop domains)' : null;
    },

    async start() {
      if (shops.length === 0) {
        throw new Error('shopify source enabled but SHOPIFY_SHOPS is empty (see .env.example)');
      }
    },

    async search({ text }) {
      const out = [];
      for (const shop of shops) {
        try {
          out.push(...(await searchShopifyShop(shop, text)));
        } catch {
          // one shop down ≠ the source down
        }
        if (shops.length > 1) await sleep(400);
      }
      return out;
    },

    async close() {},
  };
}
