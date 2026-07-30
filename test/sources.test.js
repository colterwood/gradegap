// Parser tests for the scraped-source adapters. Each adapter keeps its
// payload→listing translation in pure exported functions so they're testable
// against fixture payloads with zero network. Fixtures follow the shapes
// documented from public client code (COMC's is a real captured feed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseComcFeed } from '../src/marketplace/sources/comc.js';
import { parseFanaticsListing, parseFanaticsAlgoliaHit } from '../src/marketplace/sources/fanatics.js';
import { parseHibidResults } from '../src/marketplace/sources/hibid.js';
import { parseAuctionWorxBrowse, parseAuctionWorxLotLinks } from '../src/marketplace/sources/cia.js';
import { parseHeritageEnds } from '../src/marketplace/sources/heritage.js';
import { parseClassicCatalog } from '../src/marketplace/sources/classic.js';
import { extractViewVars, parseMillerLots } from '../src/marketplace/sources/miller.js';
import { extractGoldinConfig, parseGoldinLots } from '../src/marketplace/sources/goldin.js';
import { parseCatawikiLots } from '../src/marketplace/sources/catawiki.js';
import { parsePristineJsonLd, extractLotArrays, mapPristineApiLot } from '../src/marketplace/sources/pristine.js';
import { extractJsonLd, decodeEntities, withTimeout, gotoStable } from '../src/marketplace/sources/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('comc: parses a real captured SearchFeed (sloppy XML and all)', () => {
  const xml = readFileSync(path.join(__dirname, 'fixtures', 'comc-feed.rss'), 'utf8');
  const out = parseComcFeed(xml);
  assert.equal(out.length, 3);
  const first = out[0];
  assert.equal(first.listingId, '13673333');
  assert.match(first.title, /2018 Topps Update Series .* Juan Soto/);
  assert.equal(first.price, 44.23);
  assert.equal(first.listingType, 'fixed');
  assert.match(first.imageUrl, /^https:\/\/img\.comc\.com\//);
  assert.match(first.url, /\/13673333$/);
});

test('fanatics: auction vs fixed, cents → dollars, end time', () => {
  const auction = parseFanaticsListing({
    id: 'abc-123',
    title: '1986 Fleer Michael Jordan #57 PSA 10',
    slug: '1986-fleer-jordan',
    listingType: 'WEEKLY',
    currentBid: { amountInCents: 4500000, currency: 'USD' },
    auction: { endsAt: '2026-08-01T02:00:00Z' },
    imageSets: [{ medium: 'https://img/m.jpg' }],
  });
  assert.equal(auction.listingType, 'auction');
  assert.equal(auction.price, 45000);
  assert.equal(auction.endsAt, '2026-08-01T02:00:00Z');
  // No payload URL field here, so it falls back to a site search link
  // (a constructed /listing/<id> link 404s — verified live).
  assert.match(auction.url, /^https:\/\/www\.fanaticscollect\.com\/search\?query=/);

  const fixed = parseFanaticsListing({
    id: 'def',
    title: 'Card',
    listingType: 'FIXED_PRICE',
    buyNowPrice: { amountInCents: 9999, currency: 'USD' },
  });
  assert.equal(fixed.listingType, 'fixed');
  assert.equal(fixed.price, 99.99);
  assert.equal(fixed.endsAt, null);
});

