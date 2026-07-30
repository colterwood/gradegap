// Config diagnosis: `npm run doctor`
//
// Answers "why isn't my source running?" — where .env was looked for, which
// keys actually landed in the process (masked), and each source's readiness.
// Catches the classic Windows trap of Notepad saving ".env" as ".env.txt".

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../src/config.js';
import { REGISTRY, resolveSourceNames } from '../src/marketplace/sources/index.js';

const tick = (ok) => (ok ? '✓' : '✗');
const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)` : '(empty)');

console.log(`\nGradeGap config doctor`);
console.log(`project root : ${ROOT}`);
console.log(`working dir  : ${process.cwd()}`);

// --- .env file ---------------------------------------------------------
// dotenv reads <cwd>/.env, so running npm from elsewhere silently skips it.
const envPath = path.join(process.cwd(), '.env');
const rootEnvPath = path.join(ROOT, '.env');
console.log(`\n.env`);
console.log(`  ${tick(existsSync(envPath))} ${envPath}${existsSync(envPath) ? '' : '  <-- dotenv looks HERE'}`);
if (rootEnvPath !== envPath) {
  console.log(`  ${tick(existsSync(rootEnvPath))} ${rootEnvPath} (project root)`);
  if (existsSync(rootEnvPath) && !existsSync(envPath)) {
    console.log(`  !! run npm from the project root, or move the file`);
  }
}

// Look-alikes: .env.txt, .env.env, ENV, etc.
try {
  const strays = readdirSync(process.cwd())
    .filter((f) => /^\.?env/i.test(f) && f !== '.env');
  if (strays.length) {
    console.log(`  !! look-alike files found: ${strays.join(', ')}`);
    console.log(`     Windows Notepad saves ".env" as ".env.txt" — rename it to exactly .env`);
    console.log(`     PowerShell:  Rename-Item .env.txt .env`);
  }
} catch { /* unreadable dir — skip */ }

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, 'utf8');
  const keys = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.split('=')[0].trim());
  console.log(`  keys defined: ${keys.length ? keys.join(', ') : '(none)'}`);
  const quoted = raw.match(/^\s*EBAY_CLIENT_(?:ID|SECRET)\s*=\s*["'].*["']\s*$/m);
  if (quoted) console.log(`  !! quotes around a value are kept literally — remove them`);
}

// --- credentials as the process actually sees them ---------------------
console.log(`\ncredentials (as loaded)`);
console.log(`  EBAY_CLIENT_ID     : ${mask(config.ebayClientId)}`);
console.log(`  EBAY_CLIENT_SECRET : ${mask(config.ebayClientSecret)}`);
console.log(`  EBAY_MARKETPLACES  : ${config.ebayMarketplaces.join(', ')}`);
console.log(`  NTFY_TOPIC         : ${config.ntfyTopic || '(empty — phone pushes disabled)'}`);
console.log(`  SHOPIFY_SHOPS      : ${config.shopifyShops.join(', ') || '(empty)'}`);

// --- sources -----------------------------------------------------------
const names = resolveSourceNames(config.watchSources);
console.log(`\nWATCH_SOURCES = ${config.watchSources.join(',')} -> ${names.length} sources`);
let ready = 0;
for (const name of names) {
  const make = REGISTRY[name];
  if (!make) {
    console.log(`  ✗ ${name.padEnd(10)} unknown source name`);
    continue;
  }
  const src = await make();
  const reason = src.configured?.() ?? null;
  if (!reason) ready += 1;
  console.log(
    `  ${tick(!reason)} ${name.padEnd(10)} ${reason ?? (src.needsBrowser ? 'ready (opens browser)' : 'ready')}`
  );
}
console.log(`\n${ready}/${names.length} sources ready.`);
console.log(`Check interval: ${config.watchIntervalMin === 0 ? 'manual only' : `every ${config.watchIntervalMin} min`}\n`);
process.exit(0);
