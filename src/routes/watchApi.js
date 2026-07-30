import { Router } from 'express';
import {
  BASELINE_COMPANY,
  COMPARE_GRADERS,
  COMPARE_GRADES,
  MANUAL_GRADERS,
  MANUAL_GRADES,
} from '../config.js';

// Watch + matches routes, mounted at /api beside makeApiRouter. Same rules:
// all SQL lives in queries.js, 409 means "already running".
export function makeWatchRouter(db, q, watchRunner) {
  const router = Router();

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
    res.json(q.listWatches.all());
  });

  router.patch('/watches/:id', (req, res) => {
    const id = Number(req.params.id);
    const watch = q.getWatch.get(id);
    if (!watch) return res.status(404).json({ ok: false, error: 'no such watch' });
    const { enabled, maxPrice } = req.body ?? {};
    if (enabled !== undefined) q.setWatchEnabled.run(enabled ? 1 : 0, id);
    if (maxPrice !== undefined) {
      const price = maxPrice == null || maxPrice === '' ? null : Math.max(0, parseFloat(maxPrice) || 0) || null;
      q.setWatchMaxPrice.run(price, id);
    }
    res.json({ ok: true, watch: q.getWatch.get(id) });
  });

  // Deleting a watch also deletes its listing history (unwatching from the
  // results table checkbox lands here). Pausing without losing history is
  // what the enabled toggle is for.
  router.delete('/watches/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!q.getWatch.get(id)) return res.status(404).json({ ok: false, error: 'no such watch' });
    db.transaction(() => {
      q.deleteWatchListings.run(id);
      q.deleteWatchItems.run(id);
      q.deleteWatch.run(id);
    })();
    res.json({ ok: true });
  });

  router.get('/matches', (req, res) => {
    const statuses = (req.query.status ? String(req.query.status).split(',') : ['new', 'notified'])
      .map((s) => s.trim())
      .filter((s) => ['new', 'notified', 'dismissed', 'ended'].includes(s));
    const watchId = parseInt(req.query.watchId, 10) || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json(q.listMatches.all({ watchId, statuses: `|${statuses.join('|')}|`, limit }));
  });

  router.post('/matches/:id/dismiss', (req, res) => {
    q.setListingStatus.run('dismissed', Number(req.params.id));
    res.json({ ok: true });
  });

  router.post('/watch-check', (req, res) => {
    watchRunner
      .start({ trigger: 'manual' })
      .then((runId) => res.json({ ok: true, runId }))
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