test('hibid: maps lots, prefers highBid, drops closed, carries house currency', () => {
  const out = parseHibidResults([
    {
      itemId: 111,
      lead: '1979 OPC Wayne Gretzky RC PSA 5',
      lotState: { highBid: 3200, minBid: 100, isClosed: false },
      featuredPicture: { thumbnailLocation: 'https://img/t.jpg' },
      auction: {
        bidCloseDateTime: '2026-08-03T00:00:00',
        currencyAbbreviation: 'CAD',
        auctioneer: { name: 'Small Town Auctions' },
      },
    },
    { itemId: 222, lead: 'Closed lot', lotState: { highBid: 5, isClosed: true }, auction: {} },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 3200);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(out[0].seller, 'Small Town Auctions');
  assert.equal(out[0].url, 'https://hibid.com/lot/111/1979-opc-wayne-gretzky-rc-psa-5');
});

test('cia: parses AuctionWorx browse sections', () => {
  const html = `
    <section data-listingid="4696386" class="listing">
      <div class="panel listing">
        <h1 class="title"><a href="/Event/LotDetails/4696386/1996-skybox-kobe">Lot 42 - 1996 Skybox Kobe Bryant PSA 8</a></h1>
        <span class="awe-rt-CurrentPrice price">$1,225.00</span>
        <span data-epoch="ending" data-action-time="2026-08-10T21:30:00"></span>
        <img src="/images/lots/4696386.jpg" />
      </div>
    </section>
    <section data-listingid="4696387">
      <h1 class="title"><a href="/Event/LotDetails/4696387/x">Lot 43 - 2003 Topps Chrome LeBron BGS 9.5</a></h1>
    </section>`;
  const out = parseAuctionWorxBrowse(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].listingId, '4696386');
  assert.equal(out[0].price, 1225);
  assert.equal(out[0].endsAt, '2026-08-10T21:30:00');
  assert.match(out[0].url, /^https:\/\/bid\.collectorinvestorauctions\.com\/Event\/LotDetails/);
  assert.equal(out[1].price, null);
});

test('classic: extracts lots from catalog anchors, dedupes both link styles', () => {
  const html = `
    <a href="/lot-173141.aspx">1951 Parkhurst Gordie Howe Rookie PSA 5 (Current Bid: $12,500.00)</a>
    <img src="https://pics.classicauctions.net/classicauctions/auctions/78/173141.jpg">
    <a href="/toronto_maple_leafs_flag-lot150174.aspx">Toronto Maple Leafs 1998-99 Final Game Flag SGC Authentic</a>
    <a href="/lot-173141.aspx"><img src="x.jpg"></a>`;
  const out = parseClassicCatalog(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].listingId, '173141');
  assert.equal(out[0].price, 12500);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(out[1].listingId, '150174');
});

test('miller: extracts balanced viewVars and maps Auction Mobility lots', () => {
  const html = `<script>var x=1; viewVars = {"lots":{"result_page":[
    {"row_id":"4-FKIDQO","title":"1979 O-Pee-Chee #18 Wayne Gretzky PSA 4","_detail_url":"/lots/view/4-FKIDQO/gretzky",
     "timed_auction_bid":{"amount":2100},"currency_code":"CAD",
     "extended_end_time":"2026-08-13T23:00:00Z","cover_thumbnail":"https://images-cdn.auctionmobility.com/t.jpg"}
  ],"query_info":{"total_num_results":1,"page_size":48}},"endpoints":{"ajax_lots":"/ajax/lots/"}}; other();</script>`;
  const vv = extractViewVars(html);
  assert.ok(vv);
  const out = parseMillerLots(vv);
  assert.equal(out.length, 1);
  assert.equal(out[0].listingId, '4-FKIDQO');
  assert.equal(out[0].price, 2100);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(out[0].endsAt, '2026-08-13T23:00:00Z');
  assert.match(out[0].url, /^https:\/\/live\.millerandmillerauctions\.com\/lots\/view/);
});

test('goldin: bundle config extraction and lot mapping with CDN images', () => {
  const js = 'x={api:{auctions:"https://api.goldin.example/auctions",lots_v2:"https://api.goldin.example/lots"}},cloudFrontURL:"https://cdn.goldin.example"';
  const cfg = extractGoldinConfig(js);
  assert.equal(cfg.lotsUrl, 'https://api.goldin.example/lots');
  assert.equal(cfg.cloudFront, 'https://cdn.goldin.example');

  const out = parseGoldinLots(
    { searchalgolia: { lots: [{ lot_id: '99', title: '1986 Fleer Jordan PSA 10', current_price: 45000, primary_image_name: 'a.jpg' }] } },
    cfg.cloudFront
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 45000);
  assert.equal(out[0].imageUrl, 'https://cdn.goldin.example/public/Lots/99/a.jpg');
});

