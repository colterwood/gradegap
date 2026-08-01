// Marketplace watch runner, structured like sync/syncRunner.js: a single
// in-process manager with a resumable SQLite work queue (one item per
// watch × source), 409 single-flight, and the same status() surface so the
// UI polling pattern transfers. Sources run concurrently — every HTTP-API
// source at once, browser sources through a small pool of tabs — with each
// source pacing its own requests. On top of that: a setTimeout-chain
// scheduler (next tick armed only after the previous run fully completes)
// and the post-run passes — ended auctions, stale fixed listings, and the
// two aggregate ntfy pushes (new listings / auctions ending soon).

import { config } from '../config.js';
import { buildQueries, buildWatchTarget, scoreListing } from './match.js';
import { createMarketplaceSources } from './sources/index.js';
import { withTimeout, toIsoDate } from './sources/util.js';
import { createFx } from './fx.js';
import { sendNtfy, sendEmail } from './notify.js';

// Sources in the user's productivity order (config.watchSourceOrder), so a
// multi-hour run front-loads the sources that actually produce listings.
// Names not in the order list keep their registry order, after the listed
// ones. Exported for tests.
export function orderSources(sources, priority = config.watchSourceOrder) {
  const rank = new Map(priority.map((name, i) => [name, i]));
  return [...sources].sort(
    (a, b) => (rank.get(a.name) ?? priority.length) - (rank.get(b.name) ?? priority.length)
  );
}

// Minutes-of-day until the next occurrence of one of `times` ("HH:MM",
// 24h) in the IANA zone `tz`, computed against the CURRENT wall clock in
// that zone — so DST shifts are absorbed each time we re-arm. Exported for
// tests via the `now` override.
export function nextFireDelayMs(times, tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  // Intl renders midnight as "24" in some ICU versions; normalize.
  const nowMin = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const targets = times
    .map((t) => {
      const [h, m] = String(t).split(':').map(Number);
      return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
    })
    .sort((a, b) => a - b);
  const next = targets.find((t) => t > nowMin) ?? targets[0] + 24 * 60;
  return (next - nowMin) * 60_000 - Number(parts.second) * 1000;
}

// Did a re-sighted listing's price drop ENOUGH to alert on (>= followDropPct
// of the old price)? Native currency only — comparing across a currency
// change (or through the USD conversion) would let FX drift fake a "drop"
// the seller never made.
// One listing can satisfy several watched cards ("Beam Team Members Only"
// titles match a plain "Members Only" watch too), but the listings table
// holds ONE row per (source, listing_id) — so exactly one watch owns it.
// Ownership goes to the better match, not to whichever watch searched
// first: higher score wins; on a tie, the more SPECIFIC watch wins (the one
// whose identity explains more of the title). Ties beyond that keep the
// incumbent, so ownership can't oscillate between equal candidates.
export function isBetterOwner(candidate, existing) {
  const eps = 1e-9;
  const exScore = existing.match_score ?? 0;
  if (candidate.score > exScore + eps) return true;
  if (candidate.score < exScore - eps) return false;
  return (candidate.specificity ?? 0) > (existing.match_specificity ?? 0);
}

