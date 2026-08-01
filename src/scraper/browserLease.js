// Refcounted lease over the ONE persistent browser context. The profile dir
// can only be locked by a single Chromium instance, so the Card Ladder sync
// and any browser-based marketplace sources must share it: first acquire
// launches, last release closes. Each holder opens its own page — pages are
// cheap, contexts are not.

import { launchBrowser } from './browser.js';

let context = null;
let refs = 0;
let launching = null; // in-flight launch, so concurrent acquires share it
let closing = null; // in-flight close — a relaunch must wait out the profile lock

export async function acquireBrowser() {
  refs += 1;
  try {
    if (!context) {
      // Serialize the launch itself; whoever loses the race awaits the winner.
      launching ??= (async () => {
        // With concurrent lanes, refs can hit 0 and bounce straight back up
        // while the old Chromium is still closing. Launching before that
        // close finishes fails on the profile-dir singleton lock, so wait.
        if (closing) await closing;
        const ctx = await launchBrowser();
        // If Chromium dies or the user closes the window, reset so the next
        // acquire relaunches instead of handing out a dead context. Guarded:
        // our own deliberate close() already nulled `context`, and firing
        // then would clobber a NEWER launch's state.
        ctx.on('close', () => {
          if (context !== ctx) return;
          context = null;
          launching = null;
          refs = 0;
        });
        context = ctx;
        return ctx;
      })();
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
        const done = ctx.close().catch(() => {});
        closing = done;
        await done;
        if (closing === done) closing = null;
      }
    },
  };
}
