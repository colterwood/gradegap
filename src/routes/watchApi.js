import { Router } from 'express';
import {
  BASELINE_COMPANY,
  COMPARE_GRADERS,
  COMPARE_GRADES,
  MANUAL_GRADERS,
  MANUAL_GRADES,
  config,
} from '../config.js';
import { REGISTRY, resolveSourceNames } from '../marketplace/sources/index.js';
import { buildQueries, scoreListing } from '../marketplace/match.js';

// The automatic search query for a watch row — same construction the
// runner uses, so the Watched tab's Search-term placeholder shows exactly
// what a check would send when no override is set.
function autoSearch(w) {
  const target = w.description
    ? { description: w.description, company: w.grading_company, grade: w.grade }
    : {
        playerName: w.player_name ?? w.card_name,
        year: w.year,
        setName: w.set_name,
        cardNumber: w.card_number,
        parallel: w.parallel,
        company: w.grading_company,
        grade: w.grade,
      };
  return buildQueries(target).tight;
}

// Watch + matches routes, mounted at /api beside makeApiRouter. Same rules:
// all SQL lives in queries.js, 409 means "already running".
export function makeWatchRouter(db, q, watchRunner) {
  const router = Router();

  // Scoring target for a watch row, matching what the runner builds so the
  // UI's candidate list agrees with what a check would decide.
  const siblingCache = new Map();
  const siblingsFor = (cardId) => {
    if (cardId == null) return [];
    if (!siblingCache.has(cardId)) {
      siblingCache.set(cardId, q.siblingParallels.all(cardId).map((r) => r.parallel));
    }
    return siblingCache.get(cardId);
  };
  const watchTarget = (w) =>
    w.description && w.card_id == null
      ? { description: w.description, company: w.grading_company, grade: w.grade }
      : {
          playerName: w.player_name ?? w.card_name,
          year: w.year,
          setName: w.set_name,
          cardNumber: w.card_number,
          parallel: w.parallel,
          company: w.grading_company,
          grade: w.grade,
          siblingParallels: siblingsFor(w.card_id),
        };

  // Which watched cards could this listing title belong to, best first.
  // Powers the Watched-card dropdown so a mis-attributed row can be moved
  // to the right card by hand.
  function candidatesFor(title, targets) {
    const out = [];
    for (const { watch, target, label } of targets) {
      const s = scoreListing(target, title);
      if (s.ok) out.push({ watchId: watch.id, label, score: s.score, specificity: s.specificity });
    }
    out.sort((a, b) => b.score - a.score || b.specificity - a.specificity);
    return out;
  }

  const slabOf = (w) =>
    w.grading_company === 'None' || w.grade === 'Raw' ? 'Ungraded' : `${w.grading_company} ${w.grade}`;

  function watchTargets() {
    return q.listWatchTargets.all().map((w) => ({
      watch: w,
      target: watchTarget(w),
      label: `${w.card_name} · ${slabOf(w)}`,
    }));
  }

  const VALID_COMPANIES = [BASELINE_COMPANY, ...COMPARE_GRADERS];
  const toPrice = (v) => (v == null || v === '' ? null : Math.max(0, parseFloat(v) || 0) || null);

  // 'None' grader and 'Raw' grade are two names for one state — pick either
  // in the UI and both are stored, so the slab rule is unambiguous.
  function normalizeManualSlab(gradingCompany, grade) {
    if (String(gradingCompany) === 'None' || String(grade) === 'Raw') {
      return { gradingCompany: 'None', grade: 'Raw' };
    }
    return { gradingCompany: String(gradingCompany), grade: String(grade) };
  }

  router.post('/watches', (req, res) => {
    const { cardId, description, gradingCompany, grade, maxPrice = null } = req.body ?? {};
    const price = toPrice(maxPrice);

    // Hand-added watch: free text instead of a Card Ladder card.
    if (description !== undefined && description !== null && String(description).trim() !== '') {
      if (!MANUAL_GRADERS.includes(String(gradingCompany)) || !MANUAL_GRADES.includes(String(grade))) {
        return res.status(400).json({ ok: false, error: 'grader/grade must come from the configured lists' });
      }
      const slab = normalizeManualSlab(gradingCompany, grade);
      const text = String(description).trim().replace(/\s+/g, ' ');
      q.insertManualWatch.run({ description: text, ...slab, maxPrice: price });
      return res.json({
        ok: true,
        watch: q.getManualWatchByKey.get(text, slab.gradingCompany, slab.grade),
      });
    }

    const card = Number(cardId);
    if (!Number.isInteger(card) || !VALID_COMPANIES.includes(gradingCompany) || !COMPARE_GRADES.includes(String(grade))) {
      return res.status(400).json({ ok: false, error: 'need cardId + a configured gradingCompany + grade, or a description' });
    }
    try {
      q.insertWatch.run({ cardId: card, gradingCompany, grade: String(grade), maxPrice: price });
    } catch {
      return res.status(400).json({ ok: false, error: 'unknown cardId' });
    }
    res.json({ ok: true, watch: q.getWatchByKey.get(card, gradingCompany, String(grade)) });
  });

  router.get('/watches', (_req, res) => {
    res.json(q.listWatches.all().map((w) => ({ ...w, auto_search: autoSearch(w) })));
  });

  router.patch('/watches/:id', (req, res) => {
    const id = Number(req.params.id);
    const watch = q.getWatch.get(id);
    if (!watch) return res.status(404).json({ ok: false, error: 'no such watch' });
    const { enabled, maxPrice, searchTerm } = req.body ?? {};
    if (enabled !== undefined) q.setWatchEnabled.run(enabled ? 1 : 0, id);
    if (maxPrice !== undefined) {
      const price = maxPrice == null || maxPrice === '' ? null : Math.max(0, parseFloat(maxPrice) || 0) || null;
      q.setWatchMaxPrice.run(price, id);
    }
    // Blank/whitespace clears the override back to the automatic query.
    if (searchTerm !== undefined) {
      const term = searchTerm == null ? null : String(searchTerm).trim().replace(/\s+/g, ' ') || null;
      q.setWatchSearchTerm.run(term, id);
    }
    res.json({ ok: true, watch: q.getWatch.get(id) });
  });

  // Deleting a watch also deletes its listing history and dismiss blocklist
  // (unwatching from the results table checkbox lands here) — a re-added
  // watch starts fresh. Pausing without losing history is what the enabled
  // toggle is for.
  router.delete('/watches/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!q.getWatch.get(id)) return res.status(404).json({ ok: false, error: 'no such watch' });
    db.transaction(() => {
      q.deleteWatchListings.run(id);
      q.deleteWatchItems.run(id);
      q.deleteWatchDismissed.run(id);
      q.deleteWatch.run(id);
    })();
    res.json({ ok: true });
  });

  router.get('/matches', (req, res) => {
    const statuses = (req.query.status ? String(req.query.status).split(',') : ['new', 'notified'])
      .map((s) => s.trim())
      .filter((s) => ['new', 'notified'].includes(s));
    const watchId = parseInt(req.query.watchId, 10) || null;
    // The badge counts every live listing, so the table must be able to
    // show every live listing — a 200 default silently truncated the view
    // (445 live, 200 rendered) and made the badge look wrong.
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    // followed=1 -> Following tab; followed=0 -> unfollowed only; absent -> all.
    const followed = req.query.followed === '1' ? 1 : req.query.followed === '0' ? 0 : null;
    const rows = q.listMatches.all({ watchId, statuses: `|${statuses.join('|')}|`, limit, followed });
    // Attach the other watched cards each listing could belong to, so the
    // UI can offer them in a dropdown. Targets are built once per request.
    const targets = watchTargets();
    res.json(rows.map((r) => ({ ...r, candidates: candidatesFor(r.title, targets) })));
  });

  // Move a listing to a different watched card by hand. watchId null (or
  // 'auto') releases the pin and lets scoring own it again.
  router.post('/matches/:id/watch', (req, res) => {
    const id = Number(req.params.id);
    const listing = q.getListingById.get(id);
    if (!listing) return res.status(404).json({ ok: false, error: 'no such listing' });
    const raw = req.body?.watchId;

    if (raw == null || raw === 'auto') {
      // Release: re-score against every candidate and take the best, exactly
      // as a check would, so the row doesn't sit on a stale manual choice.
      const best = candidatesFor(listing.title, watchTargets())[0];
      if (!best) return res.status(400).json({ ok: false, error: 'no watched card matches this listing' });
      q.setListingWatch.run({
        id, watchId: best.watchId, matchScore: best.score, matchSpecificity: best.specificity, locked: 0,
      });
      return res.json({ ok: true, watchId: best.watchId, locked: false });
    }

    const watchId = Number(raw);
    const watch = q.getWatch.get(watchId);
    if (!watch) return res.status(400).json({ ok: false, error: 'no such watch' });
    // Score the chosen pairing so CL/PSA/Match stay honest; a hand-picked
    // card that doesn't match scores 0, which is information, not an error.
    const chosen = watchTargets().find((t) => t.watch.id === watchId);
    const s = chosen ? scoreListing(chosen.target, listing.title) : { score: 0, specificity: 0 };
    q.setListingWatch.run({
      id, watchId, matchScore: s.score, matchSpecificity: s.specificity ?? 0, locked: 1,
    });
    res.json({ ok: true, watchId, locked: true });
  });

  // Tag/untag a listing for the Following tab.
  router.post('/matches/:id/follow', (req, res) => {
    const id = Number(req.params.id);
    if (!q.getListingById.get(id)) return res.status(404).json({ ok: false, error: 'no such listing' });
    q.setListingFollowed.run({ id, followed: req.body?.followed ? 1 : 0 });
    res.json({ ok: true });
  });

  // Dismissing deletes the listing outright and remembers it permanently in
  // dismissed_listings, so this exact listing (by source id or canonical
  // key) can never be re-inserted as 'new' on a later check.
  router.post('/matches/:id/dismiss', (req, res) => {
    const id = Number(req.params.id);
    const listing = q.getListingById.get(id);
    if (!listing) return res.status(404).json({ ok: false, error: 'no such listing' });
    db.transaction(() => {
      q.insertDismissedListing.run({
        watchId: listing.watch_id,
        source: listing.source,
        listingId: listing.listing_id,
        canonicalKey: listing.canonical_key,
      });
      q.deleteListing.run(id);
    })();
    res.json({ ok: true });
  });

  // Per-source dashboard: how the latest run went for each source, what it
  // is holding, and why it is idle (disabled / in 429 backoff / missing
  // setup). Every configured source appears even if it never ran.
  router.get('/sources', async (_req, res) => {
    const run = q.latestWatchRun.get() ?? null;
    const stats = new Map((run ? q.watchRunSourceStats.all(run.id) : []).map((r) => [r.source, r]));
    const listings = new Map(q.listingCountsBySource.all().map((r) => [r.source, r.n]));
    const state = new Map(q.listSourceState.all().map((r) => [r.source, r]));
    // Distinct failure reasons this run, most common first, per source.
    const errors = new Map();
    for (const f of run ? q.watchRunFailures.all(run.id) : []) {
      if (!errors.has(f.source)) errors.set(f.source, { error: f.error, n: f.n });
    }
    const status = watchRunner.status();
    const skipped = new Map((status.skippedSources ?? []).map((s) => [s.name, s.reason]));

    const names = resolveSourceNames(config.watchSources).filter((n) => REGISTRY[n]);
    res.json({
      running: status.running,
      run: run ? { id: run.id, started_at: run.started_at, finished_at: run.finished_at, status: run.status } : null,
      sources: names.map((name) => {
        const s = stats.get(name) ?? {};
        const st = state.get(name) ?? {};
        return {
          name,
          done: s.done ?? 0,
          failed: s.failed ?? 0,
          pending: s.pending ?? 0,
          listings: listings.get(name) ?? 0,
          enabled: st.enabled == null ? 1 : st.enabled,
          backoffUntil: st.backoff_until ?? null,
          lastRequestAt: st.last_request_at ?? null,
          error: errors.get(name)?.error ?? null,
          errorCount: errors.get(name)?.n ?? 0,
          skippedReason: skipped.get(name) ?? null,
        };
      }),
    });
  });

  router.post('/watch-check', (req, res) => {
    // sources: [] / omitted -> every configured source ("Check All").
    // A named subset runs only those ("Check Selected"), so one broken or
    // rate-limited source can be re-run without redoing the whole list.
    const raw = req.body?.sources;
    const only = Array.isArray(raw) && raw.length > 0 ? raw.filter((n) => REGISTRY[n]) : null;
    if (Array.isArray(raw) && raw.length > 0 && (!only || only.length === 0)) {
      return res.status(400).json({ ok: false, error: 'no valid sources selected' });
    }
    watchRunner
      .start({ trigger: 'manual', only })
      .then((runId) => res.json({ ok: true, runId, sources: only }))
      .catch((err) => res.status(err.code === 409 ? 409 : 400).json({ ok: false, error: err.message }));
  });

  router.post('/watch-check/cancel', (_req, res) => {
    res.json({ ok: true, cancelling: watchRunner.cancel() });
  });

  router.get('/watch-check/status', (_req, res) => {
    res.json(watchRunner.status());
  });

  return router;
}
