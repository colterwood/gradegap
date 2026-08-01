// HiBid (hibid.com) — aggregator over thousands of auction houses, US and
// Canadian alike (canada.hibid.com is a country-filtered portal over the
// SAME lot pool, so one global search covers both — per user, both sides
// matter). All lot data comes from a GraphQL endpoint; Cloudflare wants a
// browser-grade client, so the adapter opens the site in the shared
// browser once and POSTs the captured LotSearch operation from inside the
// page (same-origin — CF cookies ride along automatically). Lots are CAD
// or USD per auction house (currencyAbbreviation).
// Verify locally with `npm run test-source hibid "psa 10 jordan"`.

import { acquireBrowser } from '../../scraper/browserLease.js';
import { gotoStable, zonedToIso } from './util.js';

const SITE = 'https://hibid.com';
// bidCloseDateTime arrives WITHOUT a zone. Live-verified against the
// per-lot countdown across auctions in CA/OH/KS/IL/MO (2026-08-01): only
// reading it as US Eastern makes every lot close AFTER its event's stated
// time; every other reading puts lots before their own auction started.
const HIBID_TZ = 'America/New_York';

// HiBid lot links are /lot/<itemId>/<slugified-lead> (user-verified live).
// Their slugifier turns EVERY non-alphanumeric character into a dash
// without collapsing runs ("NAT. VIP" -> "nat--vip"); the id does the
// routing, the slug is cosmetic, but match their shape anyway.
export const hibidSlug = (lead) =>
  String(lead ?? '')
    .toLowerCase()
    .replace(/[#'"’]/g, '') // stripped outright ("VIP #6" -> "vip-6")
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');

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
// nowMs is the instant the response was requested, so the per-lot
// countdown can be turned into an absolute end time.
export function parseHibidResults(results, nowMs = Date.now()) {
  const out = [];
  for (const lot of results ?? []) {
    if (lot?.itemId == null || !lot.lead) continue;
    if (lot.lotState?.isClosed) continue;
    // HiBid closes lots in a staggered sequence, so the per-lot countdown
    // is both more accurate than the event-wide bidCloseDateTime AND free
    // of the zone guessing that field needs (live-verified: lots in one
    // auction differed by 80 minutes while sharing a bidCloseDateTime).
    // A 0/absent countdown means a live webcast lot — fall back to the
    // event close, read in HiBid's Eastern zone.
    const secs = lot.lotState?.timeLeftSeconds;
    const endsAt = Number.isFinite(secs) && secs > 0
      ? new Date(nowMs + secs * 1000).toISOString()
      : zonedToIso(lot.auction?.bidCloseDateTime, HIBID_TZ);
    // A lot with no bids reports highBid 0 — that's "no price yet", not $0.
    const highBid = lot.lotState?.highBid;
    const minBid = lot.lotState?.minBid;
    out.push({
      listingId: String(lot.itemId),
      canonicalKey: `hibid:${lot.itemId}`,
      title: lot.lead,
      url: `${SITE}/lot/${lot.itemId}/${hibidSlug(lot.lead)}`,
      price: highBid > 0 ? highBid : minBid > 0 ? minBid : null,
      currency: lot.auction?.currencyAbbreviation ?? 'CAD',
      listingType: 'auction',
      endsAt,
      imageUrl: lot.featuredPicture?.thumbnailLocation ?? lot.featuredPicture?.fullSizeLocation ?? null,
      // House + location, so Canadian vs US lots are visible at a glance
      // (the global search spans both).
      seller: [
        lot.auction?.auctioneer?.name ?? lot.auction?.eventName ?? null,
        [lot.auction?.eventCity, lot.auction?.eventState].filter(Boolean).join(', ') || null,
      ]
        .filter(Boolean)
        .join(' — ') || null,
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
      await gotoStable(page, `${SITE}/lots`);
      await page.waitForTimeout(2000);
    },

    async search({ text }) {
      // Captured before the request so the per-lot countdown in the
      // response can be resolved to an absolute instant.
      const requestedAt = Date.now();
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
                  countryName: null, // ALL of HiBid — US and Canadian houses alike
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
      // GraphQL failures arrive as HTTP 200 with an errors array and no
      // data — indistinguishable from "no lots" unless checked, and three
      // such "successful" empty checks delete tracked listings as stale.
      if (res.body.errors?.length) {
        throw new Error(`HiBid GraphQL error: ${res.body.errors[0]?.message ?? 'unknown'}`);
      }
      const paged = res.body.data?.lotSearch?.pagedResults;
      if (!paged) throw new Error('HiBid GraphQL: no lotSearch data in response (schema changed?)');
      return parseHibidResults(paged.results, requestedAt);
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      page = null;
      lease = null;
    },
  };
}
