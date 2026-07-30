// Sign in to a marketplace once: `npm run login-site -- alt.xyz`
//
// Opens the shared Chromium profile (the same one Sync and the scraped
// sources use) so you can log in by hand. The session is saved in ./profile
// and every later check reuses it — useful for sites that hide listings or
// prices behind an account.

import { acquireBrowser } from '../src/scraper/browserLease.js';

const arg = (process.argv[2] || '').trim();
if (!arg) {
  console.error('usage: npm run login-site -- <site>');
  console.error('  e.g. npm run login-site -- alt.xyz');
  console.error('       npm run login-site -- https://www.catawiki.com');
  process.exit(1);
}
const url = /^https?:\/\//i.test(arg) ? arg : `https://${arg}`;

const lease = await acquireBrowser();
const page = await lease.context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
  console.error(`could not open ${url}: ${err.message}`);
});

console.log(`\nA browser window is open at ${url}.`);
console.log('Log in there, then press Enter here to save the session and close.\n');

await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once('data', resolve);
});

// Cookies live in the persistent profile directory, so closing is enough.
await page.close().catch(() => {});
await lease.release().catch(() => {});
console.log('Session saved to ./profile — scraped sources will reuse it.');
process.exit(0);
