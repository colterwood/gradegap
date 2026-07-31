const state = {
  basis: 'cl_value',
  direction: 'all',
  maxPrice: 0, // 0 = no cap
  minDiff: 200, // matches the input's default value in index.html
  minPctDiff: 15, // matches the input's default value in index.html
  search: '', // client-side card/player name filter
  playerId: '',
  sortColumn: 'abs_diff', // default: biggest dollar gaps first
  sortDir: 'desc',
  watchFilter: 'all', // all | watched | unwatched (client-side)
  // Liquidity defaults to green only — both sides sold recently.
  colors: { green: true, yellow: false, red: false, gray: false },
  // Which graders are compared against the PSA baseline (several at once are
  // fine — each gets its own rows), and which like-for-like grade comparisons
  // run (<grader> g vs PSA g). Both checkbox sets are populated from
  // /api/config on init so the server config is the single source of truth.
  graders: {},
  grades: {},
};

// The current, unsorted result set (fetched once per server-side filter change).
let currentRows = [];

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Card names and URLs come from scraped Card Ladder data — escape them before
// they go through innerHTML.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Card Ladder dates arrive as ISO (2026-05-06T10:00:00.000Z); show just the day.
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');

// Severity order for sorting the color column: green < yellow < red < gray(unknown).
const COLOR_RANK = { green: 0, yellow: 1, red: 2, gray: 3 };

// --- recency dot -----------------------------------------------------------
// Months since a YYYY-MM-DD last-sale date; a missing date = never sold.
function monthsSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function fmtAge(m) {
  if (m === Infinity) return 'never sold';
  if (m < 1) return `${Math.max(1, Math.round(m * 30.44))}d ago`;
  if (m < 12) return `${Math.round(m)}mo ago`;
  return `${(m / 12).toFixed(1)}yr ago`;
}

// Color rules, evaluated against TODAY (grader = the non-PSA side):
//   green = both grader and PSA last sold <3mo
//   yellow = both grader and PSA last sold >12mo
//   red = grader last sold >3mo AND PSA last sold <3mo
//   gray = anything the three rules don't cover (e.g. PSA itself >3mo)
function recencyDot(row) {
  const grdM = monthsSince(row.grader_last_sale_date);
  const psaM = monthsSince(row.psa_last_sale_date);

  let color;
  if (grdM < 3 && psaM < 3) color = 'green';
  else if (grdM > 12 && psaM > 12) color = 'yellow';
  else if (grdM > 3 && psaM < 3) color = 'red';
  else color = 'gray';

  const g = row.grade ?? '';
  const title = `${row.grader} ${g} last sold ${fmtAge(grdM)} · PSA ${g} last sold ${fmtAge(psaM)}`;
  return { color, title };
}

// Watches keyed "cardId|grader|grade" → watch row (drives the Watch
// checkboxes in the results table and the Watched tab).
const watchByKey = new Map();
const watchKey = (cardId, grader, grade) => `${cardId}|${grader}|${grade}`;

let pollTimer = null;
let wasRunning = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// --- results ---------------------------------------------------------------

// Guards against overlapping fetches resolving out of order (the 2s sync poll
// plus a filter change): only the newest call may commit its response.
let loadSeq = 0;

// Fetch the full comparable set for the current server-side filters (basis,
// direction, min price, player). Sorting and color filtering happen client-side.
async function loadResults() {
  const seq = ++loadSeq;
  const grades = Object.entries(state.grades).filter(([, on]) => on).map(([g]) => g);
  const graders = Object.entries(state.graders).filter(([, on]) => on).map(([c]) => c);
  // No grade or no grader selected -> nothing to compare; clear without a fetch.
  if (grades.length === 0 || graders.length === 0) {
    currentRows = [];
    lastMeta = { total: 0, excluded: 0, missing: [] };
    renderResults();
    return;
  }

  const params = new URLSearchParams({
    basis: state.basis,
    direction: state.direction,
    maxPrice: state.maxPrice,
    minDiff: state.minDiff,
    minPctDiff: state.minPctDiff,
    grades: grades.join(','),
    graders: graders.join(','),
    limit: 5000,
  });
  if (state.playerId) params.set('playerId', state.playerId);

  const data = await api(`/api/results?${params}`);
  if (seq !== loadSeq) return; // a newer request took over while we awaited
  currentRows = data.rows.map((row) => ({ ...row, _dot: recencyDot(row) }));
  lastMeta = { total: data.total, excluded: data.excludedMissingGrade, missing: data.missingGrades ?? [] };
  renderResults();
}

let lastMeta = { total: 0, excluded: 0, missing: [] };

const isWatched = (row) => watchByKey.has(watchKey(row.card_id, row.grader, row.grade));

function sortValue(row, column) {
  switch (column) {
    case 'watch': return isWatched(row) ? 1 : 0;
    case 'color': return COLOR_RANK[row._dot.color];
    case 'grade': return Number(row.grade);
    case 'name': return (row.name || '').toLowerCase();
    case 'grader_last_sale_date':
    case 'psa_last_sale_date': return row[column] || ''; // ISO strings sort lexically; '' (never) sorts first asc / handled below
    default: return row[column]; // numeric columns
  }
}

