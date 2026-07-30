// Generic WooCommerce-shop source — the WordPress counterpart to the
// Shopify adapter. Every WooCommerce store exposes a public Store API
// (/wp-json/wc/store/v1/products?search=…) with no auth, so this is clean
// JSON rather than scraping. Configured by domain, defaulting to Galaxy
// Auctions (Surrey BC, CAD).
//
// Prices arrive in MINOR units with the divisor alongside them
// ("12500" + currency_minor_unit 2 = $125.00).

import { config } from '../../config.js';
import { fetchWithTimeout, decodeEntities, debugLog } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure, fixture-testable: Store API products → normalized raw listings.
export function parseWooProducts(products, { domain, currency }) {
  const out = [];
  for (const p of products ?? []) {
    if (p?.id == null || !p.name) continue;
    const minor = p.prices?.currency_minor_unit ?? 2;
    const raw = p.prices?.price ?? p.prices?.regular_price ?? null;
    const price = raw == null || raw === '' ? null : Number(raw) / 10 ** minor;
    out.push({
      listingId: `${domain}:${p.id}`,
      canonicalKey: null,
      title: decodeEntities(p.name),
      url: p.permalink ?? null,
      price: Number.isFinite(price) ? price : null,
      currency: p.prices?.currency_code ?? currency,
      listingType: 'fixed',
      endsAt: null,
      imageUrl: p.images?.[0]?.src ?? null,
      seller: domain,
    });
  }
  return out;
}

export async function searchWooShop({ domain, currency = 'CAD' }, text) {
  const params = new URLSearchParams({ search: text, per_page: '20' });
  const res = await fetchWithTimeout(`https://${domain}/wp-json/wc/store/v1/products?${params}`, {
    headers: { accept: 'application/json' },
    timeoutMs: 15_000,
  });
  if (res.status === 429) throw Object.assign(new Error(`${domain} rate limited (429)`), { rateLimited: true });
  if (!res.ok) throw new Error(`${domain} Store API HTTP ${res.status} (not a public WooCommerce store?)`);
  return parseWooProducts(await res.json(), { domain, currency });
}

export function createWooSource() {
  const shops = config.wooShops.map((entry) => {
    const [domain, cur] = entry.split(':');
    return {
      domain: domain.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      currency: (cur || 'CAD').toUpperCase(),
    };
  });

  return {
    name: 'woocommerce',
    needsBrowser: false,
    minIntervalMs: 2000,

    configured() {
      return shops.length === 0 ? 'set WOO_SHOPS in .env (comma-separated WooCommerce shop domains)' : null;
    },

    async start() {},

    async search({ text }) {
      const out = [];
      const errors = [];
      for (const shop of shops) {
        try {
          out.push(...(await searchWooShop(shop, text)));
        } catch (err) {
          if (err.rateLimited) throw err;
          errors.push(`${shop.domain}: ${err.message}`);
        }
        if (shops.length > 1) await sleep(400);
      }
      // One shop down must not sink the rest; all down is a real failure.
      if (errors.length && errors.length === shops.length) throw new Error(errors.join(' · '));
      if (errors.length) debugLog('woocommerce', `partial: ${errors.join(' · ')}`);
      return out;
    },

    async close() {},
  };
}
