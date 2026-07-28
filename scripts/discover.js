// Discovery mode: opens Card Ladder logged in and records EVERY backend
// response to captures/<timestamp>/ while you browse. The goal is to capture
// the bulk API behind THE LADDER (the grade-filterable ranked list), which is
// what the scalable sync will crawl. Ctrl-C to finish.

import { launchBrowser, looksLoggedOut } from '../src/scraper/browser.js';
import { attachCapture } from '../src/scraper/capture.js';
import * as nav from '../src/scraper/cardladder/navigate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await launchBrowser({ headless: false });
const capture = attachCapture(context, { discovery: true });
const page = context.pages()[0] ?? (await context.newPage());

console.log(`\nCapturing to: ${capture.dir}\n`);

await nav.goToLadder(page);
if (await looksLoggedOut(page)) {
  console.log('⚠️  You appear to be logged out. Run `npm run login` first, then re-run discover.');
} else {
  console.log('The Ladder is open. Now do these steps IN THE BROWSER — everything is recorded:');
  console.log('');
  console.log('  1. Open the filter and set Condition → "SGC 10 - Gem Mint"');
  console.log('     (Gem Mint, NOT Pristine)');
  console.log('  2. Scroll / page through at least 3-4 pages of results');
  console.log('  3. Change the Condition filter to "PSA 10 - Gem Mint"');
  console.log('  4. Scroll / page through another 3-4 pages');
  console.log('  5. (Bonus) Click into ONE card, then use its condition selector');
  console.log('     to flip between SGC 10 - Gem Mint and PSA 10 - Gem Mint');
  console.log('');
  console.log('Press Ctrl-C here when done.\n');
}

process.on('SIGINT', async () => {
  const s = capture.summary();
  console.log('\nCapture summary:', JSON.stringify(s, null, 2));
  console.log(`Files in: ${capture.dir}`);
  console.log('Share that folder to finalize the sync parsers (it contains no passwords or tokens).');
  await context.close().catch(() => {});
  process.exit(0);
});

// keep alive until Ctrl-C or the browser window is closed
for (;;) {
  await sleep(2000);
  if (context.pages().filter((p) => !p.isClosed()).length === 0) {
    const s = capture.summary();
    console.log('\nBrowser closed. Capture summary:', JSON.stringify(s, null, 2));
    console.log(`Files in: ${capture.dir}`);
    console.log('Share that folder to finalize the sync parsers (it contains no passwords or tokens).');
    process.exit(0);
  }
}