test('catawiki: joins search lots with bidding state, prefers USD quote, drops closed', () => {
  const search = [
    { id: 100, title: '1986 Fleer Michael Jordan PSA 8', url: 'https://www.catawiki.com/en/l/100-x', originalImageUrl: 'https://a/i.jpg' },
    { id: 101, title: 'Closed lot' },
  ];
  const bidding = {
    100: { current_bid_amount: { EUR: 10000, USD: 11624 }, bidding_end_time: '2026-08-01T20:04:00Z', closed: false },
    101: { closed: true },
  };
  const out = parseCatawikiLots(search, bidding);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 11624);
  assert.equal(out[0].currency, 'USD');
  assert.equal(out[0].endsAt, '2026-08-01T20:04:00Z');
});

test('util: decodeEntities handles named + numeric refs', () => {
  assert.equal(decodeEntities('PSA&nbsp;10&nbsp;GEM&#8209;MT &amp; more'), 'PSA 10 GEM‑MT & more');
});

test('util: gotoStable retries navigations aborted by a late redirect', async () => {
  // Reproduces the live MySlabs failure: the previous results page fires its
  // own navigation mid-goto.
  const calls = [];
  let attempt = 0;
  const page = {
    url: () => 'https://www.myslabs.com/search/slabs/?q=x',
    waitForTimeout: async () => {},
    goto: async (url) => {
      calls.push(url);
      if (++attempt === 1) {
        throw new Error(
          'page.goto: Navigation to "https://www.myslabs.com/auction/search/all/?q=x" is interrupted by another navigation to "https://www.myslabs.com/search/slabs/?q=x"'
        );
      }
      return { status: () => 200 };
    },
  };
  const res = await gotoStable(page, 'https://www.myslabs.com/auction/search/all/?q=x');
  assert.equal(res.status(), 200);
  assert.equal(calls.length, 2, 'retried once');
});

test('util: gotoStable accepts an interrupted nav that still landed on target', async () => {
  const target = 'https://www.myslabs.com/search/slabs/?publish_type=0';
  const page = {
    url: () => 'https://www.myslabs.com/search/slabs/?other=1', // same path, different query
    waitForTimeout: async () => {},
    goto: async () => {
      throw new Error('page.goto: net::ERR_ABORTED at ' + target);
    },
  };
  assert.equal(await gotoStable(page, target), null); // treated as arrived
});

test('util: gotoStable rethrows non-navigation errors immediately', async () => {
  let calls = 0;
  const page = {
    url: () => 'about:blank',
    waitForTimeout: async () => {},
    goto: async () => {
      calls += 1;
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    },
  };
  await assert.rejects(() => gotoStable(page, 'https://nope.example/'), /NAME_NOT_RESOLVED/);
  assert.equal(calls, 1, 'no pointless retries');
});

test('util: withTimeout rejects a stuck promise', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 50, 'stuck thing'),
    /stuck thing timed out/
  );
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
});

test('comc: titles with embedded HTML entities are decoded', () => {
  // Real live-feed URL shape: card number (short) + item id (long) + graded
  // suffix — the id must be the long segment, never the trailing grade.
  const xml = `<rss><channel><item>
    <guid>https://www.comc.com/Cards/Basketball/1996/Fleer/47/Michael_Jordan/24815903/Graded/PSA/10</guid>
    <title>1996 Fleer Michael Jordan [PSA&nbsp;10&nbsp;GEM&nbsp;MT]</title>
    <link>https://www.comc.com/Cards/Basketball/1996/Fleer/47/Michael_Jordan/24815903/Graded/PSA/10</link>
    <description>Sale Price: $99.00</description>
  </item></channel></rss>`;
  const out = parseComcFeed(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0].listingId, '24815903');
  assert.equal(out[0].title, '1996 Fleer Michael Jordan [PSA 10 GEM MT]');
});

