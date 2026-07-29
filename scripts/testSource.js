// Exercise one marketplace source from the CLI — the fastest way to verify
// an adapter against the live site from YOUR machine (scraped sites are not
// reachable from every network, and several block datacenter IPs):
//
//   npm run test-source -- ebay "1986 fleer jordan psa 10"
//   npm run test-source -- fanatics "jordan psa 10"
//
// Prints the normalized raw listings the watcher would score. No DB rows are
// written (the real DB is only used for cached auth like the eBay token).

import { openDb } from '../src/db/db.js';
import { makeQueries } from '../src/db/queries.js';
import { REGISTRY } from '../src/marketplace/sources/index.js';
import { withTimeout } from '../src/marketplace/sources/util.js';

const args = process.argv.slice(2);
// --debug saves the raw payloads each adapter parsed (plus screenshots for
// browser sources) to captures/source-debug/ — attach those when reporting
// a source that returns nothing or garbage.
const debug = args.includes('--debug');
if (debug) process.env.WATCH_DEBUG = '1';
const [name, ...rest] = args.filter((a) => a !== '--debug');
const query = rest.join(' ').trim() || 'michael jordan psa 10';

if (!name || !REGISTRY[name]) {
  console.error(`usage: npm run test-source -- <source> "<query>" [--debug]`);
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
  }
  if (results.length > 20) console.log(`… and ${results.length - 20} more`);
} catch (err) {
  console.error(`\n${name} FAILED: ${err.message}`);
  if (!debug) console.error(`re-run with --debug to capture raw payloads for a bug report`);
  await source.close().catch(() => {});
  process.exit(1);
} finally {
  await source.close().catch(() => {});
}
process.exit(0);
