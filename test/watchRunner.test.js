import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_CL = '1';
process.env.NTFY_TOPIC = ''; // pushes disabled: new listings stay status 'new'
// Email hard-off for tests: dotenv never overrides pre-set vars, so this
// wins over whatever the real .env has — no test may ever send real mail.
process.env.GMAIL_USER = '';
process.env.GMAIL_APP_PASSWORD = '';
process.env.EMAIL_TO = '';
// Pin the price-drop threshold to its documented default (intEnv parses ''
// as NaN and falls back to 10). Without this, the boundary assertions below
// silently test whatever the machine's .env happens to set.
process.env.FOLLOW_DROP_PCT = '';

const { openDb } = await import('../src/db/db.js');
const { makeQueries } = await import('../src/db/queries.js');
const { createSyncManager } = await import('../src/sync/syncRunner.js');
const { createWatchRunner, priceDropped, orderSources, nextFireDelayMs, isBetterOwner } = await import('../src/marketplace/watchRunner.js');
const { sendEmail, emailConfigured } = await import('../src/marketplace/notify.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilDone(mgr, timeoutMs = 20000) {
  const start = Date.now();
  while (mgr.status().running) {
    if (Date.now() - start > timeoutMs) throw new Error('did not finish in time');
    await sleep(25);
  }
}

// A fresh in-memory app with cards populated by the mock ladder sync, plus a
// watch on the 1986 Fleer Jordan #57 (the card the market fixtures target).
async function freshWatched({ maxPrice = null, company = 'SGC', grade = '10' } = {}) {
  const db = openDb(':memory:');
  const q = makeQueries(db);
  // Pre-seed the FX cache so ensureRates() never touches the network — the
  // tests must be hermetic (and CAD assertions deterministic at 1.37/USD).
  q.kvSet.run('fx:usd', JSON.stringify({ USD: 1, CAD: 1.37, EUR: 0.92, GBP: 0.79 }));
  const syncManager = createSyncManager(db, q);
  await syncManager.start({});
  await waitUntilDone(syncManager);

  const card = q.getCardByClId.get('spec:299576');
  assert.ok(card, 'mock sync stored the Jordan card');
  q.insertWatch.run({ cardId: card.id, gradingCompany: company, grade, maxPrice });
  const watch = q.getWatchByKey.get(card.id, company, grade);

  const runner = createWatchRunner(db, q, { syncManager });
  return { db, q, runner, watch, card };
}

test('check finds, scores, and stores matching listings; hard failures are dropped', async () => {
  const { q, runner, watch } = await freshWatched();
  const runId = await runner.start({});
  await waitUntilDone(runner);

  const run = q.getWatchRun.get(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.items_failed, 0);
  assert.equal(run.new_listings, 3);

  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  const ids = stored.map((l) => l.listing_id).sort();
  // wrong grade (SGC 9), wrong grader (PSA 10), wrong player (Bird) never
  // stored; the long-ended auction is found by the search but never even
  // inserted — its captured end date is already in the past on first sight.
  assert.deepEqual(ids, ['mkt-auction-1', 'mkt-fixed-cad', 'mkt-reprint']);
  assert.equal(q.getListingByKey.get('mockmarket', 'mkt-ended-auction'), undefined);

  // the reprint survives but with a visibly low confidence score
  const reprint = stored.find((l) => l.listing_id === 'mkt-reprint');
  assert.ok(reprint.match_score < 0.7, `score ${reprint.match_score}`);
  assert.ok(JSON.parse(reprint.match_debug).penalties.includes('word:reprint'));

  // the CAD listing was normalized to a plausible USD figure
  const cad = stored.find((l) => l.listing_id === 'mkt-fixed-cad');
  assert.equal(cad.currency, 'CAD');
  assert.ok(cad.price_usd > 20000 && cad.price_usd < 36000, `price_usd ${cad.price_usd}`);

  // pushes are disabled, so live matches stay 'new'
  assert.equal(stored.find((l) => l.listing_id === 'mkt-auction-1').status, 'new');
  assert.equal(runner.status().newCount, 3);
});