test('fanatics: Algolia hits map tolerantly (cents, dollars, epoch ends)', () => {
  const auction = parseFanaticsAlgoliaHit({
    listingUuid: 'u-1',
    title: '1986 Fleer Michael Jordan #57 PSA 10',
    marketplace: 'WEEKLY',
    currentBidAmountInCents: 4500000,
    auctionEndsAt: 1785540000, // seconds epoch
    images: { primary: { small: 'https://img/s.jpg' } },
  });
  assert.equal(auction.listingType, 'auction');
  assert.equal(auction.price, 45000);
  assert.match(auction.endsAt, /^20\d\d-.*Z$/);

  const fixed = parseFanaticsAlgoliaHit({
    objectID: 'o-2',
    name: 'Card',
    marketplace: 'FIXED',
    buyNowPrice: 125.5,
  });
  assert.equal(fixed.listingType, 'fixed');
  assert.equal(fixed.price, 125.5);
  assert.equal(fixed.endsAt, null);

  assert.equal(parseFanaticsAlgoliaHit({ objectID: 'no-title' }), null);
});

test('hibid: zero-bid lots report null price, not $0', () => {
  const out = parseHibidResults([
    { itemId: 5, lead: 'No bids yet PSA 10', lotState: { highBid: 0, minBid: 0, isClosed: false }, auction: {} },
    { itemId: 6, lead: 'Min bid only PSA 10', lotState: { highBid: 0, minBid: 25, isClosed: false }, auction: {} },
  ]);
  assert.equal(out[0].price, null);
  assert.equal(out[1].price, 25);
});

test('heritage: relative end times become ISO timestamps', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  assert.equal(parseHeritageEnds('25 days', now), '2026-08-23T12:00:00.000Z');
  assert.equal(parseHeritageEnds('2 days 6 hours', now), '2026-07-31T18:00:00.000Z');
  assert.equal(parseHeritageEnds('45 minutes', now), '2026-07-29T12:45:00.000Z');
  assert.match(parseHeritageEnds('Aug 9, 2026', now), /^2026-08-09T/);
  assert.equal(parseHeritageEnds('Auction Ended', now), null);
  assert.equal(parseHeritageEnds(null, now), null);
});

test('cia: lot-link fallback parses skinned pages without stock blocks', () => {
  const html = `
    <div class="custom-skin-card">
      <a href="/Event/LotDetails/4696386/1996-skybox-kobe"><img src="x.jpg"></a>
      <a href="/Event/LotDetails/4696386/1996-skybox-kobe">1996 Skybox Kobe Bryant PSA 8</a>
      <div class="bid">Current Bid: $1,225.00</div>
      <span data-action-time="2026-08-10T21:30:00"></span>
    </div>
    <a href="/Listing/Details/555/other">2003 Topps Chrome LeBron James BGS 9.5 rookie</a>`;
  const out = parseAuctionWorxLotLinks(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].listingId, '4696386');
  assert.equal(out[0].price, 1225);
  assert.equal(out[0].endsAt, '2026-08-10T21:30:00');
  assert.equal(out[1].listingId, '555');
});

test('cia: data-listingid on non-section elements still parses', () => {
  const html = `<div data-listingid="777" class="row">
    <h1 class="title"><a href="/Event/LotDetails/777/slug">Lot 7 - 1979 OPC Gretzky PSA 5</a></h1>
    <span class="awe-rt-CurrentPrice price">$900.00</span>
  </div>`;
  const out = parseAuctionWorxBrowse(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].listingId, '777');
  assert.equal(out[0].price, 900);
});

