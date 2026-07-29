// The real Card Ladder source. It drives a logged-in browser to the Ladder,
// captures the app's own Firebase Bearer token from live requests, then
// replays the Ladder's JSON search endpoint directly from inside the page
// (same origin/cookies/CORS the app uses) — paginating without rendering a
// single card page.
//
// Interface (shared with the mock source):
//   start()                              -> open browser, reach the Ladder
//   fetchLadderPage({condition,page,limit}) -> { status, body:{hits,totalHits} }
//   refreshAuth()                        -> reload to mint a fresh token
//   close()

import { looksLoggedOut } from '../browser.js';
import { acquireBrowser } from '../browserLease.js';
import { buildLadderUrl } from './endpoints.js';
import * as nav from './navigate.js';

export function createCardLadderSource() {
  let lease = null;
  let context = null;
  let page = null;
  let lastAuth = null;

  function watchAuth(ctx) {
    ctx.on('request', (req) => {
      try {
        const auth = req.headers()['authorization'];
        if (auth && req.url().includes('cardladder.com')) lastAuth = auth;
      } catch { /* header access can throw on some requests */ }
    });
  }

  return {
    name: 'cardladder',

    async start() {
      // The persistent profile is shared (leased) with marketplace sources —
      // see browserLease.js. This source opens its own page in it.
      lease = await acquireBrowser();
      context = lease.context;
      watchAuth(context);
      // Reuse only the context's initial blank tab — any other page belongs
      // to another lease holder (a marketplace source).
      const blank = context.pages().find((p) => p.url() === 'about:blank');
      page = blank ?? (await context.newPage());
      await nav.goToLadder(page);
      if (await looksLoggedOut(page)) {
        throw new Error('Not logged in to Card Ladder — run `npm run login` first.');
      }
      // The Ladder's own search fires on load, carrying a Bearer token we grab.
      // Wait for it (up to ~15s) before crawling.
      for (let i = 0; i < 15 && !lastAuth; i++) await page.waitForTimeout(1000);
    },

    async refreshAuth() {
      await nav.goToLadder(page);
      for (let i = 0; i < 10 && !lastAuth; i++) await page.waitForTimeout(1000);
      if (await looksLoggedOut(page)) {
        throw new Error('Session expired — run `npm run login` again.');
      }
    },

    async fetchLadderPage({ condition, page: pageNum, limit }) {
      const url = buildLadderUrl({ condition, page: pageNum, limit });

      // Primary: fetch from inside the page, exactly like the app does — no
      // `credentials` (the API allows origin '*', which browsers reject when
      // credentials are sent), auth via the Bearer token only.
      const inPage = await page.evaluate(
        async ({ url, auth }) => {
          try {
            const headers = { accept: 'application/json' };
            if (auth) headers.authorization = auth;
            const r = await fetch(url, { headers });
            let body = null;
            try { body = await r.json(); } catch { /* non-JSON error page */ }
            return { status: r.status, body };
          } catch (e) {
            return { status: 0, body: null, error: String(e) };
          }
        },
        { url, auth: lastAuth }
      );
      if (inPage.status !== 0) return inPage;

      // Fallback: a server-side request (no CORS at all), reusing the browser's
      // cookies + the captured Bearer token.
      try {
        const resp = await context.request.get(url, {
          headers: {
            accept: 'application/json',
            referer: 'https://app.cardladder.com/',
            ...(lastAuth ? { authorization: lastAuth } : {}),
          },
        });
        let body = null;
        try { body = await resp.json(); } catch { /* non-JSON */ }
        return { status: resp.status(), body };
      } catch (e) {
        return { status: 0, body: null, error: String(e) };
      }
    },

    async close() {
      await page?.close().catch(() => {});
      await lease?.release().catch(() => {});
      lease = null;
      context = null;
      page = null;
    },
  };
}
