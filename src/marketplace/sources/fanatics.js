// Fanatics Collect (formerly PWCC) — weekly/premier auctions plus a
// fixed-price vault marketplace. Live testing showed their GraphQL schema
// has drifted from the public captures (the collectAlgoliaSearch input type
// was renamed), so the primary path is now their Algolia backend directly:
// GraphQL `{ collectSearchKey }` mints a short-lived search key, then the
// prod_item_state_v1 index answers keyword queries with live listings. The
// old GraphQL search chain remains as a fallback for other deployments.
// Verify locally with `npm run test-source fanatics "jordan psa 10"`.

import { fetchWithTimeout, centsToDollars, toNumber, saveDebug, debugLog } from './util.js';

const GRAPHQL_URL = 'https://app.fanaticscollect.com/graphql';
const SITE = 'https://www.fanaticscollect.com';
const ALGOLIA_APP = '3XT9C4X62I';
const ALGOLIA_URL = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;
const ALGOLIA_INDEX = 'prod_item_state_v1';

const HEADERS = {
  'content-type': 'application/json',
  origin: SITE,
  referer: `${SITE}/`,
  'x-platform': 'WEB',
};

async function gql(query, variables = {}) {
  const res = await fetchWithTimeout(GRAPHQL_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
    timeoutMs: 15_000,
  });
  if (res.status === 429) throw Object.assign(new Error('Fanatics rate limited (429)'), { rateLimited: true });
  if (!res.ok) throw new Error(`Fanatics GraphQL HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Fanatics GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
  return body.data;
}

// --- Algolia path (primary) ------------------------------------------------

const AUCTION_RE = /WEEKLY|PREMIER|AUCTION/i;

const epochToIso = (v) => {
  const n = toNumber(v);
  if (n == null) return typeof v === 'string' ? v : null;
  if (n > 1e12) return new Date(n).toISOString();
  if (n > 1e9) return new Date(n * 1000).toISOString();
  return null;
};

// Pure, fixture-testable: one Algolia hit → normalized listing (tolerant of
// field-name drift: ids, money-in-cents vs dollars, epoch vs ISO end times).
export function parseFanaticsAlgoliaHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const id = hit.listingUuid ?? hit.listingId ?? hit.uuid ?? hit.objectID ?? hit.id;
  const title = hit.title ?? hit.name ?? hit.listingTitle ?? null;
  if (!id || !title) return null;

  const type = String(hit.marketplace ?? hit.listingType ?? hit.type ?? '');
  const isAuction = AUCTION_RE.test(type);

  const centsKeys = isAuction
    ? ['currentBidAmountInCents', 'highestBidAmountInCents', 'startingPriceInCents', 'lowestPriceInCents', 'priceInCents']
    : ['buyNowPriceInCents', 'askingPriceInCents', 'lowestPriceInCents', 'priceInCents'];
  const dollarKeys = isAuction
    ? ['currentBid', 'highestBid', 'startingPrice', 'lowestPrice', 'price']
    : ['buyNowPrice', 'askingPrice', 'lowestPrice', 'price'];
  let price = null;
  for (const k of centsKeys) {
    if (hit[k] != null) { price = centsToDollars(toNumber(hit[k])); break; }
  }
  if (price == null) {
    for (const k of dollarKeys) {
      const v = toNumber(hit[k]);
      if (v != null) { price = v; break; }
    }
  }

  return {
    listingId: String(id),
    canonicalKey: `fanatics:${id}`,
    title: String(title),
    url: `${SITE}/listing/${hit.slug ?? id}`,
    price,
    currency: hit.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    endsAt: isAuction
      ? epochToIso(hit.auctionEndsAt ?? hit.endsAt ?? hit.endTime ?? hit.auction?.endsAt) ?? null
      : null,
    imageUrl: hit.images?.primary?.small ?? hit.imageUrl ?? (typeof hit.image === 'string' ? hit.image : null),
    seller: null, // consignment model — no per-lot seller
  };
}

async function algoliaSearch(searchKey, text) {
  const res = await fetchWithTimeout(
    `${ALGOLIA_URL}?x-algolia-application-id=${ALGOLIA_APP}&x-algolia-api-key=${encodeURIComponent(searchKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, referer: `${SITE}/` },
      body: JSON.stringify({
        requests: [{ indexName: ALGOLIA_INDEX, query: text, hitsPerPage: 50, page: 0, filters: 'status:Live' }],
      }),
      timeoutMs: 15_000,
    }
  );
  if (res.status === 429) throw Object.assign(new Error('Fanatics/Algolia rate limited (429)'), { rateLimited: true });
  if (!res.ok) throw new Error(`Fanatics Algolia HTTP ${res.status}`);
  const body = await res.json();
  return body.results?.[0]?.hits ?? [];
}