test('second check dedupes: refreshes rows instead of re-inserting', async () => {
  const { q, runner } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);
  const firstCount = q.countActiveMatches.get().n;

  const runId2 = await runner.start({});
  await waitUntilDone(runner);
  assert.equal(q.getWatchRun.get(runId2).new_listings, 0);
  assert.equal(q.countActiveMatches.get().n, firstCount);
});

test('the PSA side of the same card matches the PSA vault listing', async () => {
  const { q, runner, watch } = await freshWatched({ company: 'PSA' });
  await runner.start({});
  await waitUntilDone(runner);
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.deepEqual(stored.map((l) => l.listing_id), ['mkt-psa-side']);
});

test('max_price caps new listings in USD', async () => {
  const { q, runner, watch } = await freshWatched({ maxPrice: 1000 });
  await runner.start({});
  await waitUntilDone(runner);
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  // only the $49 reprint sneaks under a $1,000 cap
  assert.deepEqual(stored.map((l) => l.listing_id), ['mkt-reprint']);
});

test('second start while running is rejected with 409', async () => {
  process.env.MOCK_MARKET_MS = '300';
  try {
    const { runner } = await freshWatched();
    await runner.start({});
    await assert.rejects(() => runner.start({}), (err) => err.code === 409);
    runner.cancel();
    await waitUntilDone(runner);
  } finally {
    // finally, not tail code: a failed assertion above must not leak the
    // slow-mock setting into every later test in this process.
    delete process.env.MOCK_MARKET_MS;
  }
});

test('start with no watches is a 400', async () => {
  const db = openDb(':memory:');
  const q = makeQueries(db);
  const runner = createWatchRunner(db, q, {});
  await assert.rejects(() => runner.start({}), (err) => err.code === 400);
});

test('reminder window and staleness queries behave', async () => {
  const { db, q, runner } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  // Auction ending in ~10h falls inside the 24h reminder window, once.
  db.prepare(`UPDATE listings SET ends_at = datetime('now', '+10 hours') WHERE listing_id = 'mkt-auction-1'`).run();
  const due = q.reminderCandidates.all({ minutes: 1440 });
  assert.deepEqual(due.map((l) => l.listing_id), ['mkt-auction-1']);
  q.markListingReminded.run(due[0].id);
  assert.equal(q.reminderCandidates.all({ minutes: 1440 }).length, 0);

  // A fixed listing that misses 3 consecutive checks is deleted outright.
  db.prepare(`UPDATE listings SET misses = 3 WHERE listing_id = 'mkt-fixed-cad'`).run();
  q.deleteStaleListings.run();
  assert.equal(q.getListingByKey.get('mockmarket', 'mkt-fixed-cad'), undefined);
});

test('an auction with no end date ages out via misses instead of living forever', async () => {
  // deleteEndedAuctions needs an ends_at, so an auction whose end time a
  // source never reported (every Goldin auction, before the ISO fix) could
  // never be removed by any path. Those must accrue misses like fixed ones.
  const { db, q, runner, watch } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const auction = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  db.prepare(`UPDATE listings SET ends_at = NULL WHERE id = ?`).run(auction.id);

  // A check that doesn't see it bumps the counter (last_seen_at predates it).
  q.bumpListingMisses.run({ watchId: watch.id, source: 'mockmarket', runStartedAt: '2099-01-01 00:00:00' });
  assert.equal(q.getListingById.get(auction.id).misses, 1);

  // An auction that DOES have an end date is left alone — it gets deleted
  // when that date passes, so miss-counting it would remove it early.
  db.prepare(`UPDATE listings SET ends_at = '2099-01-01 00:00:00', misses = 0 WHERE id = ?`).run(auction.id);
  q.bumpListingMisses.run({ watchId: watch.id, source: 'mockmarket', runStartedAt: '2099-01-01 00:00:00' });
  assert.equal(q.getListingById.get(auction.id).misses, 0);
});

