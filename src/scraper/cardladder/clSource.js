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

import { launchBrowser, looksLoggedOut } from '../browser.js';
import { buildLadderUrl } from './endpoints.js';
import * as nav from './navigate.js';

export function createCardLadderSource() {
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
      context = await launchBrowser();
      watchAuth(context);
      page = context.pages()[0] ?? (await context.newPage());
      await nav.goToLadder(page);
      if (await looksLoggedOut(page)) {
        throw new Error('Not logged in to Card Ladder — run `npm run login` first.');
      }
      // Let the Ladder's own search fire so we capture a Bearer token.
      await page.waitForTimeout(2500);
    },

    async refreshAuth() {
      await nav.goToLadder(page);
      await page.waitForTimeout(2500);
      if (await looksLoggedOut(page)) {
        throw new Error('Session expired — run `npm run login` again.');
      }
    },

    async fetchLadderPage({ condition, page: pageNum, limit }) {
      const url = buildLadderUrl({ condition, page: pageNum, limit });
      return page.evaluate(
        async ({ url, auth }) => {
          try {
            const headers = { accept: 'application/json' };
            if (auth) headers.authorization = auth;
            const r = await fetch(url, { headers, credentials: 'include' });
            let body = null;
            try { body = await r.json(); } catch { /* non-JSON error page */ }
            return { status: r.status, body };
          } catch (e) {
            return { status: 0, body: null, error: String(e) };
          }
        },
        { url, auth: lastAuth }
      );
    },

    async close() {
      await context?.close().catch(() => {});
      context = null;
      page = null;
    },
  };
}
