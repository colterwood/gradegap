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
import { withTimeout } from './sources/util.js';
import { createFx } from './fx.js';
import { sendNtfy, sendEmail } from './notify.js';

// Did a re-sighted listing's price actually go DOWN? Native currency only —
// comparing across a currency change (or through the USD conversion) would
// let FX drift fake a "drop" the seller never made. Sub-cent noise ignored.
export function priceDropped(existing, raw) {
  const oldPrice = existing?.price;
  const newPrice = raw?.price;
  if (oldPrice == null || newPrice == null) return false;
  if ((existing.currency ?? 'USD') !== (raw.currency ?? 'USD')) return false;
  return newPrice < oldPrice - 0.004;
}

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
  let skippedSources = [];
  // Price drops on followed Buy It Nows, collected during the run and
  // flushed by notifyAfterRun. Kept on the runner (not per-call) so tests
  // and status() can see what the last run found.
  let priceDrops = [];

  function status() {
    const run = q.latestWatchRun.get() ?? null;
    return {
      running,
      currentLabel,
      lastError,
      run,
      newCount: q.countActiveMatches.get().n,
      // Why items failed, grouped — the UI shows this so "35 failed" is
      // never a dead end.
      failures: run ? q.watchRunFailures.all(run.id) : [],
      skippedSources,
      // What the last completed run flagged on followed Buy It Nows —
      // surfaced for tests and debugging; the UI doesn't render it (yet).
      priceDrops,
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
        // Followed Buy It Now re-sighted at a lower native price -> alert
        // material. Captured BEFORE the refresh overwrites the old price.
        if (existing.followed && existing.listing_type === 'fixed' && priceDropped(existing, raw)) {
          priceDrops.push({
            id: existing.id,
            title: raw.title ?? existing.title,
            url: raw.url ?? existing.url,
            oldPrice: existing.price,
            newPrice: raw.price,
            currency: existing.currency ?? 'USD',
          });
        }
        q.refreshListing.run({
          id: existing.id,
          title: raw.title,
          price: raw.price ?? null,
          currency: raw.currency ?? 'USD',
          priceUsd,
          endsAt: toSqlDate(raw.endsAt),
          url: raw.url ?? null,
        });
      } else {
        // Never resurrect a listing the user explicitly rejected, however it
        // resurfaces (same source id, or the same physical item's canonical
        // key via another search).
        const dismissed =
          q.getDismissedByKey.get(sourceName, String(raw.listingId)) ??
          (canonicalKey ? q.getDismissedByCanonical.get(canonicalKey) : undefined);
        if (dismissed) continue;
        // A stale search index can still return an auction whose captured end
        // date already passed — that's not a "new" listing, it's an old one
        // surfacing for the first time after it's over. Skip it outright
        // instead of inserting it only for the post-run pass to delete it
        // right back out.
        const endsAtMs = raw.listingType === 'auction' && raw.endsAt ? Date.parse(raw.endsAt) : NaN;
        if (!Number.isNaN(endsAtMs) && endsAtMs < Date.now()) continue;
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
    // Manual watches carry a typed description instead of a Ladder card.
    const target = watch.description
      ? { description: watch.description, company: watch.grading_company, grade: watch.grade }
      : {
          playerName: watch.player_name ?? watch.card_name,
          year: watch.year,
          setName: watch.set_name,
          cardNumber: watch.card_number,
          parallel: watch.parallel,
          company: watch.grading_company,
          grade: watch.grade,
        };
    const queries = buildQueries(target);
    // Show the FULL card name ("1997 Metal Universe Michael Jordan Titanium
    // #1"), not year+player — the compressed form looked like a watch that
    // didn't exist ("1997 Michael Jordan" matches four different watches).
    const label = watch.card_name ?? watch.description ?? `${target.year ?? ''} ${target.playerName}`.trim();
    currentLabel = `${source.name} — ${label} · ${target.company} ${target.grade}`.trim();

    // Hard-capped: a wedged site fails this item, never the whole run.
    let raw = await withTimeout(source.search({ text: queries.tight }), 90_000, `${source.name} search`);
    if ((!raw || raw.length === 0) && queries.loose) {
      raw = await withTimeout(source.search({ text: queries.loose }), 90_000, `${source.name} search`);
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
      await withTimeout(source.start({ q, db }), 60_000, `${source.name} start`);
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
    const watchedUrl = `${config.appBaseUrl || `http://localhost:${config.port}`}/#listings`;

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

    // --- Following-tab alerts: per-item ntfy (deep link to the listing)
    // plus one digest email per run covering everything that fired. An
    // ending-soon item is marked reminded only after at least one channel
    // actually delivered — if both fail it stays unmarked and retries next
    // run. Price drops need no flag: a further drop is a new event, and an
    // unchanged price simply isn't a drop on the next re-sighting.
    const money = (n, cur) =>
      n == null ? '?' : `${cur && cur !== 'USD' ? cur + ' ' : '$'}${Number(n).toLocaleString('en-US')}`;
    const emailLines = [];

    const followHours = Math.round(config.followRemindMin / 60);
    const followEnding = q.followReminderCandidates.all({ minutes: config.followRemindMin });
    for (const l of followEnding) {
      l._ntfyOk = await sendNtfy({
        title: `Ending within ${followHours}h — you follow this`,
        message: `${l.title} · ${money(l.price, l.currency)}`,
        clickUrl: l.url ?? watchedUrl,
        priority: 'high',
      });
      emailLines.push(`ENDING within ${followHours}h: ${l.title}\n  current ${money(l.price, l.currency)} · ends ${l.ends_at} UTC\n  ${l.url ?? watchedUrl}`);
    }

    for (const d of priceDrops) {
      await sendNtfy({
        title: 'Price drop — you follow this',
        message: `${d.title} · ${money(d.oldPrice, d.currency)} → ${money(d.newPrice, d.currency)}`,
        clickUrl: d.url ?? watchedUrl,
        priority: 'high',
      });
      emailLines.push(`PRICE DROP: ${d.title}\n  ${money(d.oldPrice, d.currency)} → ${money(d.newPrice, d.currency)}\n  ${d.url ?? watchedUrl}`);
    }

    const emailOk =
      emailLines.length > 0 &&
      (await sendEmail({
        subject: `GradeGap: ${plural(emailLines.length, 'alert')} on followed listings`,
        text: emailLines.join('\n\n') + `\n\nFollowing tab: ${watchedUrl}`,
      }));

    for (const l of followEnding) {
      if (l._ntfyOk || emailOk) q.markListingFollowReminded.run(l.id);
    }
  }

  async function start({ trigger = 'manual' } = {}) {
    if (running) throw Object.assign(new Error('watch check already running'), { code: 409 });
    const watches = q.listEnabledWatches.all();
    if (watches.length === 0) {
      throw Object.assign(new Error('no watched cards — flag cards in the results table first'), { code: 400 });
    }
    const allSources = await createMarketplaceSources();
    if (allSources.length === 0) {
      throw Object.assign(new Error('no watch sources configured (WATCH_SOURCES)'), { code: 400 });
    }
    // A source missing its setup (e.g. eBay without API keys) is skipped
    // with a reason instead of failing every watch against it.
    const sources = [];
    skippedSources = [];
    for (const s of allSources) {
      const reason = s.configured?.() ?? null;
      if (reason) skippedSources.push({ name: s.name, reason });
      else sources.push(s);
    }
    if (sources.length === 0) {
      const detail = skippedSources.map((s) => `${s.name}: ${s.reason}`).join(' · ');
      throw Object.assign(
        new Error(`no usable watch sources — ${detail}. Sources needing no setup: fanatics, comc, hibid, heritage, myslabs, pristine, goldin, cia, classic, miller, catawiki (set WATCH_SOURCES in .env).`),
        { code: 400 }
      );
    }

    const runId = Number(q.createWatchRun.run(trigger).lastInsertRowid);
    for (const source of sources) {
      for (const watch of watches) q.insertWatchItem.run(runId, watch.id, source.name);
    }
    q.updateWatchRunTotals.run({ id: runId, total: watches.length * sources.length });

    running = true;
    cancelRequested = false;
    lastError = null;
    priceDrops = [];

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

        q.deleteEndedAuctions.run();
        q.deleteStaleListings.run();
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