test('follow flag: round-trip, Following filter, unfollow resets the reminder flag', async () => {
  const { q, runner, watch } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const auction = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  q.setListingFollowed.run({ id: auction.id, followed: 1 });

  // followed=1 returns only the tagged row; followed=null returns everything.
  const followedRows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: 1 });
  assert.deepEqual(followedRows.map((l) => l.listing_id), ['mkt-auction-1']);
  const allRows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.ok(allRows.length > followedRows.length);

  // Unfollowing resets follow_reminder_sent so a later re-follow can alert again.
  q.markListingFollowReminded.run(auction.id);
  assert.equal(q.getListingById.get(auction.id).follow_reminder_sent, 1);
  q.setListingFollowed.run({ id: auction.id, followed: 0 });
  const after = q.getListingById.get(auction.id);
  assert.equal(after.followed, 0);
  assert.equal(after.follow_reminder_sent, 0);
});

test('followed auctions leave the generic reminder and enter the Following one, once', async () => {
  const { db, q, runner } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  db.prepare(`UPDATE listings SET ends_at = datetime('now', '+10 hours') WHERE listing_id = 'mkt-auction-1'`).run();
  const auction = q.getListingByKey.get('mockmarket', 'mkt-auction-1');

  // Unfollowed: generic aggregate only.
  assert.equal(q.reminderCandidates.all({ minutes: 1440 }).length, 1);
  assert.equal(q.followReminderCandidates.all({ minutes: 1440 }).length, 0);

  // Followed: swaps lists — the per-item alert owns it now.
  q.setListingFollowed.run({ id: auction.id, followed: 1 });
  assert.equal(q.reminderCandidates.all({ minutes: 1440 }).length, 0);
  const due = q.followReminderCandidates.all({ minutes: 1440 });
  assert.deepEqual(due.map((l) => l.listing_id), ['mkt-auction-1']);
  assert.ok(due[0].card_name, 'joined to the watch for the alert text');

  // Outside the window (10h to go, 1h window) -> not due.
  assert.equal(q.followReminderCandidates.all({ minutes: 60 }).length, 0);
  // Dedupe flag: alerted once, never again.
  q.markListingFollowReminded.run(auction.id);
  assert.equal(q.followReminderCandidates.all({ minutes: 1440 }).length, 0);
});

test('priceDropped: native-currency decreases of followDropPct or more', () => {
  const fixed = (over) => ({ price: 100, currency: 'USD', ...over });
  // Exactly 10% (the default threshold) alerts; epsilon absorbs float rounding.
  assert.equal(priceDropped(fixed(), { price: 90, currency: 'USD' }), true);
  assert.equal(priceDropped(fixed(), { price: 89.99, currency: 'USD' }), true);
  // Smaller decreases stay silent — a $5 nudge on $100 isn't alert material.
  assert.equal(priceDropped(fixed(), { price: 95, currency: 'USD' }), false);
  assert.equal(priceDropped(fixed(), { price: 90.01, currency: 'USD' }), false);
  assert.equal(priceDropped(fixed(), { price: 100, currency: 'USD' }), false);
  assert.equal(priceDropped(fixed(), { price: 110, currency: 'USD' }), false);
  // Threshold 0 restores alert-on-any-decrease (minus sub-cent noise).
  assert.equal(priceDropped(fixed(), { price: 99, currency: 'USD' }, 0), true);
  assert.equal(priceDropped(fixed(), { price: 99.999, currency: 'USD' }, 0), false);
  // FX guard: a currency change is never a "drop", whatever the number says.
  assert.equal(priceDropped(fixed(), { price: 90, currency: 'CAD' }), false);
  // Missing currency defaults to USD on both sides.
  assert.equal(priceDropped({ price: 100, currency: null }, { price: 90 }), true);
  // Unknown prices can't drop; sub-cent noise is ignored.
  assert.equal(priceDropped(fixed({ price: null }), { price: 90, currency: 'USD' }), false);
  assert.equal(priceDropped(fixed(), { price: null, currency: 'USD' }), false);
  assert.equal(priceDropped(fixed(), { price: 99.999, currency: 'USD' }), false);
});

