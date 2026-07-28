import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';

// A persistent profile (not just storageState) is essential: Cloudflare
// clearance cookies and Card Ladder's auth tokens both live in it, so one
// interactive login survives across syncs.
export async function launchBrowser({ headless = config.headless } = {}) {
  mkdirSync(config.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless,
    viewport: { width: 1400, height: 950 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}

export const APP_URL = 'https://app.cardladder.com';

export async function looksLoggedOut(page) {
  const url = page.url();
  if (/login|signin|sign-in|auth/i.test(url)) return true;
  const loginForm = await page
    .locator('input[type="password"], text=/log in|sign in/i')
    .first()
    .isVisible()
    .catch(() => false);
  return loginForm;
}
