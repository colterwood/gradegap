import { Router } from 'express';
import {
  BASELINE_COMPANY,
  COMPARE_GRADERS,
  COMPARE_GRADES,
  GRADE_BASELINE,
  MANUAL_GRADERS,
  MANUAL_GRADES,
} from '../config.js';

export function makeApiRouter(db, q, syncManager) {
  const router = Router();

  // The UI builds its Grade checkboxes and Grader dropdown from this, so
  // adding a grade or grader is a config-only change.
  router.get('/config', (_req, res) => {
    res.json({
      grades: COMPARE_GRADES,
      graders: COMPARE_GRADERS,
      baseline: BASELINE_COMPANY,
      // Which PSA grade each compared grade is measured against, so the UI
      // can say so instead of implying like-for-like everywhere.
      gradeBaseline: GRADE_BASELINE,
      // Wider vocabularies for the Watched tab's hand-add form.
      manualGraders: MANUAL_GRADERS,
      manualGrades: MANUAL_GRADES,
    });
  });

  // Body: { resume } only. (A playerIds parameter used to be accepted here
  // and silently ignored — the crawl is always full-catalog, filtered by
  // config/players.json.)
  router.post('/sync', (req, res) => {
    const { resume = false } = req.body ?? {};
    syncManager
      .start({ resume })
      .then((runId) => res.json({ ok: true, runId }))
      .catch((err) => {
        const code = err.code === 409 ? 409 : err.code === 400 ? 400 : 500;
        res.status(code).json({ ok: false, error: err.message });
      });
  });

  router.post('/sync/cancel', (_req, res) => {
    res.json({ ok: true, cancelling: syncManager.cancel() });
  });

  router.get('/sync/status', (_req, res) => {
    res.json(syncManager.status());
  });

  router.get('/sync/runs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    res.json(q.listSyncRuns.all(limit));
  });

  router.get('/players', (_req, res) => {
    res.json(q.listPlayers.all());
  });

  router.get('/results', (req, res) => {
    const basis = req.query.basis === 'last_sale' ? 'last_sale' : 'cl_value';
    const sort = req.query.sort === 'abs' ? 'abs' : 'pct';
    const direction = ['grader_cheaper', 'psa_cheaper'].includes(req.query.direction)
      ? req.query.direction
      : 'all';
    const maxPrice = Math.max(0, parseFloat(req.query.maxPrice) || 0);
    const minDiff = Math.max(0, parseFloat(req.query.minDiff) || 0);
    const minPctDiff = Math.max(0, parseFloat(req.query.minPctDiff) || 0);
    // grades / graders: comma-separated subsets of COMPARE_GRADES /
    // COMPARE_GRADERS; values are validated inside resultsQuery (single owner
    // of that rule). Absent -> the query's defaults (grade 10, first grader).
    const grades = req.query.grades === undefined
      ? undefined
      : String(req.query.grades).split(',').map((s) => s.trim()).filter(Boolean);
    const graders = req.query.graders === undefined
      ? undefined
      : String(req.query.graders).split(',').map((s) => s.trim()).filter(Boolean);
    const playerId = parseInt(req.query.playerId, 10) || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 5000);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    res.json(q.resultsQuery({ basis, sort, direction, maxPrice, minDiff, minPctDiff, grades, graders, playerId, limit, offset }));
  });

  return router;
}