test('a followed Buy It Now re-sighted cheaper is flagged as a price drop', async () => {
  const { db, q, runner } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  // Follow the CAD fixed listing, then pretend its stored price predates a
  // seller discount: bump it ABOVE the fixture price so the next re-sighting
  // (at the fixture's 36,000 CAD) is a decrease — exactly the 10% default.
  const cad = q.getListingByKey.get('mockmarket', 'mkt-fixed-cad');
  db.prepare(`UPDATE listings SET followed = 1, price = 40000 WHERE id = ?`).run(cad.id);
  // Negative gates at the CALL SITE (the unit test only pins the predicate):
  // an UNFOLLOWED fixed listing with a big drop must not alert…
  const reprint = q.getListingByKey.get('mockmarket', 'mkt-reprint');
  db.prepare(`UPDATE listings SET followed = 0, price = 100 WHERE id = ?`).run(reprint.id);
  // …and neither may a FOLLOWED AUCTION whose current bid re-sights lower
  // (bids fluctuate; only Buy It Nows are drop material).
  const auction = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  db.prepare(`UPDATE listings SET followed = 1, price = 99999 WHERE id = ?`).run(auction.id);

  await runner.start({});
  await waitUntilDone(runner);

  const drops = runner.status().priceDrops;
  assert.equal(drops.length, 1);
  assert.equal(drops[0].id, cad.id);
  assert.equal(drops[0].oldPrice, 40000);
  assert.equal(drops[0].newPrice, 36000);
  assert.equal(drops[0].currency, 'CAD');
  // The refresh itself still landed the new price.
  assert.equal(q.getListingById.get(cad.id).price, 36000);

  // Same price on the NEXT check -> no phantom drop.
  await runner.start({});
  await waitUntilDone(runner);
  assert.equal(runner.status().priceDrops.length, 0);

  // A sub-threshold decrease (36,000 -> 37,000 stored, ~2.7% back down to
  // 36,000) stays silent — the followDropPct gate applies at the call site.
  db.prepare(`UPDATE listings SET price = 37000 WHERE id = ?`).run(cad.id);
  await runner.start({});
  await waitUntilDone(runner);
  assert.equal(runner.status().priceDrops.length, 0);
});

test('a custom search term replaces the generated queries verbatim', async () => {
  const { q, runner, watch } = await freshWatched();

  // Nonsense override: shares <2 tokens with every fixture title, so the
  // mock market returns nothing — and with an override there is no loose
  // fallback, so the watch genuinely finds zero.
  q.setWatchSearchTerm.run('zzz qqq', watch.id);
  await runner.start({});
  await waitUntilDone(runner);
  assert.equal(q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null }).length, 0);

  // A sensible override finds listings — and the match layer still gates:
  // the PSA vault copy and the Larry Bird fixture never get stored for this
  // SGC 10 watch, whatever the query said.
  q.setWatchSearchTerm.run('1986 Fleer Jordan', watch.id);
  await runner.start({});
  await waitUntilDone(runner);
  const rows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.ok(rows.length > 0, 'override query found listings');
  assert.ok(!rows.some((l) => l.listing_id === 'mkt-psa-side' || l.listing_id === 'mkt-other-player'));

  // Clearing the override restores the automatic queries.
  q.setWatchSearchTerm.run(null, watch.id);
  await runner.start({});
  await waitUntilDone(runner);
  assert.ok(
    q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null }).length >= rows.length
  );
});

