// Daily FX rates for normalizing listing prices to USD (the app's display
// currency, matching the Card Ladder data). Rates come from the free, no-key
// Frankfurter API (ECB reference rates) and are cached in kv_cache so checks
// keep working offline; a hardcoded approximation is the last resort.

import { fetchWithTimeout } from './sources/util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK = { USD: 1, CAD: 1.37, EUR: 0.92, GBP: 0.79 };

// Shared across fx instances: after a failed fetch, don't retry for a
// minute — a check run must never stall on rates (they're display-only).
let lastFailedFetchAt = 0;

export function createFx(q) {
  let rates = null;
  let loadedAt = 0;

  function loadCached() {
    const row = q.kvGet.get('fx:usd');
    if (!row?.value) return;
    try {
      rates = JSON.parse(row.value);
      // kv updated_at is SQLite "YYYY-MM-DD HH:MM:SS" (UTC).
      loadedAt = Date.parse(row.updated_at.replace(' ', 'T') + 'Z') || 0;
    } catch {
      rates = null;
    }
  }

  async function ensureRates() {
    if (!rates) loadCached();
    if (rates && Date.now() - loadedAt < DAY_MS) return;
    if (Date.now() - lastFailedFetchAt < 60_000) {
      if (!rates) rates = { ...FALLBACK };
      return;
    }
    try {
      // Hard 5s cap: a stalled connection here must not hang the whole run.
      const res = await fetchWithTimeout('https://api.frankfurter.dev/v1/latest?base=USD', { timeoutMs: 5000 });
      if (res.ok) {
        const body = await res.json();
        if (body?.rates) {
          rates = { USD: 1, ...body.rates };
          loadedAt = Date.now();
          q.kvSet.run('fx:usd', JSON.stringify(rates));
          return;
        }
      }
    } catch {
      // offline / API down — stale cache (or fallback below) is fine for display
    }
    lastFailedFetchAt = Date.now();
    if (!rates) rates = { ...FALLBACK };
  }

  // rates are per-USD (1 USD = rates[CUR] units), so USD = amount / rate.
  function toUsd(amount, currency) {
    if (amount == null) return null;
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return amount;
    const r = (rates ?? FALLBACK)[cur] ?? FALLBACK[cur];
    return r ? Math.round((amount / r) * 100) / 100 : null;
  }

  return { ensureRates, toUsd };
}