test('pristine: sniffed JSON payloads yield lots wherever the array hides', () => {
  // Algolia-style envelope: results[0].hits[]
  const payload = {
    results: [{
      hits: [
        { objectID: '123456', name: '1986 Fleer Michael Jordan #57 PSA 10', current_bid: 4100, end_time: 1785540000 },
        { objectID: '123457', name: '1991 Upper Deck Michael Jordan #44 PSA 10', current_bid: 55 },
        { objectID: '123458', name: '1989 Hoops Michael Jordan #200 PSA 9', current_bid: 20 },
      ],
      nbHits: 3,
    }],
  };
  const arrays = extractLotArrays(payload);
  assert.ok(arrays.length >= 1);
  const lots = arrays[0].map(mapPristineApiLot).filter(Boolean);
  assert.equal(lots.length, 3);
  assert.equal(lots[0].listingId, '123456');
  assert.equal(lots[0].price, 4100);
  assert.match(lots[0].endsAt, /^20\d\d-.*Z$/); // seconds epoch → ISO
  assert.match(lots[0].url, /^https:\/\/www\.pristineauction\.com\//);

  // arrays without titles are ignored
  assert.equal(extractLotArrays({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }).length, 0);
});

test('pristine: parses Product JSON-LD, including ItemList wrappers', () => {
  const html = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
    {"item":{"@type":"Product","name":"1986 Fleer Michael Jordan PSA 7","url":"/auction/item/123456-jordan",
     "image":"https://images.pristineauction.com/j.jpg","offers":{"price":"4100.00","priceCurrency":"USD"}}}
  ]}</script>`;
  const out = parsePristineJsonLd(extractJsonLd(html));
  assert.equal(out.length, 1);
  assert.equal(out[0].listingId, '123456-jordan');
  assert.equal(out[0].price, 4100);
  assert.match(out[0].url, /^https:\/\/www\.pristineauction\.com\//);
});

// --- WooCommerce (Galaxy Auctions and any other Woo card shop) -----------

test('woocommerce: Store API products map, minor units become dollars', async () => {
  const { parseWooProducts } = await import('../src/marketplace/sources/woocommerce.js');
  const out = parseWooProducts(
    [
      {
        id: 4821,
        name: '1979-80 O-Pee-Chee Wayne Gretzky #18 RC PSA 5 &#8211; Rookie',
        permalink: 'https://galaxy-auctions.com/product/gretzky-rc-psa-5/',
        prices: { price: '1250000', regular_price: '1250000', currency_code: 'CAD', currency_minor_unit: 2 },
        images: [{ src: 'https://galaxy-auctions.com/img/gretzky.jpg' }],
      },
      { id: 77, name: 'No price product', prices: { price: '', currency_minor_unit: 2 } },
      { name: 'no id' },
    ],
    { domain: 'galaxy-auctions.com', currency: 'CAD' }
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].price, 12500);
  assert.equal(out[0].currency, 'CAD');
  assert.equal(out[0].listingType, 'fixed');
  assert.match(out[0].title, /Wayne Gretzky #18 RC PSA 5 – Rookie/); // entity decoded
  assert.equal(out[0].listingId, 'galaxy-auctions.com:4821');
  assert.equal(out[1].price, null);
});

// --- Alt ------------------------------------------------------------------

test('alt: listing objects map tolerantly; cents-scale prices normalize', async () => {
  const { mapAltListing, extractAltListings } = await import('../src/marketplace/sources/alt.js');
  const fixed = mapAltListing({
    id: 'a1',
    title: '1986 Fleer Michael Jordan #57 PSA 8',
    price: 1250000, // cents
    slug: 'jordan-57-psa-8',
  });
  assert.equal(fixed.price, 12500);
  assert.equal(fixed.listingType, 'fixed');
  // /itm/<id> is Alt's real item route (user-verified live; the guessed
  // /marketplace/<id> bounced to the homepage).
  assert.match(fixed.url, /^https:\/\/alt\.xyz\/itm\/a1$/);

  const auction = mapAltListing({
    listingId: 'a2',
    cardName: '2003 Topps Chrome LeBron James #111 BGS 9',
    listingType: 'WEEKLY_AUCTION',
    currentBid: { amount: 8400 },
    endsAt: 1785540000,
  });
  assert.equal(auction.listingType, 'auction');
  assert.equal(auction.price, 8400);
  assert.match(auction.endsAt, /^20\d\d-.*Z$/);

  assert.equal(mapAltListing({ id: 'x', title: 'short' }), null); // title too short

  // buried arrays are found wherever they sit in the payload
  const groups = extractAltListings({
    data: { marketplace: { results: [
      { id: 1, title: '1986 Fleer Michael Jordan #57 PSA 8', price: 100 },
      { id: 2, title: '1979 OPC Wayne Gretzky #18 PSA 6', price: 200 },
    ] } },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('woocommerce: HTML fallback parses product links and prices', async () => {
  const { parseWooHtml } = await import('../src/marketplace/sources/woocommerce.js');
  const html = `
    <li class="product">
      <a href="https://galaxy-auctions.com/product/gretzky-rc-psa-5/">
        <img src="https://galaxy-auctions.com/img/g.jpg">
        <h2>1979-80 O-Pee-Chee Wayne Gretzky #18 RC PSA 5</h2>
      </a>
      <span class="woocommerce-Price-amount amount"><bdi><span>$</span>12,500.00</bdi></span>
    </li>
    <li class="product">
      <a href="https://galaxy-auctions.com/product/howe-psa-4/">1951 Parkhurst Gordie Howe RC PSA 4</a>
    </li>`;
  const out = parseWooHtml(html, { domain: 'galaxy-auctions.com', currency: 'CAD' });
  assert.equal(out.length, 2);
  assert.match(out[0].title, /Wayne Gretzky #18 RC PSA 5/);
  assert.equal(out[0].price, 12500);
  assert.equal(out[0].listingId, 'galaxy-auctions.com:gretzky-rc-psa-5');
  assert.equal(out[1].listingId, 'galaxy-auctions.com:howe-psa-4');
});

test('alt: analytics/config objects without prices are rejected', async () => {
  const { mapAltListing } = await import('../src/marketplace/sources/alt.js');
  // Real false positives from a live run
  assert.equal(mapAltListing({ id: 3237, title: 'Jul 17 - Jul 30, 2026' }), null);
  assert.equal(mapAltListing({ id: 'x', name: 'Shipping Label – Cash Advance Non-Users' }), null);
  assert.equal(mapAltListing({ id: 'y', name: 'Auction seller CSAT' }), null);
  // A card with a price still passes
  assert.ok(mapAltListing({ id: 'z', title: '1986 Fleer Michael Jordan #57 PSA 8', price: 12500 }));
  // …but a card-shaped title with no price does not
  assert.equal(mapAltListing({ id: 'w', title: '1986 Fleer Michael Jordan #57 PSA 8' }), null);
});

test('woocommerce: HTML fallback ignores a "no products found" page', async () => {
  const { parseWooHtml } = await import('../src/marketplace/sources/woocommerce.js');
  // Live failure: Galaxy's empty search rendered the notice plus a grid of
  // unrelated recommendations, which came back as 36 bogus "matches".
  const html = `
    <p class="woocommerce-info">No products were found matching your selection.</p>
    <li class="product"><a href="https://galaxy-auctions.com/product/unrelated-card/">1970-71 Topps #3 Field Goal Leaders</a></li>`;
  assert.deepEqual(parseWooHtml(html, { domain: 'galaxy-auctions.com', currency: 'CAD' }), []);
});