test('isBetterOwner: score first, specificity breaks ties, incumbent keeps true ties', () => {
  const owned = (score, specificity) => ({ match_score: score, match_specificity: specificity });
  // Higher score always wins.
  assert.equal(isBetterOwner({ score: 0.9, specificity: 1 }, owned(0.8, 9)), true);
  assert.equal(isBetterOwner({ score: 0.7, specificity: 9 }, owned(0.8, 1)), false);
  // Equal score -> the more specific watch takes it (the Beam Team case).
  assert.equal(isBetterOwner({ score: 1, specificity: 8 }, owned(1, 6)), true);
  assert.equal(isBetterOwner({ score: 1, specificity: 6 }, owned(1, 8)), false);
  // Dead tie -> incumbent stays, so ownership cannot oscillate run to run.
  assert.equal(isBetterOwner({ score: 1, specificity: 6 }, owned(1, 6)), false);
  // Legacy rows predate match_specificity (NULL) -> treated as 0.
  assert.equal(isBetterOwner({ score: 1, specificity: 1 }, { match_score: 1 }), true);
});

test('a contested listing moves to the better-matching watch', async () => {
  const { db, q, runner, card } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const listing = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  assert.ok(listing, 'the auction listing was stored');
  const rightfulOwner = listing.watch_id;

  // Hand it to a different watch with a deliberately poor match, as a
  // first-searched-but-worse watch would have done.
  q.insertWatch.run({ cardId: card.id, gradingCompany: 'BGS', grade: '9', maxPrice: null });
  const other = q.getWatchByKey.get(card.id, 'BGS', '9');
  db.prepare('UPDATE listings SET watch_id = ?, match_score = 0.3, match_specificity = 1 WHERE id = ?')
    .run(other.id, listing.id);

  // Next check: the genuinely-better watch reclaims it, in place.
  await runner.start({});
  await waitUntilDone(runner);
  const after = q.getListingById.get(listing.id);
  assert.equal(after.watch_id, rightfulOwner, 'reassigned to the better match');
  assert.ok(after.match_score > 0.3);
  assert.equal(q.getListingByKey.get('mockmarket', 'mkt-auction-1').id, listing.id, 'same row, not a duplicate');
});

test('reassignment preserves the user-owned flags', async () => {
  const { db, q, runner, card } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const listing = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  q.insertWatch.run({ cardId: card.id, gradingCompany: 'BGS', grade: '9', maxPrice: null });
  const other = q.getWatchByKey.get(card.id, 'BGS', '9');
  // Followed by the user, and parked on the wrong watch.
  db.prepare('UPDATE listings SET watch_id = ?, match_score = 0.3, match_specificity = 1, followed = 1 WHERE id = ?')
    .run(other.id, listing.id);

  await runner.start({});
  await waitUntilDone(runner);
  const after = q.getListingById.get(listing.id);
  assert.notEqual(after.watch_id, other.id, 'ownership moved');
  assert.equal(after.followed, 1, 'still followed — the flag is the user\'s, not the watch\'s');
});

test('a hand-pinned watched card survives the next check', async () => {
  const { db, q, runner, card } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const listing = q.getListingByKey.get('mockmarket', 'mkt-auction-1');
  q.insertWatch.run({ cardId: card.id, gradingCompany: 'BGS', grade: '9', maxPrice: null });
  const other = q.getWatchByKey.get(card.id, 'BGS', '9');

  // The user pins it to a deliberately worse-matching watch.
  q.setListingWatch.run({ id: listing.id, watchId: other.id, matchScore: 0.3, matchSpecificity: 1, locked: 1 });

  await runner.start({});
  await waitUntilDone(runner);
  assert.equal(q.getListingById.get(listing.id).watch_id, other.id, 'the pin outranks the scorer');

  // Releasing the pin lets automatic reassignment take it back.
  db.prepare('UPDATE listings SET watch_locked = 0 WHERE id = ?').run(listing.id);
  await runner.start({});
  await waitUntilDone(runner);
  assert.notEqual(q.getListingById.get(listing.id).watch_id, other.id, 'released -> scorer owns it again');
});

