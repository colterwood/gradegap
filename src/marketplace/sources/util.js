// Shared helpers for scraped marketplace sources. Every scraped site gets
// the same browser-shaped headers and timeout handling; adapters keep their
// parse functions pure (and exported) so they're unit-testable against
// fixture payloads without any network.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SHOPIFY_SHOPS / WOO_SHOPS entries: "domain[:CUR]", tolerant of pasted
// URLs. The protocol must be stripped BEFORE splitting on ':' — an
// "https://shop.com" entry used to split into domain "https" and every
// request silently targeted https://https/. Currency is the part after the
// last colon only when it looks like a 3-letter code.
export function parseShopList(entries, defaultCurrency = 'CAD') {
  return entries.map((entry) => {
    const bare = String(entry).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const m = bare.match(/^(.*):([A-Za-z]{3})$/);
    return {
      domain: m ? m[1] : bare,
      currency: (m ? m[2] : defaultCurrency).toUpperCase(),
    };
  });
}

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
  // A date-TIME with no zone is parsed as the SERVER's local time by spec,
  // which makes the stored value depend on the machine rather than the
  // marketplace. Read it as UTC so it is at least deterministic — an
  // adapter that KNOWS the site's zone should call zonedToIso instead.
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = new Date(naive ? `${s.replace(' ', 'T')}Z` : s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// A zone-less timestamp ("2026-08-16T21:00:00", "08/16/2026 21:00:00") is
// NOT a UTC instant — JS parses it as the SERVER's local time, so the same
// scrape produces a different stored end date on every machine. Sites that
// render times without an offset always mean their own zone (AuctionWorx
// prints `timeZoneLabel = 'ET'` next to them), so adapters resolve them
// against that zone explicitly. Returns an ISO instant, or null.
//
// Two passes: the first guesses the offset by reading the naive time as
// UTC, the second re-reads it at that offset — which lands correctly on
// either side of a DST boundary, where the offset depends on the answer.
function zoneOffsetAt(instant, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  // "GMT-4" / "GMT-04:00" / "GMT" (UTC itself renders bare).
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+00:00';
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
}

export function zonedToIso(naive, timeZone) {
  if (!naive) return null;
  // Accept "YYYY-MM-DD HH:MM[:SS]" and US "M/D/YYYY H:MM[:SS]".
  const s = String(naive).trim();
  let iso = null;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const sortable = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (us) {
    const [, mo, d, y, h, mi, se = '00'] = us;
    iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se}`;
  } else if (sortable) {
    const [, y, mo, d, h, mi, se = '00'] = sortable;
    iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${se}`;
  } else {
    return toIsoDate(s); // already carries a zone (or is an epoch) — shared path
  }
  let off = zoneOffsetAt(new Date(`${iso}Z`), timeZone);
  off = zoneOffsetAt(new Date(`${iso}${off}`), timeZone);
  const dt = new Date(`${iso}${off}`);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Auction tiles often render a COUNTDOWN rather than a timestamp, in every
// abbreviation style going: "06d 19h 13m" (MySlabs), "25 days",
// "6 hours 12 minutes" (Heritage). Sum whatever units are present and
// anchor them to `now`. Returns null when no unit is found, so callers can
// fall back to an absolute date. Exported for tests.
const REL_UNITS = [
  [/(\d+)\s*(?:d|days?)\b/i, 24 * 60 * 60 * 1000],
  [/(\d+)\s*(?:h|hrs?|hours?)\b/i, 60 * 60 * 1000],
  [/(\d+)\s*(?:m|mins?|minutes?)\b/i, 60 * 1000],
  [/(\d+)\s*(?:s|secs?|seconds?)\b/i, 1000],
];

export function relativeToIso(text, now = Date.now()) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let ms = 0;
  let matched = false;
  for (const [re, unit] of REL_UNITS) {
    const m = s.match(re);
    if (m) {
      ms += Number(m[1]) * unit;
      matched = true;
    }
  }
  if (!matched || ms <= 0) return null;
  return new Date(now + ms).toISOString();
}

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
