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

function isCandidate(url) {
  if (SKIP_HOSTS.some((h) => url.includes(h))) return false;
  return CANDIDATE_HOSTS.some((h) => url.includes(h));
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
    if (!isCandidate(url)) return;
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
      writeFileSync(
        path.join(dir, file),
        JSON.stringify({ url, method: entry.method, status: entry.status, requestBody: entry.requestBody, body: json ?? text }, null, 2)
      );
      appendFileSync(
        path.join(dir, 'index.jsonl'),
        JSON.stringify({ n, file, url, method: entry.method, status: entry.status, bytes: text?.length ?? 0, claimed }) + '\n'
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