test('per-source stats back the Sources tab', async () => {
  const { q, runner } = await freshWatched();
  const runId = await runner.start({});
  await waitUntilDone(runner);

  const stats = q.watchRunSourceStats.all(runId);
  assert.equal(stats.length, 1, 'one source in mock mode');
  assert.equal(stats[0].source, 'mockmarket');
  assert.ok(stats[0].done > 0);
  assert.equal(stats[0].pending, 0);
  assert.equal(stats[0].failed, 0);

  const counts = q.listingCountsBySource.all();
  assert.equal(counts[0].source, 'mockmarket');
  assert.ok(counts[0].n > 0);

  // source_state is seeded by the run, so the tab can report backoff/enabled.
  assert.ok(q.listSourceState.all().some((s) => s.source === 'mockmarket'));
});

test('a check can be limited to selected sources', async () => {
  const { q, runner } = await freshWatched();
  // "Check Selected" with a source that isn't configured -> nothing to do.
  await assert.rejects(() => runner.start({ only: ['ebay'] }), (err) => err.code === 400);

  // The configured one runs normally.
  const runId = await runner.start({ only: ['mockmarket'] });
  await waitUntilDone(runner);
  const stats = q.watchRunSourceStats.all(runId);
  assert.deepEqual(stats.map((s) => s.source), ['mockmarket']);
});

test('orderSources: priority names first, stragglers keep registry order', () => {
  const s = (name) => ({ name });
  const input = ['miller', 'alt', 'woocommerce', 'ebay', 'shopify', 'fanatics', 'comc'].map(s);
  const out = orderSources(input, ['ebay', 'fanatics', 'comc', 'alt']);
  assert.deepEqual(out.map((x) => x.name), ['ebay', 'fanatics', 'comc', 'alt', 'miller', 'woocommerce', 'shopify']);
  // Input array is not mutated (sources are shared state on the runner).
  assert.equal(input[0].name, 'miller');
});

test('nextFireDelayMs: soonest of the configured times, rolling over midnight', () => {
  // Deterministic zone: UTC. 10:00 -> 11:00 fire = 60 min out.
  const at = (h, m) => new Date(Date.UTC(2026, 6, 31, h, m, 0));
  const times = ['11:00', '21:00'];
  assert.equal(nextFireDelayMs(times, 'UTC', at(10, 0)), 60 * 60_000);
  // 11:00 exactly -> the 11:00 slot is past; next is 21:00.
  assert.equal(nextFireDelayMs(times, 'UTC', at(11, 0)), 10 * 60 * 60_000);
  // 22:30 -> rolls over to tomorrow's 11:00.
  assert.equal(nextFireDelayMs(times, 'UTC', at(22, 30)), 12.5 * 60 * 60_000);
  // Zone-awareness: 14:00 UTC in July = 10:00 in New York (EDT) -> 60 min to 11:00.
  assert.equal(nextFireDelayMs(['11:00'], 'America/New_York', at(14, 0)), 60 * 60_000);
});

test('email: unconfigured send is a clean false, never a throw', async () => {
  // The test env sets none of GMAIL_USER / GMAIL_APP_PASSWORD / EMAIL_TO.
  assert.equal(emailConfigured(), false);
  assert.equal(await sendEmail({ subject: 'x', text: 'y' }), false);
});

