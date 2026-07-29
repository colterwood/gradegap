// Refcounted lease over the ONE persistent browser context. The profile dir
// can only be locked by a single Chromium instance, so the Card Ladder sync
// and any browser-based marketplace sources must share it: first acquire
// launches, last release closes. Each holder opens its own page — pages are
// cheap, contexts are not.

import { launchBrowser } from './browser.js';

let context = null;
let refs = 0;
let launching = null; // in-flight launch, so concurrent acquires share it

export async function acquireBrowser() {
  refs += 1;
  try {
    if (!context) {
      // Serialize the launch itself; whoever loses the race awaits the winner.
      launching ??= launchBrowser().then((ctx) => {
        context = ctx;
        // If Chromium dies or the user closes the window, reset so the next
        // acquire relaunches instead of handing out a dead context.
        ctx.on('close', () => {
          context = null;
          launching = null;
          refs = 0;
        });
        return ctx;
      });
      await launching;
    }
  } catch (err) {
    refs = Math.max(0, refs - 1);
    launching = null;
    throw err;
  }

  let released = false;
  return {
    context,
    async release() {
      if (released) return;
      released = true;
      refs = Math.max(0, refs - 1);
      if (refs === 0 && context) {
        const ctx = context;
        context = null;
        launching = null;
        await ctx.close().catch(() => {});
      }
    },
  };
}
