import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_CL = '1';

const { openDb, syncPlayersFromConfig } = await import('../src/db/db.js');
const { makeQueries } = await import('../src/db/queries.js');
const { createSyncManager } = await import('../src/sync/syncRunner.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshManager() {
  const db = openDb(':memory:');
  syncPlayersFromConfig(db, [{ name: 'Michael Jordan', searchTerm: 'Michael Jordan' }]);
  const q = makeQueries(db);
  return { db, q, mgr: createSyncManager(db, q) };
}

async function waitUntilDone(mgr, timeoutMs = 15000) {
  const start = Date.now();
  while (mgr.status().running) {
    if (Date.now() - start > timeoutMs) throw new Error('sync did not finish in time');
    await sleep(100);
  }
}

test('full mock sync populates prices', async () => {
  const { q, mgr } = freshManager();
  await mgr.start({});
  await waitUntilDone(mgr);
  const run = q.latestSyncRun.get();
  assert.equal(run.status, 'completed');
  assert.equal(run.cards_total, 15);
  assert.equal(run.cards_processed, 15);
  const r = q.resultsQuery({ basis: 'cl_value', sort: 'pct', direction: 'all', minPrice: 0, playerId: null, limit: 100, offset: 0 });
  assert.equal(r.total, 13);
  assert.equal(r.excludedMissingGrade, 2);
});

test('cancel stops mid-run, resume finishes only pending items', async () => {
  const { db, q, mgr } = freshManager();
  await mgr.start({});
  // enumeration takes ~300ms, each card ~150ms; cancel partway through
  await sleep(900);
  assert.equal(mgr.cancel(), true);
  await waitUntilDone(mgr);

  const run = q.latestSyncRun.get();
  assert.equal(run.status, 'cancelled');
  assert.ok(run.cards_processed > 0, 'some cards processed before cancel');
  assert.ok(run.cards_processed < 15, `expected partial progress, got ${run.cards_processed}`);
  const pendingBefore = q.pendingSyncItems.all(run.id).length;
  assert.equal(pendingBefore, 15 - run.cards_processed);

  // simulate the crash-recovery path: mark the run as if the process died mid-run
  db.prepare(`UPDATE sync_runs SET status = 'running', finished_at = NULL WHERE id = ?`).run(run.id);
  assert.equal(mgr.status().staleRun?.id, run.id);

  await mgr.start({ resume: true });
  await waitUntilDone(mgr);
  const after = q.getSyncRun.get(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.cards_processed, 15);
  assert.equal(q.pendingSyncItems.all(run.id).length, 0);
});

test('second start while running is rejected with 409', async () => {
  const { mgr } = freshManager();
  await mgr.start({});
  await assert.rejects(() => mgr.start({}), (err) => err.code === 409);
  mgr.cancel();
  await waitUntilDone(mgr);
});
