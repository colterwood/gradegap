import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Hosts worth capturing. Card Ladder's exact backend is unknown until the
// first discovery run; these cover the likely candidates for a Firebase SPA.
const CANDIDATE_HOSTS = [
  'app.cardladder.com',
  'cardladder.com',
  'firestore.googleapis.com',
  'firebasedatabase.app',
  'cloudfunctions.net',
  'run.app',
  'algolia.net',
  'algolianet.com',
];

// Never persist auth material.
const SKIP_HOSTS = ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'];

// Analytics/telemetry — noise in discovery captures.
const NOISE_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'sentry.io', 'intercom.io', 'segment.com', 'segment.io', 'stripe.com',
  'hotjar.com', 'clarity.ms', 'datadoghq.com', 'launchdarkly.com',
  'mixpanel.com', 'amplitude.com', 'fullstory.com', 'posthog.com',
  'cloudflareinsights.com', 'facebook.com', 'facebook.net',
];

// In discovery mode capture EVERY non-auth, non-analytics response so the
// real backend is guaranteed to be in the capture, whatever it turns out to
// be. During normal syncs, only watch the known candidate hosts.
function isCandidate(url, discovery) {
  if (SKIP_HOSTS.some((h) => url.includes(h))) return false;
  if (discovery) return !NOISE_HOSTS.some((h) => url.includes(h));
  return CANDIDATE_HOSTS.some((h) => url.includes(h));
}

// Request-header VALUES are recorded only for these known-non-secret headers;
// everything else (authorization, cookie, api keys, …) is name-only.
const SAFE_HEADER_VALUES = new Set([
  'content-type', 'accept', 'x-algolia-agent', 'x-algolia-application-id',
  'x-firebase-gmpid', 'referer', 'origin',
]);

function describeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key.startsWith(':')) continue;
    out[key] = SAFE_HEADER_VALUES.has(key) ? value : `<redacted ${value.length} chars>`;
  }
  return out;
}

// Tokens can ride inside request BODIES and URLs too (Firestore's Listen/Write
// channels url-encode "Authorization:Bearer <jwt>" into the POST body). Scrub
// any JWT and any bearer/access/id token from a string before it's written.
function scrubSecrets(str) {
  if (typeof str !== 'string' || !str) return str;
  return str
    // JWTs (header.payload.signature)
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    // Bearer <token>, url-encoded or not
    .replace(/(Bearer(?:%20|\s)+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    // access_token / id_token / refresh_token / gsessionid = value (query or body)
    .replace(/((?:access_token|id_token|refresh_token|gsessionid|auth)=)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// Watches all responses in a browser context. Recognized payloads are pushed
// to `onPayload`; in discovery mode everything is also dumped to captures/.
export function attachCapture(context, { discovery = config.discovery, onPayload } = {}) {
  let dir = null;
  let counter = 0;
  if (discovery) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dir = path.join(config.capturesDir, stamp);
    mkdirSync(dir, { recursive: true });
  }

  const seen = [];

  context.on('response', async (response) => {
    const url = response.url();
    if (!isCandidate(url, discovery)) return;
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;

    let text = null;
    let json = null;
    try {
      text = await response.text();
      try { json = JSON.parse(text); } catch { /* Firestore Listen streams aren't plain JSON */ }
    } catch {
      return; // body unavailable (redirect, aborted, …)
    }

    const entry = {
      url,
      method: request.method(),
      status: response.status(),
      requestHeaders: describeHeaders(request.headers()),
      requestBody: request.postData() ?? null,
      json,
      text,
    };

    let claimed = false;
    if (onPayload && json !== null) {
      try { claimed = Boolean(await onPayload(entry)); } catch { claimed = false; }
    }

    if (dir) {
      const n = String(++counter).padStart(3, '0');
      const u = new URL(url);
      const file = `${n}-${slug(u.host)}-${slug(u.pathname)}.json`;
      const safeUrl = scrubSecrets(url);
      const safeBody = json ?? scrubSecrets(text);
      writeFileSync(
        path.join(dir, file),
        JSON.stringify({ url: safeUrl, method: entry.method, status: entry.status, requestHeaders: entry.requestHeaders, requestBody: scrubSecrets(entry.requestBody), body: safeBody }, null, 2)
      );
      appendFileSync(
        path.join(dir, 'index.jsonl'),
        JSON.stringify({ n, file, url: safeUrl, method: entry.method, status: entry.status, bytes: text?.length ?? 0, claimed }) + '\n'
      );
      seen.push({ url, claimed });
    }
  });

  return {
    dir,
    summary: () => {
      const byHost = {};
      for (const s of seen) {
        const host = new URL(s.url).host;
        byHost[host] = (byHost[host] ?? 0) + 1;
      }
      return { total: seen.length, byHost };
    },
  };
}

// For payloads the adapter couldn't parse during a real sync.
export function saveFailure(name, payload) {
  const dir = path.join(config.capturesDir, 'failures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${slug(name)}.json`), JSON.stringify(payload, null, 2));
}