test('woocommerce: only Woo price markup counts as a price', async () => {
  const { parseWooHtml } = await import('../src/marketplace/sources/woocommerce.js');
  const html = `
    <aside class="widget">Filter by price: $36 — $500</aside>
    <li class="product"><a href="https://x.com/product/a-card-here/">1979 OPC Wayne Gretzky #18 RC</a>
      <span class="woocommerce-Price-amount amount"><bdi><span>C$</span>12,500.00</bdi></span></li>`;
  const out = parseWooHtml(html, { domain: 'x.com', currency: 'CAD' });
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 12500); // not the 36 from the sidebar filter
});

test('alt: telemetry hosts are blocked, search backends are not', async () => {
  const { ANALYTICS_HOST_RE } = await import('../src/marketplace/sources/alt.js');
  for (const h of ['us.i.posthog.com', 'sentry.io', 'www.google-analytics.com']) {
    assert.ok(ANALYTICS_HOST_RE.test(h), h);
  }
  // Alt's own API and any external search service must get through
  for (const h of [
    'alt-platform-server.production.internal.onlyalt.com',
    'alt.xyz',
    'abc123-dsn.algolia.net',
    'search.typesense.net',
  ]) {
    assert.ok(!ANALYTICS_HOST_RE.test(h), h);
  }
});

