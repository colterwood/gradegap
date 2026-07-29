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

// The two conditions being compared. `condition` is the exact filter value the
// Ladder's search API expects (e.g. "condition:SGC 10"). SGC's numeric 10 comes
// in two flavors — "10 Gem Mint" and the rarer "10 Pristine"; the app's
// "SGC 10 - Gem Mint" selection maps to condition "SGC 10", and the adapter
// normalizes any Pristine rows to grade '10 PRI', so grade '10' always = Gem Mint.
export const TARGETS = {
  sgc: { company: 'SGC', grade: '10', condition: 'SGC 10', label: 'SGC 10 Gem Mint' },
  psa: { company: 'PSA', grade: '10', condition: 'PSA 10', label: 'PSA 10 Gem Mint' },
};

// The numeric grades we compare like-for-like: SGC 10 vs PSA 10, SGC 9 vs PSA 9.
// A 9 is NEVER compared against a 10 — each grade is its own paired comparison.
export const COMPARE_GRADES = ['10', '9'];

// Conditions the sync crawls, one grade-filtered pass each. SGC before PSA per
// grade so its (smaller) universe and card-page links seed shared cards first.
export const CRAWL_CONDITIONS = COMPARE_GRADES.flatMap((g) => [
  `${TARGETS.sgc.company} ${g}`,
  `${TARGETS.psa.company} ${g}`,
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
