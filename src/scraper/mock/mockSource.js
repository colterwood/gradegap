// Mock data source with the same interface as the real Card Ladder source:
//   start() / fetchLadderPage({condition,page,limit}) / refreshAuth() / close()
// It serves fixture "hits" shaped exactly like search.cardladder.com rows, so
// MOCK_CL=1 exercises the real adapter and sync path end to end without an
// account.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockSource() {
  const hits = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'ladder.json'), 'utf8'));

  return {
    name: 'mock',

    async start() {},
    async refreshAuth() {},
    async close() {},

    async fetchLadderPage({ condition, page, limit }) {
      const ms = parseInt(process.env.MOCK_PAGE_MS, 10) || 50;
      await sleep(ms);
      const matching = hits.filter((h) => h.condition === condition);
      const start = page * limit;
      return {
        status: 200,
        body: { hits: matching.slice(start, start + limit), totalHits: matching.length },
      };
    },
  };
}
