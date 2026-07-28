// All prepared statements live here. Parsers and routes never build SQL.

import { TARGETS } from '../config.js';

export function makeQueries(db) {
  const upsertCard = db.prepare(`
    INSERT INTO cards (player_id, cl_card_id, name, set_name, year, card_number, parallel, cl_url, raw_json)
    VALUES (@playerId, @clCardId, @name, @setName, @year, @cardNumber, @parallel, @clUrl, @rawJson)
    ON CONFLICT(cl_card_id) DO UPDATE SET
      name = excluded.name,
      set_name = excluded.set_name,
      year = excluded.year,
      card_number = excluded.card_number,
      parallel = excluded.parallel,
      cl_url = excluded.cl_url,
      raw_json = excluded.raw_json,
      last_seen_at = datetime('now')
  `);

  const upsertGradePrice = db.prepare(`
    INSERT INTO grade_prices (card_id, grading_company, grade, cl_value, last_sale_price, last_sale_date, sync_run_id, captured_at)
    VALUES (@cardId, @company, @grade, @clValue, @lastSalePrice, @lastSaleDate, @syncRunId, datetime('now'))
    ON CONFLICT(card_id, grading_company, grade) DO UPDATE SET
      cl_value = excluded.cl_value,
      last_sale_price = excluded.last_sale_price,
      last_sale_date = excluded.last_sale_date,
      sync_run_id = excluded.sync_run_id,
      captured_at = excluded.captured_at
  `);

  const getCardByClId = db.prepare(`SELECT * FROM cards WHERE cl_card_id = ?`);

  // --- disparity ---------------------------------------------------------
  // basis: 'cl_value' | 'last_sale' ; both grades must have a non-null value
  // on the chosen basis to be comparable.
  function resultsQuery({ basis, sort, direction, minPrice, playerId, limit, offset }) {
    const basisCol = basis === 'last_sale' ? 'last_sale_price' : 'cl_value';
    const sortCol = sort === 'abs' ? 'abs_diff' : 'pct_diff';

    let where = '1=1';
    if (direction === 'sgc_cheaper') where = 'd.abs_diff > 0';
    else if (direction === 'psa_cheaper') where = 'd.abs_diff < 0';

    const params = { minPrice: minPrice ?? 0, limit, offset };
    let playerFilter = '';
    if (playerId) {
      playerFilter = 'AND c.player_id = @playerId';
      params.playerId = playerId;
    }

    const cte = `
      WITH pairs AS (
        SELECT
          c.id AS card_id, c.name, c.set_name, c.year, c.card_number, c.parallel, c.cl_url,
          p.name AS player_name,
          sgc.${basisCol} AS sgc_price,
          psa.${basisCol} AS psa_price,
          sgc.last_sale_date AS sgc_last_sale_date,
          psa.last_sale_date AS psa_last_sale_date,
          sgc.last_sale_price AS sgc_last_sale_price,
          psa.last_sale_price AS psa_last_sale_price,
          sgc.cl_value AS sgc_cl_value,
          psa.cl_value AS psa_cl_value
        FROM cards c
        JOIN players p ON p.id = c.player_id
        LEFT JOIN grade_prices sgc ON sgc.card_id = c.id
          AND sgc.grading_company = '${TARGETS.sgc.company}' AND sgc.grade = '${TARGETS.sgc.grade}'
        LEFT JOIN grade_prices psa ON psa.card_id = c.id
          AND psa.grading_company = '${TARGETS.psa.company}' AND psa.grade = '${TARGETS.psa.grade}'
        WHERE 1=1 ${playerFilter}
      ),
      comparable AS (
        SELECT *,
          (psa_price - sgc_price) AS abs_diff,
          ROUND((psa_price - sgc_price) * 100.0 / sgc_price, 1) AS pct_diff
        FROM pairs
        WHERE sgc_price IS NOT NULL AND sgc_price > 0
          AND psa_price IS NOT NULL AND psa_price > 0
      ),
      filtered AS (
        SELECT * FROM comparable d
        WHERE MAX(d.sgc_price, d.psa_price) >= @minPrice AND ${where}
      )
    `;

    const rows = db.prepare(`
      ${cte}
      SELECT * FROM filtered d
      ORDER BY ABS(d.${sortCol}) DESC
      LIMIT @limit OFFSET @offset
    `).all(params);

    const totals = db.prepare(`
      ${cte}
      SELECT
        (SELECT COUNT(*) FROM filtered) AS total,
        (SELECT COUNT(*) FROM pairs) AS all_cards,
        (SELECT COUNT(*) FROM comparable) AS comparable_cards
    `).get(params);

    return {
      rows,
      total: totals.total,
      excludedMissingGrade: totals.all_cards - totals.comparable_cards,
    };
  }

  return {
    upsertCard,
    upsertGradePrice,
    getCardByClId,
    resultsQuery,

    listPlayers: db.prepare(`SELECT * FROM players ORDER BY name`),
    getPlayerByName: db.prepare(`SELECT * FROM players WHERE name = ?`),

    createSyncRun: db.prepare(`INSERT INTO sync_runs DEFAULT VALUES`),
    getSyncRun: db.prepare(`SELECT * FROM sync_runs WHERE id = ?`),
    latestSyncRun: db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`),
    listSyncRuns: db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?`),
    latestStaleRun: db.prepare(`SELECT * FROM sync_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`),
    updateSyncRunTotals: db.prepare(`UPDATE sync_runs SET cards_total = @total WHERE id = @id`),
    bumpSyncRunProgress: db.prepare(`
      UPDATE sync_runs SET cards_processed = cards_processed + 1,
        cards_failed = cards_failed + @failedDelta
      WHERE id = @id
    `),
    finishSyncRun: db.prepare(`
      UPDATE sync_runs SET status = @status, error = @error, finished_at = datetime('now') WHERE id = @id
    `),

    insertSyncItem: db.prepare(`
      INSERT INTO sync_items (sync_run_id, cl_card_id, card_name) VALUES (?, ?, ?)
      ON CONFLICT(sync_run_id, cl_card_id) DO NOTHING
    `),
    pendingSyncItems: db.prepare(`SELECT * FROM sync_items WHERE sync_run_id = ? AND status = 'pending' ORDER BY id`),
    markSyncItem: db.prepare(`
      UPDATE sync_items SET status = @status, attempts = attempts + 1, error = @error WHERE id = @id
    `),
  };
}