test('alt: only Alt-listed items are kept, not the houses it aggregates', async () => {
  const { mapAltListing, isAltsOwnListing } = await import('../src/marketplace/sources/alt.js');
  const card = { id: 'a1', title: '1986 Fleer Michael Jordan #57 PSA 8', price: 12500 };

  assert.ok(mapAltListing({ ...card, auctionHouse: 'Alt' }));
  assert.ok(mapAltListing({ ...card, auctionHouse: { name: 'Alt' } }));
  assert.ok(mapAltListing(card), 'no house field -> URL filter already applied');

  for (const house of ['Goldin', 'Heritage Auctions', 'Fanatics Collect', 'PWCC']) {
    assert.equal(mapAltListing({ ...card, auctionHouse: house }), null, house);
    assert.equal(isAltsOwnListing({ auctionHouse: house }), false, house);
  }
});

test('alt: near-miss diagnostic surfaces rejected card-ish objects and their keys', async () => {
  const { findNearMisses } = await import('../src/marketplace/sources/alt.js');
  const payload = {
    data: {
      items: [
        // card-shaped title but no recognizable price -> a near miss
        { itemTitle: '1986 Fleer Michael Jordan #57 PSA 8', lowestOffer: { cents: 1250000 } },
        { name: 'Auction seller CSAT' }, // not card-shaped, ignored
      ],
    },
  };
  const misses = findNearMisses(payload);
  assert.equal(misses.length, 1);
  assert.match(misses[0].sampleTitle, /Michael Jordan/);
  assert.ok(misses[0].keys.includes('itemTitle') && misses[0].keys.includes('lowestOffer'));
});

test('fanatics: URLs come from the payload, else a search link (never a 404 guess)', async () => {
  const { buildFanaticsUrl, parseFanaticsAlgoliaHit } = await import('../src/marketplace/sources/fanatics.js');

  // A URL the API actually gave us wins
  assert.equal(
    buildFanaticsUrl({ url: 'https://www.fanaticscollect.com/weekly-auction/x_123' }),
    'https://www.fanaticscollect.com/weekly-auction/x_123'
  );
  assert.equal(
    buildFanaticsUrl({ path: '/weekly-auction/x_123' }),
    'https://www.fanaticscollect.com/weekly-auction/x_123'
  );

  // Live bug: /listing/<uuid> 404s, so a bare uuid must NOT become a link
  const hit = parseFanaticsAlgoliaHit({
    listingUuid: 'a741a966-8b92-11f1-9b47-02ffd3767c89',
    title: '1986 Fleer Michael Jordan #57 PSA 8',
    marketplace: 'FIXED',
    buyNowPrice: 500,
  });
  assert.ok(!hit.url.includes('a741a966'), 'no constructed /listing/<uuid> link');
  assert.match(hit.url, /^https:\/\/www\.fanaticscollect\.com\/search\?query=/);
  assert.match(hit.url, /Michael/);
});

