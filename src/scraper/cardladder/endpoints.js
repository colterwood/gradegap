// The Ladder is backed by search.cardladder.com. This is now confirmed from a
// real capture, not a guess: a GET to /search?index=cards with a
// condition:<GRADE> filter returns { hits:[...], totalHits } where each hit
// carries card identity + per-grade value. Pagination is page (0-based) +
// limit. Auth is a Firebase Bearer token in the Authorization header.

const LADDER_HOST = 'search.cardladder.com';

// Build a cards-index search URL. encodeURIComponent keeps the exact
// "condition:SGC 10" → "condition%3ASGC%2010" encoding the app itself uses.
export function buildLadderUrl({ condition, page = 0, limit = 100 }) {
  const q =
    `index=cards&query=&page=${page}&limit=${limit}` +
    `&filters=${encodeURIComponent(`condition:${condition}`)}` +
    `&sort=score&direction=desc`;
  return `https://${LADDER_HOST}/search?${q}`;
}
