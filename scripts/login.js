// One-time interactive login. Opens a visible browser on Card Ladder; you log
// in yourself (email/password, any 2FA, any Cloudflare check). The session is
// saved in ./profile and reused by every later sync.

import { launchBrowser, looksLoggedOut, APP_URL } from '../src/scraper/browser.js';
import { config } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await launchBrowser({ headless: false });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

if (config.clEmail) {
  // best-effort pre-fill; harmless if the selectors don't match
  await page.fill('input[type="email"], input[name*="email" i]', config.clEmail).catch(() => {});
  if (config.clPassword) {
    await page.fill('input[type="password"]', config.clPassword).catch(() => {});
  }
}

console.log('\nA browser window is open. Log in to Card Ladder there (including any 2FA).');
console.log('Waiting for login — this window closes automatically once you are in…\n');

const deadline = Date.now() + 10 * 60 * 1000;
let loggedIn = false;
while (Date.now() < deadline) {
  await sleep(3000);
  if (page.isClosed()) break;
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
