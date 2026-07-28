// The real Card Ladder data source. Same interface as mockSource:
//   start() / enumerateCards(playerRow) / fetchCardPrices(cardRow) / close()

import { launchBrowser, looksLoggedOut, APP_URL } from '../browser.js';
import { attachCapture, saveFailure } from '../capture.js';
import { mightContainCards, mightContainPrices } from './endpoints.js';
import { parseCards, parsePrices } from './adapter.js';
import * as nav from './navigate.js';

export function createCardLadderSource() {
  let context = null;
  let page = null;

  // Collectors the capture callback feeds while a flow is running.
  let cardCollector = null;
  let priceCollector = null;
  let unclaimed = [];

  return {
    name: 'cardladder',

    async start() {
      context = await launchBrowser();
      attachCapture(context, {
        onPayload: async (entry) => {
          let claimed = false;
          if (cardCollector && mightContainCards(entry.url)) {
            const res = parseCards(entry, cardCollector.player);
            if (res.ok) {
              for (const c of res.data) cardCollector.cards.set(c.clCardId, c);
              claimed = true;
            }
          }
          if (priceCollector && mightContainPrices(entry.url)) {
            const res = parsePrices(entry);
            if (res.ok) {
              for (const p of res.data) priceCollector.prices.set(`${p.company}|${p.grade}`, p);
              claimed = true;
            }
          }
          if (!claimed) unclaimed.push({ url: entry.url, json: entry.json });
          return claimed;
        },
      });
      page = context.pages()[0] ?? (await context.newPage());
      await nav.goToApp(page);
      if (await looksLoggedOut(page)) {
        throw new Error('Not logged in to Card Ladder — run `npm run login` first.');
      }
    },

    async enumerateCards(playerRow) {
      cardCollector = { player: { name: playerRow.name }, cards: new Map() };
      unclaimed = [];
      try {
        await nav.searchPlayer(page, playerRow.search_term);
        await nav.openFirstPlayerResult(page, playerRow.name);
        await nav.exhaustCardList(page);

        if (cardCollector.cards.size === 0) {
          // network interception found nothing recognizable — try the DOM
          const links = await nav.scrapeCardLinksFromDom(page);
          for (const l of links) {
            const id = l.href.split('/card/')[1]?.split(/[/?#]/)[0];
            if (!id) continue;
            const yearMatch = l.text.match(/\b(19|20)\d{2}\b/);
            cardCollector.cards.set(id, {
              clCardId: id,
              name: l.text,
              setName: null,
              year: yearMatch ? Number(yearMatch[0]) : null,
              cardNumber: null,
              parallel: null,
              clUrl: new URL(l.href, APP_URL).href,
              raw: { domFallback: true, ...l },
            });
          }
        }

        if (cardCollector.cards.size === 0) {
          saveFailure(`enumerate-${playerRow.name}`, {
            note: 'No cards recognized from network or DOM. Inspect these unclaimed payloads and update endpoints.js/adapter.js.',
            url: page.url(),
            unclaimedCount: unclaimed.length,
            unclaimed: unclaimed.slice(0, 25),
          });
        }
        return [...cardCollector.cards.values()];
      } finally {
        cardCollector = null;
      }
    },

    async fetchCardPrices(cardRow) {
      priceCollector = { prices: new Map() };
      unclaimed = [];
      try {
        await nav.openCardPage(page, cardRow);
        if (await looksLoggedOut(page)) {
          throw new Error('Session expired — run `npm run login` again.');
        }
        if (priceCollector.prices.size === 0) {
          saveFailure(`prices-${cardRow.cl_card_id}`, {
            note: 'No grade prices recognized on this card page. Inspect these unclaimed payloads and update endpoints.js/adapter.js.',
            card: { id: cardRow.cl_card_id, name: cardRow.name, url: cardRow.cl_url },
            unclaimedCount: unclaimed.length,
            unclaimed: unclaimed.slice(0, 25),
          });
        }
        return [...priceCollector.prices.values()];
      } finally {
        priceCollector = null;
      }
    },

    async close() {
      await context?.close().catch(() => {});
      context = null;
      page = null;
    },
  };
}
