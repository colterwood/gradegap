// All prepared statements live here. Parsers and routes never build SQL.

import { BASELINE_COMPANY, COMPARE_GRADERS, COMPARE_GRADES } from '../config.js';

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

  // Which (grader, grade) combinations have any synced rows — drives the
  // "no grade N data synced yet" hint in resultsQuery.
  const listGradePresence = db.prepare(`SELECT DISTINCT grading_company, grade FROM grade_prices`);

  // --- disparity ---------------------------------------------------------
  // basis: 'cl_value' | 'last_sale' ; both sides must have a non-null value
  // on the chosen basis to be comparable.
  // graders: which companies' grades are compared against the PSA baseline.
  //   Omitted -> [COMPARE_GRADERS[0]]. Several at once are fine — each
  //   produces its own rows, tagged by a `grader` column.
  // grades: which numeric grades to compare like-for-like (<grader> g vs PSA g).
  //   Omitted -> ['10'] (the original behavior). A 9 is never compared to a 10:
  //   each (card, grade, grader) with both sides is its own row.
  function resultsQuery({ basis, sort, direction, maxPrice, minDiff, minPctDiff, grades, graders, playerId, limit, offset }) {
    const basisCol = basis === 'last_sale' ? 'last_sale_price' : 'cl_value';
    const sortCol = sort === 'abs' ? 'abs_diff' : 'pct_diff';

    // Only configured graders/grades are valid; anything else is dropped.
    const graderList = (graders === undefined ? [COMPARE_GRADERS[0]] : graders)
      .filter((c) => COMPARE_GRADERS.includes(c));
    const gradeList = (grades === undefined ? ['10'] : grades).filter((g) => COMPARE_GRADES.includes(g));
    if (gradeList.length === 0 || graderList.length === 0) {
      return { rows: [], total: 0, excludedMissingGrade: 0, missingGrades: [] };
    }

    // A requested (grader, grade) combo with no synced rows on BOTH sides (a
    // DB from before that grade/grader was crawled, or a sync cancelled
    // between passes) can never produce a pair — report it (as "SGC 7" style
    // labels) so the UI can say "run Sync" instead of showing a silently
    // empty table.
    const present = new Set(listGradePresence.all().map((r) => `${r.grading_company}|${r.grade}`));
    const missingGrades = graderList.flatMap((c) =>
      gradeList
        .filter((g) => !present.has(`${c}|${g}`) || !present.has(`${BASELINE_COMPANY}|${g}`))
        .map((g) => `${c} ${g}`)
    );

    let where = '1=1';
    if (direction === 'grader_cheaper') where = 'd.abs_diff > 0';
    else if (direction === 'psa_cheaper') where = 'd.abs_diff < 0';

    const params = { maxPrice: maxPrice ?? 0, minDiff: minDiff ?? 0, minPctDiff: minPctDiff ?? 0, limit, offset };
    let playerFilter = '';
    if (playerId) {
      playerFilter = 'AND c.player_id = @playerId';
      params.playerId = playerId;
    }

    // Single pass driven from the graders' own price rows: (card, grade,
    // grader) pairs with both sides valid come straight out of one self-join,
    // instead of the old per-grade UNION of LEFT JOINs over the whole cards
    // table. Company names and grades are interpolated as literals — all are
    // validated against the fixed config allowlists above, so that's safe.
    const gradeIn = gradeList.map((g) => `'${g}'`).join(', ');
    const graderIn = graderList.map((c) => `'${c}'`).join(', ');

    const cte = `
      WITH comparable AS (
        SELECT
          c.id AS card_id, c.name, c.set_name, c.year, c.card_number, c.parallel, c.cl_url,
          p.name AS player_name,
          grd.grade AS grade,
          grd.grading_company AS grader,
          grd.${basisCol} AS grader_price,
          psa.${basisCol} AS psa_price,
          grd.last_sale_date AS grader_last_sale_date,
          psa.last_sale_date AS psa_last_sale_date,
          grd.last_sale_price AS grader_last_sale_price,
          psa.last_sale_price AS psa_last_sale_price,
          grd.cl_value AS grader_cl_value,
          psa.cl_value AS psa_cl_value,
          grd.population AS grader_pop,
          psa.population AS psa_pop,
          grd.num_sales AS grader_sales,
          psa.num_sales AS psa_sales,
          (psa.${basisCol} - grd.${basisCol}) AS abs_diff,
          ROUND((psa.${basisCol} - grd.${basisCol}) * 100.0 / grd.${basisCol}, 1) AS pct_diff
        FROM grade_prices grd
        JOIN grade_prices psa ON psa.card_id = grd.card_id
          AND psa.grade = grd.grade
          AND psa.grading_company = '${BASELINE_COMPANY}'
        JOIN cards c ON c.id = grd.card_id
        LEFT JOIN players p ON p.id = c.player_id
        WHERE grd.grading_company IN (${graderIn})
          AND grd.grade IN (${gradeIn})
          AND grd.${basisCol} IS NOT NULL AND grd.${basisCol} > 0
          AND psa.${basisCol} IS NOT NULL AND psa.${basisCol} > 0
          ${playerFilter}
      ),
      filtered AS (
        SELECT * FROM comparable d
        WHERE (@maxPrice <= 0 OR d.grader_price <= @maxPrice)
          AND ABS(d.abs_diff) >= @minDiff
          AND ABS(d.pct_diff) >= @minPctDiff AND ${where}
      )
    `;

    const rows = db.prepare(`
      ${cte}
      SELECT * FROM filtered d
      ORDER BY ABS(d.${sortCol}) DESC
      LIMIT @limit OFFSET @offset
    `).all(params);

    // excludedMissingGrade counts one-sided data on this basis: grader-side
    // rows that couldn't pair with a valid PSA row, plus PSA rows that paired
    // with none of the selected graders. Cards with data only under some
    // OTHER grader deliberately don't count: they're irrelevant here.
    const totals = db.prepare(`
      ${cte}
      SELECT
        (SELECT COUNT(*) FROM filtered) AS total,
        (SELECT COUNT(*) FROM comparable) AS comparable_cards,
        (SELECT COUNT(*) FROM (SELECT DISTINCT card_id, grade FROM comparable)) AS paired_card_grades,
        (SELECT COUNT(*) FROM grade_prices gp JOIN cards c ON c.id = gp.card_id
          WHERE gp.grading_company IN (${graderIn}) AND gp.grade IN (${gradeIn})
            AND gp.${basisCol} IS NOT NULL ${playerFilter}) AS grader_rows,
        (SELECT COUNT(*) FROM grade_prices gp JOIN cards c ON c.id = gp.card_id
          WHERE gp.grading_company = '${BASELINE_COMPANY}' AND gp.grade IN (${gradeIn})
            AND gp.${basisCol} IS NOT NULL ${playerFilter}) AS psa_rows
    `).get(params);

    return {
      rows,
      total: totals.total,
      excludedMissingGrade:
        totals.grader_rows + totals.psa_rows - totals.comparable_cards - totals.paired_card_grades,
      missingGrades,
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
