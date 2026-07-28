// Mock data source with the same interface as the real Card Ladder source:
//   enumerateCards(player) -> [{clCardId, name, setName, year, cardNumber, parallel, clUrl, raw}]
//   fetchCardPrices(card)  -> [{company, grade, clValue, lastSalePrice, lastSaleDate}]
//   close()
// Used when MOCK_CL=1 so the whole app can be exercised without Card Ladder.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockSource() {
  const cards = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'jordan-cards.json'), 'utf8'));
  const prices = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'prices.json'), 'utf8'));

  return {
    name: 'mock',

    async start() {},

    async enumerateCards(player) {
      await sleep(300);
      if (!/jordan/i.test(player.search_term)) return [];
      return cards.map((c) => ({
        ...c,
        clUrl: `https://app.cardladder.com/card/${c.clCardId}`,
        raw: c,
      }));
    },

    // card is a DB row (snake_case columns)
    async fetchCardPrices(card) {
      await sleep(150);
      return prices[card.cl_card_id] ?? [];
    },

    async close() {},
  };
}
