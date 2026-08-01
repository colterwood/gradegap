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
import { parseClassicCatalog, parseClassicSaleStatus } from '../src/marketplace/sources/classic.js';
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
  assert.equal(auction.endsAt, '2026-08-01T02:00:00.000Z');
  // WEEKLY + id + slug -> the real /weekly/<uuid>/<slug> page (verified live).
  assert.equal(auction.url, 'https://www.fanaticscollect.com/weekly/abc-123/1986-fleer-jordan');

  // This fallback path used to pass the end time through un-normalized,
  // unlike the primary Algolia path — so an epoch (the shape Fanatics
  // actually uses on the live index) reached storage as a bare number and
  // was mis-read. It also only accepted the exact strings WEEKLY/PREMIER,
  // so a plain 'AUCTION' type was stored as fixed with no end date at all.
  const epochAuction = parseFanaticsListing({
    id: 'e1', title: 'Card', listingType: 'AUCTION',
    currentBid: { amountInCents: 1000 },
    auction: { endsAt: 1785722400 },
  });
  assert.equal(epochAuction.listingType, 'auction');
  assert.equal(epochAuction.endsAt, new Date(1785722400 * 1000).toISOString());

  const fixed = parseFanaticsListing({
    id: 'def',
    title: 'Card',
    listingType: 'FIXED_PRICE',
    buyNowPrice: { amountInCents: 9999, currency: 'USD' },
  });
  assert.equal(fixed.listingType, 'fixed');
  assert.equal(fixed.price, 99.99);
  assert.equal(fixed.endsAt, null);
  // FIXED_PRICE isn't a known marketplace segment -> resolving search link,
  // never a guessed deep link.
  assert.match(fixed.url, /^https:\/\/www\.fanaticscollect\.com\/search\?query=/);
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
  // No per-lot countdown here, so the event close is used — and it arrives
  // WITHOUT a zone, so it must resolve against HiBid's Eastern zone, not
  // whatever zone the machine running the check happens to be in.
  assert.equal(out[0].endsAt, '2026-08-03T04:00:00.000Z');
});

test('hibid: the per-lot countdown wins over the shared event close time', () => {
  // Live-verified: lots in ONE auction share a bidCloseDateTime but close
  // in a staggered sequence up to 80 minutes apart. Using the event value
  // for all of them fired ending-soon alerts at the wrong moment for every
  // lot but the last, and kept closed lots alive until the whole sale ended.
  const auction = { bidCloseDateTime: '2026-08-05T19:00:00', currencyAbbreviation: 'USD' };
  const now = Date.parse('2026-08-01T00:00:00Z');
  const out = parseHibidResults([
    { itemId: 1, lead: '1968 Topps #280 Mickey Mantle PSA 4', lotState: { highBid: 10, isClosed: false, timeLeftSeconds: 3600 }, auction },
    { itemId: 2, lead: '1967 Topps #150 Mickey Mantle PSA 3', lotState: { highBid: 10, isClosed: false, timeLeftSeconds: 7200 }, auction },
    // A live webcast lot reports 0 — fall back to the event close (Eastern).
    { itemId: 3, lead: '1961 Topps Mickey Mantle PSA 1', lotState: { highBid: 10, isClosed: false, timeLeftSeconds: 0 }, auction },
  ], now);
  assert.equal(out[0].endsAt, '2026-08-01T01:00:00.000Z');
  assert.equal(out[1].endsAt, '2026-08-01T02:00:00.000Z');
  assert.notEqual(out[0].endsAt, out[1].endsAt); // staggered, not shared
  assert.equal(out[2].endsAt, '2026-08-05T23:00:00.000Z'); // 19:00 EDT
});