// --- legacy GraphQL path (fallback) ----------------------------------------

const LEGACY_SEARCH_QUERY = `
  query watchSearch($requests: [CollectAlgoliaRequest!]!) {
    collectAlgoliaSearch(requests: $requests) {
      hits { listingUuid }
    }
  }
`;

const LISTINGS_QUERY = `
  query watchListings($listingIds: [CollectListingIdInput]!) {
    collectListings(listingIds: $listingIds) {
      id
      title
      subtitle
      slug
      listingType
      status
      imageSets { small medium }
      currentBid { amountInCents currency }
      startingPrice { amountInCents currency }
      buyNowPrice { amountInCents currency }
      askingPrice { amountInCents currency }
      auction { endsAt status }
    }
  }
`;

// Pure, fixture-testable: one hydrated GraphQL listing → normalized listing.
export function parseFanaticsListing(node) {
  if (!node?.id || !node.title) return null;
  const isAuction = node.listingType === 'WEEKLY' || node.listingType === 'PREMIER';
  const money = isAuction
    ? node.currentBid ?? node.startingPrice
    : node.buyNowPrice ?? node.askingPrice;
  return {
    listingId: String(node.id),
    canonicalKey: `fanatics:${node.id}`,
    title: [node.title, node.subtitle].filter(Boolean).join(' '),
    url: `${SITE}/listing/${node.slug ?? node.id}`,
    price: centsToDollars(money?.amountInCents),
    currency: money?.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    endsAt: isAuction ? node.auction?.endsAt ?? null : null,
    imageUrl: node.imageSets?.[0]?.medium ?? node.imageSets?.[0]?.small ?? null,
    seller: null,
  };
}

export function createFanaticsSource() {
  let searchKey = null;
  let searchKeyAt = 0;

  async function ensureSearchKey() {
    // Keys are short-lived (~15 min per public docs); refresh at 10.
    if (searchKey && Date.now() - searchKeyAt < 10 * 60 * 1000) return searchKey;
    const data = await gql('query watchSearchKey { collectSearchKey }');
    const key = data?.collectSearchKey;
    if (typeof key !== 'string' || !key) throw new Error('Fanatics: collectSearchKey returned nothing');
    searchKey = key;
    searchKeyAt = Date.now();
    return key;
  }

  async function legacySearch(text) {
    const data = await gql(LEGACY_SEARCH_QUERY, {
      requests: [{ indexName: 'LISTING_LOWEST_PRICE', query: text }],
    });
    const uuids = (data?.collectAlgoliaSearch ?? [])
      .flatMap((r) => r?.hits ?? [])
      .map((h) => h?.listingUuid)
      .filter(Boolean)
      .slice(0, 50);
    if (uuids.length === 0) return [];
    const hydrated = await gql(LISTINGS_QUERY, { listingIds: uuids.map((id) => ({ id })) });
    return (hydrated?.collectListings ?? []).map(parseFanaticsListing).filter(Boolean);
  }

  return {
    name: 'fanatics',
    needsBrowser: false,
    minIntervalMs: 3000,

    async start() {},

    async search({ text }) {
      let primaryErr;
      try {
        const key = await ensureSearchKey();
        const hits = await algoliaSearch(key, text);
        saveDebug('fanatics', 'algolia-hits', JSON.stringify(hits.slice(0, 3), null, 2), 'json');
        const out = hits.map(parseFanaticsAlgoliaHit).filter(Boolean);
        debugLog('fanatics', `algolia returned ${hits.length} hits, ${out.length} parseable`);
        if (out.length > 0 || hits.length === 0) return out;
        primaryErr = new Error('Fanatics: Algolia hits had no recognizable fields (see --debug capture)');
      } catch (err) {
        if (err.rateLimited) throw err;
        primaryErr = err;
        debugLog('fanatics', `algolia path failed (${err.message}), trying legacy GraphQL`);
      }
      try {
        return await legacySearch(text);
      } catch (legacyErr) {
        if (legacyErr.rateLimited) throw legacyErr;
        throw new Error(`Fanatics search failed — primary: ${primaryErr?.message}; legacy: ${legacyErr.message}`);
      }
    },

    async close() {},
  };
}
