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

// For knobs where fractions are meaningful (percent thresholds) — parseInt
// would silently turn FOLLOW_DROP_PCT=7.5 into 7.
function floatEnv(name, fallback) {
  const v = parseFloat(process.env[name]);
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
// comparison); condition "BGS 10" is BGS Pristine, its standard numeric 10;
// "CGC 10" is Gem Mint, with CGC's higher "10 Pristine" tier canonicalized
// away the same way SGC's is. Ladder volumes when these were added
// (2026-08-01): CGC ~2,900 rows across the compared grades, CSG only 8 —
// CSG is kept because it costs one near-empty page per grade to crawl.
export const COMPARE_GRADERS = ['SGC', 'BGS', 'CGC', 'CSG'];

// Each compared grade and the PSA grade it is measured against.
//
// Whole grades pair like-for-like (a 9 is never compared against a 10).
// HALF grades pair DOWN to the whole grade below: a BGS 9.5 is measured
// against PSA 9. That is the intended reading — "what does this half-grade
// slab cost versus the PSA grade it trades near" — not a data limitation.
// PSA 9.5 genuinely does not exist on the Ladder (0 rows), though PSA 8.5
// (689) and PSA 7.5 (320) do; pairing 8.5 against PSA 8.5 instead is a
// one-line change here, and nothing else needs to know.
// Ordered [grade, PSA grade it pairs with], best grade first. An ARRAY,
// not an object: JS reorders integer-like object keys ahead of the rest,
// which turned a 10-first list into "7, 8, 9, 10, 9.5, …" — the order
// drives both the UI's checkboxes and the crawl's priority.
const GRADE_PAIRS = [
  ['10', '10'],
  ['9.5', '9'],
  ['9', '9'],
  ['8.5', '8'],
  ['8', '8'],
  ['7.5', '7'],
  ['7', '7'],
];

export const GRADE_BASELINE = Object.fromEntries(GRADE_PAIRS);

// The grades offered in the UI, best first.
export const COMPARE_GRADES = GRADE_PAIRS.map(([g]) => g);

// The PSA grade a compared grade is measured against (identity for anything
// unmapped, so a future grade can't silently vanish from a join).
export const baselineGrade = (g) => GRADE_BASELINE[String(g)] ?? String(g);

// The distinct PSA grades worth crawling — 9.5/9 both resolve to PSA 9, so
// the baseline side is crawled once per distinct grade, not once per grade.
export const BASELINE_GRADES = [...new Set(GRADE_PAIRS.map(([, b]) => b))];

// Vocabularies for hand-added watches (the Watched tab's add form). Wider
// than the disparity comparison: any grader, half grades, Authentic, and
// the ungraded pairing — 'None' grader <-> 'Raw' grade always travel
// together and mean "must NOT be slabbed".
export const MANUAL_GRADERS = ['Any', 'None', 'SGC', 'PSA', 'BGS', 'CGC', 'CSG'];
export const MANUAL_GRADES = [
  'Any', 'Raw',
  '10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5',
  '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1',
  'Authentic',
];

// Conditions the sync crawls, one grade-filtered pass each: every compare
// grader plus the PSA baseline that grade pairs with. Compare graders come
// before PSA per grade so their (smaller) universes and card-page links
// seed shared cards first, and a baseline reached by two grades (PSA 9
// serves both 9.5 and 9) is crawled only once.
export const CRAWL_CONDITIONS = (() => {
  const seen = new Set();
  const out = [];
  const add = (condition) => {
    if (seen.has(condition)) return;
    seen.add(condition);
    out.push(condition);
  };
  for (const g of COMPARE_GRADES) {
    for (const c of COMPARE_GRADERS) add(`${c} ${g}`);
    add(`${BASELINE_COMPANY} ${baselineGrade(g)}`);
  }
  return out;
})();

export const config = {
  port: intEnv('PORT', 4000),
  // Loopback by default: this app has no authentication. Accepts a
  // comma-separated list, so you can add ONE more interface without
  // exposing the rest — e.g. "127.0.0.1,100.x.y.z" (your Tailscale IP)
  // keeps localhost working while making the app reachable from your other
  // Tailscale devices, and nothing else.
  // A set-but-empty BIND_HOST would otherwise parse to [] — zero listeners
  // and a silent exit-0 that looks like the app started and vanished.
  bindHosts: listEnv('BIND_HOST', '127.0.0.1').length
    ? listEnv('BIND_HOST', '127.0.0.1')
    : ['127.0.0.1'],
  headless: process.env.HEADLESS === 'true',
  mock: process.env.MOCK_CL === '1' || process.argv.includes('--mock'),
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
  // How many browser-based sources may drive the shared Chromium at once
  // during a check. Each source works in its own tab, so 2 roughly halves
  // the browser half of a run; 1 restores strictly serial tabs. HTTP-API
  // sources are unaffected — they all run concurrently regardless.
  watchBrowserConcurrency: intEnv('WATCH_BROWSER_CONCURRENCY', 2),
  // Browser sources work through this order — most productive first, so
  // new listings appear early in a long run instead of after the thin
  // auction houses. Unlisted sources run after these, registry order.
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
  // Minimum decrease (percent of the old price, native currency) before a
  // followed listing's re-sighting counts as a price drop worth alerting on.
  // Small seller nudges stay silent; 0 restores alert-on-any-decrease.
  followDropPct: floatEnv('FOLLOW_DROP_PCT', 10),
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
  // The Playwright profile. Only ONE Chromium may lock a profile directory,
  // so a running check owns ./profile for its whole duration — PROFILE_DIR
  // lets a one-off (scripts/testSource.js --scratch-profile) work in a
  // throwaway copy instead of waiting hours for the check to finish.
  profileDir: process.env.PROFILE_DIR ? path.resolve(process.env.PROFILE_DIR) : path.join(ROOT, 'profile'),
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
