// One-time interactive login. Opens a visible browser on Card Ladder; you log
// in yourself (email/password, any 2FA, any Cloudflare check). The session is
// saved in ./profile and reused by every later sync.

import { launchBrowser, looksLoggedOut, APP_URL } from '../src/scraper/browser.js';
import { config } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await launchBrowser({ headless: false });
let page = context.pages()[0] ?? (await context.newPage());
// "Sign in with Apple" (and similar OAuth buttons) often opens a new tab or
// popup for the actual login — always follow whichever tab is newest so we
// don't keep watching a stale one.
context.on('page', (p) => { page = p; });

await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

if (config.clEmail) {
  // best-effort pre-fill for email/password login; harmless (and a no-op)
  // if you use "Sign in with Apple" instead, or if selectors don't match.
  await page.fill('input[type="email"], input[name*="email" i]', config.clEmail).catch(() => {});
  if (config.clPassword) {
    await page.fill('input[type="password"]', config.clPassword).catch(() => {});
  }
}

console.log('\nA browser window is open. Log in to Card Ladder there (including any 2FA).');
console.log('Using "Sign in with Apple"? Click it and finish the flow in whatever tab opens —');
console.log('this script follows it automatically.');
console.log('Waiting for login — this window closes automatically once you are in…\n');

const deadline = Date.now() + 10 * 60 * 1000;
let loggedIn = false;
while (Date.now() < deadline) {
  await sleep(3000);
  const openPages = context.pages().filter((p) => !p.isClosed());
  if (openPages.length === 0) break;
  if (page.isClosed()) page = openPages[openPages.length - 1];
  if (!(await looksLoggedOut(page).catch(() => true))) {
    loggedIn = true;
    break;
  }
}

if (loggedIn) {
  await sleep(3000); // let tokens settle into the profile
  console.log('✅ Login saved. You can now run syncs from the web UI (npm start).');
} else {
  console.log('⚠️  Could not confirm login (timed out or window closed). If you did log in, syncs may still work — try one.');
}
await context.close().catch(() => {});
process.exit(0);
