// Marketplace source factory, mirroring src/scraper/source.js: adapters are
// imported lazily so an unused source's dependencies are never loaded, and
// mock mode swaps in the fixture-backed source so `npm run mock` (and tests)
// exercise the whole watch path without credentials.
//
// A source adapter is a small object:
//   { name, needsBrowser, minIntervalMs,
//     async start({ q }), async search({ text }) -> raw listings, async close() }
// where a raw listing is { listingId, canonicalKey?, title, url, price,
// currency, listingType: 'auction'|'fixed', endsAt, imageUrl, seller }.
// Matching/scoring happens OUTSIDE adapters (match.js) so every source is
// judged identically.

import { config } from '../../config.js';

// Exported for scripts/testSource.js, which lets you exercise any single
// adapter from the CLI regardless of WATCH_SOURCES.
export const REGISTRY = {
  ebay: async () => (await import('./ebay.js')).createEbaySource(),
  shopify: async () => (await import('./shopify.js')).createShopifySource(),
  fanatics: async () => (await import('./fanatics.js')).createFanaticsSource(),
  goldin: async () => (await import('./goldin.js')).createGoldinSource(),
  pristine: async () => (await import('./pristine.js')).createPristineSource(),
};

export async function createMarketplaceSources() {
  if (config.mock) {
    const { createMockMarketSource } = await import('./mockMarket.js');
    return [createMockMarketSource()];
  }
  const sources = [];
  for (const name of config.watchSources) {
    const make = REGISTRY[name];
    if (!make) throw new Error(`unknown watch source "${name}" — valid: ${Object.keys(REGISTRY).join(', ')}`);
    sources.push(await make());
  }
  return sources;
}
