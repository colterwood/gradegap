// Exercise one marketplace source from the CLI — the fastest way to verify
// an adapter against the live site from YOUR machine (scraped sites are not
// reachable from every network, and several block datacenter IPs):
//
//   npm run test-source -- ebay "1986 fleer jordan psa 10"
//   npm run test-source -- fanatics "jordan psa 10"
//   npm run test-source -- heritage "1986 fleer jordan bgs 8" --scratch-profile
//
// Prints the normalized raw listings the watcher would score. No DB rows are
// written (the real DB is only used for cached auth like the eBay token).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
// --debug saves the raw payloads each adapter parsed (plus screenshots for
// browser sources) to captures/source-debug/ — attach those when reporting
// a source that returns nothing or garbage.
const debug = args.includes('--debug');
if (debug) process.env.WATCH_DEBUG = '1';

// --scratch-profile runs the browser in a throwaway profile dir. Chromium
// locks a profile to one instance, so while a check is running it owns
// ./profile and any browser source here fails with "Opening in existing
// browser session". The scratch profile is NOT logged in — fine for public
// sites (heritage, hibid, myslabs), useless for anything gated.
const scratch = args.includes('--scratch-profile');
if (scratch) {
  const dir = path.join(os.tmpdir(), `gradegap-scratch-profile-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.PROFILE_DIR = dir; // read by config.js on import below
  console.log(`using scratch profile: ${dir}\n  (not logged in — public sites only)`);
}

// Imported AFTER PROFILE_DIR is set: config.js reads it at module load.
const { openDb } = await import('../src/db/db.js');
const { makeQueries } = await import('../src/db/queries.js');
const { REGISTRY } = await import('../src/marketplace/sources/index.js');
const { withTimeout } = await import('../src/marketplace/sources/util.js');

const [name, ...rest] = args.filter((a) => a !== '--debug' && a !== '--scratch-profile');
const query = rest.join(' ').trim() || 'michael jordan psa 10';

if (!name || !REGISTRY[name]) {
  console.error(`usage: npm run test-source -- <source> "<query>" [--debug] [--scratch-profile]`);
  console.error(`sources: ${Object.keys(REGISTRY).join(', ')}`);
  process.exit(1);
}

const db = openDb();
const q = makeQueries(db);
const source = await REGISTRY[name]();

try {
  console.log(`starting ${name}…`);
  await withTimeout(source.start({ q, db }), 60_000, `${name} start`);
  console.log(`searching ${name} for "${query}" (up to 90s)…`);
  const t0 = Date.now();
  const results = await withTimeout(source.search({ text: query }), 90_000, `${name} search`);
  console.log(`\n${source.name}: ${results.length} raw listings for "${query}" in ${Date.now() - t0}ms\n`);
  for (const r of results.slice(0, 20)) {
    const price = r.price != null ? `${r.price.toLocaleString('en-US')} ${r.currency ?? ''}`.trim() : '—';
    console.log(`- [${r.listingType ?? '?'}] ${price} · ${r.title}`);
    if (r.url) console.log(`    ${r.url}`);
    if (r.endsAt) console.log(`    ends ${r.endsAt}`);
    if (r.seller) console.log(`    seller: ${r.seller}`);
  }
  if (results.length > 20) console.log(`… and ${results.length - 20} more`);
} catch (err) {
  // The single most confusing failure here: Chromium locks ./profile to one
  // instance, so this fails for the whole duration of a running check.
  if (/already in use|existing browser session/i.test(err.message)) {
    console.error(
      `\n${name} FAILED: the browser profile is in use — a watch check or sync has it.\n` +
        `  Re-run with --scratch-profile to use a throwaway profile instead:\n` +
        `    npm run test-source -- ${name} "${query}" --scratch-profile${debug ? ' --debug' : ''}\n` +
        `  (public sites only; the scratch profile has no logins)`
    );
    await source.close().catch(() => {});
    process.exit(1);
  }
  console.error(`\n${name} FAILED: ${err.message}`);
  if (!debug) console.error(`re-run with --debug to capture raw payloads for a bug report`);
  await source.close().catch(() => {});
  process.exit(1);
} finally {
  await source.close().catch(() => {});
}
process.exit(0);
