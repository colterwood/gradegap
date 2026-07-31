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
// Vocabularies for hand-added watches (the Watched tab's add form). Wider
// than the disparity comparison: any grader, half grades, Authentic, and
// the ungraded pairing — 'None' grader <-> 'Raw' grade always travel
// together and mean "must NOT be slabbed".
export const MANUAL_GRADERS = ['Any', 'None', 'SGC', 'PSA', 'BGS'];
export const MANUAL_GRADES = [
  'Any', 'Raw',
  '10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5',
  '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1',
  'Authentic',
];

export const CRAWL_CONDITIONS = COMPARE_GRADES.flatMap((g) => [
  ...COMPARE_GRADERS.map((c) => `${c} ${g}`),
  `${BASELINE_COMPANY} ${g}`,
]);

export const config = {
  port: intEnv('PORT', 4000),
  // Loopback by default: this app has no authentication. Accepts a
  // comma-separated list, so you can add ONE more interface without
  // exposing the rest — e.g. "127.0.0.1,100.x.y.z" (your Tailscale IP)
  // keeps localhost working while making the app reachable from your other
  // Tailscale devices, and nothing else.
  bindHosts: listEnv('BIND_HOST', '127.0.0.1'),
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
  // 'all' = every adapter in the source registry (the default). Sources
  // missing setup are skipped with a reason, so this is safe.
  watchSources: listEnv('WATCH_SOURCES', 'all'),
  // Checks work through sources in this order — most productive first, so
  // new listings appear early in a multi-hour run instead of after the
  // thin auction houses. Unlisted sources run after these, registry order.
  watchSourceOrder: listEnv(
    'WATCH_SOURCE_ORDER',
    'ebay,fanatics,comc,heritage,goldin,cia,pristine,alt,hibid'
  ),
  // Fixed-time eBay runs, e.g. "11:00,21:00" (24h clock in EBAY_CHECK_TZ,
  // default US Eastern — DST-aware). When set, the interval scheduler skips
  // eBay and these dedicated ebay-only runs handle it, making API-quota
  // spend predictable: runs/day × watches × marketplaces. Manual "Check
  // now" still includes eBay — pressing the button is an explicit ask.
  // Empty = eBay joins every check like any other source.
  ebayCheckTimes: listEnv('EBAY_CHECK_TIMES', ''),
  ebayCheckTz: process.env.EBAY_CHECK_TZ || 'America/New_York',
  ebayClientId: process.env.EBAY_CLIENT_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  ebayEnv: process.env.EBAY_ENV || 'production',
  ebayMarketplaces: listEnv('EBAY_MARKETPLACES', 'EBAY_US,EBAY_CA,EBAY_GB,EBAY_DE,EBAY_FR,EBAY_IT'),
  // Generic Shopify-shop adapter: "domain" or "domain:CUR" entries, e.g.
  // "flipcollect.com:CAD,mintink.ca:CAD" (currency defaults to CAD).
  shopifyShops: listEnv('SHOPIFY_SHOPS', ''),
  // WooCommerce shops, same "domain[:CUR]" form. Galaxy Auctions (Surrey
  // BC) ships as the default so the source works out of the box.
  wooShops: listEnv('WOO_SHOPS', 'galaxy-auctions.com:CAD'),
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
  // Following-tab alerts. Lead time for the per-item "auction ending soon"
  // alert on followed listings (minutes; default 24h), and email delivery:
  // alerts go to EMAIL_TO via Gmail SMTP using GMAIL_USER + a Google App
  // Password (NOT the account password — create one at
  // https://myaccount.google.com/apppasswords, requires 2-Step Verification).
  // Any of the three left empty disables email; ntfy still fires.
  followRemindMin: intEnv('FOLLOW_REMIND_MIN', 1440),
  emailTo: process.env.EMAIL_TO || '',
  gmailUser: process.env.GMAIL_USER || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
  // Where a phone notification should link to. localhost only resolves on
  // the machine running the app, so set APP_BASE_URL (e.g. your laptop's
  // LAN address, or a VPN/Tailscale hostname) to make pushes tappable from
  // the phone — pair it with BIND_HOST=0.0.0.0.
  appBaseUrl: (process.env.APP_BASE_URL || '').replace(/\/+$/, ''),
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