function renderResults() {
  const active = new Set(Object.entries(state.colors).filter(([, v]) => v).map(([k]) => k));
  const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = currentRows.filter((r) => {
    if (!active.has(r._dot.color)) return false;
    if (terms.length > 0) {
      const hay = `${r.name ?? ''} ${r.player_name ?? ''}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (state.watchFilter === 'watched') return isWatched(r);
    if (state.watchFilter === 'unwatched') return !isWatched(r);
    return true;
  });

  const col = state.sortColumn;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const isDate = col === 'grader_last_sale_date' || col === 'psa_last_sale_date';
  rows.sort((a, b) => {
    let av = sortValue(a, col);
    let bv = sortValue(b, col);
    // push nulls/never-sold to the bottom regardless of direction
    const aNull = av === null || av === undefined || (isDate && av === '');
    const bNull = bv === null || bv === undefined || (isDate && bv === '');
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    const diffClass = row.abs_diff >= 0 ? 'pos' : 'neg';
    const link = row.cl_url
      ? `<a href="${esc(row.cl_url)}" target="_blank" rel="noopener">${esc(row.name)}</a>`
      : esc(row.name);
    const watched = isWatched(row);
    tr.innerHTML = `
      <td class="watch-cell"><input type="checkbox" class="watch-cb" ${watched ? 'checked' : ''}
        data-card-id="${row.card_id}" data-grader="${esc(row.grader)}" data-grade="${esc(row.grade)}" /></td>
      <td class="dot-cell"><span class="dot dot-${row._dot.color}" title="${row._dot.title}"></span></td>
      <td>${link}</td>
      <td class="num grade-cell">${row.grade ?? '—'}</td>
      <td class="grade-cell">${row.grader ?? '—'}</td>
      <td class="num">${fmtMoney(row.grader_price)}</td>
      <td class="num">${fmtMoney(row.psa_price)}</td>
      <td class="num ${diffClass}">${row.abs_diff >= 0 ? '+' : ''}${fmtMoney(row.abs_diff)}</td>
      <td class="num ${diffClass}">${row.pct_diff >= 0 ? '+' : ''}${row.pct_diff}%</td>
      <td class="date">${fmtDate(row.grader_last_sale_date)}</td>
      <td class="num">${row.grader_sales ?? '—'}</td>
      <td class="date">${fmtDate(row.psa_last_sale_date)}</td>
      <td class="num">${row.psa_sales ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }

  $('results').hidden = rows.length === 0;
  const emptyEl = $('empty');
  emptyEl.hidden = rows.length > 0;
  if (rows.length === 0) {
    if (!Object.values(state.grades).some(Boolean)) {
      emptyEl.textContent = 'Select a grade to compare.';
    } else if (!Object.values(state.graders).some(Boolean)) {
      emptyEl.textContent = 'Select at least one grader to compare against PSA.';
    } else if (currentRows.length > 0 && state.search) {
      emptyEl.textContent = 'No rows match the search.';
    } else if (currentRows.length > 0 && state.watchFilter !== 'all') {
      emptyEl.textContent = `No ${state.watchFilter} rows under the current filters.`;
    } else if (currentRows.length > 0) {
      emptyEl.textContent = 'All rows are hidden by the current Liquidity filter.';
    } else if (lastMeta.missing.length > 0) {
      emptyEl.innerHTML = `No ${lastMeta.missing.join(' or ')} vs PSA data synced yet — hit <strong>Sync</strong> to pull it.`;
    } else {
      emptyEl.innerHTML = 'No matching cards — hit <strong>Sync</strong> to pull data from Card Ladder, or loosen the filters.';
    }
  }

  updateSortArrows('results', state.sortColumn, state.sortDir);

  const bits = [];
  if (rows.length !== lastMeta.total) bits.push(`${rows.length} of ${lastMeta.total} cards`);
  else bits.push(`${lastMeta.total} card${lastMeta.total === 1 ? '' : 's'} with both grades`);
  if (lastMeta.excluded > 0) bits.push(`${lastMeta.excluded} skipped (missing a grade on this basis)`);
  for (const m of lastMeta.missing) bits.push(`no ${m} vs PSA data synced yet — run Sync to pull it`);
  $('summary').textContent = bits.join(' · ');
}

function updateSortArrows(tableId, sortCol, sortDir) {
  for (const th of document.querySelectorAll(`#${tableId} th.sortable`)) {
    const arrow = th.querySelector('.arrow');
    if (th.dataset.col === sortCol) {
      th.classList.add('sorted');
      arrow.textContent = sortDir === 'asc' ? ' ▲' : ' ▼';
    } else {
      th.classList.remove('sorted');
      arrow.textContent = '';
    }
  }
}

// --- sync ------------------------------------------------------------------

function setError(msg) {
  const el = $('error-banner');
  el.hidden = !msg;
  el.textContent = msg || '';
}

async function refreshStatus() {
  const s = await api('/api/sync/status');

  $('sync-btn').disabled = s.running;
  $('cancel-btn').hidden = !s.running;
  $('resume-btn').hidden = s.running || !s.staleRun;
  $('progress').hidden = !s.running;

  if (s.running && s.run) {
    const { cards_total, cards_processed } = s.run;
    const pct = cards_total ? Math.round((cards_processed / cards_total) * 100) : 0;
    $('progress-fill').style.width = `${pct}%`;
    // Primary line: the live per-grade counter (e.g. "SGC 10 — 142 / 533 cards").
    // Secondary: overall processed across both grade passes.
    const label = s.currentCardName || 'Starting…';
    const overall = cards_total
      ? `${cards_processed.toLocaleString()} / ${cards_total.toLocaleString()} total · ${pct}%`
      : '';
    $('progress-text').textContent = overall ? `${label}   ·   ${overall}` : label;
  }

  if (!s.running && s.run) {
    if (s.run.status === 'completed') {
      const failed = s.run.cards_failed ? ` (${s.run.cards_failed} failed — see captures/failures/)` : '';
      $('sync-info').textContent = `Last synced ${s.run.finished_at} UTC${failed}`;
    } else if (s.run.status === 'failed') {
      setError(`Last sync failed: ${s.run.error ?? 'unknown error'}`);
    } else if (s.run.status === 'cancelled') {
      $('sync-info').textContent = `Last sync cancelled (${s.run.cards_processed}/${s.run.cards_total})`;
    }
  }

  // Refresh the table live while a sync runs so cards visibly accumulate,
  // and once more when it finishes.
  if (s.running || (wasRunning && !s.running)) {
    await loadResults().catch(() => {});
  }
  if (wasRunning && !s.running) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  wasRunning = s.running;
  return s;
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(refreshStatus, 2000);
}

async function triggerSync(resume) {
  setError('');
  try {
    await api('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume }),
    });
    wasRunning = true;
    await refreshStatus();
    startPolling();
  } catch (err) {
    setError(err.message);
  }
}

// --- config-driven controls ------------------------------------------------

// Fill a .checks container with one labeled checkbox per value, mirroring the
// selections into stateMap (all start checked).
function buildChecks(containerId, dataKey, values, stateMap) {
  const box = $(containerId);
  box.innerHTML = '';
  for (const v of values) {
    stateMap[v] = true;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset[dataKey] = v;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${v}`));
    box.appendChild(label);
  }
}

// Build the Grade and Grader checkboxes from the server's config so adding a
// grade or grader is a config.js-only change.
async function loadConfig() {
  const cfg = await api('/api/config');
  buildChecks('grade-filter', 'grade', cfg.grades, state.grades);
  buildChecks('grader-filter', 'grader', cfg.graders, state.graders);
  // The hand-add form's dropdowns (wider vocabulary than the comparison).
  fillSelect('new-grader', cfg.manualGraders ?? [], 'SGC');
  fillSelect('new-grade', cfg.manualGrades ?? [], '10');
  document.querySelector('.subtitle').textContent =
    `${cfg.graders.join(' / ')} vs ${cfg.baseline} price disparity, like grade vs like grade`;
}

// --- players + wiring ------------------------------------------------------

async function loadPlayers() {
  const players = await api('/api/players');
  const sel = $('player');
  for (const p of players) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
}

function wireToggle(id, key) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('active', b === btn);
    state[key] = btn.dataset.value;
    loadResults().catch((err) => setError(err.message));
  });
}

wireToggle('basis-toggle', 'basis');

// Watched/unwatched is a client-side view of rows already loaded.
$('watch-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  for (const b of $('watch-filter').querySelectorAll('button')) b.classList.toggle('active', b === btn);
  state.watchFilter = btn.dataset.value;
  renderResults();
});

// Click a column header to sort by it; first click ascending, click again to
// flip to descending. (Color column ascending = green→yellow→red.)
for (const th of document.querySelectorAll('#results th.sortable')) {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.sortColumn === col) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortColumn = col;
      state.sortDir = 'asc';
    }
    renderResults();
  });
}

// Liquidity color filter checkboxes (client-side only).
$('color-filter').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  state.colors[cb.dataset.color] = cb.checked;
  renderResults();
});

// Grade checkboxes change which comparisons the server runs (SGC 10 vs PSA 10,
// SGC 9 vs PSA 9, or both), so they trigger a refetch.
$('grade-filter').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  state.grades[cb.dataset.grade] = cb.checked;
  loadResults().catch((err) => setError(err.message));
});

// Grader checkboxes change which companies are compared against the PSA
// baseline; several can be shown at once (each row carries its grader).
$('grader-filter').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  state.graders[cb.dataset.grader] = cb.checked;
  loadResults().catch((err) => setError(err.message));
});

let maxPriceDebounce = null;
$('max-price').addEventListener('input', (e) => {
  clearTimeout(maxPriceDebounce);
  maxPriceDebounce = setTimeout(() => {
    state.maxPrice = parseFloat(e.target.value) || 0;
    loadResults().catch((err) => setError(err.message));
  }, 300);
});

let minDiffDebounce = null;
$('min-diff').addEventListener('input', (e) => {
  clearTimeout(minDiffDebounce);
  minDiffDebounce = setTimeout(() => {
    state.minDiff = parseFloat(e.target.value) || 0;
    loadResults().catch((err) => setError(err.message));
  }, 300);
});

let minPctDiffDebounce = null;
$('min-pct-diff').addEventListener('input', (e) => {
  clearTimeout(minPctDiffDebounce);
  minPctDiffDebounce = setTimeout(() => {
    state.minPctDiff = parseFloat(e.target.value) || 0;
    loadResults().catch((err) => setError(err.message));
  }, 300);
});

$('player').addEventListener('change', (e) => {
  state.playerId = e.target.value;
  loadResults().catch((err) => setError(err.message));
});

// Search filters the already-loaded rows client-side — no refetch needed.
let searchDebounce = null;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.search = e.target.value.trim();
    renderResults();
  }, 200);
});

$('sync-btn').addEventListener('click', () => triggerSync(false));
$('resume-btn').addEventListener('click', () => triggerSync(true));
$('cancel-btn').addEventListener('click', () => api('/api/sync/cancel', { method: 'POST' }).catch(() => {}));

// --- marketplace watcher ---------------------------------------------------

let currentView = 'disparity';
let checkPollTimer = null;
let checkWasRunning = false;

// The two listing tables (Listings = everything, Following = tagged rows)
// share one renderer; each keeps its own rows, sort, and search so flipping
// tabs never clobbers the other's view state. sort.col null = the server's
// newest-first order.
const listingViews = {
  listings: {
    rows: [], sort: { col: null, dir: 'asc' }, search: '',
    tableId: 'matches-table', summaryId: 'matches-summary', emptyId: 'matches-empty',
    emptyText: 'No listings matched yet — hit Check now, or wait for the next scheduled check.',
  },
  following: {
    rows: [], sort: { col: null, dir: 'asc' }, search: '',
    tableId: 'following-table', summaryId: 'following-summary', emptyId: 'following-empty',
    emptyText: 'Not following anything yet — tick the Follow box on a row in the Listings tab.',
  },
};

async function loadWatches() {
  const watches = await api('/api/watches');
  watchByKey.clear();
  for (const w of watches) watchByKey.set(watchKey(w.card_id, w.grading_company, w.grade), w);
  renderWatches(watches);
  return watches;
}

// Tick/untick a Watch checkbox in the results table. Unticking deletes the
// watch AND its listing history (pausing is the Watched tab's On toggle).
document.querySelector('#results tbody').addEventListener('change', async (e) => {
  const cb = e.target.closest('input.watch-cb');
  if (!cb) return;
  const key = watchKey(cb.dataset.cardId, cb.dataset.grader, cb.dataset.grade);
  cb.disabled = true;
  try {
    if (cb.checked) {
      await api('/api/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: Number(cb.dataset.cardId), gradingCompany: cb.dataset.grader, grade: cb.dataset.grade }),
      });
    } else {
      const existing = watchByKey.get(key);
      if (existing) await api(`/api/watches/${existing.id}`, { method: 'DELETE' });
    }
    await loadWatches();
    await refreshWatchBadge();
  } catch (err) {
    setError(err.message);
    cb.checked = !cb.checked;
  } finally {
    cb.disabled = false;
  }
});

// --- tabs ---

function switchView(view) {
  currentView = view;
  for (const btn of document.querySelectorAll('.tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  $('view-disparity').hidden = view !== 'disparity';
  $('view-watched').hidden = view !== 'watched';
  $('view-listings').hidden = view !== 'listings';
  $('view-following').hidden = view !== 'following';
  $('view-sources').hidden = view !== 'sources';
  if (view === 'watched') loadWatchedView().catch((err) => setError(err.message));
  if (view === 'listings') loadListingsView().catch((err) => setError(err.message));
  if (view === 'following') loadFollowingView().catch((err) => setError(err.message));
  if (view === 'sources') loadSourcesView().catch((err) => setError(err.message));
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchView(btn.dataset.view);
});

// --- watched view ---

// Listing times are SQLite "YYYY-MM-DD HH:MM:SS" (UTC).
const parseSqlDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);

function fmtTimeLeft(endsAt) {
  const d = parseSqlDate(endsAt);
  if (!d || isNaN(d.getTime())) return '';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'ended';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

// When a listing row was added, in Regina local time (the machine's zone;
// no DST there, but Intl handles that either way). found_at is SQLite UTC.
function fmtAdded(sqlTs) {
  const d = parseSqlDate(sqlTs);
  if (!d || isNaN(d.getTime())) return '—';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Regina',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// None grader + Raw grade are one state: an ungraded card.
const slabLabel = (w) =>
  w.grading_company === 'None' || w.grade === 'Raw' ? 'Ungraded' : `${w.grading_company} ${w.grade}`;

// Card names ("1986 Fleer Michael Jordan #57") already carry year/set/number;
// manual watches show the description that was typed.
const watchLabel = (w) => `${w.card_name} · ${slabLabel(w)}`;

function renderWatches(watches) {
  const tbody = document.querySelector('#watches-table tbody');
  tbody.innerHTML = '';
  for (const w of watches) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(w.card_name)}${w.card_id == null ? ' <span class="manual-tag">manual</span>' : ''}</td>
      <td class="grade-cell">${esc(slabLabel(w))}</td>
      <td><input type="text" class="watch-search-term" data-id="${w.id}"
        value="${esc(w.search_term ?? '')}" placeholder="${esc(w.auto_search ?? '')}"
        title="Sent to marketplaces verbatim when set; blank = the automatic query shown in gray" /></td>
      <td class="num"><input type="number" class="watch-max-price" data-id="${w.id}" min="0" step="50"
        value="${w.max_price ?? ''}" placeholder="—" /></td>
      <td class="num">${w.active_listings}</td>
      <td class="date">${w.last_checked_at ? esc(w.last_checked_at) + ' UTC' : 'never'}</td>
      <td><input type="checkbox" class="watch-enabled" data-id="${w.id}" ${w.enabled ? 'checked' : ''} /></td>
      <td><button class="link-btn watch-delete" data-id="${w.id}" title="Delete this watch and its listing history">✕</button></td>
    `;
    tbody.appendChild(tr);
  }
  $('watches-table').hidden = watches.length === 0;
  $('watches-empty').hidden = watches.length > 0;
}

// Deal dot: how the asking price sits against the watched grade's CL value.
// red = already over CL; green = under CL and buyable now; yellow = under CL
// but an auction (the price can still climb); gray = nothing to compare.
function dealDot(m) {
  const price = m.price_usd ?? m.price;
  const cl = m.cl_value;
  if (price == null || cl == null) {
    return { color: 'gray', rank: 3, title: 'No CL value to compare against' };
  }
  if (price > cl) {
    return { color: 'red', rank: 2, title: `Price ${fmtMoney(price)} is above the ${fmtMoney(cl)} CL value` };
  }
  if (m.listing_type === 'auction') {
    return { color: 'yellow', rank: 1, title: `Bid ${fmtMoney(price)} is under the ${fmtMoney(cl)} CL value, but it's an auction` };
  }
  return { color: 'green', rank: 0, title: `Price ${fmtMoney(price)} is under the ${fmtMoney(cl)} CL value — Buy It Now` };
}

function matchSortValue(m, col) {
  switch (col) {
    case 'deal': return m._deal.rank;
    case 'followed': return m.followed ? 1 : 0;
    case 'price_usd': return m.price_usd ?? m.price;
    case 'ends_at': return m.listing_type === 'auction' ? m.ends_at || null : null; // SQL dates sort lexically
    case 'source': case 'listing_type': return m[col] || '';
    case 'title': return (m.title || '').toLowerCase();
    case 'card_name': return watchLabel(m).toLowerCase();
    default: return m[col]; // cl_value, psa_value, match_score
  }
}

// One renderer for both listing tables. viewKey selects the per-view state
// in listingViews; the two tables differ only in their first and last
// columns (Listings: Follow checkbox + Dismiss; Following: Unfollow).
// The Watched card cell. When a listing title could belong to more than one
// watched card, offer them all in a dropdown (best match first) so a
// mis-attributed row can be corrected — picking one PINS it, and "Auto"
// hands it back to the scorer. A single candidate needs no dropdown.
function watchCardCell(m) {
  const cands = m.candidates ?? [];
  const current = watchLabel(m);
  if (cands.length < 2) {
    return esc(current) + (m.watch_locked ? ' <span class="pin" title="Pinned by you">📌</span>' : '');
  }
  const opts = cands
    .map(
      (c) =>
        `<option value="${c.watchId}" ${c.watchId === m.watch_id ? 'selected' : ''}>` +
        `${esc(c.label)} — ${Math.round(c.score * 100)}%</option>`
    )
    .join('');
  // The current owner may not be among the candidates (a pinned pick that
  // no longer matches) — keep it selectable so the cell never lies.
  const orphan = cands.some((c) => c.watchId === m.watch_id)
    ? ''
    : `<option value="${m.watch_id}" selected>${esc(current)} — pinned</option>`;
  return (
    `<select class="watch-pick" data-id="${m.id}" title="${cands.length} watched cards match this listing — pick the right one">` +
    `${orphan}${opts}<option value="auto">↺ Auto (best match)</option></select>` +
    (m.watch_locked ? ' <span class="pin" title="Pinned by you">📌</span>' : '')
  );
}

function renderMatches(viewKey) {
  const view = listingViews[viewKey];
  const all = view.rows;
  for (const m of all) m._deal = dealDot(m);

  // Listings-only view filters (the Following tab is a hand-curated list,
  // nothing there should be hidden): "Hide low-confidence" drops sub-50%
  // scores, "Hide following" drops rows already tagged onto the Following
  // tab — seeing them in both places is redundant. Both are view-only; the
  // rows stay in the DB and reappear when unchecked. Ended/dismissed
  // listings never reach here at all — they're deleted server-side the
  // moment they're confirmed gone.
  let matches = [...all];
  if (viewKey === 'listings') {
    if ($('hide-low').checked) matches = matches.filter((m) => m.match_score == null || m.match_score >= 0.5);
    if ($('hide-following').checked) matches = matches.filter((m) => !m.followed);
  }

  const terms = view.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 0) {
    matches = matches.filter((m) => {
      const hay = `${m.title ?? ''} ${watchLabel(m)} ${m.source ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  if (view.sort.col) {
    const dir = view.sort.dir === 'asc' ? 1 : -1;
    matches.sort((a, b) => {
      const av = matchSortValue(a, view.sort.col);
      const bv = matchSortValue(b, view.sort.col);
      // nulls (no price, no end time, no CL value) go to the bottom either way
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  const tbody = document.querySelector(`#${view.tableId} tbody`);
  tbody.innerHTML = '';
  for (const m of matches) {
    const tr = document.createElement('tr');
    const title = m.url
      ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>`
      : esc(m.title);
    const score = m.match_score == null ? '—' : `${Math.round(m.match_score * 100)}%`;
    const low = m.match_score != null && m.match_score < 0.7;
    const ends = m.listing_type === 'auction' && m.ends_at
      ? `<span class="date">${esc(m.ends_at)}</span><br /><span class="time-left">${fmtTimeLeft(m.ends_at)}</span>`
      : '—';
    const followCell = viewKey === 'listings'
      ? `<td class="watch-cell"><input type="checkbox" class="follow-cb" data-id="${m.id}" ${m.followed ? 'checked' : ''}
           title="Follow: 24h-left and price-drop alerts, and a row on the Following tab" /></td>`
      : '';
    const actionCell = viewKey === 'listings'
      ? `<td><button class="link-btn match-dismiss" data-id="${m.id}">Dismiss</button></td>`
      : `<td><button class="link-btn match-unfollow" data-id="${m.id}">Unfollow</button></td>`;
    tr.innerHTML = `
      ${followCell}
      <td class="dot-cell"><span class="dot dot-${m._deal.color}" title="${esc(m._deal.title)}"></span></td>
      <td><span class="source-badge">${esc(m.source)}</span></td>
      <td class="listing-title">${title}${m.seller ? `<div class="seller">${esc(m.seller)}</div>` : ''}</td>
      <td class="watch-ref">${watchCardCell(m)}</td>
      <td class="date">${fmtAdded(m.found_at)}</td>
      <td class="num">${fmtMoney(m.price_usd ?? m.price)}${m.currency && m.currency !== 'USD' ? `<div class="native-price">${esc(String(m.price))} ${esc(m.currency)}</div>` : ''}</td>
      <td class="num cl-value">${fmtMoney(m.cl_value)}</td>
      <td class="num cl-value">${fmtMoney(m.psa_value)}</td>
      <td>${m.listing_type === 'auction' ? 'Auction' : 'Buy It Now'}</td>
      <td>${ends}</td>
      <td class="num">${low ? `<span class="score-low" title="Low-confidence match — verify before trusting">${score}</span>` : score}</td>
      ${actionCell}
    `;
    tbody.appendChild(tr);
  }

  updateSortArrows(view.tableId, view.sort.col, view.sort.dir);
  $(view.tableId).hidden = matches.length === 0;
  const empty = $(view.emptyId);
  empty.hidden = matches.length > 0;
  if (matches.length === 0) {
    empty.textContent = all.length > 0 ? 'No rows match the search.' : view.emptyText;
  }
  const hidden = all.length - matches.length;
  const noun = viewKey === 'following' ? 'followed listing' : 'live listing';
  const reasons = viewKey === 'listings' ? 'followed, low-confidence, or search' : 'search';
  $(view.summaryId).textContent = `${matches.length} ${noun}${matches.length === 1 ? '' : 's'}` +
    (hidden > 0 ? ` · ${hidden} hidden (${reasons})` : '');
}

async function loadWatchedView() {
  const watches = await loadWatches();
  await refreshCheckStatus();
  return watches;
}

// --- hand-add a watch ---

function fillSelect(id, values, initial) {
  const sel = $(id);
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  if (values.includes(initial)) sel.value = initial;
}

// 'None' grader and 'Raw' grade are one state (ungraded) — picking either
// pulls the other along, and leaving it releases both to their defaults.
function coupleUngraded(changed) {
  const grader = $('new-grader');
  const grade = $('new-grade');
  if (changed === 'grader') {
    if (grader.value === 'None') grade.value = 'Raw';
    else if (grade.value === 'Raw') grade.value = '10';
  } else {
    if (grade.value === 'Raw') grader.value = 'None';
    else if (grader.value === 'None') grader.value = 'SGC';
  }
}

$('new-grader').addEventListener('change', () => coupleUngraded('grader'));
$('new-grade').addEventListener('change', () => coupleUngraded('grade'));

$('add-watch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = $('new-desc').value.trim();
  if (!description) {
    setError('Enter a description for the card you want to watch.');
    return;
  }
  setError('');
  $('add-watch-btn').disabled = true;
  try {
    await api('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        gradingCompany: $('new-grader').value,
        grade: $('new-grade').value,
        maxPrice: $('new-max-price').value === '' ? null : parseFloat($('new-max-price').value),
      }),
    });
    $('new-desc').value = '';
    $('new-max-price').value = '';
    await loadWatchedView();
  } catch (err) {
    setError(err.message);
  } finally {
    $('add-watch-btn').disabled = false;
  }
});

// limit is explicit so the table can never silently show fewer rows than
// the badge counts.
async function loadListingsView() {
  listingViews.listings.rows = await api('/api/matches?status=new,notified&limit=20000');
  renderMatches('listings');
  await refreshWatchBadge();
}

async function loadFollowingView() {
  listingViews.following.rows = await api('/api/matches?status=new,notified&followed=1&limit=20000');
  renderMatches('following');
}

// Click a column header to sort, same behavior as the disparity table —
// wired for both listing tables, each against its own sort state.
for (const [viewKey, tableId] of [['listings', 'matches-table'], ['following', 'following-table']]) {
  for (const th of document.querySelectorAll(`#${tableId} th.sortable`)) {
    th.addEventListener('click', () => {
      const sort = listingViews[viewKey].sort;
      const col = th.dataset.col;
      if (sort.col === col) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort.col = col;
        sort.dir = 'asc';
      }
      renderMatches(viewKey);
    });
  }
}

document.querySelector('#watches-table tbody').addEventListener('change', async (e) => {
  const enabled = e.target.closest('input.watch-enabled');
  const maxPrice = e.target.closest('input.watch-max-price');
  const searchTerm = e.target.closest('input.watch-search-term');
  try {
    if (enabled) {
      await api(`/api/watches/${enabled.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled.checked }),
      });
    } else if (maxPrice) {
      await api(`/api/watches/${maxPrice.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPrice: maxPrice.value === '' ? null : parseFloat(maxPrice.value) }),
      });
    } else if (searchTerm) {
      // Blank clears the override — the placeholder (automatic query) takes
      // back over on the next check.
      await api(`/api/watches/${searchTerm.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerm: searchTerm.value }),
      });
    }
  } catch (err) {
    setError(err.message);
  }
});

document.querySelector('#watches-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.watch-delete');
  if (!btn) return;
  if (!confirm('Delete this watch and its listing history?')) return;
  try {
    await api(`/api/watches/${btn.dataset.id}`, { method: 'DELETE' });
    await loadWatchedView();
    await loadResults().catch(() => {});
  } catch (err) {
    setError(err.message);
  }
});

document.querySelector('#matches-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.match-dismiss');
  if (!btn) return;
  try {
    await api(`/api/matches/${btn.dataset.id}/dismiss`, { method: 'POST' });
    await loadListingsView();
  } catch (err) {
    setError(err.message);
  }
});

// Watched-card dropdown on either listing table: re-point a mis-attributed
// listing at the right card (or back to automatic). CL Value / PSA / the
// deal dot all come from the owning watch, so the view is reloaded after.
for (const [viewKey, tableId] of [['listings', 'matches-table'], ['following', 'following-table']]) {
  document.querySelector(`#${tableId} tbody`).addEventListener('change', async (e) => {
    const sel = e.target.closest('select.watch-pick');
    if (!sel) return;
    sel.disabled = true;
    try {
      await api(`/api/matches/${sel.dataset.id}/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchId: sel.value === 'auto' ? null : Number(sel.value) }),
      });
      await (viewKey === 'listings' ? loadListingsView() : loadFollowingView());
    } catch (err) {
      setError(err.message);
      sel.disabled = false;
    }
  });
}

// Follow checkbox on a Listings row: tag/untag for the Following tab.
document.querySelector('#matches-table tbody').addEventListener('change', async (e) => {
  const cb = e.target.closest('input.follow-cb');
  if (!cb) return;
  cb.disabled = true;
  try {
    await api(`/api/matches/${cb.dataset.id}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followed: cb.checked }),
    });
    const row = listingViews.listings.rows.find((m) => m.id === Number(cb.dataset.id));
    if (row) row.followed = cb.checked ? 1 : 0;
    // With "Hide following" on, a just-followed row leaves the table right
    // away — it now lives on the Following tab.
    if ($('hide-following').checked) renderMatches('listings');
  } catch (err) {
    setError(err.message);
    cb.checked = !cb.checked;
  } finally {
    cb.disabled = false;
  }
});

document.querySelector('#following-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.match-unfollow');
  if (!btn) return;
  try {
    await api(`/api/matches/${btn.dataset.id}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followed: false }),
    });
    await loadFollowingView();
  } catch (err) {
    setError(err.message);
  }
});

$('hide-low').addEventListener('change', () => renderMatches('listings'));
$('hide-following').addEventListener('change', () => renderMatches('listings'));

// Per-table search boxes, same feel as the disparity tab's.
for (const [viewKey, inputId] of [['listings', 'listing-search'], ['following', 'following-search']]) {
  let debounce = null;
  $(inputId).addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      listingViews[viewKey].search = e.target.value.trim();
      renderMatches(viewKey);
    }, 200);
  });
}

// --- sources view ---

// Which sources "Check Selected" will run. Every source starts ticked; the
// set is remembered across re-renders so a poll doesn't undo a choice.
const sourceSelection = new Set();
let sourcesSeeded = false;

// One-line account of why a source is or isn't doing anything, most
// actionable first — this is the column that answers "why did it return
// nothing?" without digging through the DB.
function sourceStatus(s) {
  if (!s.enabled) return '<span class="src-bad">disabled</span>';
  if (s.skippedReason) return `<span class="src-warn">skipped — ${esc(s.skippedReason)}</span>`;
  if (s.backoffUntil && s.backoffUntil > new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    return `<span class="src-warn">rate-limit backoff until ${esc(s.backoffUntil)} UTC</span>`;
  }
  if (s.error) {
    return `<span class="src-bad" title="${esc(s.error)}">${esc(String(s.error).slice(0, 70))}${
      s.errorCount > 1 ? ` (×${s.errorCount})` : ''
    }</span>`;
  }
  if (s.pending > 0) return '<span class="src-muted">queued</span>';
  if (s.done > 0 && s.listings === 0) return '<span class="src-warn">ran, found nothing</span>';
  if (s.done > 0) return '<span class="src-ok">ok</span>';
  return '<span class="src-muted">—</span>';
}

function renderSources(data) {
  const tbody = document.querySelector('#sources-table tbody');
  tbody.innerHTML = '';
  for (const s of data.sources) {
    if (!sourcesSeeded) sourceSelection.add(s.name); // default: all ticked
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="watch-cell"><input type="checkbox" class="source-cb" data-name="${esc(s.name)}"
        ${sourceSelection.has(s.name) ? 'checked' : ''} /></td>
      <td><span class="source-badge">${esc(s.name)}</span></td>
      <td class="num">${s.done}</td>
      <td class="num ${s.failed > 0 ? 'neg' : ''}">${s.failed}</td>
      <td class="num">${s.pending}</td>
      <td class="num">${s.listings}</td>
      <td class="src-status">${sourceStatus(s)}</td>
    `;
    tbody.appendChild(tr);
  }
  sourcesSeeded = true;
  $('sources-table').hidden = data.sources.length === 0;
  $('sources-empty').hidden = data.sources.length > 0;

  const totals = data.sources.reduce(
    (a, s) => ({ done: a.done + s.done, failed: a.failed + s.failed, pending: a.pending + s.pending, listings: a.listings + s.listings }),
    { done: 0, failed: 0, pending: 0, listings: 0 }
  );
  const run = data.run;
  $('sources-info').textContent = run
    ? `Run ${run.id} (${run.status}) · ${totals.done} done · ${totals.failed} failed · ${totals.pending} pending · ${totals.listings} listings`
    : 'No check has run yet';
  syncSelectAllBox();
}

function syncSelectAllBox() {
  const boxes = [...document.querySelectorAll('#sources-table .source-cb')];
  const all = boxes.length > 0 && boxes.every((b) => b.checked);
  const none = boxes.every((b) => !b.checked);
  const master = $('sources-all-cb');
  master.checked = all;
  master.indeterminate = !all && !none;
}

async function loadSourcesView() {
  let data;
  try {
    data = await api('/api/sources');
  } catch (err) {
    // public/ is served fresh but src/ is baked into the running process, so
    // this tab exists in the browser before the server knows the endpoint.
    $('sources-table').hidden = true;
    const empty = $('sources-empty');
    empty.hidden = false;
    empty.textContent = /404|not found/i.test(err.message)
      ? 'Restart the server to enable this tab (it needs the new /api/sources endpoint).'
      : err.message;
    return;
  }
  renderSources(data);
  await refreshCheckStatus();
}

document.querySelector('#sources-table tbody').addEventListener('change', (e) => {
  const cb = e.target.closest('input.source-cb');
  if (!cb) return;
  if (cb.checked) sourceSelection.add(cb.dataset.name);
  else sourceSelection.delete(cb.dataset.name);
  syncSelectAllBox();
});

$('sources-all-cb').addEventListener('change', (e) => {
  for (const cb of document.querySelectorAll('#sources-table .source-cb')) {
    cb.checked = e.target.checked;
    if (cb.checked) sourceSelection.add(cb.dataset.name);
    else sourceSelection.delete(cb.dataset.name);
  }
  syncSelectAllBox();
});

// Kick off a check. sources = null runs everything; an array runs only those.
async function startCheck(sources) {
  setError('');
  try {
    await api('/api/watch-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sources ? { sources } : {}),
    });
    checkWasRunning = true;
    await refreshCheckStatus();
    if (currentView === 'sources') await loadSourcesView().catch(() => {});
    if (!checkPollTimer) checkPollTimer = setInterval(() => refreshCheckStatus().catch(() => {}), 2000);
  } catch (err) {
    setError(err.message);
  }
}

