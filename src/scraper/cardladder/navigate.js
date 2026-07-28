// Page flows for the Card Ladder SPA. Selectors are best guesses — the
// discovery run will confirm or correct them. Every flow is defensive: if a
// selector misses, we fall back to broader ones and ultimately rely on the
// network capture (parsers don't care how a page was reached).

import { APP_URL } from '../browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function goToApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

export async function searchPlayer(page, searchTerm) {
  const searchBox = page
    .locator('input[type="search"], input[placeholder*="earch" i], [role="searchbox"]')
    .first();
  await searchBox.waitFor({ timeout: 15000 });
  await searchBox.click();
  await searchBox.fill(searchTerm);
  await sleep(1500); // let type-ahead fire its requests
  await searchBox.press('Enter').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

export async function openFirstPlayerResult(page, playerName) {
  const link = page
    .locator(`a:has-text("${playerName}"), [class*="result" i]:has-text("${playerName}")`)
    .first();
  const visible = await link.isVisible().catch(() => false);
  if (visible) {
    await link.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    return true;
  }
  return false;
}

// Scroll/paginate until the page stops producing new content, so the capture
// layer sees every card-list response. Caps out defensively.
export async function exhaustCardList(page, { maxRounds = 60 } = {}) {
  let lastHeight = 0;
  for (let i = 0; i < maxRounds; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    const nextBtn = page
      .locator('button:has-text("Next"), [aria-label*="next" i], button:has-text("Load more"), button:has-text("Show more")')
      .first();
    if (await nextBtn.isVisible().catch(() => false)) {
      if (await nextBtn.isEnabled().catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        continue;
      }
      break;
    }
    await page.mouse.wheel(0, 2500);
    await sleep(1200);
    if (height === lastHeight) break;
    lastHeight = height;
  }
}

export async function openCardPage(page, card) {
  await page.goto(card.cl_url ?? `${APP_URL}/card/${card.cl_card_id}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

// DOM fallback for card links if network interception yields nothing.
export async function scrapeCardLinksFromDom(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/card/"]')];
    return links
      .map((a) => ({
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().replace(/\s+/g, ' '),
      }))
      .filter((l) => l.text.length > 5);
  });
}