// Verbatim structure from a live CIA /Browse page (2026-08-01): the
// heading is an h2 whose class is "title inlinebidding" (with a sibling
// "subtitle" heading), the thumbnail anchor comes BEFORE the title anchor,
// the countdown spans carry data-end-*-selector attributes whose values
// contain the literal text `data-listingid=`, and times are US-format
// Eastern with no zone. Every one of those broke the old parser.
const ciaLot = ({ listingId, lotId, name, price, ends, starts = '08/06/2026 12:00:00' }) => `
<section id="LID${listingId}" data-listingid="${listingId}">
  <div class="panel panel-default hasQuickbid clearfix listing">
    <div class="context-wrapper" data-nosnippet>
      <button class="addOrRemoveWatchlist" data-watch-listingid="${listingId}"></button>
      <span class="awe-hidden awe-rt-ShowOnEnd label label-default status-type">Ended</span>
      <span class="awe-rt-HideOnEnd label label-primary status-type InlineListingType">Auction</span>
    </div>
    <div class="row">
      <div class="col-xs-4 img-container">
        <a href="/Event/LotDetails/${lotId}/slug"><img src="https://ciaimages.blob.core.windows.net/a.jpg" class="img-responsive" /></a>
      </div>
      <div class="col-xs-8">
        <h2 class="title inlinebidding">
          <a href="/Event/LotDetails/${lotId}/slug">
${name}          </a>
        </h2>
        <h3 class="subtitle inlinebidding"><a href="/Event/LotDetails/${lotId}/slug">BLAZER DIVISION</a></h3>
      </div>
    </div>
    <div class="cta">
      <p class="awe-rt-HideOnEnd time">
        <span class="awe-rt-HideOnStart">Starts In
          <span data-epoch="starting" data-end-hide-selector="[data-listingid='${listingId}'] .awe-rt-HideOnStart" data-end-show-selector="[data-listingid='${listingId}'] .awe-rt-ShowOnStart" data-action-time="${starts}"></span>
        </span>
        <span class="awe-hidden awe-rt-ShowOnStart">
          <span data-epoch="ending" data-end-hide-selector="[data-listingid='${listingId}'] .awe-rt-HideOnEnd" data-end-show-selector="[data-listingid='${listingId}'] .awe-rt-ShowOnEnd" data-action-time="${ends}" data-end-value="Ended"></span>
        </span>
      </p>
      <p class="bids">
        <span class="awe-rt-HideOnEnd awe-rt-CurrentPrice price">$<span class="NumberPart">${price}</span> USD</span>
        <a href="/Event/LotDetails/${lotId}/slug" class="awe-rt-HideOnStart btn btn-primary"><span>Preview </span></a>
        <a href="/Event/LotDetails/${lotId}/slug" class="awe-hidden btn btn-default"><span>View Details </span></a>
      </p>
    </div>
  </div>
</section>`;

