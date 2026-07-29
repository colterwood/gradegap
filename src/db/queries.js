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
    INSERT INTO grade_prices (card_id, grading_company, grade, cl_value, last_sale_price, last_sale_date, population, num_sales, sync_run_id, captured_at)
    VALUES (@cardId, @company, @grade, @clValue, @lastSalePrice, @lastSaleDate, @population, @numSales, @syncRunId, datetime('now'))
    ON CONFLICT(card_id, grading_company, grade) DO UPDATE SET
      cl_value = excluded.cl_value,
      last_sale_price = excluded.last_sale_price,
      last_sale_date = excluded.last_sale_date,
      population = excluded.population,
      num_sales = excluded.num_sales,
      sync_run_id = excluded.sync_run_id,
      captured_at = excluded.captured_at
  `);

  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, enabled) VALUES (@name, 1)
    ON CONFLICT(name) DO NOTHING
  `);
  const getPlayerIdByName = db.prepare(`SELECT id FROM players WHERE name = ?`);

  const getCardByClId = db.prepare(`SELECT * FROM cards WHERE cl_card_id = ?`);

  // --- disparity ---------------------------------------------------------
  // basis: 'cl_value' | 'last_sale' ; both grades must have a non-null value
  // on the chosen basis to be comparable.
  // grades: which numeric grades to compare like-for-like (SGC <g> vs PSA <g>).
  //   Omitted -> ['10'] (the original behavior). A 9 is never compared to a 10:
  //   each grade produces its own paired rows, UNION'd, with a `grade` column so
  //   a card can appear once per grade when both are requested.
  function resultsQuery({ basis, sort, direction, minPrice, minDiff, grades, playerId, limit, offset }) {
    const basisCol = basis === 'last_sale' ? 'last_sale_price' : 'cl_value';
    const sortCol = sort === 'abs' ? 'abs_diff' : 'pct_diff';

    // Only the grades we actually crawl are valid; anything else is dropped.
    const gradeList = (grades === undefined ? ['10'] : grades).filter((g) => g === '10' || g === '9');
    if (gradeList.length === 0) {
      return { rows: [], total: 0, excludedMissingGrade: 0 };
    }

    let where = '1=1';
    if (direction === 'sgc_cheaper') where = 'd.abs_diff > 0';
    else if (direction === 'psa_cheaper') where = 'd.abs_diff < 0';

    const params = { minPrice: minPrice ?? 0, minDiff: minDiff ?? 0, limit, offset };
    let playerFilter = '';
    if (playerId) {
      playerFilter = 'AND c.player_id = @playerId';
      params.playerId = playerId;
    }

    // One paired SELECT per requested grade, UNION ALL'd. `grade` is a literal
    // column (the values are validated above, so interpolation is safe).
    const pairSelect = (g) => `
        SELECT
          c.id AS card_id, c.name, c.set_name, c.year, c.card_number, c.parallel, c.cl_url,
          p.name AS player_name,
          '${g}' AS grade,
          sgc.${basisCol} AS sgc_price,
          psa.${basisCol} AS psa_price,
          sgc.last_sale_date AS sgc_last_sale_date,
          psa.last_sale_date AS psa_last_sale_date,
          sgc.last_sale_price AS sgc_last_sale_price,
          psa.last_sale_price AS psa_last_sale_price,
          sgc.cl_value AS sgc_cl_value,
          psa.cl_value AS psa_cl_value,
          sgc.population AS sgc_pop,
          psa.population AS psa_pop,
          sgc.num_sales AS sgc_sales,
          psa.num_sales AS psa_sales
        FROM cards c
        LEFT JOIN players p ON p.id = c.player_id
        LEFT JOIN grade_prices sgc ON sgc.card_id = c.id
          AND sgc.grading_company = '${TARGETS.sgc.company}' AND sgc.grade = '${g}'
        LEFT JOIN grade_prices psa ON psa.card_id = c.id
          AND psa.grading_company = '${TARGETS.psa.company}' AND psa.grade = '${g}'
        WHERE 1=1 ${playerFilter}`;

    const cte = `
      WITH pairs AS (
${gradeList.map(pairSelect).join('\n        UNION ALL\n')}
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
        WHERE d.sgc_price >= @minPrice AND ABS(d.abs_diff) >= @minDiff AND ${where}
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

  // Resolve a player name to an id, creating the player row on first sight.
  function ensurePlayer(name) {
    if (!name) return null;
    upsertPlayer.run({ name });
    return getPlayerIdByName.get(name)?.id ?? null;
  }

  return {
    upsertCard,
    upsertGradePrice,
    ensurePlayer,
    getCardByClId,
    resultsQuery,

    listPlayers: db.prepare(`SELECT * FROM players WHERE search_term IS NOT NULL OR id IN (SELECT DISTINCT player_id FROM cards) ORDER BY name`),
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
