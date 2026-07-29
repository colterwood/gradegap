// The Ladder is backed by search.cardladder.com. This is now confirmed from a
// real capture, not a guess: a GET to /search?index=cards with a
// condition:<GRADE> filter returns { hits:[...], totalHits } where each hit
// carries card identity + per-grade value. Pagination is page (0-based) +
// limit. Auth is a Firebase Bearer token in the Authorization header.

const LADDER_HOST = 'search.cardladder.com';

export function isLadderSearch(url) {
  return url.includes(LADDER_HOST) && /[?&]index=cards\b/.test(url);
}

// Build a cards-index search URL. encodeURIComponent keeps the exact
// "condition:SGC 10" → "condition%3ASGC%2010" encoding the app itself uses.
export function buildLadderUrl({ condition, page = 0, limit = 100 }) {
  const q =
    `index=cards&query=&page=${page}&limit=${limit}` +
    `&filters=${encodeURIComponent(`condition:${condition}`)}` +
    `&sort=score&direction=desc`;
  return `https://${LADDER_HOST}/search?${q}`;
}

// --- legacy per-card matchers (kept for the optional card-page fallback) ----
export function mightContainCards(url) {
  return (
    /firestore\.googleapis\.com/.test(url) ||
    /search\.cardladder\.com/.test(url) ||
    /cloudfunctions\.net|run\.app/.test(url) ||
    /cardladder\.com\/.*(card|search|player)/i.test(url)
  );
}

export function mightContainPrices(url) {
  return (
    /firestore\.googleapis\.com/.test(url) ||
    /search\.cardladder\.com/.test(url) ||
    /cloudfunctions\.net|run\.app/.test(url) ||
    /cardladder\.com\/.*(sale|price|index|chart|card)/i.test(url)
  );
}