$('check-all-btn').addEventListener('click', () => startCheck(null));
$('check-selected-btn').addEventListener('click', () => {
  const picked = [...document.querySelectorAll('#sources-table .source-cb')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.name);
  if (picked.length === 0) {
    setError('Tick at least one source, or use Check All.');
    return;
  }
  startCheck(picked);
});
$('sources-cancel-btn').addEventListener('click', () =>
  api('/api/watch-check/cancel', { method: 'POST' }).catch(() => {})
);

// --- check-now + status ---

async function refreshCheckStatus() {
  const s = await api('/api/watch-check/status');

  $('check-btn').disabled = s.running;
  $('check-cancel-btn').hidden = !s.running;
  $('check-progress').hidden = !s.running;
  // The Sources tab drives the same run, so its controls mirror these.
  $('check-all-btn').disabled = s.running;
  $('check-selected-btn').disabled = s.running;
  $('sources-cancel-btn').hidden = !s.running;
  $('sources-progress').hidden = !s.running;
  if (s.running && s.run) {
    const { items_total, items_processed } = s.run;
    const label = s.currentLabel || 'Starting…';
    const text = `${label}   ·   ${items_processed} / ${items_total} checks`;
    $('check-progress-text').textContent = text;
    $('sources-progress-text').textContent = text;
  }
  if (!s.running && s.run) {
    if (s.run.status === 'completed') {
      const failed = s.run.items_failed ? ` · ${s.run.items_failed} failed` : '';
      $('check-info').textContent = `Last checked ${s.run.finished_at} UTC · ${s.run.new_listings} new${failed}`;
    } else if (s.run.status === 'failed') {
      setError(`Last check failed: ${s.run.error ?? s.lastError ?? 'unknown error'}`);
    }
    // Never leave "N failed" unexplained: show the grouped reasons, plus any
    // source skipped for missing setup.
    const notes = [
      ...(s.failures ?? []).map((f) => `${f.source} — ${f.error ?? 'unknown error'} (${f.n} watch${f.n === 1 ? '' : 'es'})`),
      ...(s.skippedSources ?? []).map((x) => `${x.name} skipped — ${x.reason}`),
    ];
    if (notes.length > 0 && s.run.status !== 'failed') setError(notes.join(' · '));
    else if (notes.length === 0 && s.run.status === 'completed') setError('');
  }
  updateBadge(s.newCount);

  if (checkWasRunning && !s.running) {
    clearInterval(checkPollTimer);
    checkPollTimer = null;
    await loadWatches().catch(() => {});
    if (currentView === 'listings') await loadListingsView().catch(() => {});
    if (currentView === 'following') await loadFollowingView().catch(() => {});
    if (currentView === 'sources') await loadSourcesView().catch(() => {});
  }
  checkWasRunning = s.running;
  return s;
}

