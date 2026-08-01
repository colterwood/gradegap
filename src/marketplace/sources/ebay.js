// eBay Browse API source — the one adapter with an official API, and the
// bulk of live slab inventory worldwide. One search() fans out across the
// configured marketplaces (EBAY_US, EBAY_CA, EBAY_GB, …) and dedupes by the
// item's legacy id, so the same listing surfacing on several sites comes
// back once. Auth is client-credentials OAuth; the ~2h token is cached in
// memory and in source_state so restarts don't re-mint.

import { config } from '../../config.js';
import { fetchWithTimeout } from './util.js';

const HOSTS = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
};

export function createEbaySource() {
  const host = HOSTS[config.ebayEnv] ?? HOSTS.production;
  let q = null;
  let token = null;
  let tokenExpMs = 0;
  let minting = null; // single-flight: parallel 401s must not mint 6 tokens

  function loadCachedToken() {
    const row = q?.getSourceState.get('ebay');
    if (!row?.auth_json) return;
    try {
      const auth = JSON.parse(row.auth_json);
      if (auth.token && auth.expMs > Date.now() + 60_000) {
        token = auth.token;
        tokenExpMs = auth.expMs;
      }
    } catch {
      // stale/corrupt cache — just re-mint
    }
  }

  async function ensureToken(force = false) {
    if (!force && token && tokenExpMs > Date.now() + 60_000) return token;
    minting ??= (async () => {
      const res = await fetchWithTimeout(`${host}/identity/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' + Buffer.from(`${config.ebayClientId}:${config.ebayClientSecret}`).toString('base64'),
        },
        body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        throw new Error(`eBay OAuth failed (HTTP ${res.status}) — check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET`);
      }
      const body = await res.json();
      token = body.access_token;
      tokenExpMs = Date.now() + (body.expires_in ?? 7200) * 1000;
      q?.setSourceAuth.run(JSON.stringify({ token, expMs: tokenExpMs }), 'ebay');
      return token;
    })().finally(() => { minting = null; });
    return minting;
  }

  async function searchMarketplace(text, marketplace) {
    const params = new URLSearchParams({ q: text, limit: '50' });
    // 212 = Sports Trading Card Singles on the US/CA category trees. Other
    // marketplaces use different trees, so there the match layer alone
    // provides the precision.
    if (marketplace === 'EBAY_US' || marketplace === 'EBAY_CA') params.set('category_ids', '212');

    // fetchWithTimeout, not bare fetch: a hung connection must fail in 15s
    // like every other source, not burn the runner's whole 90s item budget.
    const doFetch = () =>
      fetchWithTimeout(`${host}/buy/browse/v1/item_summary/search?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplace,
        },
        timeoutMs: 15_000,
      });

    let res = await doFetch();
    if (res.status === 401) {
      await ensureToken(true); // token expired mid-run — re-mint and retry once
      res = await doFetch();
    }
    if (res.status === 429) {
      throw Object.assign(new Error('eBay rate limit hit (HTTP 429)'), { rateLimited: true });
    }
    if (!res.ok) {
      throw new Error(`eBay search failed on ${marketplace} (HTTP ${res.status})`);
    }
    return (await res.json()).itemSummaries ?? [];
  }

  return {
    name: 'ebay',
    needsBrowser: false,
    minIntervalMs: 1200,

    // Non-null = this source can't run yet, and why. Checked before a run
    // queues any work, so missing setup reads as "skipped: <reason>" instead
    // of every watch failing.
    configured() {
      if (!config.ebayClientId || !config.ebayClientSecret) {
        return 'set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET in .env (free developer keyset — see the Configuration reference in README, and run `npm run doctor` to check your .env)';
      }
      return null;
    },

    async start(ctx = {}) {
      q = ctx.q ?? null;
      if (!config.ebayClientId || !config.ebayClientSecret) {
        throw new Error('eBay credentials missing — set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (see README Configuration reference)');
      }
      loadCachedToken();
      await ensureToken();
    },

    async search({ text }) {
      // All marketplaces AT ONCE: parallel fan-out changes burst, not daily
      // API call counts, and drops the per-item cost from ~6 serial round
      // trips plus sleeps to one slow round trip. Results keep marketplace
      // order, so dedupe still prefers the earlier-listed marketplace.
      const perMarket = await Promise.all(
        config.ebayMarketplaces.map((m) => searchMarketplace(text, m))
      );
      const out = new Map();
      for (const items of perMarket) {
        for (const item of items) {
          // itemId is "v1|<legacyId>|<variation>"; the legacy id is stable
          // across marketplaces and is our cross-marketplace/-source dedupe key.
          const legacy = item.legacyItemId ?? item.itemId?.split('|')[1] ?? null;
          const key = legacy ?? item.itemId;
          if (!key || out.has(key)) continue;
          const priceObj = item.currentBidPrice ?? item.price ?? null;
          out.set(key, {
            listingId: String(key),
            canonicalKey: legacy ? `ebay:${legacy}` : null,
            title: item.title ?? '',
            url: item.itemWebUrl ?? null,
            price: priceObj ? Number(priceObj.value) : null,
            currency: priceObj?.currency ?? 'USD',
            listingType: (item.buyingOptions ?? []).includes('AUCTION') ? 'auction' : 'fixed',
            endsAt: item.itemEndDate ?? null,
            imageUrl: item.image?.imageUrl ?? null,
            seller: item.seller?.username ?? null,
          });
        }
      }
      return [...out.values()];
    },

    async close() {},
  };
}
