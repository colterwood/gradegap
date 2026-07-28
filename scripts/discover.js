// Discovery mode: opens Card Ladder logged in, records EVERY backend response
// to captures/<timestamp>/, and best-effort walks the Michael Jordan flow.
// Then it stays open — click around the site yourself; everything you load is
// captured. Ctrl-C to finish. The captured JSON is what we use to finalize
// src/scraper/cardladder/endpoints.js and adapter.js.

import { launchBrowser, looksLoggedOut } from '../src/scraper/browser.js';
import { attachCapture } from '../src/scraper/capture.js';
import * as nav from '../src/scraper/cardladder/navigate.js';
import { loadPlayers } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await launchBrowser({ headless: false });
const capture = attachCapture(context, { discovery: true });
const page = context.pages()[0] ?? (await context.newPage());

console.log(`\nCapturing to: ${capture.dir}\n`);

await nav.goToApp(page);
if (await looksLoggedOut(page)) {
  console.log('⚠️  You appear to be logged out. Run `npm run login` first, then re-run discover.');
} else {
  const player = loadPlayers()[0];
  console.log(`Walking the "${player.name}" flow (search → player page → first cards)…`);
  try {
    await nav.searchPlayer(page, player.searchTerm);
    await nav.openFirstPlayerResult(page, player.name);
    await nav.exhaustCardList(page, { maxRounds: 5 });
    const links = await nav.scrapeCardLinksFromDom(page);
    for (const link of links.slice(0, 3)) {
      console.log(`Opening card: ${link.text}`);
      await page.goto(new URL(link.href, 'https://app.cardladder.com').href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(2000);
    }
  } catch (err) {
    console.log(`Scripted flow hit a snag (${err.message}) — no problem, browse manually instead.`);
  }
}

console.log('\nNow browse Card Ladder yourself: open the player, open a few cards,');
console.log('look at PSA 10 and SGC 10 prices. Everything is being recorded.');
console.log('Press Ctrl-C here when done.\n');

process.on('SIGINT', async () => {
  const s = capture.summary();
  console.log('\nCapture summary:', JSON.stringify(s, null, 2));
  console.log(`Files in: ${capture.dir}`);
  await context.close().catch(() => {});
  process.exit(0);
});

// keep alive until Ctrl-C or the browser window is closed
for (;;) {
  await sleep(2000);
  if (context.pages().length === 0) {
    const s = capture.summary();
    console.log('\nBrowser closed. Capture summary:', JSON.stringify(s, null, 2));
    console.log(`Files in: ${capture.dir}`);
    process.exit(0);
  }
}
