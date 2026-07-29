// COMC (comc.com) — huge fixed-price inventory. Cleanest path is their RSS
// SearchFeed (one <item> per card, price + image embedded in the description
// HTML), fetched with plain HTTP — no browser, no auth. COMC has no
// auctions, so everything is fixed-price and there's nothing to end-filter.
// Verify locally with `npm run test-source comc "jordan psa 10"`.

import { fetchHtml, toNumber, decodeEntities } from './util.js';

const SITE = 'https://www.comc.com';

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? null;

// Pure, fixture-testable: SearchFeed RSS → normalized raw listings.
export function parseComcFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const link = unescapeXml(tag(item, 'link') ?? tag(item, 'guid') ?? '').trim();
    // Titles carry embedded HTML entities (&nbsp;, &#8209;) — decode twice:
    // once for the XML layer, once for the HTML inside it.
    const title = decodeEntities(unescapeXml(tag(item, 'title') ?? ''));
    // The card id is the last LONG numeric path segment. Trailing segments
    // may follow it (/Ungraded/COMC/EX-NM, /Graded/PSA/10) and short numeric
    // segments appear as card numbers (/47/) and grades (/10) — requiring 4+
    // digits keeps only the item id.
    const id = [...link.matchAll(/\/(\d{4,})(?=\/|$)/g)].pop()?.[1];
    if (!id || !title) continue;
    const desc = unescapeXml(tag(item, 'description') ?? '');
    const price = toNumber(desc.match(/Sale Price:\s*\$?([\d,]+(?:\.\d{2})?)/i)?.[1]);
    const imageUrl = desc.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null;
    out.push({
      listingId: id,
      canonicalKey: `comc:${id}`,
      title,
      url: link,
      price,
      currency: 'USD',
      listingType: 'fixed',
      endsAt: null,
      imageUrl,
      seller: null,
    });
  }
  return out;
}

export function createComcSource() {
  return {
    name: 'comc',
    needsBrowser: false,
    minIntervalMs: 3000,

    async start() {},

    async search({ text }) {
      const params = new URLSearchParams({ SportID: '0', Search: text, PageSize: '100', Sort: 'r' });
      const xml = await fetchHtml(`${SITE}/SearchFeed?${params}`, {
        headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      return parseComcFeed(xml);
    },

    async close() {},
  };
}
