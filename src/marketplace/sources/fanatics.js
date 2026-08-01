// Fanatics Collect (formerly PWCC) — weekly/premier auctions plus a
// fixed-price vault marketplace. Live testing showed their GraphQL schema
// has drifted from the public captures (the collectAlgoliaSearch input type
// was renamed), so the primary path is now their Algolia backend directly:
// GraphQL `{ collectSearchKey }` mints a short-lived search key, then the
// prod_item_state_v1 index answers keyword queries with live listings. The
// old GraphQL search chain remains as a fallback for other deployments.
// Verify locally with `npm run test-source fanatics "jordan psa 10"`.

import { fetchWithTimeout, centsToDollars, toNumber, toIsoDate, saveDebug, debugLog } from './util.js';

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

// Real listing URLs are /<segment>/<listingUuid>/<slug>, one segment per
// marketplace (all three verified live 2026-07-30 by fetching constructed
// URLs and checking the page actually carries the card title — the site
// returns 200 for ANY path, so a status check alone proves nothing):
//   WEEKLY  -> /weekly/…   PREMIER -> /premier/…   FIXED -> /buy-now/…
// (/listing/, /fixed/ and /marketplace/ variants are wrong: 404 or a
// redirect to the generic marketplace page.) Routing is by uuid — the slug
// is cosmetic — but match the site's shape anyway.
const MARKETPLACE_SEGMENT = { WEEKLY: 'weekly', PREMIER: 'premier', FIXED: 'buy-now', BUY_NOW: 'buy-now' };

// Fanatics' slugs collapse each non-alphanumeric run to one dash:
// "… Kobe Bryant #1HV SGC 9 MINT" -> "…-kobe-bryant-1hv-sgc-9-mint".
export const fanaticsSlug = (title) =>
  String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function buildFanaticsUrl(node) {
  // A URL the payload hands us verbatim always wins.
  const direct =
    node.url ?? node.webUrl ?? node.permalink ?? node.canonicalUrl ?? node.href ?? node.path ?? null;
  if (typeof direct === 'string' && direct.trim()) {
    try {
      return new URL(direct, SITE).href;
    } catch {
      /* fall through */
    }
  }
  const uuid = node.listingUuid ?? node.uuid ?? node.id ?? null;
  const segment = MARKETPLACE_SEGMENT[String(node.marketplace ?? node.listingType ?? '').toUpperCase()];
  const title = node.title ?? node.name ?? '';
  if (uuid && segment) {
    return `${SITE}/${segment}/${uuid}/${node.slug ?? fanaticsSlug(title)}`;
  }
  // Unknown marketplace value (schema drift): a search link that resolves
  // beats a guessed deep link that 404s.
  return `${SITE}/search?query=${encodeURIComponent(String(title).slice(0, 120))}`;
}

// Shared normalizer: this adapter's field is epoch seconds today, but the
// same "looks numeric, is actually ISO" trap that emptied every Goldin end
// time applies here the moment Fanatics changes shape.
const epochToIso = toIsoDate;

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
  // Live index fields (2026-07-30): auctions carry currentBid/currentPrice in
  // DOLLARS, with startingBid as the no-bids-yet floor — a 0 current bid must
  // fall through to it instead of showing "$0".
  const dollarKeys = isAuction
    ? ['currentBid', 'currentPrice', 'highestBid', 'startingBid', 'startingPrice', 'lowestPrice', 'price']
    : ['buyNowPrice', 'askingPrice', 'currentPrice', 'lowestPrice', 'price'];
  // Same 0-falls-through rule as the dollar loop below: a 0 current bid is
  // provisional, and breaking on it would skip startingPriceInCents — the
  // exact "$0 auction" the comment below exists to prevent.
  let price = null;
  for (const k of centsKeys) {
    const v = hit[k] != null ? centsToDollars(toNumber(hit[k])) : null;
    if (v != null && v > 0) { price = v; break; }
    if (v != null && price == null) price = v;
  }
  if (price == null || price === 0) {
    for (const k of dollarKeys) {
      const v = toNumber(hit[k]);
      if (v != null && v > 0) { price = v; break; }
      if (v != null && price == null) price = v; // keep a real 0 only if nothing beats it
    }
  }

  return {
    listingId: String(id),
    canonicalKey: `fanatics:${id}`,
    title: String(title),
    url: buildFanaticsUrl(hit),
    price,
    currency: hit.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    // auctionEndDatetime (epoch seconds) is the field the live index actually
    // populates; the others are kept for schema drift.
    endsAt: isAuction
      ? epochToIso(hit.auctionEndDatetime ?? hit.auctionEndsAt ?? hit.endsAt ?? hit.endTime ?? hit.auction?.endsAt) ?? null
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
  // Same auction test as the primary Algolia path — an exact-match pair of
  // strings meant a differently-cased or plainly 'AUCTION' listingType was
  // stored as fixed here, which forces a null end date and exempts the row
  // from every end-date behavior.
  const isAuction = AUCTION_RE.test(String(node.listingType ?? node.marketplace ?? ''));
  const money = isAuction
    ? node.currentBid ?? node.startingPrice
    : node.buyNowPrice ?? node.askingPrice;
  return {
    listingId: String(node.id),
    canonicalKey: `fanatics:${node.id}`,
    title: [node.title, node.subtitle].filter(Boolean).join(' '),
    url: buildFanaticsUrl(node),
    price: centsToDollars(money?.amountInCents),
    currency: money?.currency ?? 'USD',
    listingType: isAuction ? 'auction' : 'fixed',
    // Normalized like the primary path: this fallback used to hand the raw
    // value straight through, so an epoch (or a zone-less string) would be
    // mis-stored — the exact "looks numeric, is actually ISO" trap that
    // emptied every Goldin end time.
    endsAt: isAuction
      ? toIsoDate(node.auction?.endsAt ?? node.auction?.endTime ?? node.endsAt)
      : null,
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