test('dismissing a listing deletes it and blocks it from ever coming back', async () => {
  const { db, q, runner, watch } = await freshWatched();
  await runner.start({});
  await waitUntilDone(runner);

  const reprint = q.getListingByKey.get('mockmarket', 'mkt-reprint');
  assert.ok(reprint, 'reprint was matched on the first check');

  const listing = q.getListingById.get(reprint.id);
  db.transaction(() => {
    q.insertDismissedListing.run({
      watchId: listing.watch_id,
      source: listing.source,
      listingId: listing.listing_id,
      canonicalKey: listing.canonical_key,
    });
    q.deleteListing.run(listing.id);
  })();
  assert.equal(q.getListingByKey.get('mockmarket', 'mkt-reprint'), undefined);

  // Same source item resurfaces on the next check — must not be re-inserted.
  await runner.start({});
  await waitUntilDone(runner);
  assert.equal(q.getListingByKey.get('mockmarket', 'mkt-reprint'), undefined);
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.ok(!stored.some((l) => l.listing_id === 'mkt-reprint'));
});

test('psa_value tracks the watched grade, not a hard-coded PSA 10', async () => {
  // Regression: the Listings tab briefly showed the PSA *10* value for every
  // row, which is meaningless for the many watches graded below 10 — an
  // SGC 9 has to be read against PSA 9.
  const { db, q, runner, watch, card } = await freshWatched({ company: 'SGC', grade: '9' });
  await runner.start({});
  await waitUntilDone(runner);

  const priceAt = (company, grade) =>
    db
      .prepare(`SELECT cl_value FROM grade_prices WHERE card_id = ? AND grading_company = ? AND grade = ?`)
      .get(card.id, company, grade)?.cl_value ?? null;

  const psa9 = priceAt('PSA', '9');
  const psa10 = priceAt('PSA', '10');
  // The assertion below is only meaningful if the fixture separates them.
  assert.ok(psa9 != null && psa10 != null && psa9 !== psa10, 'fixture has distinct PSA 9 / PSA 10 values');

  const rows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.ok(rows.length > 0, 'the SGC 9 watch matched at least one listing');
  for (const r of rows) {
    assert.equal(r.psa_value, psa9, `${r.listing_id} should carry the PSA 9 value`);
    assert.notEqual(r.psa_value, psa10);
  }
});

test('a PSA watch reports its own value as psa_value', async () => {
  // Degenerate but correct: watching a PSA slab means cl_value and psa_value
  // are the same number — the join must not silently drop to NULL.
  const { q, runner, watch } = await freshWatched({ company: 'PSA', grade: '10' });
  await runner.start({});
  await waitUntilDone(runner);

  const rows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50, followed: null });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.psa_value != null, 'PSA watch must still resolve a psa_value');
    assert.equal(r.psa_value, r.cl_value);
  }
});

// --- source-health failAll paths and the exclude filter ---------------------

test('a disabled source fails every item with the disabled reason', async () => {
  const { db, q, runner } = await freshWatched();
  q.ensureSourceState.run('mockmarket');
  db.prepare(`UPDATE source_state SET enabled = 0 WHERE source = 'mockmarket'`).run();

  const runId = await runner.start({});
  await waitUntilDone(runner);

  const run = q.getWatchRun.get(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.items_failed, run.items_total);
  const failures = q.watchRunFailures.all(runId);
  assert.ok(failures.some((f) => /source disabled/.test(f.error)), JSON.stringify(failures));
});

test('a source in backoff fails the run, then succeeds once the window clears', async () => {
  const { q, runner } = await freshWatched();
  q.ensureSourceState.run('mockmarket');
  q.setSourceBackoff.run('2099-01-01 00:00:00', 'mockmarket');

  const runId = await runner.start({});
  await waitUntilDone(runner);
  const failures = q.watchRunFailures.all(runId);
  assert.ok(failures.some((f) => /backoff until 2099-01-01/.test(f.error)), JSON.stringify(failures));

  q.setSourceBackoff.run(null, 'mockmarket');
  const runId2 = await runner.start({});
  await waitUntilDone(runner);
  assert.equal(q.getWatchRun.get(runId2).items_failed, 0);
});

test('exclude filters sources; excluding everything is a 400', async () => {
  const { runner } = await freshWatched();
  await assert.rejects(() => runner.start({ exclude: ['mockmarket'] }), (err) => err.code === 400);
});