function updateBadge(n) {
  const badge = $('watched-badge');
  badge.hidden = !n;
  badge.textContent = n || '';
}

async function refreshWatchBadge() {
  try {
    const s = await api('/api/watch-check/status');
    updateBadge(s.newCount);
    return s;
  } catch {
    return null;
  }
}

$('check-btn').addEventListener('click', () => startCheck(null));

$('check-cancel-btn').addEventListener('click', () => api('/api/watch-check/cancel', { method: 'POST' }).catch(() => {}));

(async function init() {
  try {
    await loadConfig();
    await loadPlayers();
    await loadWatches().catch(() => {});
    const s = await refreshStatus();
    if (s.running) startPolling();
    await loadResults();
    const cs = await refreshWatchBadge();
    // Scheduled checks run server-side; a slow poll keeps the badge and any
    // in-flight check visible even if this tab never triggered it.
    if (cs?.running && !checkPollTimer) {
      checkWasRunning = true;
      checkPollTimer = setInterval(() => refreshCheckStatus().catch(() => {}), 2000);
    }
    setInterval(() => {
      (currentView === 'watched' ? refreshCheckStatus() : refreshWatchBadge()).catch(() => {});
    }, 30000);
    if (location.hash === '#watched') switchView('watched');
    if (location.hash === '#listings') switchView('listings');
    if (location.hash === '#following') switchView('following');
    if (location.hash === '#sources') switchView('sources');
  } catch (err) {
    setError(err.message);
  }
})();
