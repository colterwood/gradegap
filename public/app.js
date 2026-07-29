const state = {
  basis: 'cl_value',
  direction: 'all',
  minPrice: 0,
  minDiff: 0,
  playerId: '',
  sortColumn: 'pct_diff', // default: biggest % gaps first
  sortDir: 'desc',
  colors: { green: true, yellow: true, red: true, gray: true },
  // Which like-for-like comparisons to run: SGC 10 vs PSA 10, SGC 9 vs PSA 9.
  grades: { '10': true, '9': true },
};

// The current, unsorted result set (fetched once per server-side filter change).
let currentRows = [];

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

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

// Color rules, evaluated against TODAY (SGC = the non-PSA grader):
//   green = both SGC and PSA last sold <3mo
//   yellow = both SGC and PSA last sold >12mo
//   red = SGC last sold >3mo AND PSA last sold <3mo
//   gray = anything the three rules don't cover (e.g. PSA itself >3mo)
function recencyDot(row) {
  const sgcM = monthsSince(row.sgc_last_sale_date);
  const psaM = monthsSince(row.psa_last_sale_date);

  let color;
  if (sgcM < 3 && psaM < 3) color = 'green';
  else if (sgcM > 12 && psaM > 12) color = 'yellow';
  else if (sgcM > 3 && psaM < 3) color = 'red';
  else color = 'gray';

  const g = row.grade ?? '';
  const title = `SGC ${g} last sold ${fmtAge(sgcM)} · PSA ${g} last sold ${fmtAge(psaM)}`;
  return { color, title };
}

let pollTimer = null;
let wasRunning = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// --- results ---------------------------------------------------------------

// Fetch the full comparable set for the current server-side filters (basis,
// direction, min price, player). Sorting and color filtering happen client-side.
async function loadResults() {
  const grades = Object.entries(state.grades).filter(([, on]) => on).map(([g]) => g);
  // No grade selected -> nothing to compare; clear the table without a fetch.
  if (grades.length === 0) {
    currentRows = [];
    lastMeta = { total: 0, excluded: 0 };
    renderResults();
    return;
  }

  const params = new URLSearchParams({
    basis: state.basis,
    direction: state.direction,
    minPrice: state.minPrice,
    minDiff: state.minDiff,
    grades: grades.join(','),
    limit: 5000,
  });
  if (state.playerId) params.set('playerId', state.playerId);

  const data = await api(`/api/results?${params}`);
  currentRows = data.rows.map((row) => ({ ...row, _dot: recencyDot(row) }));
  lastMeta = { total: data.total, excluded: data.excludedMissingGrade };
  renderResults();
}

let lastMeta = { total: 0, excluded: 0 };

function sortValue(row, column) {
  switch (column) {
    case 'color': return COLOR_RANK[row._dot.color];
    case 'grade': return Number(row.grade);
    case 'name': return (row.name || '').toLowerCase();
    case 'sgc_last_sale_date':
    case 'psa_last_sale_date': return row[column] || ''; // ISO strings sort lexically; '' (never) sorts first asc / handled below
    default: return row[column]; // numeric columns
  }
}

function renderResults() {
  const active = new Set(Object.entries(state.colors).filter(([, v]) => v).map(([k]) => k));
  const rows = currentRows.filter((r) => active.has(r._dot.color));

  const col = state.sortColumn;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const isDate = col === 'sgc_last_sale_date' || col === 'psa_last_sale_date';
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
      ? `<a href="${row.cl_url}" target="_blank" rel="noopener">${row.name}</a>`
      : row.name;
    tr.innerHTML = `
      <td class="dot-cell"><span class="dot dot-${row._dot.color}" title="${row._dot.title}"></span></td>
      <td>${link}</td>
      <td class="num grade-cell">${row.grade ?? '—'}</td>
      <td class="num">${fmtMoney(row.sgc_price)}</td>
      <td class="num">${fmtMoney(row.psa_price)}</td>
      <td class="num ${diffClass}">${row.abs_diff >= 0 ? '+' : ''}${fmtMoney(row.abs_diff)}</td>
      <td class="num ${diffClass}">${row.pct_diff >= 0 ? '+' : ''}${row.pct_diff}%</td>
      <td class="date">${fmtDate(row.sgc_last_sale_date)}</td>
      <td class="num">${row.sgc_sales ?? '—'}</td>
      <td class="date">${fmtDate(row.psa_last_sale_date)}</td>
      <td class="num">${row.psa_sales ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }

  $('results').hidden = rows.length === 0;
  $('empty').hidden = rows.length > 0 || currentRows.length === 0;

  updateSortArrows();

  const bits = [];
  if (rows.length !== lastMeta.total) bits.push(`${rows.length} of ${lastMeta.total} cards`);
  else bits.push(`${lastMeta.total} card${lastMeta.total === 1 ? '' : 's'} with both grades`);
  if (lastMeta.excluded > 0) bits.push(`${lastMeta.excluded} skipped (missing a grade on this basis)`);
  $('summary').textContent = bits.join(' · ');
}

function updateSortArrows() {
  for (const th of document.querySelectorAll('#results th.sortable')) {
    const arrow = th.querySelector('.arrow');
    if (th.dataset.col === state.sortColumn) {
      th.classList.add('sorted');
      arrow.textContent = state.sortDir === 'asc' ? ' ▲' : ' ▼';
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

// Recency color filter checkboxes (client-side only).
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

// Grader selector — only SGC for now; PSA is always the compare-to (higher)
// side. Wired so adding more graders later is a one-line change.
$('grader').addEventListener('change', () => {
  loadResults().catch((err) => setError(err.message));
});

let minPriceDebounce = null;
$('min-price').addEventListener('input', (e) => {
  clearTimeout(minPriceDebounce);
  minPriceDebounce = setTimeout(() => {
    state.minPrice = parseFloat(e.target.value) || 0;
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

$('player').addEventListener('change', (e) => {
  state.playerId = e.target.value;
  loadResults().catch((err) => setError(err.message));
});

$('sync-btn').addEventListener('click', () => triggerSync(false));
$('resume-btn').addEventListener('click', () => triggerSync(true));
$('cancel-btn').addEventListener('click', () => api('/api/sync/cancel', { method: 'POST' }).catch(() => {}));

(async function init() {
  try {
    await loadPlayers();
    const s = await refreshStatus();
    if (s.running) startPolling();
    await loadResults();
  } catch (err) {
    setError(err.message);
  }
})();