test('alt: Typesense hit wrappers are unwrapped (the live parse failure)', async () => {
  const { extractAltListings } = await import('../src/marketplace/sources/alt.js');
  // Real Typesense multi_search shape: results[].hits[].document
  const payload = {
    results: [
      {
        found: 2,
        hits: [
          {
            document: {
              id: 'ast_1',
              name: '1986 Fleer Michael Jordan #57 PSA 8',
              lowestAsk: 1250000,
              gradingCompany: 'PSA',
              grade: '8',
              auctionHouse: 'Alt',
            },
            highlights: [{ field: 'name' }],
            text_match: 578730123,
          },
          {
            document: {
              id: 'ast_2',
              name: '1998 Skybox Molten Metal Michael Jordan #41 PSA 9',
              gradingCompany: 'PSA',
              grade: '9',
              // no recognizable price field — card fields keep it
            },
          },
        ],
      },
    ],
  };
  const groups = extractAltListings(payload);
  const listings = groups.flat();
  assert.equal(listings.length, 2);
  assert.equal(listings[0].price, 12500); // cents normalized
  assert.match(listings[0].title, /Michael Jordan #57 PSA 8/);
  assert.equal(listings[1].price, null); // kept on card fields alone
  assert.match(listings[1].title, /Molten Metal/);
});

test('alt: only responses whose REQUEST carried the query count as results', async () => {
  const { requestCarriesQuery } = await import('../src/marketplace/sources/alt.js');
  const ts = 'https://tlzfv6xaq81nhsbyp.a1.typesense.net/multi_search?collection=production_universal_search';

  // query in the POST body (the normal case)
  assert.ok(requestCarriesQuery(ts, '{"searches":[{"q":"jordan psa","per_page":50}]}', 'jordan psa'));
  // query in the URL (the per_page=0 count calls)
  assert.ok(requestCarriesQuery(`${ts}&per_page=0&q=jordan+psa`, '', 'jordan psa'));
  // the unfiltered browse-grid query — live bug returned Curry/Brady/Messi
  assert.ok(!requestCarriesQuery(ts, '{"searches":[{"q":"*","sort_by":"price:desc"}]}', 'jordan psa'));
  assert.ok(!requestCarriesQuery(ts, '', 'jordan psa'));
  // partial match is not enough
  assert.ok(!requestCarriesQuery(ts, '{"q":"jordan"}', 'jordan psa'));
});

test('hibid: links follow /lot/<id>/<slug> on hibid.com, slugified their way', async () => {
  const { hibidSlug } = await import('../src/marketplace/sources/hibid.js');
  // User-verified live link: hibid.com/lot/312530147/2007-upper-deck-michael-jordan-nat--vip-6-psa-10
  assert.equal(hibidSlug('2007 UPPER DECK MICHAEL JORDAN NAT. VIP #6 PSA 10'), '2007-upper-deck-michael-jordan-nat--vip-6-psa-10');
  const out = parseHibidResults([
    { itemId: 312530147, lead: '2007 UPPER DECK MICHAEL JORDAN NAT. VIP #6 PSA 10', lotState: { highBid: 10, isClosed: false }, auction: {} },
  ]);
  assert.equal(out[0].url, 'https://hibid.com/lot/312530147/2007-upper-deck-michael-jordan-nat--vip-6-psa-10');
});

test('goldin: a payload slug or URL beats the search fallback', async () => {
  const { parseGoldinLots } = await import('../src/marketplace/sources/goldin.js');
  const [withSlug, withUrl, without] = parseGoldinLots({
    lots: [
      { lot_id: 1, title: '1986 Fleer Michael Jordan #57 BGS 8', slug: '1986-87-fleer-57-michael-jordan-bgs-nm-mt-89p99a' },
      { lot_id: 2, title: 'Card two here', item_url: 'https://goldin.co/item/card-two-ab12cd' },
      { lot_id: 3, title: 'Card three here' },
    ],
  }, null);
  assert.equal(withSlug.url, 'https://goldin.co/item/1986-87-fleer-57-michael-jordan-bgs-nm-mt-89p99a');
  assert.equal(withUrl.url, 'https://goldin.co/item/card-two-ab12cd');
  assert.match(without.url, /\/buy\?search=/);
});

test('goldin: meta_slug builds real /item/ links; end_timestamp becomes ISO', async () => {
  const { parseGoldinLots } = await import('../src/marketplace/sources/goldin.js');
  // Real key set from a live debug dump: meta_slug carries the item slug,
  // end_timestamp the auction close.
  const [lot] = parseGoldinLots({
    searchalgolia: { lots: [{
      lot_id: 42,
      title: '1986-87 Fleer #57 Michael Jordan - BGS NM-MT 8',
      meta_slug: '1986-87-fleer-57-michael-jordan-bgs-nm-mt-89p99a',
      current_price: 900,
      end_timestamp: 1785540000,
      auction_id: 7, auction_type: 'weekly', buyer_premium: 20, lot_number: 12,
    }] },
  }, null);
  assert.equal(lot.url, 'https://goldin.co/item/1986-87-fleer-57-michael-jordan-bgs-nm-mt-89p99a');
  assert.match(lot.endsAt, /^20\d\d-.*Z$/);
});

test('hibid: seller carries house and location so CA vs US is visible', async () => {
  const out = parseHibidResults([
    {
      itemId: 9, lead: '1979 OPC Wayne Gretzky PSA 5 rookie card',
      lotState: { highBid: 100, isClosed: false },
      auction: { currencyAbbreviation: 'CAD', eventCity: 'Calgary', eventState: 'AB', auctioneer: { name: 'Prairie Auctions' } },
    },
  ]);
  assert.equal(out[0].seller, 'Prairie Auctions — Calgary, AB');
});
