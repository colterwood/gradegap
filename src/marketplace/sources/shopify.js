// Generic Shopify-shop source: every Shopify storefront exposes a public
// predictive-search endpoint (/search/suggest.json), so one adapter covers
// any number of card shops — the Canadian ones (Flip Collectibles, Mintink,
// Overtime, …) being the motivating set. No scraping fragility: it's a
// stable, documented JSON endpoint.
//
// Config: SHOPIFY_SHOPS=domain[:CUR],domain[:CUR]  (currency defaults to CAD
// since the initial shop list is Canadian).

import { config } from '../../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    async start() {
      if (shops.length === 0) {
        throw new Error('shopify source enabled but SHOPIFY_SHOPS is empty (see .env.example)');
      }
    },

    async search({ text }) {
      const out = [];
      for (const shop of shops) {
        try {
          const params = new URLSearchParams({
            q: text,
            'resources[type]': 'product',
            'resources[limit]': '10',
            'resources[options][unavailable_products]': 'hide',
          });
          const res = await fetch(`https://${shop.domain}/search/suggest.json?${params}`, {
            headers: { Accept: 'application/json' },
          });
          if (!res.ok) continue; // one shop down ≠ the source down
          const body = await res.json();
          for (const p of body?.resources?.results?.products ?? []) {
            const price = p.price != null ? parseFloat(String(p.price).replace(/[$,]/g, '')) : null;
            out.push({
              listingId: `${shop.domain}:${p.id}`,
              canonicalKey: null,
              title: p.title ?? '',
              url: p.url ? new URL(p.url, `https://${shop.domain}`).href : null,
              price: Number.isFinite(price) ? price : null,
              currency: shop.currency,
              listingType: 'fixed',
              endsAt: null,
              imageUrl: p.image ?? p.featured_image ?? null,
              seller: shop.domain,
            });
          }
        } catch {
          // per-shop network failures are non-fatal
        }
        if (shops.length > 1) await sleep(400);
      }
      return out;
    },

    async close() {},
  };
}
