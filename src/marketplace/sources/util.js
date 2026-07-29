// Shared helpers for scraped marketplace sources. Every scraped site gets
// the same browser-shaped headers and timeout handling; adapters keep their
// parse functions pure (and exported) so they're unit-testable against
// fixture payloads without any network.

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