test('cia: parses AuctionWorx browse sections', () => {
  const html =
    ciaLot({ listingId: '5593506', lotId: '5593505', name: 'Lot 001 -\n                1952 Topps #311 Mickey Mantle Hi# MBA 7', price: '1,225.00', ends: '08/16/2026 21:00:00' }) +
    ciaLot({ listingId: '4696387', lotId: '4696386', name: 'Lot 043 - 2003 Topps Chrome LeBron BGS 9.5', price: '900.00', ends: '08/16/2026 21:00:07' });
  const out = parseAuctionWorxBrowse(html);
  assert.equal(out.length, 2);
  // Identity comes from the LOT id in the URL, matching the fallback parser
  // (AuctionWorx's section data-listingid is a different, adjacent number).
  assert.equal(out[0].listingId, '5593505');
  assert.match(out[0].url, /\/Event\/LotDetails\/5593505\//);
  // The h2.title anchor wins over the thumbnail anchor (empty text) and the
  // "Preview" CTA — the old parser stored "Preview" as every lot's title.
  assert.equal(out[0].title, '1952 Topps #311 Mickey Mantle Hi# MBA 7');
  assert.equal(out[0].price, 1225);
  // 21:00 ET on Aug 16 (EDT, UTC-4) = 01:00 UTC on Aug 17 — the ENDING
  // span, never the "starting" one, and never the machine's zone.
  assert.equal(out[0].endsAt, '2026-08-17T01:00:00.000Z');
  assert.equal(out[0].listingType, 'auction');
  assert.equal(out[1].endsAt, '2026-08-17T01:00:07.000Z');
  assert.equal(out[1].price, 900);
});

test('cia: winter lots resolve against Eastern STANDARD time', () => {
  const html = ciaLot({ listingId: '2', lotId: '1', name: 'Lot 001 - 1986 Fleer Michael Jordan #57 PSA 8', price: '10.00', ends: '01/16/2026 21:00:00' });
  const out = parseAuctionWorxBrowse(html);
  assert.equal(out[0].endsAt, '2026-01-17T02:00:00.000Z'); // EST = UTC-5
});

test('classic: a finished sale is recognized so its sold lots are not served as live', () => {
  // Verbatim wording from the live catalog (2026-08-01). The page keeps
  // serving the closed sale's lots, each with a "Final Price" — emitting
  // those as live auctions parked sold lots in the table forever, since
  // the page never stops returning them so the miss counter never advances.
  const closed = `<div class="head">Historical Hockey and Sports Memorabilia Auction June 2026
    <span>Auction closed on 6/17/2026. Final prices include buyers premium.</span></div>`;
  const s = parseClassicSaleStatus(closed, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(s.closed, true);
  // 23:59 Montreal on the closing day (EDT, UTC-4) = 03:59 UTC next day.
  assert.equal(s.closingIso, '2026-06-18T03:59:00.000Z');

  // The same wording for a sale still ahead is NOT closed, and its date
  // becomes every lot's end time.
  const live = `<span>Auction closes on 10/15/2026. Bid now.</span>`;
  const t = parseClassicSaleStatus(live, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(t.closed, false);
  assert.equal(t.closingIso, '2026-10-16T03:59:00.000Z');

  // No wording at all: no date, and not treated as closed.
  assert.deepEqual(parseClassicSaleStatus('<p>no status here</p>'), { closingIso: null, closed: false });
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
  assert.equal(out[0].endsAt, '2026-08-01T20:04:00.000Z');
  assert.equal(out[0].listingType, 'auction');
});

test('catawiki: a buy-now-available lot with a close time is still an auction', () => {
  // Buy-now is an EXTRA option on a running Catawiki auction (offered
  // until the first bid), not a separate format. Calling it 'fixed'
  // exempted the lot from the ended-auction sweep and from every
  // ending-soon alert while its close time sat right there in the payload.
  const out = parseCatawikiLots(
    [{ id: 200, title: '1999 Pokemon Charizard PSA 9' }],
    { 200: { closed: false, bidding_end_time: '2026-08-05T18:00:00Z', is_buy_now_available: true, current_bid_amount: { EUR: 500 } } }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].listingType, 'auction');
  assert.equal(out[0].endsAt, '2026-08-05T18:00:00.000Z');

  // A genuine fixed-price lot (no bidding close at all) stays fixed.
  const fixed = parseCatawikiLots(
    [{ id: 201, title: '1999 Pokemon Blastoise PSA 9' }],
    { 201: { closed: false, is_buy_now_available: true, current_bid_amount: { EUR: 300 } } }
  );
  assert.equal(fixed[0].listingType, 'fixed');
  assert.equal(fixed[0].endsAt, null);
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

test('fanatics: live-index field shapes — auctionEndDatetime, dollar bids, startingBid floor', () => {
  // Field names exactly as the prod_item_state_v1 index returned them on
  // 2026-07-30 (the user-reported Kobe card, abridged).
  const kobe = parseFanaticsAlgoliaHit({
    listingUuid: 'eed49848-852e-11f1-9b99-0a0f8b986c27',
    listingId: 6246520,
    objectID: 'WEEKLY6246520',
    title: '1997 Hoops High Voltage Kobe Bryant #1HV SGC 9 MINT',
    marketplace: 'WEEKLY',
    currentBid: 725,
    currentPrice: 725,
    startingBid: 5,
    auctionEndDatetime: 1785722400, // epoch seconds
    status: 'Live',
  });
  assert.equal(kobe.listingType, 'auction');
  assert.equal(kobe.price, 725);
  assert.equal(kobe.endsAt, new Date(1785722400 * 1000).toISOString());
  // The exact URL the user verified by hand on the live site.
  assert.equal(
    kobe.url,
    'https://www.fanaticscollect.com/weekly/eed49848-852e-11f1-9b99-0a0f8b986c27/1997-hoops-high-voltage-kobe-bryant-1hv-sgc-9-mint'
  );

  // A no-bids auction must fall through 0 to the startingBid floor.
  const noBids = parseFanaticsAlgoliaHit({
    listingUuid: 'u-3',
    title: 'Card A',
    marketplace: 'WEEKLY',
    currentBid: 0,
    startingBid: 5,
  });
  assert.equal(noBids.price, 5);

  // All three marketplace segments (each verified live 2026-07-30).
  const premier = parseFanaticsAlgoliaHit({ listingUuid: 'u-4', title: 'Card B', marketplace: 'PREMIER', currentBid: 100 });
  assert.equal(premier.url, 'https://www.fanaticscollect.com/premier/u-4/card-b');
  assert.equal(premier.listingType, 'auction');
  const buyNow = parseFanaticsAlgoliaHit({ listingUuid: 'u-5', title: 'Card C', marketplace: 'FIXED', buyNowPrice: 50 });
  assert.equal(buyNow.url, 'https://www.fanaticscollect.com/buy-now/u-5/card-c');
  assert.equal(buyNow.listingType, 'fixed');
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
  // Abbreviated countdowns too (MySlabs renders "06d 19h 13m").
  assert.equal(parseHeritageEnds('06d 19h 13m', now), '2026-08-05T07:13:00.000Z');
  // A bare date is resolved in Heritage's own Central zone, at end of day —
  // an EXACT instant, so a machine in another timezone fails this test
  // instead of silently storing a different end time. A prefix match on
  // /^2026-08-09T/ passed anywhere west of UTC and hid the bug.
  assert.equal(parseHeritageEnds('Aug 9, 2026', now), '2026-08-10T04:59:00.000Z');
  assert.equal(parseHeritageEnds('Auction Ended', now), null);
  assert.equal(parseHeritageEnds(null, now), null);
});

test('cia: lot-link fallback parses skinned pages without stock blocks', () => {
  // The countdown sits far past the anchor (it did on the live page too:
  // 1118-3762 chars), and the STARTING span comes first — the old fixed
  // 1200-char window never reached either, so this returned a null end.
  const filler = '<div class="pad">' + 'x'.repeat(1500) + '</div>';
  const html = `
    <div class="custom-skin-card">
      <a href="/Event/LotDetails/4696386/1996-skybox-kobe"><img src="x.jpg"></a>
      <a href="/Event/LotDetails/4696386/1996-skybox-kobe">1996 Skybox Kobe Bryant PSA 8</a>
      <div class="bid">Current Bid: $1,225.00</div>
      ${filler}
      <span data-epoch="starting" data-action-time="08/06/2026 12:00:00"></span>
      <span data-epoch="ending" data-end-hide-selector="[data-listingid='4696387'] .x" data-action-time="08/16/2026 21:00:00"></span>
    </div>
    <a href="/Listing/Details/555/other">2003 Topps Chrome LeBron James BGS 9.5 rookie</a>`;
  const out = parseAuctionWorxLotLinks(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].listingId, '4696386');
  assert.equal(out[0].price, 1225);
  assert.equal(out[0].endsAt, '2026-08-17T01:00:00.000Z'); // ending, not starting
  assert.equal(out[1].listingId, '555');
});

test('cia: data-listingid on non-section elements still parses', () => {
  const html = `<div data-listingid="778" class="row">
    <h1 class="title"><a href="/Event/LotDetails/777/slug">Lot 7 - 1979 OPC Gretzky PSA 5</a></h1>
    <span class="awe-rt-CurrentPrice price">$900.00</span>
  </div>`;
  const out = parseAuctionWorxBrowse(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].listingId, '777');
  assert.equal(out[0].title, '1979 OPC Gretzky PSA 5'); // house lot prefix stripped
  assert.equal(out[0].price, 900);
});

test('cia: a lot whose only text anchor is a CTA button is skipped, not titled "Preview"', () => {
  const html = `<section data-listingid="9">
    <a href="/Event/LotDetails/9/x"><img src="i.jpg"></a>
    <a href="/Event/LotDetails/9/x" class="btn"><span>Preview </span></a>
  </section>`;
  assert.deepEqual(parseAuctionWorxBrowse(html), []);
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

  // endsAt here is DRIFT INSURANCE, not Alt's real field — see the
  // live-shape test below for what Alt actually sends.
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

test('alt: a real Typesense auction document keeps its end time', async () => {
  const { mapAltListing } = await import('../src/marketplace/sources/alt.js');
  // Verbatim field shape from a live capture (2026-08-01,
  // production_universal_search). Alt names the close "expiresAt" — the
  // adapter used to read endsAt/endTime/auctionEndsAt/closesAt, none of
  // which Alt sends, so every auction stored a NULL end date: no
  // ending-soon alert, no countdown, and never removed by the
  // ended-auction sweep. The old fixture invented the field name, so the
  // tests agreed with the bug.
  const doc = {
    id: '72f6269d-f421-416f-a70c-f7bc6a614590',
    objectID: '72f6269d-f421-416f-a70c-f7bc6a614590',
    listingId: '72f6269d-f421-416f-a70c-f7bc6a614590',
    name: '1995 Skybox E-Xl Blue Michael Jordan #10',
    itemName: '1995 Skybox E-Xl Blue Michael Jordan #10 PSA 10',
    listingType: 'AUCTION',
    auctionHouse: 'Alt',
    price: 62,
    priceCents: 6200,
    expiresAt: '2026-08-07 01:05:00+00:00',
    expiresAtEpoch: 1786064700,
    startsAt: '2026-07-24 13:00:00+00:00',
    hasAuctionEnded: false,
    auctionCycleId: 3238,
    gradingCompany: 'PSA',
    grade: '10',
    seller: 'jacksonsportscards',
    images: [{ position: 'FRONT', url: 'https://onlyalt-images.s3.us-east-2.amazonaws.com/x.jpg' }],
  };
  const r = mapAltListing(doc);
  assert.equal(r.listingType, 'auction');
  assert.equal(r.endsAt, '2026-08-07T01:05:00.000Z');
  assert.equal(r.price, 62);
  assert.equal(r.seller, 'jacksonsportscards');
  assert.match(r.title, /PSA 10$/); // slab folded in for the match layer
  assert.equal(r.imageUrl, 'https://onlyalt-images.s3.us-east-2.amazonaws.com/x.jpg');

  // The string form alone (no epoch) must land on the same instant — it
  // carries an explicit +00:00, so it must never be read as local time.
  const strOnly = mapAltListing({ ...doc, expiresAtEpoch: undefined });
  assert.equal(strOnly.endsAt, '2026-08-07T01:05:00.000Z');

  // A Buy It Now's expiry is a renewal date, not a deadline — not stored.
  const buyNow = mapAltListing({ ...doc, listingType: 'BUY_NOW' });
  assert.equal(buyNow.listingType, 'fixed');
  assert.equal(buyNow.endsAt, null);
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

test('fanatics: payload URL wins; known marketplace builds a deep link; unknown falls to search', async () => {
  const { buildFanaticsUrl, fanaticsSlug, parseFanaticsAlgoliaHit } = await import('../src/marketplace/sources/fanatics.js');

  // A URL the API actually gave us wins even over a buildable deep link
  assert.equal(
    buildFanaticsUrl({ url: 'https://www.fanaticscollect.com/weekly-auction/x_123', listingUuid: 'u', marketplace: 'WEEKLY', title: 't' }),
    'https://www.fanaticscollect.com/weekly-auction/x_123'
  );
  assert.equal(
    buildFanaticsUrl({ path: '/weekly-auction/x_123' }),
    'https://www.fanaticscollect.com/weekly-auction/x_123'
  );

  // Known marketplace + uuid -> the real /buy-now/<uuid>/<slug> deep link
  const hit = parseFanaticsAlgoliaHit({
    listingUuid: 'a741a966-8b92-11f1-9b47-02ffd3767c89',
    title: '1986 Fleer Michael Jordan #57 PSA 8',
    marketplace: 'FIXED',
    buyNowPrice: 500,
  });
  assert.equal(
    hit.url,
    'https://www.fanaticscollect.com/buy-now/a741a966-8b92-11f1-9b47-02ffd3767c89/1986-fleer-michael-jordan-57-psa-8'
  );

  // Unknown marketplace -> a search link that resolves, never a 404 guess
  const unknown = parseFanaticsAlgoliaHit({
    listingUuid: 'u-9',
    title: 'Mystery Card',
    marketplace: 'SOMETHING_NEW',
    price: 5,
  });
  assert.match(unknown.url, /^https:\/\/www\.fanaticscollect\.com\/search\?query=/);
  assert.match(unknown.url, /Mystery/);

  // Slug shape: every non-alphanumeric run collapses to ONE dash
  assert.equal(fanaticsSlug('1997 Hoops High Voltage Kobe Bryant #1HV SGC 9 MINT'), '1997-hoops-high-voltage-kobe-bryant-1hv-sgc-9-mint');
  assert.equal(fanaticsSlug('  NAT. VIP #6  '), 'nat-vip-6');
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

test('fetchWithTimeout: a timeout reports itself as one, never a bare abort', async () => {
  // "This operation was aborted" in a check-run failure told the user
  // nothing. A server that accepts and never answers forces the timer path.
  const { createServer } = await import('node:http');
  const { fetchWithTimeout } = await import('../src/marketplace/sources/util.js');
  const srv = createServer(() => { /* hold the socket open, never respond */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${srv.address().port}/slow?q=x`, { timeoutMs: 300 }),
      (err) =>
        err.timedOut === true &&
        /timed out after \ds/.test(err.message) &&
        err.message.includes('/slow') &&
        !err.message.includes('q=x') // query strings can carry card names; keep them out of error text
    );
  } finally {
    srv.close();
  }
});

test('alt: slab-less titles get grader+grade folded in from metadata', async () => {
  const { mapAltListing } = await import('../src/marketplace/sources/alt.js');
  // Alt's real shape: grade in fields, not in the title (why 279 watches
  // produced zero Alt matches — the slab gate never saw a grade).
  const folded = mapAltListing({
    id: 'ast_9',
    name: '1986 Fleer Michael Jordan #57',
    gradingCompany: 'BGS',
    grade: 9,
    lowestAsk: 250000,
  });
  assert.equal(folded.title, '1986 Fleer Michael Jordan #57 BGS 9');

  // A title that already names a slab is left alone.
  const already = mapAltListing({
    id: 'ast_10',
    name: '1986 Fleer Michael Jordan #57 PSA 8',
    gradingCompany: 'PSA',
    grade: 8,
    lowestAsk: 100000,
  });
  assert.equal(already.title, '1986 Fleer Michael Jordan #57 PSA 8');

  // No metadata -> unchanged (and still a valid listing via price).
  const bare = mapAltListing({ id: 'ast_11', name: '1986 Fleer Michael Jordan #57', lowestAsk: 5000 });
  assert.equal(bare.title, '1986 Fleer Michael Jordan #57');
});

test('heritage: searches the URL Heritage actually serves, not the redirecting one', async () => {
  const { heritageSearchUrl } = await import('../src/marketplace/sources/heritage.js');
  const url = heritageSearchUrl('1986 Fleer Michael Jordan BGS 8');
  // Live-verified 2026-07-31: /c/search-results.zx?Ntt= 302s to this form and
  // renders only after the hop, which the old fixed 2s wait raced — 252
  // searches produced 1 stored listing. This URL serves tiles immediately.
  assert.equal(
    url,
    'https://sports.ha.com/c/search/results.zx?term=1986+Fleer+Michael+Jordan+BGS+8&mode=live&layout=list'
  );
  assert.ok(!url.includes('search-results.zx'), 'must not use the redirecting path');
  assert.ok(!url.includes('Ntt='), 'must not use the old Ntt parameter');
});

test('toIsoDate: epoch seconds, epoch ms, ISO strings, and the toNumber trap', async () => {
  const { toIsoDate, toNumber } = await import('../src/marketplace/sources/util.js');
  // The trap: toNumber mangles an ISO string into a small number, so an
  // epoch-only converter silently returned null for a valid date.
  assert.equal(toNumber('2026-07-31T02:00:00Z'), 2026);
  assert.equal(toIsoDate('2026-07-31T02:00:00Z'), '2026-07-31T02:00:00.000Z');

  assert.equal(toIsoDate(1785722400), new Date(1785722400 * 1000).toISOString()); // seconds
  assert.equal(toIsoDate(1785722400000), new Date(1785722400000).toISOString()); // ms
  assert.equal(toIsoDate('1785722400'), new Date(1785722400 * 1000).toISOString()); // epoch as string
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate('not a date'), null);
  assert.equal(toIsoDate(2026), null); // too small to be an epoch
  assert.equal(toIsoDate(NaN), null);
});

test('goldin: ISO end_timestamp survives (every auction had a null end date)', async () => {
  const { parseGoldinLots } = await import('../src/marketplace/sources/goldin.js');
  // Field shape exactly as the live lots_v2 payload returns it.
  const out = parseGoldinLots({
    searchalgolia: { lots: [{
      lot_id: '202607-2113-4455-169a6056',
      title: '1992-93 Topps Stadium Club Beam Team #1 Michael Jordan - BGS 9',
      meta_slug: '1992-93-topps-stadium-club-beam-team-1-michael-jordan',
      current_price: 900,
      start_timestamp: '2026-07-21T21:00:00Z',
      end_timestamp: '2026-07-31T02:00:00Z',
      auction_type: 'Weekly',
    }] },
  }, null, 'auction');
  assert.equal(out.length, 1);
  assert.equal(out[0].endsAt, '2026-07-31T02:00:00.000Z');
  // An epoch-shaped payload must still work, in case Goldin switches back.
  const epoch = parseGoldinLots(
    { searchalgolia: { lots: [{ lot_id: '1', title: 'x', end_timestamp: 1785722400 }] } }, null, 'auction'
  );
  assert.equal(epoch[0].endsAt, new Date(1785722400 * 1000).toISOString());
});
