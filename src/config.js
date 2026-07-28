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

// The two conditions being compared. SGC's numeric 10 comes in two flavors —
// "10 Gem Mint" and the rarer "10 Pristine". The adapter normalizes Pristine
// to grade '10 PRI', so grade '10' here always means Gem Mint.
export const TARGETS = {
  sgc: { company: 'SGC', grade: '10', label: 'SGC 10 Gem Mint' },
  psa: { company: 'PSA', grade: '10', label: 'PSA 10 Gem Mint' },
};

export const config = {
  port: intEnv('PORT', 4000),
  headless: process.env.HEADLESS === 'true',
  mock: process.env.MOCK_CL === '1' || process.argv.includes('--mock'),
  discovery: process.env.DISCOVERY === '1',
  rateMinMs: intEnv('RATE_MIN_MS', 3000),
  rateMaxMs: intEnv('RATE_MAX_MS', 7000),
  clEmail: process.env.CL_EMAIL || '',
  clPassword: process.env.CL_PASSWORD || '',
  dataDir: path.join(ROOT, 'data'),
  capturesDir: path.join(ROOT, 'captures'),
  profileDir: path.join(ROOT, 'profile'),
  publicDir: path.join(ROOT, 'public'),
};

export function loadPlayers() {
  const raw = readFileSync(path.join(ROOT, 'config', 'players.json'), 'utf8');
  const players = JSON.parse(raw);
  if (!Array.isArray(players)) throw new Error('config/players.json must be an array');
  for (const p of players) {
    if (!p.name || !p.searchTerm) {
      throw new Error('each player in config/players.json needs "name" and "searchTerm"');
    }
  }
  return players;
}
