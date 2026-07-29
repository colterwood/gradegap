// Goldin (goldin.co) — weekly + premier auctions. Goldin fronts its Algolia
// search with its own backend API whose hostnames rotate with each frontend
// deploy, so the adapter discovers them at runtime from the site's JS bundle
// (the same way the public clients do) and caches them in source_state for a
// day. EXPERIMENTAL: shapes come from public client code, not a live capture
// — verify locally with `npm run test-source goldin "jordan psa 10"`.

import { fetchWithTimeout, fetchHtml, toNumber } from './util.js';

const SITE = 'https://goldin.co';

// Endpoint discovery: the buy page links a hashed client bundle whose source
// embeds an API url map ({... auctions: "https://...", lots_v2: "https://..."})
// and the image CDN base.
export function extractGoldinConfig(bundleJs) {
  const grab = (re) => bundleJs.match(re)?.[1] ?? null;
  return {
    auctionsUrl: grab(/["']?auctions["']?\s*:\s*["'](https:[^"']+)["']/),
    lotsUrl: grab(/["']?lots_v2["']?\s*:\s*["'](https:[^"']+)["']/),
    cloudFront: grab(/cloudFrontURL\s*:\s*["'](https:[^"']+)["']/),
  };
}

// Pure, fixture-testable: the lots response → normalized raw listings.
export function parseGoldinLots(body, cloudFront) {
  const lots = body?.searchalgolia?.lots ?? body?.lots ?? [];
  const out = [];
  for (const lot of lots) {
    const id = lot.lot_id ?? lot.id;
    if (id == null || !lot.title) continue;
    const slug = lot.slug ?? lot.url_slug ?? lot.item_slug ?? null;
    let imageUrl = lot.primary_image_name ?? null;
    if (imageUrl && !/^https?:/.test(imageUrl) && cloudFront) {
      imageUrl = `${cloudFront.replace(/\/+$/, '')}/public/Lots/${id}/${imageUrl}`;
    }
    out.push({
      listingId: String(id),
      canonicalKey: `goldin:${id}`,
      title: lot.title,
      url: slug ? `${SITE}/item/${slug}` : `${SITE}/buy?search=${encodeURIComponent(lot.title)}`,
      price: toNumber(lot.current_price ?? lot.min_bid_price),
      currency: 'USD',
      listingType: 'auction',
      endsAt: lot.end_time ?? lot.ends_at ?? lot.auction_end_time ?? null,
      imageUrl,
      seller: null,
    });
  }
  return out;
}

export function createGoldinSource() {
  let q = null;
  let cfg = null;
  let auctionIds = null;

  async function discover(force = false) {
    if (!force) {
      const cached = q?.getSourceState.get('goldin')?.auth_json;
      if (cached) {
        try {
          const saved = JSON.parse(cached);
          if (saved.cfg?.lotsUrl && Date.now() - saved.at < 24 * 60 * 60 * 1000) {
            cfg = saved.cfg;
            return;
          }
        } catch { /* re-discover */ }
      }
    }
    const html = await fetchHtml(`${SITE}/buy/`);
    const bundlePath = html.match(/<script[^>]+src=["']([^"']*client\.[a-z0-9]+\.js)["']/i)?.[1];
    if (!bundlePath) throw new Error('Goldin: could not find client bundle in /buy/ — site layout changed');
    const bundleJs = await fetchHtml(new URL(bundlePath, SITE).href);
    cfg = extractGoldinConfig(bundleJs);
    if (!cfg.lotsUrl) throw new Error('Goldin: could not extract lots API url from bundle — adapter needs updating');
    q?.ensureSourceState.run('goldin');
    q?.setSourceAuth.run(JSON.stringify({ cfg, at: Date.now() }), 'goldin');
  }

  async function post(url, body) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, referer: `${SITE}/` },
      body: JSON.stringify(body),
    });
    if (res.status === 429) throw Object.assign(new Error('Goldin rate limited (429)'), { rateLimited: true });
    if (!res.ok) throw new Error(`Goldin HTTP ${res.status}: ${url}`);
    return res.json();
  }

  return {
    name: 'goldin',
    needsBrowser: false,
    minIntervalMs: 4000,

    async start(ctx = {}) {
      q = ctx.q ?? null;
      await discover();
      const auctions = await post(cfg.auctionsUrl ?? cfg.lotsUrl, { status: 'Active', order: 'asc' }).catch(() => null);
      auctionIds = (auctions?.auctions ?? []).map((a) => a.auction_id).filter((x) => x != null);
    },

    async search({ text }) {
      const body = {
        search: {
          queryType: 'Featured',
          query: text,
          size: 48,
          from: 0,
          ...(auctionIds?.length ? { auction_id: auctionIds } : {}),
        },
      };
      try {
        return parseGoldinLots(await post(cfg.lotsUrl, body), cfg.cloudFront);
      } catch (err) {
        if (err.rateLimited) throw err;
        // A stale cached endpoint (frontend redeployed) is the common failure:
        // re-discover once and retry.
        await discover(true);
        return parseGoldinLots(await post(cfg.lotsUrl, body), cfg.cloudFront);
      }
    },

    async close() {},
  };
}
