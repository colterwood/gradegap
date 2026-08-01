// Page flows for the Card Ladder SPA. Only the Ladder page is ever visited:
// the sync captures a Bearer token there and then talks to the search API
// directly (clSource.js). The discovery-era flows (player search, card-page
// scraping, infinite-scroll exhaustion) were deleted once the bulk endpoint
// was confirmed — see git history if a per-card fallback is ever needed.

import { APP_URL } from '../browser.js';

export async function goToLadder(page) {
  await page.goto(`${APP_URL}/ladder`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}
