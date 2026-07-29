import { config, CRAWL_CONDITIONS, loadPlayerAllowlist } from '../config.js';
import { createSource } from '../scraper/source.js';
import { parseLadderPage } from '../scraper/cardladder/adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single in-process sync manager. The sync is a bulk crawl of the Ladder:
// for each target condition (SGC 10, PSA 10) it pages through the grade-
// filtered list endpoint, writing card identity + that grade's value from
// every row. The disparity SQL then joins the two grades per card. No
// per-card page visits — work is O(totalHits / pageSize), not O(cards).
export function createSyncManager(db, q) {
  const allowlist = new Set(loadPlayerAllowlist());
  let running = false;
  let cancelRequested = false;
  let currentLabel = null;
  let lastError = null;

  function status() {
    const run = q.latestSyncRun.get() ?? null;
    const stale = !running && run && run.status === 'running' ? run : null;
    return { running, currentCardName: currentLabel, lastError, run, staleRun: stale };
  }

  const applyHit = db.transaction((parsed, runId) => {
    if (allowlist.size && !allowlist.has(String(parsed.card.player ?? '').toLowerCase())) return false;
    const playerId = q.ensurePlayer(parsed.card.player);
    q.upsertCard.run({
      playerId,
      clCardId: parsed.cardKey,
      name: parsed.card.name,
      setName: parsed.card.setName,
      year: parsed.card.year,
      cardNumber: parsed.card.cardNumber,
      parallel: parsed.card.parallel,
      clUrl: parsed.card.clUrl,
      rawJson: null,
    });
    const cardId = q.getCardByClId.get(parsed.cardKey).id;
    q.upsertGradePrice.run({
      cardId,
      company: parsed.price.company,
      grade: parsed.price.grade,
      clValue: parsed.price.clValue,
      lastSalePrice: parsed.price.lastSalePrice,
      lastSaleDate: parsed.price.lastSaleDate,
      population: parsed.price.population,
      syncRunId: runId,
    });
    return true;
  });

  async function fetchPage(source, condition, pageNum, stride) {
    let res = await source.fetchLadderPage({ condition, page: pageNum, limit: stride });
    if (res && (res.status === 401 || res.status === 403)) {
      // Firebase tokens expire; let the source re-auth and retry once.
      if (source.refreshAuth) await source.refreshAuth();
      res = await source.fetchLadderPage({ condition, page: pageNum, limit: stride });
    }
    if (!res || res.status !== 200 || !res.body) {
      throw new Error(`Ladder request failed for "${condition}" page ${pageNum} (status ${res?.status ?? 'none'}). If this says session expired, run \`npm run login\`.`);
    }
    return res.body;
  }

  const fmt = (n) => Number(n).toLocaleString('en-US');

  async function crawlCondition(source, runId, condition, totals) {
    currentLabel = `${condition} — starting…`;
    let stride = config.crawlLimit;
    let page = 0;
    let collected = 0;
    let totalHits = Infinity;

    while (collected < totalHits) {
      if (cancelRequested) return 'cancelled';
      const body = await fetchPage(source, condition, page, stride);
      const parsed = parseLadderPage(body);
      if (!parsed.ok) throw new Error(`Could not parse Ladder response for "${condition}" — the API shape may have changed.`);

      if (page === 0) {
        totalHits = parsed.totalHits;
        // Auto-adapt if the server capped the page size below what we asked.
        if (body.hits.length > 0 && body.hits.length < stride && body.hits.length < totalHits) {
          stride = body.hits.length;
        }
        totals.value += totalHits;
        q.updateSyncRunTotals.run({ id: runId, total: totals.value });
      }

      for (const card of parsed.cards) {
        const applied = applyHit(card, runId);
        if (applied) q.bumpSyncRunProgress.run({ id: runId, failedDelta: 0 });
      }

      collected += body.hits.length;
      currentLabel = `${condition} — ${fmt(Math.min(collected, totalHits))} / ${fmt(totalHits)} cards`;
      if (body.hits.length === 0) break;
      page += 1;
      if (collected < totalHits) await sleep(config.pageDelayMs);
    }
    return 'completed';
  }

  async function start({ resume = false } = {}) {
    if (running) throw Object.assign(new Error('sync already running'), { code: 409 });

    let runId;
    if (resume) {
      const stale = q.latestStaleRun.get();
      if (!stale) throw Object.assign(new Error('no interrupted sync to resume'), { code: 400 });
      runId = stale.id;
    } else {
      runId = Number(q.createSyncRun.run().lastInsertRowid);
      for (const condition of CRAWL_CONDITIONS) q.insertSyncItem.run(runId, condition, condition);
    }

    running = true;
    cancelRequested = false;
    lastError = null;

    (async () => {
      let source;
      const totals = { value: resume ? (q.getSyncRun.get(runId)?.cards_total ?? 0) : 0 };
      try {
        source = await createSource();
        await source.start();
        const pending = q.pendingSyncItems.all(runId);
        for (const item of pending) {
          if (cancelRequested) break;
          const outcome = await crawlCondition(source, runId, item.cl_card_id, totals);
          if (outcome === 'completed') {
            q.markSyncItem.run({ id: item.id, status: 'done', error: null });
          } else {
            break; // cancelled — leave item pending so resume re-crawls it
          }
        }
        const finalStatus = cancelRequested ? 'cancelled' : 'completed';
        q.finishSyncRun.run({ id: runId, status: finalStatus, error: null });
      } catch (err) {
        lastError = String(err?.message ?? err);
        q.finishSyncRun.run({ id: runId, status: 'failed', error: lastError });
      } finally {
        try { await source?.close(); } catch { /* already closing */ }
        running = false;
        currentLabel = null;
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
