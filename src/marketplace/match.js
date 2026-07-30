// Pure matching layer for marketplace listings, in the style of adapter.js:
// no I/O, unit-testable. Source adapters only translate a query string into
// raw listings; everything here decides whether a listing is actually the
// watched card.
//
// Philosophy: hard requirements (year, player last name, grader+grade) must
// all appear in the title or the listing is discarded outright. Everything
// else (set, parallel, card number, first name) only moves a fuzzy 0..1
// score — low scorers are KEPT and shown with a low-confidence badge so
// false positives are dismissed by a human instead of dropped silently.

const GRADERS = ['PSA', 'SGC', 'BGS', 'CGC', 'CSG'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Tokens for fuzzy overlap: lowercase, punctuation → space.
const tokenize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

// --- query building --------------------------------------------------------

// Search strings for a watch. `tight` leans on the full card identity;
// `loose` (used when tight finds nothing) drops set/parallel — the fields
// sellers most often word differently — keeping year + player + number +
// slab. Either way the match layer re-verifies every result.
export function buildQueries(target) {
  const { year, setName, playerName, cardNumber, parallel, company, grade, description } = target;
  // Slab words worth sending to a site's search box: skip them when the
  // watch says Any/ungraded (they'd wrongly narrow the results).
  const slab = isUngraded(company, grade)
    ? ''
    : [
        String(company).toLowerCase() === 'any' ? '' : company,
        String(grade).toLowerCase() === 'any' ? '' : grade,
      ].filter(Boolean).join(' ');

  // Manual watch: the typed description IS the query.
  if (description) {
    const tight = [description, slab].filter(Boolean).join(' ').trim();
    return { tight, loose: tight === description ? null : description };
  }

  const tight = [year, setName, playerName, parallel, slab].filter(Boolean).join(' ').trim();
  const loose = [year, playerName, cardNumber ? `#${cardNumber}` : null, slab]
    .filter(Boolean)
    .join(' ')
    .trim();
  return { tight, loose: loose !== tight ? loose : null };
}

// --- hard-requirement regexes ----------------------------------------------

// A card's year appears in titles as "1986", "1986-87", "1986/87" or "86-87"
// (season formats are the norm for hockey/basketball).
export function yearRegex(year) {
  const y = String(year);
  const yy = y.slice(2);
  const nextYy = String((Number(yy) + 1) % 100).padStart(2, '0');
  return new RegExp(
    `\\b${y}(?:\\s*[-/]\\s*(?:${nextYy}|${y.slice(0, 2)}${nextYy}))?\\b` +
      `|\\b${yy}\\s*[-/]\\s*${nextYy}\\b`,
    'i'
  );
}

// "PSA 10", "PSA10", "PSA-10", "PSA GEM MINT 10", and word-label forms like
// "PSA Mint 9" / "PSA NM-MT 8" / "PSA EX-MT 6" (Heritage writes grades this
// way) all hit; "PSA 10.5"/"PSA 9" for a PSA-10 target do not (grade must
// match exactly). Only known grade-label words may sit between company and
// number — "PSA lot of 9" must NOT match.
const GRADE_WORDS = '(?:gem|mint|mt|nm|ex|vg|gd|fr|pr|near|pristine|authentic)';

// A grade is a number ("10", "9.5") or the word grade "Authentic".
function gradeSource(grade) {
  const g = String(grade);
  if (/^authentic$/i.test(g)) return '(?:authentic|auth)\\b';
  // Trailing lookahead blocks decimals ("9" must not match "9.5") but NOT
  // sentence punctuation ("…PSA Mint 9." is a match).
  return `${esc(g)}(?!\\d)(?!\\.\\d)`;
}

export function slabRegex(company, grade) {
  // No \b between company and grade: "PSA10" has no letter/digit boundary.
  return new RegExp(
    `\\b${esc(company)}[\\s:–-]*(?:${GRADE_WORDS}[\\s.+:–-]*){0,3}${gradeSource(grade)}`,
    'i'
  );
}

// Same grade, any grading company — the "Any" grader of a manual watch.
export function anyGraderRegex(grade) {
  return new RegExp(
    `\\b(?:${GRADERS.join('|')})[\\s:–-]*(?:${GRADE_WORDS}[\\s.+:–-]*){0,3}${gradeSource(grade)}`,
    'i'
  );
}

// Named company, any grade — the "Any" grade of a manual watch.
export function anyGradeRegex(company) {
  return new RegExp(
    `\\b${esc(company)}[\\s:–-]*(?:${GRADE_WORDS}[\\s.+:–-]*){0,3}(?:\\d{1,2}(?:\\.5)?(?!\\d)|authentic|auth)\\b`,
    'i'
  );
}

export const isUngraded = (company, grade) =>
  String(company ?? '').toLowerCase() === 'none' || String(grade ?? '').toLowerCase() === 'raw';

// The slab rule for a watch, covering every manual-watch combination.
// 'Any' grader means any GRADING COMPANY; ungraded is the separate None/Raw
// pairing, which demands the title show no slab at all.
export function slabMatcher(company, grade) {
  const co = String(company ?? '');
  const gr = String(grade ?? '');
  if (isUngraded(co, gr)) {
    return { label: 'ungraded', kind: 'ungraded', test: (raw) => !anySlabRe().test(raw) };
  }
  const anyCo = co.toLowerCase() === 'any';
  const anyGr = gr.toLowerCase() === 'any';
  if (anyCo && anyGr) return { label: 'any slab', kind: 'any', test: () => true };
  if (anyCo) return { label: `any ${gr}`, kind: 'anyGrader', test: (raw) => anyGraderRegex(gr).test(raw) };
  if (anyGr) return { label: `${co} any`, kind: 'anyGrade', test: (raw) => anyGradeRegex(co).test(raw) };
  return { label: `${co} ${gr}`, kind: 'exact', test: (raw) => slabRegex(co, gr).test(raw) };
}

// Every "GRADER n" mention in a title (word-label forms included), for
// wrong-slab penalties and the ungraded test. Built fresh per use: a /g
// regex carries lastIndex state between calls.
const ANY_SLAB_SRC =
  `\\b(${GRADERS.join('|')})[\\s:–-]*(?:${GRADE_WORDS}[\\s.+:–-]*){0,3}(\\d{1,2}(?:\\.5)?(?!\\d)(?!\\.\\d)|authentic\\b)`;
const anySlabRe = () => new RegExp(ANY_SLAB_SRC, 'i');
const anySlabReGlobal = () => new RegExp(ANY_SLAB_SRC, 'gi');

// Words that mean "this is not the real slab you watched" (plural-tolerant:
// "Fleer Reprints" must trip the reprint penalty).
const BAD_WORDS_RE = /\b(reprints?|replicas?|customs?|prox(?:y|ies)|digital|novelty|lots?|breaks?)\b/g;

const badWords = (raw) =>
  new Set([...raw.matchAll(BAD_WORDS_RE)].map((m) => m[1].replace(/ies$/, 'y').replace(/s$/, '')));

// Scoring only checks that the WATCH's words appear in the title, so extra
// title words are free — which let a base "2000 Bowman Chrome" watch score
// 100% against a "... Refractor" listing, and "Galactus" against "Fantastic
// Four vs Galactus". These words, when the title has them but the watched
// identity doesn't, mark a different card (a parallel, or a "vs" battle
// card); each one found costs 0.35. A watch that itself contains the word
// (a Silver-parallel watch, a "... vs ..." description) is exempt.
const VARIANT_WORDS = [
  'refractor', 'refractors', 'xfractor', 'foil', 'prizm', 'holo', 'atomic',
  'sapphire', 'shimmer', 'wave', 'mojo', 'sparkle', 'cracked', 'ice',
  'gold', 'silver', 'sepia', 'camo', 'vs',
];

const variantWords = (titleTokens, targetTokens) =>
  VARIANT_WORDS.filter((w) => titleTokens.has(w) && !targetTokens.has(w));

// --- scoring ---------------------------------------------------------------

// target: a catalog watch
//   { playerName, year, setName, cardNumber, parallel, company, grade }
// or a manual watch
//   { description, company, grade }   ('Any'/'None'/'Raw' allowed)
// Returns { ok, score, debug: { matched, missing, penalties } }.
// ok=false → hard requirement failed, listing must not be stored.
export function scoreListing(target, title) {
  const raw = String(title ?? '').toLowerCase();
  const tokens = new Set(tokenize(raw));
  const matched = [];
  const missing = [];
  const penalties = [];

  // -- slab rule: shared by both watch kinds
  const slab = slabMatcher(target.company, target.grade);
  if (slab.test(raw)) matched.push(`slab:${slab.label}`);
  else missing.push(`slab:${slab.label}`);

  // -- manual watch: every word typed must appear in the title
  if (target.description) {
    const want = tokenize(target.description).filter((t) => t.length >= 2);
    const missed = want.filter((t) => !tokens.has(t));
    if (missed.length > 0) missing.push(`words:${missed.join(' ')}`);
    else if (want.length) matched.push(`words:${want.join(' ')}`);
    if (missing.length > 0) return { ok: false, score: 0, debug: { matched, missing, penalties } };

    // All requested words present: full confidence, less any junk-word hits.
    let score = 1;
    for (const w of badWords(raw)) {
      score -= 0.4;
      penalties.push(`word:${w}`);
    }
    for (const w of variantWords(tokens, new Set(want))) {
      score -= 0.35;
      penalties.push(`variant:${w}`);
    }
    return { ok: true, score: Math.max(0, Math.min(1, score)), debug: { matched, missing, penalties } };
  }

  // -- catalog watch hard requirements
  if (target.year) {
    if (yearRegex(target.year).test(raw)) matched.push(`year:${target.year}`);
    else missing.push(`year:${target.year}`);
  }
  const nameTokens = tokenize(target.playerName ?? '');
  const lastName = nameTokens[nameTokens.length - 1];
  if (lastName) {
    if (tokens.has(lastName)) matched.push(`player:${lastName}`);
    else missing.push(`player:${lastName}`);
  }
  // Set name is a hard requirement too (when the card has one): at least one
  // significant set token must appear, or "1997 Kobe SGC 9" matches every
  // 1997 Kobe SGC 9 on the site regardless of set (live-verified failure
  // mode). Partial matches ("Prizm" for "Panini Prizm") still pass — the
  // fuzzy score below grades how completely the set matched.
  const setTokens = tokenize(target.setName ?? '');
  if (setTokens.length > 0 && !setTokens.some((t) => tokens.has(t))) {
    missing.push(`set:${setTokens.join(' ')}`);
  }
  if (missing.length > 0) {
    return { ok: false, score: 0, debug: { matched, missing, penalties } };
  }

  // -- fuzzy score over whatever identity fields the card actually has
  const parts = [];
  const overlap = (values) => {
    const ts = values.flatMap(tokenize);
    if (ts.length === 0) return null;
    const hit = ts.filter((t) => tokens.has(t));
    return { frac: hit.length / ts.length, hit, all: ts };
  };

  const set = overlap([target.setName]);
  if (set) parts.push({ label: 'set', weight: 0.4, ...set });
  if (target.cardNumber) {
    const num = String(target.cardNumber).toLowerCase();
    const hitNum = tokens.has(num);
    parts.push({ label: 'number', weight: 0.25, frac: hitNum ? 1 : 0, hit: hitNum ? [num] : [], all: [num] });
  }
  const par = overlap([target.parallel]);
  if (par) parts.push({ label: 'parallel', weight: 0.2, ...par });
  const first = overlap([nameTokens.slice(0, -1).join(' ')]);
  if (first) parts.push({ label: 'firstname', weight: 0.15, ...first });

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  // No optional fields at all (bare card record) → neutral-high confidence,
  // the hard requirements carried everything we know.
  let score = totalWeight === 0 ? 0.8 : parts.reduce((s, p) => s + (p.weight / totalWeight) * p.frac, 0);
  for (const p of parts) {
    if (p.frac > 0) matched.push(`${p.label}:${p.hit.join(' ')}`);
    else missing.push(`${p.label}:${p.all.join(' ')}`);
  }

  // -- penalties
  for (const m of raw.matchAll(anySlabReGlobal())) {
    const company = m[1].toUpperCase();
    const grade = m[2];
    if (company === target.company.toUpperCase() && grade !== String(target.grade)) {
      score -= 0.35; // same grader, different grade also present (lot? wrong card?)
      penalties.push(`slab:${company} ${grade}`);
    } else if (company !== target.company.toUpperCase()) {
      score -= 0.1; // another grader mentioned — often just a comparison, mild
      penalties.push(`slab:${company} ${grade}`);
    }
  }
  for (const w of badWords(raw)) {
    score -= 0.4;
    penalties.push(`word:${w}`);
  }
  const identityTokens = new Set(
    [target.year, target.setName, target.playerName, target.cardNumber, target.parallel].flatMap(tokenize)
  );
  for (const w of variantWords(tokens, identityTokens)) {
    score -= 0.35;
    penalties.push(`variant:${w}`);
  }

  score = Math.max(0, Math.min(1, score));
  return { ok: true, score, debug: { matched, missing, penalties } };
}