export function priceDropped(existing, raw, minDropPct = config.followDropPct) {
  const oldPrice = existing?.price;
  const newPrice = raw?.price;
  if (oldPrice == null || newPrice == null) return false;
  if ((existing.currency ?? 'USD') !== (raw.currency ?? 'USD')) return false;
  const drop = oldPrice - newPrice;
  // Alert only on a decrease of at least minDropPct of the old price (default
  // config.followDropPct) — small seller nudges aren't worth a push. The 1e-9
  // slack keeps an exact N% drop from failing on float rounding.
  return drop > 0.004 && drop >= oldPrice * (minDropPct / 100) - 1e-9;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 200 + Math.floor(Math.random() * 600);

// Normalize any incoming end date to SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) so
// comparisons against datetime('now') are consistent (ISO 'T' strings don't
// collate correctly against SQLite's space-separated format).
//
// Everything goes through toIsoDate first: `new Date()` alone reads a bare
// number as MILLISECONDS (epoch seconds would land in 1970) and a zone-less
// string as SERVER-LOCAL time (hours off, differently on every machine).
function toSqlDate(raw) {
  if (!raw) return null;
  const iso = toIsoDate(raw);
  return iso == null ? null : iso.slice(0, 19).replace('T', ' ');
}

// sourcesFactory: test seam — production always uses the real registry.
export function createWatchRunner(db, q, { syncManager, sourcesFactory = createMarketplaceSources } = {}) {
  const fx = createFx(q);
  // A run left 'running' by a crash or restart reads as in-flight forever
  // (the UI's last-check line never renders again, and its pending items
  // are orphaned) — finalize it at boot, mirroring the sync runner.
  {
    const stale = q.latestStaleWatchRun.get();
    if (stale) q.finishWatchRun.run({ id: stale.id, status: 'failed', error: 'interrupted by restart' });
  }
  let running = false;
  let cancelRequested = false;
  // What each in-flight source is doing right now, keyed by source name —
  // sources run concurrently, so a single "current" string would clobber.
  const activeLabels = new Map();
  let lastError = null;
  let donePromise = null;
  let timer = null;
  let ebayTimer = null;
  let skippedSources = [];
  // Price drops on followed Buy It Nows, collected during the run and
  // flushed by notifyAfterRun. Kept on the runner (not per-call) so tests
  // and status() can see what the last run found.
  let priceDrops = [];
  // Sibling parallels per card, memoized: the same watch is scored once per
  // source (15x per run), and the catalog doesn't change mid-run.
  const siblingCache = new Map();
  function siblingsFor(cardId) {
    if (cardId == null) return [];
    if (!siblingCache.has(cardId)) {
      siblingCache.set(cardId, q.siblingParallels.all(cardId).map((r) => r.parallel));
    }
    return siblingCache.get(cardId);
  }

  // One line for the UI's progress bar: the busiest-looking single label,
  // plus how many other sources are working alongside it.
  function describeActivity() {
    const labels = [...activeLabels.values()];
    if (labels.length === 0) return null;
    if (labels.length === 1) return labels[0];
    return `${labels[0]}  (+${labels.length - 1} more source${labels.length === 2 ? '' : 's'})`;
  }

  function status() {
    const run = q.latestWatchRun.get() ?? null;
    return {
      running,
      currentLabel: describeActivity(),
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
      // Normalized ONCE: the already-ended guard below used to read the raw
      // value while storage normalized it separately, so an epoch-seconds
      // end date passed the guard (Date.parse -> NaN) and then stored as
      // 1970 — inserted, deleted by the post-run sweep, re-inserted next
      // run, inflating new_listings every cycle.
      const endsAtIso = toIsoDate(raw.endsAt);
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
        // Contested listing: hand it to this watch if it matches better —
        // unless the user pinned the owner by hand, which always wins.
        if (!existing.watch_locked && existing.watch_id !== watch.id && isBetterOwner(score, existing)) {
          q.reassignListing.run({
            id: existing.id,
            watchId: watch.id,
            matchScore: score.score,
            matchSpecificity: score.specificity ?? 0,
            matchDebug: JSON.stringify(score.debug),
          });
        }
        q.refreshListing.run({
          id: existing.id,
          title: raw.title,
          price: raw.price ?? null,
          currency: raw.currency ?? 'USD',
          priceUsd,
          // listing_type was written only at insert, so a wrong first guess
          // (or a lot that genuinely flips format) was permanent — and a
          // 'fixed' row could keep a stale end date that later armed a
          // bogus delete. Both are corrected on every re-sighting now.
          listingType: raw.listingType ?? null,
          endsAt: toSqlDate(endsAtIso),
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
        const endsAtMs = raw.listingType === 'auction' && endsAtIso ? Date.parse(endsAtIso) : NaN;
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
          // Never NULL: both cleanup passes key on the type, and a NULL
          // row matches neither, so it would live forever.
          listingType: raw.listingType ?? 'fixed',
          endsAt: toSqlDate(endsAtIso),
          imageUrl: raw.imageUrl ?? null,
          seller: raw.seller ?? null,
          matchScore: score.score,
          matchSpecificity: score.specificity ?? 0,
          matchDebug: JSON.stringify(score.debug),
        });
        newCount += 1;
      }
    }
    return newCount;
  });

  async function processItem(source, item, watch, runId, runStartedAt) {
    // Manual watches carry a typed description instead of a Ladder card —
    // buildWatchTarget (shared with the API routes) handles both shapes.
    const target = buildWatchTarget(watch, siblingsFor);
    // A user-edited search term replaces the generated queries VERBATIM (no
    // loose fallback — an override means "send exactly this"). Scoring is
    // untouched: results are still verified against the card's identity.
    const queries = watch.search_term?.trim()
      ? { tight: watch.search_term.trim(), loose: null }
      : buildQueries(target);
    // Show the FULL card name ("1997 Metal Universe Michael Jordan Titanium
    // #1"), not year+player — the compressed form looked like a watch that
    // didn't exist ("1997 Michael Jordan" matches four different watches).
    const label = watch.card_name ?? watch.description ?? `${target.year ?? ''} ${target.playerName}`.trim();
    activeLabels.set(source.name, `${source.name} — ${label} · ${target.company} ${target.grade}`.trim());

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
      // A start can fail half-done (browser lease acquired, page creation
      // failed) — close so a leaked lease can't hold Chromium open.
      try { await source.close(); } catch { /* partial start */ }
      return failAll(lastError);
    }

    try {
      for (const item of items) {
        if (cancelRequested) return;
        const watch = watchById.get(item.watch_id);
        // Existence/enabled comes from a LIVE lookup, not the run-start
        // snapshot: a watch deleted mid-run otherwise FK-failed every
        // remaining source, and disabling mid-run never took effect. The
        // snapshot still supplies the joined card/player fields.
        const live = q.getWatch.get(item.watch_id);
        if (!watch || !live?.enabled) {
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
        // No pacing debt after the FINAL item — the old tail sleep held the
        // browser lease (and the lane) for up to 8s doing nothing.
        if (source.minIntervalMs > 0 && item !== items[items.length - 1]) {
          await sleep(source.minIntervalMs + jitter());
        }
      }
    } finally {
      activeLabels.delete(source.name);
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
      if (ok) db.transaction(() => { for (const l of fresh) q.setListingStatus.run('notified', l.id); })();
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
      if (ok) db.transaction(() => { for (const l of ending) q.markListingReminded.run(l.id); })();
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

  // only / exclude: source-name filters for dedicated runs — the fixed-time
  // eBay schedule runs start({ only: ['ebay'] }) while the interval runs
  // exclude it, so quota spend is exactly runs/day × watches × marketplaces.
  async function start({ trigger = 'manual', only = null, exclude = null } = {}) {
    if (running) throw Object.assign(new Error('watch check already running'), { code: 409 });
    // Claim the flight NOW, before any await: createMarketplaceSources
    // crosses a macrotask boundary on first use, and two near-simultaneous
    // starts (a double-clicked Check Now, or a manual check racing a
    // scheduler tick) both passed the old check-then-set guard and ran two
    // full concurrent checks. Any pre-run failure releases the claim.
    running = true;
    let sources, watches, runId;
    try {
      watches = q.listEnabledWatches.all();
      if (watches.length === 0) {
        throw Object.assign(new Error('no watched cards — flag cards in the results table first'), { code: 400 });
      }
      const allSources = await sourcesFactory();
      if (allSources.length === 0) {
        throw Object.assign(new Error('no watch sources configured (WATCH_SOURCES)'), { code: 400 });
      }
      // A source missing its setup (e.g. eBay without API keys) is skipped
      // with a reason instead of failing every watch against it.
      sources = [];
      skippedSources = [];
      for (const s of allSources) {
        if (only && !only.includes(s.name)) continue;
        if (exclude && exclude.includes(s.name)) continue;
        const reason = s.configured?.() ?? null;
        if (reason) skippedSources.push({ name: s.name, reason });
        else sources.push(s);
      }
      // Most-productive sources first (config.watchSourceOrder) so a long run
      // surfaces new listings early instead of after the thin auction houses.
      sources = orderSources(sources);
      if (sources.length === 0) {
        const detail = skippedSources.map((s) => `${s.name}: ${s.reason}`).join(' · ');
        throw Object.assign(
          new Error(`no usable watch sources — ${detail}. Sources needing no setup: fanatics, comc, hibid, heritage, myslabs, pristine, goldin, cia, classic, miller, catawiki (set WATCH_SOURCES in .env).`),
          { code: 400 }
        );
      }

      // One transaction for the whole enqueue — watches × sources rows as
      // individual commits stalled the Check Now button for seconds.
      runId = db.transaction(() => {
        const id = Number(q.createWatchRun.run(trigger).lastInsertRowid);
        for (const source of sources) {
          for (const watch of watches) q.insertWatchItem.run(id, watch.id, source.name);
        }
        q.updateWatchRunTotals.run({ id, total: watches.length * sources.length });
        return id;
      })();
    } catch (err) {
      running = false;
      throw err;
    }

    cancelRequested = false;
    lastError = null;
    priceDrops = [];
    // Siblings change whenever a sync lands new parallels; this cache used
    // to live for the whole process, gating matches with stale sibling sets.
    siblingCache.clear();

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
        // Sources run CONCURRENTLY, not in sequence — each source already
        // paces itself (minIntervalMs between its own requests), so nothing
        // about politeness changes; the run just stops paying for the sum of
        // every source's pacing. HTTP-API sources are fully independent and
        // all start at once. Browser sources share the one Chromium profile,
        // so they draw from a priority-ordered queue with a small pool of
        // tabs (config.watchBrowserConcurrency; 1 = the old serial chain).
        // Wall clock falls from sum(all sources) to max(slowest HTTP source,
        // browser queue / pool width).
        const runSource = (source) =>
          processSource(source, bySource.get(source.name), watchById, runId, runStartedAt);
        const httpSources = sources.filter((s) => !s.needsBrowser && bySource.has(s.name));
        const browserQueue = sources.filter((s) => s.needsBrowser && bySource.has(s.name));
        const tabCount = Math.max(1, Math.min(config.watchBrowserConcurrency, browserQueue.length));
        const browserLane = async () => {
          while (browserQueue.length > 0 && !cancelRequested) {
            const source = browserQueue.shift();
            // Per-source try/catch: one browser source crashing outright
            // must not strand the rest of the queue behind it.
            try {
              await runSource(source);
            } catch (err) {
              lastError = String(err?.message ?? err);
            }
          }
        };
        // allSettled so one source's unexpected crash can't strand the others
        // mid-flight; the first failure still fails the run afterwards.
        const settled = await Promise.allSettled([
          ...httpSources.map((s) => runSource(s)),
          ...Array.from({ length: tabCount }, () => browserLane()),
        ]);
        const crashed = settled.find((r) => r.status === 'rejected');

        // Housekeeping runs BEFORE the rethrow: it has nothing to do with
        // the crashed source, and skipping it meant one bad source delayed
        // every ending-soon alert by a full cycle and left finished
        // auctions on the board.
        q.deleteEndedAuctions.run();
        q.deleteStaleListings.run();
        await notifyAfterRun();
        if (crashed) throw crashed.reason;

        q.finishWatchRun.run({ id: runId, status: cancelRequested ? 'cancelled' : 'completed', error: null });
        // Nothing reads history past the latest runs; stop it growing forever
        // (watches × sources rows per run, several runs a day).
        q.pruneOldWatchItems.run();
        q.pruneOldWatchRuns.run();
      } catch (err) {
        lastError = String(err?.message ?? err);
        q.finishWatchRun.run({ id: runId, status: 'failed', error: lastError });
      } finally {
        running = false;
        activeLabels.clear();
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
    armEbaySchedule();
    if (config.watchIntervalMin <= 0 || timer) return;
    const intervalMs = config.watchIntervalMin * 60 * 1000;
    // With fixed eBay times configured, interval runs leave eBay to them.
    const exclude = config.ebayCheckTimes.length > 0 ? ['ebay'] : null;
    const arm = () => {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.(); // don't hold the process open just for the scheduler
    };
    const tick = async () => {
      try {
        if (!running && q.countEnabledWatches.get().n > 0) {
          await start({ trigger: 'scheduled', exclude });
          await donePromise;
        }
      } catch {
        // empty watchlist / config errors: already surfaced via lastError
      }
      arm();
    };
    arm();
  }

  // Dedicated ebay-only runs at the configured wall-clock times (e.g.
  // "11:00,21:00" US Eastern). Re-armed after every firing, so the delay is
  // always computed against the CURRENT zone offset — DST shifts absorb
  // themselves. If a general run is in flight at fire time, wait it out; if
  // another run then wins the race, this slot is skipped (409) and the next
  // scheduled time takes over.
  function armEbaySchedule() {
    if (config.ebayCheckTimes.length === 0 || ebayTimer) return;
    const arm = () => {
      ebayTimer = setTimeout(fire, nextFireDelayMs(config.ebayCheckTimes, config.ebayCheckTz));
      ebayTimer.unref?.();
    };
    const fire = async () => {
      try {
        if (running) await donePromise;
        if (q.countEnabledWatches.get().n > 0) {
          await start({ trigger: 'scheduled', only: ['ebay'] });
          await donePromise;
        }
      } catch {
        // 409 lost-race / config errors: surfaced via lastError
      }
      arm();
    };
    arm();
  }

  function stopScheduler() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (ebayTimer) clearTimeout(ebayTimer);
    ebayTimer = null;
  }

  // whenDone: test/scheduler hook to await the in-flight run.
  return { start, cancel, status, startScheduler, stopScheduler, whenDone: () => donePromise };
}
