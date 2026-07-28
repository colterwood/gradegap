const state = {
  basis: 'cl_value',
  sort: 'pct',
  direction: 'all',
  minPrice: 0,
  playerId: '',
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

let pollTimer = null;
let wasRunning = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// --- results ---------------------------------------------------------------

async function loadResults() {
  const params = new URLSearchParams({
    basis: state.basis,
    sort: state.sort,
    direction: state.direction,
    minPrice: state.minPrice,
  });
  if (state.playerId) params.set('playerId', state.playerId);

  const data = await api(`/api/results?${params}`);
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  for (const row of data.rows) {
    const tr = document.createElement('tr');
    const diffClass = row.abs_diff >= 0 ? 'pos' : 'neg';
    const link = row.cl_url
      ? `<a href="${row.cl_url}" target="_blank" rel="noopener">${row.name}</a>`
      : row.name;
    tr.innerHTML = `
      <td>${link}</td>
      <td class="num">${fmtMoney(row.sgc_price)}</td>
      <td class="num">${fmtMoney(row.psa_price)}</td>
      <td class="num ${diffClass}">${row.abs_diff >= 0 ? '+' : ''}${fmtMoney(row.abs_diff)}</td>
      <td class="num ${diffClass}">${row.pct_diff >= 0 ? '+' : ''}${row.pct_diff}%</td>
      <td class="date">${row.sgc_last_sale_date ?? '—'}</td>
      <td class="date">${row.psa_last_sale_date ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }

  $('results').hidden = data.rows.length === 0;
  $('empty').hidden = data.rows.length > 0;

  const bits = [`${data.total} card${data.total === 1 ? '' : 's'} with both grades`];
  if (data.excludedMissingGrade > 0) bits.push(`${data.excludedMissingGrade} skipped (missing a grade on this basis)`);
  $('summary').textContent = bits.join(' · ');
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
    $('progress-text').textContent = cards_total
      ? `${cards_processed} / ${cards_total} cards${s.currentCardName ? ` — ${s.currentCardName}` : ''}`
      : 'Finding cards…';
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

  if (wasRunning && !s.running) {
    clearInterval(pollTimer);
    pollTimer = null;
    await loadResults();
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
wireToggle('sort-toggle', 'sort');

$('direction').addEventListener('change', (e) => {
  state.direction = e.target.value;
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
