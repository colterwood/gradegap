import { config } from '../config.js';
import { createSource } from '../scraper/source.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitteredDelay = () =>
  config.rateMinMs + Math.floor(Math.random() * Math.max(1, config.rateMaxMs - config.rateMinMs));

// Single in-process sync manager. Only one run at a time.
export function createSyncManager(db, q) {
  let running = false;
  let cancelRequested = false;
  let currentCardName = null;
  let lastError = null;

  function status() {
    const run = q.latestSyncRun.get() ?? null;
    const stale = !running && run && run.status === 'running' ? run : null;
    return {
      running,
      currentCardName,
      lastError,
      run,
      staleRun: stale,
    };
  }

  async function enumerate(source, runId, playerIds) {
    const players = q.listPlayers.all().filter(
      (p) => p.enabled && (!playerIds?.length || playerIds.includes(p.id))
    );
    let total = 0;
    for (const player of players) {
      const cards = await source.enumerateCards(player);
      const tx = db.transaction(() => {
        for (const c of cards) {
          q.upsertCard.run({
            playerId: player.id,
            clCardId: c.clCardId,
            name: c.name,
            setName: c.setName ?? null,
            year: c.year ?? null,
            cardNumber: c.cardNumber ?? null,
            parallel: c.parallel ?? null,
            clUrl: c.clUrl ?? null,
            rawJson: c.raw ? JSON.stringify(c.raw) : null,
          });
          q.insertSyncItem.run(runId, c.clCardId, c.name);
        }
      });
      tx();
      total += cards.length;
    }
    return total;
  }

  async function processItem(source, runId, item) {
    const card = q.getCardByClId.get(item.cl_card_id);
    if (!card) throw new Error(`card ${item.cl_card_id} not found in db`);
    currentCardName = card.name;
    const prices = await source.fetchCardPrices(card);
    const tx = db.transaction(() => {
      for (const p of prices) {
        q.upsertGradePrice.run({
          cardId: card.id,
          company: p.company,
          grade: String(p.grade),
          clValue: p.clValue ?? null,
          lastSalePrice: p.lastSalePrice ?? null,
          lastSaleDate: p.lastSaleDate ?? null,
          syncRunId: runId,
        });
      }
      q.markSyncItem.run({ id: item.id, status: 'done', error: null });
      q.bumpSyncRunProgress.run({ id: runId, failedDelta: 0 });
    });
    tx();
  }

  async function runLoop(source, runId) {
    const items = q.pendingSyncItems.all(runId);
    for (const item of items) {
      if (cancelRequested) return 'cancelled';
      try {
        await processItem(source, runId, item);
      } catch (err) {
        // one retry after a backoff, then mark failed and continue
        try {
          await sleep(config.mock ? 100 : 30000);
          if (cancelRequested) return 'cancelled';
          await processItem(source, runId, item);
        } catch (err2) {
          q.markSyncItem.run({ id: item.id, status: 'failed', error: String(err2?.message ?? err2) });
          q.bumpSyncRunProgress.run({ id: runId, failedDelta: 1 });
        }
      }
      if (!config.mock) await sleep(jitteredDelay());
    }
    return 'completed';
  }

  async function start({ playerIds = null, resume = false } = {}) {
    if (running) throw Object.assign(new Error('sync already running'), { code: 409 });

    let runId;
    if (resume) {
      const stale = q.latestStaleRun.get();
      if (!stale) throw Object.assign(new Error('no interrupted sync to resume'), { code: 400 });
      runId = stale.id;
    } else {
      runId = Number(q.createSyncRun.run().lastInsertRowid);
    }

    running = true;
    cancelRequested = false;
    lastError = null;

    // fire and forget; status is polled via /api/sync/status
    (async () => {
      let source;
      try {
        source = await createSource();
        await source.start();
        if (!resume) {
          const total = await enumerate(source, runId, playerIds);
          q.updateSyncRunTotals.run({ id: runId, total });
          if (total === 0) throw new Error('no cards found during enumeration — check captures/failures/ and player config');
        }
        const outcome = await runLoop(source, runId);
        q.finishSyncRun.run({ id: runId, status: outcome, error: null });
      } catch (err) {
        lastError = String(err?.message ?? err);
        q.finishSyncRun.run({ id: runId, status: 'failed', error: lastError });
      } finally {
        try { await source?.close(); } catch { /* already closing */ }
        running = false;
        currentCardName = null;
      }
    })();

    return runId;
  }

  function cancel() {
    if (!running) return false;
    cancelRequested = true;
    return true;
  }

  return { start, cancel, status };
}
