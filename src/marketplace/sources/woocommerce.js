// Generic WooCommerce-shop source — the WordPress counterpart to the
// Shopify adapter. Every WooCommerce store exposes a public Store API
// (/wp-json/wc/store/v1/products?search=…) with no auth, so this is clean
// JSON rather than scraping. Configured by domain, defaulting to Galaxy
// Auctions (Surrey BC, CAD).
//
// Prices arrive in MINOR units with the divisor alongside them
// ("12500" + currency_minor_unit 2 = $125.00).

import { config } from '../../config.js';
import { fetchWithTimeout, fetchHtml, decodeEntities, debugLog, saveDebug, toNumber, absUrl } from './util.js';

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

// Fallback for shops without the Store API: WordPress product search is
// server-rendered, and Woo themes emit product links + a woocommerce-Price
// amount per card.
export function parseWooHtml(html, { domain, currency }) {
  const out = new Map();
  const re = /<a[^>]+href=["'](https?:\/\/[^"']*\/product\/([^"'/?#]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const [, url, slug, inner] = m;
    const title = decodeEntities(inner.replace(/<[^>]+>/g, ' '));
    if (!title || title.length < 8 || out.has(slug)) continue;
    const tail = html.slice(m.index, m.index + 1500);
    const priceText = tail.match(/woocommerce-Price-amount[^>]*>[\s\S]{0,80}?([\d.,]+)/i)?.[1]
      ?? tail.match(/[$C]\s?([\d,]+(?:\.\d{2})?)/)?.[1];
    out.set(slug, {
      listingId: `${domain}:${slug}`,
      canonicalKey: null,
      title,
      url: absUrl(url, `https://${domain}`),
      price: toNumber(priceText),
      currency,
      listingType: 'fixed',
      endsAt: null,
      imageUrl: tail.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null,
      seller: domain,
    });
  }
  return [...out.values()];
}

export async function searchWooShop({ domain, currency = 'CAD' }, text) {
  const params = new URLSearchParams({ search: text, per_page: '20' });
  const res = await fetchWithTimeout(`https://${domain}/wp-json/wc/store/v1/products?${params}`, {
    headers: { accept: 'application/json' },
    timeoutMs: 15_000,
  });
  if (res.status === 429) throw Object.assign(new Error(`${domain} rate limited (429)`), { rateLimited: true });

  if (res.ok) {
    const body = await res.json().catch(() => null);
    const products = Array.isArray(body) ? body : [];
    const mapped = parseWooProducts(products, { domain, currency });
    debugLog('woocommerce', `${domain} Store API → HTTP ${res.status}, ${products.length} products, ${mapped.length} mapped`);
    if (mapped.length > 0) return mapped;
  } else {
    debugLog('woocommerce', `${domain} Store API → HTTP ${res.status}; falling back to product search page`);
  }

  // Store API missing/empty — try the storefront's own search.
  const html = await fetchHtml(`https://${domain}/?s=${encodeURIComponent(text)}&post_type=product`);
  const fromHtml = parseWooHtml(html, { domain, currency });
  debugLog('woocommerce', `${domain} HTML search → ${fromHtml.length} products (${html.length}b)`);
  if (fromHtml.length === 0) saveDebug('woocommerce', domain.replace(/\W+/g, '-'), html, 'html');
  return fromHtml;
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
