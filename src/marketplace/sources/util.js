// Shared helpers for scraped marketplace sources. Every scraped site gets
// the same browser-shaped headers and timeout handling; adapters keep their
// parse functions pure (and exported) so they're unit-testable against
// fixture payloads without any network.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

export const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

export async function fetchWithTimeout(url, { timeoutMs = 20_000, headers, ...opts } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, headers: { ...BROWSER_HEADERS, ...headers }, signal: ctl.signal });
  } catch (err) {
    // Our own timer firing surfaces as a bare AbortError ("This operation
    // was aborted") — rethrow with the facts a failure report needs.
    if (err?.name === 'AbortError' && ctl.signal.aborted) {
      throw Object.assign(
        new Error(`timed out after ${Math.round(timeoutMs / 1000)}s: ${url.split('?')[0]}`),
        { timedOut: true }
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (res.status === 429) throw Object.assign(new Error(`rate limited (HTTP 429): ${url}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

export async function fetchHtml(url, opts = {}) {
  const res = await fetchWithTimeout(url, { ...opts, headers: { accept: 'text/html,*/*;q=0.8', ...opts.headers } });
  if (res.status === 429) throw Object.assign(new Error(`rate limited (HTTP 429): ${url}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// Normalize any end-time shape a marketplace hands us to ISO. Sites are
// inconsistent and CHANGE: Goldin's end_timestamp is an ISO string while
// Fanatics' auctionEndDatetime is epoch seconds, and the same field can
// switch shape on a redeploy.
//
// The trap this exists to close: toNumber("2026-07-31T02:00:00Z") returns
// 2026 (parseFloat stops at the first dash), not null — so an epoch-only
// converter silently produced null for a perfectly good ISO date, and
// Goldin auctions were stored with no end time at all.
export const toIsoDate = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v > 1e12) return new Date(v).toISOString(); // ms
    if (v > 1e9) return new Date(v * 1000).toISOString(); // seconds
    return null; // too small to be a plausible epoch
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return toIsoDate(Number(s)); // epoch as a string
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

export const centsToDollars = (c) => (c == null ? null : Math.round(Number(c)) / 100);

export const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const absUrl = (href, base) => {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

// Hard cap any promise — a stuck source must fail its item, never freeze a
// whole check run (learned the hard way from an unbounded FX fetch).
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

// page.goto that survives a previous page's late client-side redirect.
// Sites frequently schedule a self-navigation after load; if it fires while
// we're navigating away, Playwright aborts our goto ("interrupted by another
// navigation" / ERR_ABORTED). Both are transient, so retry — and if the
// interrupted navigation actually landed on the target, accept it.
export async function gotoStable(page, url, { timeout = 45_000, attempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      if (!/interrupted by another navigation|ERR_ABORTED|NS_BINDING_ABORTED/i.test(msg)) throw err;
      // Did we end up there anyway?
      try {
        if (page.url().split('?')[0] === url.split('?')[0]) return null;
      } catch { /* page detached */ }
      await page.waitForTimeout(750 * attempt);
    }
  }
  throw lastErr;
}

// Park the page so nothing from the last site is still pending before the
// next navigation.
export async function parkPage(page) {
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
}

// Minimal HTML entity decoding for scraped titles (&nbsp;, &#8209;, &amp;…).
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- debug capture (npm run test-source -- <source> "<q>" --debug) ---------
// When WATCH_DEBUG=1, adapters save the raw payloads they parsed (HTML/JSON/
// screenshots) to captures/source-debug/ so a failing source becomes a
// paste-the-file bug report instead of a guessing game.

export const debugEnabled = () => process.env.WATCH_DEBUG === '1';

let debugSeq = 0;

export function saveDebug(source, kind, content, ext = 'txt') {
  if (!debugEnabled()) return null;
  try {
    const dir = path.join(config.capturesDir, 'source-debug');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Sequence suffix: several saves can land in the same millisecond.
    const file = path.join(dir, `${source}-${kind}-${stamp}-${++debugSeq}.${ext}`);
    writeFileSync(file, content);
    console.log(`  [debug] saved ${file}`);
    return file;
  } catch {
    return null;
  }
}

export function debugLog(source, message) {
  if (debugEnabled()) console.log(`  [debug] ${source}: ${message}`);
}

// Pull every <script type="application/ld+json"> object out of an HTML page —
// many auction sites embed lot data as schema.org Product/Offer entries.
export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // malformed block — skip
    }
  }
  return out;
}
