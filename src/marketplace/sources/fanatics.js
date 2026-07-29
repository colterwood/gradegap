// Fanatics Collect (formerly PWCC) — weekly/premier auctions plus a
// fixed-price vault marketplace. Their GraphQL API at app.fanaticscollect.com
// answers search queries anonymously (no login): a text search returns
// listing UUIDs, a second query hydrates them. Money is integer cents.
//
// Endpoint shape reconstructed from several independent public clients;
// verify locally with `npm run test-source fanatics "jordan psa 10"`.

import { fetchWithTimeout, centsToDollars } from './util.js';

const GRAPHQL_URL = 'https://app.fanaticscollect.com/graphql';
const SITE = 'https://www.fanaticscollect.com';

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
  });
  if (res.status === 429) throw Object.assign(new Error('Fanatics rate limited (429)'), { rateLimited: true });
  if (!res.ok) throw new Error(`Fanatics GraphQL HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Fanatics GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
  return body.data;
}

const SEARCH_QUERY = `
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

// Pure, fixture-testable: one GraphQL listing node → normalized raw listing
// (or null when the node is unusable/ended).
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
    seller: null, // consignment model — no per-lot seller
  };
}

export function createFanaticsSource() {
  return {
    name: 'fanatics',
    needsBrowser: false,
    minIntervalMs: 3000,

    async start() {},

    async search({ text }) {
      const data = await gql(SEARCH_QUERY, {
        requests: [{ indexName: 'LISTING_LOWEST_PRICE', query: text }],
      });
      const uuids = (data?.collectAlgoliaSearch ?? [])
        .flatMap((r) => r?.hits ?? [])
        .map((h) => h?.listingUuid)
        .filter(Boolean)
        .slice(0, 50);
      if (uuids.length === 0) return [];

      const hydrated = await gql(LISTINGS_QUERY, {
        listingIds: uuids.map((id) => ({ id })),
      });
      return (hydrated?.collectListings ?? []).map(parseFanaticsListing).filter(Boolean);
    },

    async close() {},
  };
}
