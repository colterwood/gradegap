import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_CL = '1';

const { openDb } = await import('../src/db/db.js');
const { makeQueries } = await import('../src/db/queries.js');
const { createSyncManager } = await import('../src/sync/syncRunner.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshManager() {
  const db = openDb(':memory:');
  const q = makeQueries(db);
  return { db, q, mgr: createSyncManager(db, q) };
}

async function waitUntilDone(mgr, timeoutMs = 20000) {
  const start = Date.now();
  while (mgr.status().running) {
    if (Date.now() - start > timeoutMs) throw new Error('sync did not finish in time');
    await sleep(50);
  }
}

const base = { basis: 'cl_value', sort: 'pct', direction: 'all', minPrice: 0, playerId: null, limit: 100, offset: 0 };

test('ladder crawl populates both grades and joins them', async () => {
  const { q, mgr } = freshManager();
  await mgr.start({});
  await waitUntilDone(mgr);
  const run = q.latestSyncRun.get();
  assert.equal(run.status, 'completed');

  const r = q.resultsQuery(base);
  // 15 cards; 1991 UD (PSA only) and 2003 MVP (SGC only) lack a grade -> 13 comparable
  assert.equal(r.total, 13);
  assert.equal(r.excludedMissingGrade, 2);

  // biggest pct gap is the 1986 Fleer #57 (SGC 24500 vs PSA 175000)
  assert.match(r.rows[0].name, /1986 Fleer Michael Jordan #57/);
  assert.equal(r.rows[0].sgc_price, 24500);
  assert.equal(r.rows[0].psa_price, 175000);
});

test('SGC 10 Pristine rows are excluded from the Gem Mint comparison', async () => {
  const { db, q, mgr } = freshManager();
  await mgr.start({});
  await waitUntilDone(mgr);

  const r = q.resultsQuery(base);
  const jordan = r.rows.find((x) => /1986 Fleer Michael Jordan #57/.test(x.name));
  // Pristine value is 120000; if it leaked in, sgc_price would not be 24500
  assert.equal(jordan.sgc_price, 24500);

  // the crawl only requests condition "SGC 10" (Gem Mint), so the Pristine
  // row — a distinct condition — is never even fetched: exclusion happens at
  // the source, not just in the parser. Only the Gem Mint value is stored.
  const card = q.getCardByClId.get('spec:299576');
  assert.ok(card, 'card stored under its psaSpecId key');
  const grades = db
    .prepare(`SELECT grade, cl_value FROM grade_prices WHERE card_id = ? AND grading_company = 'SGC' ORDER BY grade`)
    .all(card.id);
  assert.deepEqual(grades, [{ grade: '10', cl_value: 24500 }]);
});

test('last_sale basis drops cards missing a market value on either side', async () => {
  const { q, mgr } = freshManager();
  await mgr.start({});
  await waitUntilDone(mgr);
  const r = q.resultsQuery({ ...base, basis: 'last_sale' });
  // 1990 Skybox (PSA marketValue null) and 1996 Refractor (SGC marketValue null)
  // drop out on the last-sale basis, on top of the 2 missing-grade cards
  assert.equal(r.excludedMissingGrade, 4);
  assert.equal(r.total, 11);
});

test('cancel stops the crawl; resume finishes it', async () => {
  // slow the mock so we can cancel between the SGC and PSA conditions
  process.env.MOCK_PAGE_MS = '600';
  const { db, q, mgr } = freshManager();
  await mgr.start({});
  await sleep(250); // mid-way through the first (SGC) condition
  assert.equal(mgr.cancel(), true);
  await waitUntilDone(mgr);

  const run = q.latestSyncRun.get();
  assert.equal(run.status, 'cancelled');
  assert.ok(q.pendingSyncItems.all(run.id).length >= 1, 'a condition remains pending after cancel');

  // simulate crash-recovery: the run looks stale/running again
  db.prepare(`UPDATE sync_runs SET status = 'running', finished_at = NULL WHERE id = ?`).run(run.id);
  assert.equal(mgr.status().staleRun?.id, run.id);

  delete process.env.MOCK_PAGE_MS; // resume fast
  await mgr.start({ resume: true });
  await waitUntilDone(mgr);
  assert.equal(q.getSyncRun.get(run.id).status, 'completed');
  assert.equal(q.pendingSyncItems.all(run.id).length, 0);

  const r = q.resultsQuery(base);
  assert.equal(r.total, 13);
});

test('second start while running is rejected with 409', async () => {
  process.env.MOCK_PAGE_MS = '80';
  const { mgr } = freshManager();
  await mgr.start({});
  await assert.rejects(() => mgr.start({}), (err) => err.code === 409);
  mgr.cancel();
  await waitUntilDone(mgr);
  delete process.env.MOCK_PAGE_MS;
});
