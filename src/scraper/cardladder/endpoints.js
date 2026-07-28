// URL matchers for Card Ladder backend calls.
//
// ⚠️  BEST GUESSES. Card Ladder's internal API is undocumented and cannot be
// inspected without a logged-in account. After your first `npm run discover`
// run, open captures/<timestamp>/index.jsonl, find the requests that carry
// the card list and the per-grade prices, and tighten these matchers to the
// real URLs. The adapter's parsers are heuristic and payload-shape-driven,
// so loose matchers here are OK — they just mean more payloads get offered
// to the parsers.

export function mightContainCards(url) {
  return (
    /firestore\.googleapis\.com/.test(url) ||
    /algolia(net)?\.(net|com)/.test(url) ||
    /cloudfunctions\.net|run\.app/.test(url) ||
    /cardladder\.com\/.*(card|search|player)/i.test(url)
  );
}

export function mightContainPrices(url) {
  return (
    /firestore\.googleapis\.com/.test(url) ||
    /cloudfunctions\.net|run\.app/.test(url) ||
    /cardladder\.com\/.*(sale|price|index|chart|card)/i.test(url)
  );
}