// --- cross-source concurrency (injected stub sources) -----------------------

const stubSource = (name, { needsBrowser = false, delayMs = 20, onStart, onClose, failWith } = {}) => ({
  name,
  needsBrowser,
  minIntervalMs: 0,
  async start() { onStart?.(name); },
  async search() {
    await sleep(delayMs);
    if (failWith) throw failWith;
    return [];
  },
  async close() { onClose?.(name); },
});

test('browser sources honor the tab pool (2) while HTTP sources all run at once', async () => {
  const { db, q, syncManager } = await (async () => {
    const f = await freshWatched();
    return { db: f.db, q: f.q, syncManager: null };
  })();
  let activeBrowser = 0;
  let peakBrowser = 0;
  const closed = [];
  const mk = (name, needsBrowser) =>
    stubSource(name, {
      needsBrowser,
      delayMs: 60,
      onStart: () => {
        if (needsBrowser) {
          activeBrowser += 1;
          peakBrowser = Math.max(peakBrowser, activeBrowser);
        }
      },
      onClose: (n) => {
        if (needsBrowser) activeBrowser -= 1;
        closed.push(n);
      },
    });
  const sources = [mk('h1', false), mk('h2', false), mk('b1', true), mk('b2', true), mk('b3', true)];
  const runner = createWatchRunner(db, q, { sourcesFactory: async () => sources });

  const runId = await runner.start({});
  await waitUntilDone(runner);

  const run = q.getWatchRun.get(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.items_failed, 0);
  assert.equal(run.items_processed, run.items_total);
  // Pool discipline: exactly 2 tabs deep, never 3 — and every source closed.
  assert.equal(peakBrowser, 2);
  assert.equal(activeBrowser, 0);
  assert.deepEqual([...closed].sort(), ['b1', 'b2', 'b3', 'h1', 'h2']);
});

test('a rate-limited source backs off without poisoning concurrent sources', async () => {
  const { db, q } = await freshWatched();
  const sources = [
    stubSource('limited', { failWith: Object.assign(new Error('429 slow down'), { rateLimited: true }) }),
    stubSource('healthy', {}),
  ];
  const runner = createWatchRunner(db, q, { sourcesFactory: async () => sources });

  const runId = await runner.start({});
  await waitUntilDone(runner);

  const run = q.getWatchRun.get(runId);
  assert.equal(run.status, 'completed'); // one bad source never fails the run
  const stats = new Map(q.watchRunSourceStats.all(runId).map((r) => [r.source, r]));
  assert.equal(stats.get('limited').failed, 1);
  assert.equal(stats.get('healthy').done, 1);
  assert.ok(q.getSourceState.get('limited').backoff_until, 'backoff window was set');
});

test('cancel() stops all lanes: run ends cancelled, unprocessed items stay pending', async () => {
  const { db, q, card } = await freshWatched();
  // Two more watches so each source has several items to walk through.
  q.insertManualWatch.run({ description: 'cancel probe one', gradingCompany: 'None', grade: 'Raw', maxPrice: null });
  q.insertManualWatch.run({ description: 'cancel probe two', gradingCompany: 'None', grade: 'Raw', maxPrice: null });

  const closed = [];
  const sources = [stubSource('slowpoke', { delayMs: 250, onClose: (n) => closed.push(n) })];
  const runner = createWatchRunner(db, q, { sourcesFactory: async () => sources });

  const runId = await runner.start({});
  await sleep(100); // mid-first-item
  assert.equal(runner.cancel(), true);
  await waitUntilDone(runner);

  assert.equal(q.getWatchRun.get(runId).status, 'cancelled');
  assert.ok(q.pendingWatchItems.all(runId).length > 0, 'later items were never attempted');
  assert.deepEqual(closed, ['slowpoke'], 'the started source was still closed');
});
