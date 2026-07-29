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
import { parsePristineJsonLd } from '../src/marketplace/sources/pristine.js';
import { extractJsonLd, decodeEntities, withTimeout } from '../src/marketplace/sources/util.js';

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
  assert.match(auction.url, /\/listing\/1986-fleer-jordan$/);

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
  assert.match(out[0].url, /\/lot\/111$/);
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
