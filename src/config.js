import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function listEnv(name, fallback) {
  return (process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

// PSA is always the baseline (compare-to) side of every comparison.
export const BASELINE_COMPANY = 'PSA';

// Graders that can be compared against PSA — the UI's Grader dropdown. Note on
// grade labels: condition "SGC 10" is Gem Mint (the adapter normalizes SGC's
// rarer "10 Pristine" to grade '10 PRI' so it can never leak into the 10
// comparison); condition "BGS 10" is BGS Pristine, its standard numeric 10.
export const COMPARE_GRADERS = ['SGC', 'BGS'];

// The numeric grades we compare like-for-like: <grader> N vs PSA N. A 9 is
// NEVER compared against a 10 — each grade is its own paired comparison.
// (BGS half grades like 9.5 exist on the Ladder but are deliberately not
// crawled: they have no like-for-like PSA counterpart in this scheme.)
export const COMPARE_GRADES = ['10', '9', '8', '7'];

// Conditions the sync crawls, one grade-filtered pass each: every compare
// grader plus the PSA baseline, per grade. Compare graders before PSA per
// grade so their (smaller) universes and card-page links seed shared cards
// first.
export const CRAWL_CONDITIONS = COMPARE_GRADES.flatMap((g) => [
  ...COMPARE_GRADERS.map((c) => `${c} ${g}`),
  `${BASELINE_COMPANY} ${g}`,
]);

export const config = {
  port: intEnv('PORT', 4000),
  headless: process.env.HEADLESS === 'true',
  mock: process.env.MOCK_CL === '1' || process.argv.includes('--mock'),
  discovery: process.env.DISCOVERY === '1',
  rateMinMs: intEnv('RATE_MIN_MS', 3000),
  rateMaxMs: intEnv('RATE_MAX_MS', 7000),
  // Ladder crawl: how many hits to request per page, and the polite delay
  // between page fetches (per PAGE, not per card — the whole point of the
  // bulk crawl). The effective page size auto-adapts if the server caps it.
  crawlLimit: intEnv('CRAWL_LIMIT', 100),
  pageDelayMs: intEnv('PAGE_DELAY_MS', 1200),
  clEmail: process.env.CL_EMAIL || '',
  clPassword: process.env.CL_PASSWORD || '',
  // Marketplace watcher. Interval 0 = manual "Check now" only. Sources are
  // adapter names under src/marketplace/sources/ (mock mode overrides to the
  // fixture-backed source). Prices are displayed in USD; non-USD listings are
  // converted at daily rates.
  watchIntervalMin: intEnv('WATCH_INTERVAL_MIN', 30),
  watchRemindMin: intEnv('WATCH_REMIND_MIN', 1440),
  watchSources: listEnv('WATCH_SOURCES', 'ebay'),
  ebayClientId: process.env.EBAY_CLIENT_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  ebayEnv: process.env.EBAY_ENV || 'production',
  ebayMarketplaces: listEnv('EBAY_MARKETPLACES', 'EBAY_US,EBAY_CA,EBAY_GB,EBAY_DE,EBAY_FR,EBAY_IT'),
  // Generic Shopify-shop adapter: "domain" or "domain:CUR" entries, e.g.
  // "flipcollect.com:CAD,mintink.ca:CAD" (currency defaults to CAD).
  shopifyShops: listEnv('SHOPIFY_SHOPS', ''),
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
  dataDir: path.join(ROOT, 'data'),
  capturesDir: path.join(ROOT, 'captures'),
  profileDir: path.join(ROOT, 'profile'),
  publicDir: path.join(ROOT, 'public'),
};

// Optional allowlist. The Ladder crawl covers the whole catalog by default;
// if config/players.json lists any names, the crawl keeps only those players'
// cards. An empty array (the default) means "everything".
export function loadPlayerAllowlist() {
  const file = path.join(ROOT, 'config', 'players.json');
  let players;
  try {
    players = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(players)) throw new Error('config/players.json must be an array');
  return players
    .filter((p) => p && p.name && p.enabled !== false)
    .map((p) => String(p.name).trim().toLowerCase());
}
