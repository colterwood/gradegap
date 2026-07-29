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

const [name, ...rest] = process.argv.slice(2);
const query = rest.join(' ').trim() || 'michael jordan psa 10';

if (!name || !REGISTRY[name]) {
  console.error(`usage: npm run test-source -- <source> "<query>"`);
  console.error(`sources: ${Object.keys(REGISTRY).join(', ')}`);
  process.exit(1);
}

const db = openDb();
const q = makeQueries(db);
const source = await REGISTRY[name]();

try {
  await source.start({ q, db });
  const t0 = Date.now();
  const results = await source.search({ text: query });
  console.log(`\n${source.name}: ${results.length} raw listings for "${query}" in ${Date.now() - t0}ms\n`);
  for (const r of results.slice(0, 20)) {
    const price = r.price != null ? `${r.price.toLocaleString('en-US')} ${r.currency ?? ''}`.trim() : '—';
    console.log(`- [${r.listingType ?? '?'}] ${price} · ${r.title}`);
    if (r.url) console.log(`    ${r.url}`);
    if (r.endsAt) console.log(`    ends ${r.endsAt}`);
  }
  if (results.length > 20) console.log(`… and ${results.length - 20} more`);
} finally {
  await source.close().catch(() => {});
}
process.exit(0);
