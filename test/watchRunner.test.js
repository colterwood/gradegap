import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_CL = '1';
process.env.NTFY_TOPIC = ''; // pushes disabled: new listings stay status 'new'

const { openDb } = await import('../src/db/db.js');
const { makeQueries } = await import('../src/db/queries.js');
const { createSyncManager } = await import('../src/sync/syncRunner.js');
const { createWatchRunner } = await import('../src/marketplace/watchRunner.js');

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

  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
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
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
  assert.deepEqual(stored.map((l) => l.listing_id), ['mkt-psa-side']);
});

test('max_price caps new listings in USD', async () => {
  const { q, runner, watch } = await freshWatched({ maxPrice: 1000 });
  await runner.start({});
  await waitUntilDone(runner);
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
  // only the $49 reprint sneaks under a $1,000 cap
  assert.deepEqual(stored.map((l) => l.listing_id), ['mkt-reprint']);
});

test('second start while running is rejected with 409', async () => {
  process.env.MOCK_MARKET_MS = '300';
  const { runner } = await freshWatched();
  await runner.start({});
  await assert.rejects(() => runner.start({}), (err) => err.code === 409);
  runner.cancel();
  await waitUntilDone(runner);
  delete process.env.MOCK_MARKET_MS;
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
  const stored = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
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

  const rows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
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

  const rows = q.listMatches.all({ watchId: watch.id, statuses: '|new|notified|', limit: 50 });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.psa_value != null, 'PSA watch must still resolve a psa_value');
    assert.equal(r.psa_value, r.cl_value);
  }
});
