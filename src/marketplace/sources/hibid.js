// HiBid Canada (canada.hibid.com) — aggregator over dozens of Canadian
// auction houses. All lot data comes from a GraphQL endpoint; Cloudflare
// wants a browser-grade client, so the adapter opens the Canada portal in
// the shared browser once and POSTs the captured LotSearch operation from
// inside the page (same-origin — CF cookies ride along automatically).
// Lots are CAD or USD per auction house (currencyAbbreviation).
// Verify locally with `npm run test-source hibid "psa 10 jordan"`.

import { acquireBrowser } from '../../scraper/browserLease.js';

const SITE = 'https://canada.hibid.com';

// Captured verbatim from HiBid's frontend (public client interceptions);
// countAsView:false keeps our polling out of their view counters.
const LOT_SEARCH_QUERY = `query LotSearch($auctionId: Int = null, $pageNumber: Int!, $pageLength: Int!, $category: CategoryId = null, $searchText: String = null, $zip: String = null, $miles: Int = null, $shippingOffered: Boolean = false, $countryName: String = null, $state: String = null, $status: AuctionLotStatus = null, $sortOrder: EventItemSortOrder = null, $filter: AuctionLotFilter = null, $isArchive: Boolean = false, $dateStart: DateTime, $dateEnd: DateTime, $countAsView: Boolean = true, $hideGoogle: Boolean = false) {
  lotSearch(
    input: {auctionId: $auctionId, category: $category, searchText: $searchText, zip: $zip, miles: $miles, shippingOffered: $shippingOffered, countryName: $countryName, state: $state, status: $status, sortOrder: $sortOrder, filter: $filter, isArchive: $isArchive, dateStart: $dateStart, dateEnd: $dateEnd, countAsView: $countAsView, hideGoogle: $hideGoogle}
    pageNumber: $pageNumber
    pageLength: $pageLength
    sortDirection: DESC
  ) {
    pagedResults {
      totalCount
      results {
        id
        itemId
        lead
        lotNumber
        featuredPicture { thumbnailLocation fullSizeLocation }
        lotState { bidCount highBid buyNow minBid isClosed isLive status timeLeft timeLeftSeconds }
        auction { id eventName bidCloseDateTime eventCity eventState currencyAbbreviation auctioneer { name } }
      }
    }
  }
}`;

// Pure, fixture-testable: GraphQL results → normalized raw listings.
export function parseHibidResults(results) {
  const out = [];
  for (const lot of results ?? []) {
    if (lot?.itemId == null || !lot.lead) continue;
    if (lot.lotState?.isClosed) continue;
    out.push({
      listingId: String(lot.itemId),
      canonicalKey: `hibid:${lot.itemId}`,
      title: lot.lead,
      url: `${SITE}/lot/${lot.itemId}`,
      price: lot.lotState?.highBid ?? lot.lotState?.minBid ?? null,
      currency: lot.auction?.currencyAbbreviation ?? 'CAD',
      listingType: 'auction',
      endsAt: lot.auction?.bidCloseDateTime ?? null,
      imageUrl: lot.featuredPicture?.thumbnailLocation ?? lot.featuredPicture?.fullSizeLocation ?? null,
      seller: lot.auction?.auctioneer?.name ?? lot.auction?.eventName ?? null,
    });
  }
  return out;
}

export function createHibidSource() {
  let lease = null;
  let page = null;

  return {
    name: 'hibid',
    needsBrowser: true,
    minIntervalMs: 6000,

    async start() {
      lease = await acquireBrowser();
      page = await lease.context.newPage();
      // Prime Cloudflare cookies once; all searches then run same-origin.
      await page.goto(`${SITE}/lots`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2000);
    },

    async search({ text }) {
      const res = await page.evaluate(
        async ({ query, searchText }) => {
          try {
            const r = await fetch('/graphql', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                operationName: 'LotSearch',
                variables: {
                  searchText,
                  countryName: 'Canada',
                  status: 'OPEN',
                  isArchive: false,
                  countAsView: false,
                  sortOrder: 'NO_ORDER',
                  filter: 'ALL',
                  pageNumber: 1,
                  pageLength: 100,
                },
                query,
              }),
            });
            const text = await r.text();
            // A Cloudflare challenge can come back as HTML with HTTP 200.
            if (!text.trimStart().startsWith('{')) return { status: r.status, body: null };
            return { status: r.status, body: JSON.parse(text) };
          } catch (e) {
            return { status: 0, body: null, error: String(e) };
          }
        },
        { query: LOT_SEARCH_QUERY, searchText: text }
      );
      if (res.status === 429) throw Object.assign(new Error('HiBid rate limited (429)'), { rateLimited: true });
      if (res.status !== 200 || !res.body) throw new Error(`HiBid GraphQL failed (HTTP ${res.status || 'none'})`);
      return parseHibidResults(res.body?.data?.lotSearch?.pagedResults?.results);
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
