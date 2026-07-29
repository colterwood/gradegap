// Mock marketplace source, mirroring src/scraper/mock/mockSource.js: serves
// fixture listings shaped exactly like real adapter output so mock mode and
// the tests exercise the full watch path (search → score → store → notify)
// without any marketplace credentials. Its toy search engine returns fixtures
// sharing at least two tokens with the query — deliberately loose, like a
// real marketplace search, so the match layer has real filtering to do.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenize = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

export function createMockMarketSource(listings) {
  const data =
    listings ?? JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'market.json'), 'utf8'));

  return {
    name: 'mockmarket',
    needsBrowser: false,
    minIntervalMs: 0,

    async start() {},
    async close() {},

    async search({ text }) {
      await sleep(parseInt(process.env.MOCK_MARKET_MS, 10) || 10);
      const queryTokens = new Set(tokenize(text));
      return data
        .filter((l) => tokenize(l.title).filter((t) => queryTokens.has(t)).length >= 2)
        .map((l) => ({ ...l }));
    },
  };
}
