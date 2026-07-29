import { Router } from 'express';
import { COMPARE_GRADES } from '../config.js';

export function makeApiRouter(db, q, syncManager) {
  const router = Router();

  router.post('/sync', (req, res) => {
    const { playerIds = null, resume = false } = req.body ?? {};
    syncManager
      .start({ playerIds, resume })
      .then((runId) => res.json({ ok: true, runId }))
      .catch((err) => res.status(err.code === 409 ? 409 : 400).json({ ok: false, error: err.message }));
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
    const direction = ['sgc_cheaper', 'psa_cheaper'].includes(req.query.direction)
      ? req.query.direction
      : 'all';
    const minPrice = Math.max(0, parseFloat(req.query.minPrice) || 0);
    const minDiff = Math.max(0, parseFloat(req.query.minDiff) || 0);
    // grades: comma-separated subset of COMPARE_GRADES. Absent -> default to 10 only.
    const grades = req.query.grades === undefined
      ? undefined
      : String(req.query.grades).split(',').map((s) => s.trim()).filter((g) => COMPARE_GRADES.includes(g));
    const playerId = parseInt(req.query.playerId, 10) || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 5000);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    res.json(q.resultsQuery({ basis, sort, direction, minPrice, minDiff, grades, playerId, limit, offset }));
  });

  return router;
}
