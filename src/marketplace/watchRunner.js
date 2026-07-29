// Marketplace watch runner, structured like sync/syncRunner.js: a single
// in-process manager with a resumable SQLite work queue (one item per
// watch × source), 409 single-flight, and the same status() surface so the
// UI polling pattern transfers. On top of that: a setTimeout-chain scheduler
// (next tick armed only after the previous run fully completes) and the
// post-run passes — ended auctions, stale fixed listings, and the two
// aggregate ntfy pushes (new listings / auctions ending soon).

import { config } from '../config.js';
import { buildQueries, scoreListing } from './match.js';
import { createMarketplaceSources } from './sources/index.js';
import { createFx } from './fx.js';
import { sendNtfy } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 200 + Math.floor(Math.random() * 600);

// Normalize any incoming end date to SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) so
// comparisons against datetime('now') are consistent (ISO 'T' strings don't
// collate correctly against SQLite's space-separated format).
function toSqlDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

export function createWatchRunner(db, q, { syncManager } = {}) {
  const fx = createFx(q);
  let running = false;
  let cancelRequested = false;
  let currentLabel = null;
  let lastError = null;
  let donePromise = null;
  let timer = null;

  function status() {
    return {
      running,
      currentLabel,
      lastError,
      run: q.latestWatchRun.get() ?? null,
      newCount: q.countActiveMatches.get().n,
    };
  }

  // Store one item's surviving listings. A listing already known (same
  // source+listing_id, or same canonical item via another source) is
  // refreshed; genuinely-new ones are inserted as status 'new'. The watch's
  // USD max-price cap applies to inserts only — an already-tracked listing
  // keeps updating even if its price drifts over the cap.
  const applyListings = db.transaction((watch, sourceName, scored) => {
    let newCount = 0;
    for (const { raw, score } of scored) {
      const canonicalKey = raw.canonicalKey ?? null;
      const existing =
        q.getListingByKey.get(sourceName, String(raw.listingId)) ??
        (canonicalKey ? q.getListingByCanonical.get(canonicalKey) : undefined);
      const priceUsd = fx.toUsd(raw.price, raw.currency);
      if (existing) {
        q.refreshListing.run({
          id: existing.id,
          title: raw.title,
          price: raw.price ?? null,
          currency: raw.currency ?? 'USD',
          priceUsd,
          endsAt: toSqlDate(raw.endsAt),
        });
      } else {
        if (watch.max_price != null && priceUsd != null && priceUsd > watch.max_price) continue;
        q.insertListing.run({
          watchId: watch.id,
          source: sourceName,
          listingId: String(raw.listingId),
          canonicalKey,
          title: raw.title,
          url: raw.url ?? null,
          price: raw.price ?? null,
          currency: raw.currency ?? 'USD',
          priceUsd,
          listingType: raw.listingType ?? null,
          endsAt: toSqlDate(raw.endsAt),
          imageUrl: raw.imageUrl ?? null,
          seller: raw.seller ?? null,
          matchScore: score.score,
          matchDebug: JSON.stringify(score.debug),
        });
        newCount += 1;
      }
    }
    return newCount;
  });

  async function processItem(source, item, watch, runId, runStartedAt) {
    const target = {
      playerName: watch.player_name ?? watch.card_name,
      year: watch.year,
      setName: watch.set_name,
      cardNumber: watch.card_number,
      parallel: watch.parallel,
      company: watch.grading_company,
      grade: watch.grade,
    };
    const queries = buildQueries(target);
    currentLabel = `${source.name} — ${target.year ?? ''} ${target.playerName} ${target.company} ${target.grade}`.trim();

    let raw = await source.search({ text: queries.tight });
    if ((!raw || raw.length === 0) && queries.loose) {
      raw = await source.search({ text: queries.loose });
    }

    const scored = [];
    for (const r of raw ?? []) {
      const s = scoreListing(target, r.title);
      if (s.ok) scored.push({ raw: r, score: s }); // hard failures are dropped, low scores kept
    }

    const newCount = applyListings(watch, source.name, scored);
    // Fixed listings of this watch+source NOT seen by this (successful) check
    // move toward stale-ended.
    q.bumpListingMisses.run({ watchId: watch.id, source: source.name, runStartedAt });
    q.touchWatchChecked.run(watch.id);
    if (newCount > 0) q.addWatchRunNewListings.run(newCount, runId);
  }

  async function processSource(source, items, watchById, runId, runStartedAt) {
    q.ensureSourceState.run(source.name);
    const state = q.getSourceState.get(source.name);
    const failAll = (error) => {
      for (const item of items) {
        q.markWatchItem.run({ id: item.id, status: 'failed', error });
        q.bumpWatchRunProgress.run({ id: runId, failedDelta: 1 });
      }
    };

    if (!state.enabled) return failAll('source disabled (source_state.enabled = 0)');
    if (state.backoff_until && state.backoff_until > toSqlDate(new Date())) {
      return failAll(`in rate-limit backoff until ${state.backoff_until} UTC`);
    }
    // Browser-based sources yield to a running Card Ladder sync (shared
    // Playwright profile + CPU); they'll be retried on the next cycle.
    if (source.needsBrowser && syncManager?.status().running) {
      return failAll('deferred: Card Ladder sync in progress');
    }

    try {
      await source.start({ q, db });
    } catch (err) {
      lastError = String(err?.message ?? err);
      return failAll(lastError);
    }

    try {
      for (const item of items) {
        if (cancelRequested) return;
        const watch = watchById.get(item.watch_id);
        if (!watch || !watch.enabled) {
          q.markWatchItem.run({ id: item.id, status: 'done', error: null });
          q.bumpWatchRunProgress.run({ id: runId, failedDelta: 0 });
          continue;
        }
        try {
          await processItem(source, item, watch, runId, runStartedAt);
          q.markWatchItem.run({ id: item.id, status: 'done', error: null });
          q.bumpWatchRunProgress.run({ id: runId, failedDelta: 0 });
          q.touchSource.run(source.name);
        } catch (err) {
          const msg = String(err?.message ?? err);
          lastError = msg;
          if (err?.rateLimited) {
            // Back the whole source off for 30 minutes and give up on its
            // remaining items this run — the next cycle retries them.
            q.setSourceBackoff.run(toSqlDate(new Date(Date.now() + 30 * 60 * 1000)), source.name);
            q.markWatchItem.run({ id: item.id, status: 'failed', error: msg });
            q.bumpWatchRunProgress.run({ id: runId, failedDelta: 1 });
            const rest = items.slice(items.indexOf(item) + 1);
            for (const r of rest) {
              q.markWatchItem.run({ id: r.id, status: 'failed', error: 'skipped: source in backoff' });
              q.bumpWatchRunProgress.run({ id: runId, failedDelta: 1 });
            }
            return;
          }
          q.markWatchItem.run({ id: item.id, status: 'failed', error: msg });
          q.bumpWatchRunProgress.run({ id: runId, failedDelta: 1 });
        }
        if (source.minIntervalMs > 0) await sleep(source.minIntervalMs + jitter());
      }
    } finally {
      try { await source.close(); } catch { /* already closing */ }
    }
  }

  async function notifyAfterRun() {
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const watchedUrl = `http://localhost:${config.port}/#watched`;

    // One aggregate push per run, per the user's design — never per-listing.
    // If the push fails (or ntfy isn't configured) listings stay 'new' and
    // are re-counted next run.
    const fresh = q.listNewListings.all();
    if (fresh.length > 0) {
      const ok = await sendNtfy({
        title: 'GradeGap watchlist',
        message: `${plural(fresh.length, 'new listing')} for your watched cards — open the app for details`,
        clickUrl: watchedUrl,
      });
      if (ok) for (const l of fresh) q.setListingStatus.run('notified', l.id);
    }

    const hours = Math.round(config.watchRemindMin / 60);
    const ending = q.reminderCandidates.all({ minutes: config.watchRemindMin });
    if (ending.length > 0) {
      const ok = await sendNtfy({
        title: 'GradeGap watchlist',
        message: `${plural(ending.length, 'watched auction')} ending within ${hours}h`,
        clickUrl: watchedUrl,
        priority: 'high',
      });
      if (ok) for (const l of ending) q.markListingReminded.run(l.id);
    }
  }

  async function start({ trigger = 'manual' } = {}) {
    if (running) throw Object.assign(new Error('watch check already running'), { code: 409 });
    const watches = q.listEnabledWatches.all();
    if (watches.length === 0) {
      throw Object.assign(new Error('no watched cards — flag cards in the results table first'), { code: 400 });
    }
    const sources = await createMarketplaceSources();
    if (sources.length === 0) {
      throw Object.assign(new Error('no watch sources configured (WATCH_SOURCES)'), { code: 400 });
    }

    const runId = Number(q.createWatchRun.run(trigger).lastInsertRowid);
    for (const source of sources) {
      for (const watch of watches) q.insertWatchItem.run(runId, watch.id, source.name);
    }
    q.updateWatchRunTotals.run({ id: runId, total: watches.length * sources.length });

    running = true;
    cancelRequested = false;
    lastError = null;

    donePromise = (async () => {
      try {
        await fx.ensureRates(); // non-fatal: falls back to cached/static rates
        const runStartedAt = q.getWatchRun.get(runId).started_at;
        const watchById = new Map(q.listWatches.all().map((w) => [w.id, w]));

        const bySource = new Map();
        for (const item of q.pendingWatchItems.all(runId)) {
          if (!bySource.has(item.source)) bySource.set(item.source, []);
          bySource.get(item.source).push(item);
        }
        // Rotate source order per run so one slow source doesn't always
        // starve the last.
        const order = sources.filter((s) => bySource.has(s.name));
        const rot = order.length ? runId % order.length : 0;
        const rotated = [...order.slice(rot), ...order.slice(0, rot)];

        for (const source of rotated) {
          if (cancelRequested) break;
          await processSource(source, bySource.get(source.name), watchById, runId, runStartedAt);
        }

        q.markEndedAuctions.run();
        q.markStaleListingsEnded.run();
        await notifyAfterRun();

        q.finishWatchRun.run({ id: runId, status: cancelRequested ? 'cancelled' : 'completed', error: null });
      } catch (err) {
        lastError = String(err?.message ?? err);
        q.finishWatchRun.run({ id: runId, status: 'failed', error: lastError });
      } finally {
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

  // setTimeout chain, not setInterval: the next tick is armed only after the
  // previous run fully finishes, so runs can never stack up.
  function startScheduler() {
    if (config.watchIntervalMin <= 0 || timer) return;
    const intervalMs = config.watchIntervalMin * 60 * 1000;
    const arm = () => {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.(); // don't hold the process open just for the scheduler
    };
    const tick = async () => {
      try {
        if (!running && q.countEnabledWatches.get().n > 0) {
          await start({ trigger: 'scheduled' });
          await donePromise;
        }
      } catch {
        // empty watchlist / config errors: already surfaced via lastError
      }
      arm();
    };
    arm();
  }

  function stopScheduler() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // whenDone: test/scheduler hook to await the in-flight run.
  return { start, cancel, status, startScheduler, stopScheduler, whenDone: () => donePromise };
}
