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

    // --- marketplace watcher ------------------------------------------------

    // Re-watching a previously-watched combo re-enables it instead of erroring.
    insertWatch: db.prepare(`
      INSERT INTO watches (card_id, grading_company, grade, max_price)
      VALUES (@cardId, @gradingCompany, @grade, @maxPrice)
      ON CONFLICT(card_id, grading_company, grade) DO UPDATE SET enabled = 1
    `),
    // Hand-added watch: no card behind it, just the typed description.
    insertManualWatch: db.prepare(`
      INSERT INTO watches (card_id, description, grading_company, grade, max_price)
      VALUES (NULL, @description, @gradingCompany, @grade, @maxPrice)
      ON CONFLICT(description, grading_company, grade) WHERE card_id IS NULL
        DO UPDATE SET enabled = 1
    `),
    getManualWatchByKey: db.prepare(`
      SELECT * FROM watches WHERE card_id IS NULL AND description = ? AND grading_company = ? AND grade = ?
    `),
    getWatch: db.prepare(`SELECT * FROM watches WHERE id = ?`),
    getWatchByKey: db.prepare(`SELECT * FROM watches WHERE card_id = ? AND grading_company = ? AND grade = ?`),
    // Card/player fields ride along for query building and the management UI;
    // LEFT JOINs so manual (card-less) watches are included, with the typed
    // description standing in for the card name.
    listWatches: db.prepare(`
      SELECT w.*, COALESCE(c.name, w.description) AS card_name,
             c.set_name, c.year, c.card_number, c.parallel,
             p.name AS player_name,
             (SELECT COUNT(*) FROM listings l WHERE l.watch_id = w.id AND l.status IN ('new','notified')) AS active_listings
      FROM watches w
      LEFT JOIN cards c ON c.id = w.card_id
      LEFT JOIN players p ON p.id = c.player_id
      ORDER BY w.id DESC
    `),
    listEnabledWatches: db.prepare(`
      SELECT w.*, COALESCE(c.name, w.description) AS card_name,
             c.set_name, c.year, c.card_number, c.parallel,
             p.name AS player_name
      FROM watches w
      LEFT JOIN cards c ON c.id = w.card_id
      LEFT JOIN players p ON p.id = c.player_id
      WHERE w.enabled = 1
      ORDER BY w.id
    `),
    countEnabledWatches: db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE enabled = 1`),
    setWatchEnabled: db.prepare(`UPDATE watches SET enabled = ? WHERE id = ?`),
    setWatchMaxPrice: db.prepare(`UPDATE watches SET max_price = ? WHERE id = ?`),
    touchWatchChecked: db.prepare(`UPDATE watches SET last_checked_at = datetime('now') WHERE id = ?`),
    deleteWatchListings: db.prepare(`DELETE FROM listings WHERE watch_id = ?`),
    deleteWatchItems: db.prepare(`DELETE FROM watch_check_items WHERE watch_id = ?`),
    deleteWatch: db.prepare(`DELETE FROM watches WHERE id = ?`),

    getListingById: db.prepare(`SELECT * FROM listings WHERE id = ?`),
    getListingByKey: db.prepare(`SELECT * FROM listings WHERE source = ? AND listing_id = ?`),
    getListingByCanonical: db.prepare(`SELECT * FROM listings WHERE canonical_key = ?`),
    deleteListing: db.prepare(`DELETE FROM listings WHERE id = ?`),

    // The permanent dismiss blocklist — checked before a "new" sighting is
    // ever inserted, so a rejected listing can't come back under the same
    // source id or canonical key. Not scoped to a watch (see schema.sql).
    getDismissedByKey: db.prepare(`SELECT 1 FROM dismissed_listings WHERE source = ? AND listing_id = ?`),
    getDismissedByCanonical: db.prepare(`SELECT 1 FROM dismissed_listings WHERE canonical_key = ?`),
    insertDismissedListing: db.prepare(`
      INSERT INTO dismissed_listings (watch_id, source, listing_id, canonical_key)
      VALUES (@watchId, @source, @listingId, @canonicalKey)
      ON CONFLICT(source, listing_id) DO UPDATE SET dismissed_at = datetime('now')
    `),
    deleteWatchDismissed: db.prepare(`DELETE FROM dismissed_listings WHERE watch_id = ?`),
    insertListing: db.prepare(`
      INSERT INTO listings (watch_id, source, listing_id, canonical_key, title, url, price, currency,
                            price_usd, listing_type, ends_at, image_url, seller, match_score, match_debug)
      VALUES (@watchId, @source, @listingId, @canonicalKey, @title, @url, @price, @currency,
              @priceUsd, @listingType, @endsAt, @imageUrl, @seller, @matchScore, @matchDebug)
    `),
    // A re-sighting refreshes the live fields and resets the staleness
    // counter. url is refreshed too, so rows stored before an adapter's
    // link format was corrected get repaired on the next check.
    refreshListing: db.prepare(`
      UPDATE listings SET title = @title, price = @price, currency = @currency, price_usd = @priceUsd,
        ends_at = COALESCE(@endsAt, ends_at), url = COALESCE(@url, url),
        misses = 0, last_seen_at = datetime('now')
      WHERE id = @id
    `),
    // cl_value = the Card Ladder value for the watched card at that exact
    // grader+grade, so a listing's asking price can be read against it.
    // psa_value = the same card's PSA value AT THE SAME GRADE (an SGC 9
    // watch compares against PSA 9, not PSA 10) — the like-for-like number
    // the whole app is built around. Both are NULL for manual watches (no
    // Ladder card behind them), and psa_value simply equals cl_value when
    // the watch is itself a PSA slab.
    listMatches: db.prepare(`
      SELECT l.*, w.grading_company, w.grade, w.card_id,
             COALESCE(c.name, w.description) AS card_name, p.name AS player_name,
             gp.cl_value AS cl_value,
             gp_psa.cl_value AS psa_value
      FROM listings l
      JOIN watches w ON w.id = l.watch_id
      LEFT JOIN cards c ON c.id = w.card_id
      LEFT JOIN players p ON p.id = c.player_id
      LEFT JOIN grade_prices gp
        ON gp.card_id = w.card_id AND gp.grading_company = w.grading_company AND gp.grade = w.grade
      LEFT JOIN grade_prices gp_psa
        ON gp_psa.card_id = w.card_id AND gp_psa.grading_company = '${BASELINE_COMPANY}'
        AND gp_psa.grade = w.grade
      WHERE (@watchId IS NULL OR l.watch_id = @watchId)
        AND instr(@statuses, '|' || l.status || '|') > 0
        AND (@followed IS NULL OR l.followed = @followed)
      ORDER BY l.found_at DESC, l.id DESC
      LIMIT @limit
    `),
    // Following tab: tag/untag a listing. Untagging resets the ending-soon
    // dedupe flag so a re-follow can alert again.
    setListingFollowed: db.prepare(`
      UPDATE listings SET followed = @followed,
        follow_reminder_sent = CASE WHEN @followed = 0 THEN 0 ELSE follow_reminder_sent END
      WHERE id = @id
    `),
    countActiveMatches: db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE status IN ('new','notified')`),
    setListingStatus: db.prepare(`UPDATE listings SET status = ? WHERE id = ?`),
    listNewListings: db.prepare(`SELECT * FROM listings WHERE status = 'new' ORDER BY id`),
    // An auction with a captured end date in the past is confidently gone —
    // deleted outright, not just flagged. An auction whose end date we never
    // captured (ends_at NULL) is deliberately left alone: we're not sure.
    deleteEndedAuctions: db.prepare(`
      DELETE FROM listings
      WHERE listing_type = 'auction' AND ends_at IS NOT NULL AND ends_at < datetime('now')
        AND status IN ('new','notified')
    `),
    // Staleness for fixed-price listings (they never "end" on their own): a
    // successful (watch, source) check that didn't see a listing bumps its
    // miss counter; 3 consecutive misses = confidently sold/delisted, deleted.
    bumpListingMisses: db.prepare(`
      UPDATE listings SET misses = misses + 1
      WHERE watch_id = @watchId AND source = @source AND listing_type = 'fixed'
        AND status IN ('new','notified') AND last_seen_at < @runStartedAt
    `),
    deleteStaleListings: db.prepare(`
      DELETE FROM listings WHERE misses >= 3 AND status IN ('new','notified')
    `),
    // Auctions entering the ending-soon window that haven't had their
    // reminder push yet. @minutes is concatenated into the datetime modifier
    // string, which SQLite allows as an expression. Followed listings are
    // excluded — they get their own richer per-item alert below.
    reminderCandidates: db.prepare(`
      SELECT * FROM listings
      WHERE listing_type = 'auction' AND status IN ('new','notified') AND reminder_sent = 0
        AND followed = 0
        AND ends_at IS NOT NULL AND ends_at > datetime('now')
        AND ends_at <= datetime('now', '+' || @minutes || ' minutes')
      ORDER BY ends_at
    `),
    markListingReminded: db.prepare(`UPDATE listings SET reminder_sent = 1 WHERE id = ?`),
    // Followed auctions crossing the Following lead-time window (default
    // 24h), each alerted once via its own dedupe flag. Joined to the watch
    // like listMatches so the alert can name the card.
    followReminderCandidates: db.prepare(`
      SELECT l.*, COALESCE(c.name, w.description) AS card_name
      FROM listings l
      JOIN watches w ON w.id = l.watch_id
      LEFT JOIN cards c ON c.id = w.card_id
      WHERE l.listing_type = 'auction' AND l.status IN ('new','notified')
        AND l.followed = 1 AND l.follow_reminder_sent = 0
        AND l.ends_at IS NOT NULL AND l.ends_at > datetime('now')
        AND l.ends_at <= datetime('now', '+' || @minutes || ' minutes')
      ORDER BY l.ends_at
    `),
    markListingFollowReminded: db.prepare(`UPDATE listings SET follow_reminder_sent = 1 WHERE id = ?`),

    createWatchRun: db.prepare(`INSERT INTO watch_check_runs (trigger_kind) VALUES (?)`),
    getWatchRun: db.prepare(`SELECT * FROM watch_check_runs WHERE id = ?`),
    latestWatchRun: db.prepare(`SELECT * FROM watch_check_runs ORDER BY id DESC LIMIT 1`),
    latestStaleWatchRun: db.prepare(`SELECT * FROM watch_check_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`),
    updateWatchRunTotals: db.prepare(`UPDATE watch_check_runs SET items_total = @total WHERE id = @id`),
    bumpWatchRunProgress: db.prepare(`
      UPDATE watch_check_runs SET items_processed = items_processed + 1,
        items_failed = items_failed + @failedDelta
      WHERE id = @id
    `),
    addWatchRunNewListings: db.prepare(`UPDATE watch_check_runs SET new_listings = new_listings + ? WHERE id = ?`),
    finishWatchRun: db.prepare(`
      UPDATE watch_check_runs SET status = @status, error = @error, finished_at = datetime('now') WHERE id = @id
    `),
    insertWatchItem: db.prepare(`
      INSERT INTO watch_check_items (run_id, watch_id, source) VALUES (?, ?, ?)
      ON CONFLICT(run_id, watch_id, source) DO NOTHING
    `),
    pendingWatchItems: db.prepare(`SELECT * FROM watch_check_items WHERE run_id = ? AND status = 'pending' ORDER BY id`),
    // Distinct failure reasons for a run, so the UI can explain "N failed".
    watchRunFailures: db.prepare(`
      SELECT source, error, COUNT(*) AS n FROM watch_check_items
      WHERE run_id = ? AND status = 'failed'
      GROUP BY source, error ORDER BY n DESC
    `),
    markWatchItem: db.prepare(`
      UPDATE watch_check_items SET status = @status, attempts = attempts + 1, error = @error WHERE id = @id
    `),

    ensureSourceState: db.prepare(`INSERT INTO source_state (source) VALUES (?) ON CONFLICT(source) DO NOTHING`),
    getSourceState: db.prepare(`SELECT * FROM source_state WHERE source = ?`),
    setSourceBackoff: db.prepare(`UPDATE source_state SET backoff_until = ? WHERE source = ?`),
    setSourceAuth: db.prepare(`UPDATE source_state SET auth_json = ? WHERE source = ?`),
    touchSource: db.prepare(`UPDATE source_state SET last_request_at = datetime('now') WHERE source = ?`),

    kvGet: db.prepare(`SELECT value, updated_at FROM kv_cache WHERE key = ?`),
    kvSet: db.prepare(`
      INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
  };
}
