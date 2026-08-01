// Generic WooCommerce-shop source — the WordPress counterpart to the
// Shopify adapter. Every WooCommerce store exposes a public Store API
// (/wp-json/wc/store/v1/products?search=…) with no auth, so this is clean
// JSON rather than scraping. Configured by domain, defaulting to Galaxy
// Auctions (Surrey BC, CAD).
//
// Prices arrive in MINOR units with the divisor alongside them
// ("12500" + currency_minor_unit 2 = $125.00).

import { config } from '../../config.js';
import {
  fetchWithTimeout, fetchHtml, decodeEntities, debugLog, saveDebug, toNumber, absUrl,
  parseShopList, sleep,
} from './util.js';

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
  // WooCommerce themes render a "no products matched" notice and then often
  // show unrelated recommendations — don't mistake those for results.
  if (/no products (?:were )?found|nothing matched your search/i.test(html)) return [];
  const re = /<a[^>]+href=["'](https?:\/\/[^"']*\/product\/([^"'/?#]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const [, url, slug, inner] = m;
    const title = decodeEntities(inner.replace(/<[^>]+>/g, ' '));
    if (!title || title.length < 8 || out.has(slug)) continue;
    const tail = html.slice(m.index, m.index + 1500);
    // Only accept a price from Woo's own price markup — a loose "$n" scan
    // happily matches sidebar filters and shipping banners.
    const priceText = tail.match(
      /woocommerce-Price-amount[\s\S]{0,200}?<bdi>[\s\S]{0,60}?([\d][\d,]*(?:\.\d{2})?)/i
    )?.[1];
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
  // Budget WordPress hosts stall well past 15s under load (galaxy-auctions
  // answered in 3s one minute and timed out the next, live-observed), so:
  // a generous window, and one retry when the first attempt times out.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetchWithTimeout(`https://${domain}/wp-json/wc/store/v1/products?${params}`, {
        headers: { accept: 'application/json' },
        timeoutMs: 25_000,
      });
      break;
    } catch (err) {
      if (err.timedOut && attempt === 1) {
        debugLog('woocommerce', `${domain} attempt 1 timed out — retrying once`);
        continue;
      }
      throw err;
    }
  }
  if (res.status === 429) throw Object.assign(new Error(`${domain} rate limited (429)`), { rateLimited: true });

  if (res.ok) {
    // The Store API is authoritative when it answers — including an empty
    // result, which means "this shop has nothing matching", NOT "broken".
    // (Falling back on empty scraped the storefront's "no results, here's
    // our catalog" grid and returned dozens of unrelated cards.) But a 200
    // whose body ISN'T a JSON array is not the API answering — caching
    // plugins and maintenance pages serve 200 HTML on /wp-json routes — so
    // that falls through to the HTML search instead of counting as empty.
    const body = await res.json().catch(() => null);
    if (Array.isArray(body)) {
      const mapped = parseWooProducts(body, { domain, currency });
      debugLog('woocommerce', `${domain} Store API → HTTP ${res.status}, ${body.length} products, ${mapped.length} mapped`);
      return mapped;
    }
    debugLog('woocommerce', `${domain} Store API → HTTP 200 but non-array body; falling back to product search page`);
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
  const shops = parseShopList(config.wooShops);

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
