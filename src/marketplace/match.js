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

// Card Ladder writes player aliases in parentheses: "Kareem Abdul-Jabbar
// (Lew Alcindor)", "(Shoeless) Joe Jackson". The parenthetical is an ALIAS,
// and treating it as part of the name broke Kareem end to end (live-
// verified): queries carried "(Lew Alcindor)" so eBay's AND-semantics
// returned zero listings, and the scorer's required surname became
// "alcindor", hard-dropping every Jabbar-titled listing that did arrive.
// Split into the primary name plus alias phrases; queries use the primary,
// the player gate accepts either.
export function splitAliases(name) {
  const raw = String(name ?? '');
  const aliases = [...raw.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  const primary = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return { primary: primary || raw.trim(), aliases };
}

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

  // Queries carry only the PRIMARY player name — an alias in the query
  // ANDs against listing titles and silently zeroes the results.
  const player = splitAliases(playerName).primary;
  const tight = [year, setName, player, parallel, slab].filter(Boolean).join(' ').trim();
  const loose = [year, player, cardNumber ? `#${cardNumber}` : null, slab]
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

// --- parallel gate ---------------------------------------------------------
// A parallel is part of a card's IDENTITY, not a nice-to-have: "Row 0" and
// "Row 2" are different cards at wildly different prices, and a plain base
// card is not a "Members Only". Treating it as a soft 0.2 score component
// meant a Members-Only watch matched a base-card title at 0.80, and a
// "Row 0" watch matched a "Row 2" title at 0.90 (both live-observed).

// Plural-tolerant token presence ("Sticker" watch vs "Stickers" title).
const hasToken = (tokens, t) =>
  tokens.has(t) || tokens.has(`${t}s`) || (t.endsWith('s') && tokens.has(t.slice(0, -1)));

// What the parallel actually contributes beyond year/set/player, plus any
// "<word> <identifier>" pairs ("row 0", "sf 4") that a rival parallel can
// contradict. Exported for tests.
// Catalog vocabulary that never appears in a seller's title: "Base" is how
// the Ladder labels the plain version of a card, so a "Base /2000" parallel
// demanding the word "base" drops every real listing of that card.
const PARALLEL_STOPWORDS = new Set(['base']);

export function parallelEvidence(target) {
  const par = tokenize(target.parallel ?? '');
  if (par.length === 0) return { needed: [], pairs: [] };
  // Tokens the rest of the identity already supplies aren't evidence that
  // THIS parallel is present ("Stadium Club Members Only" -> club is not).
  const covered = new Set([target.year, target.setName, target.playerName].flatMap(tokenize));
  const needed = par.filter((t) => !covered.has(t) && !PARALLEL_STOPWORDS.has(t));
  const pairs = [];
  for (let i = 0; i < par.length - 1; i++) {
    if (/^[a-z]+$/.test(par[i]) && /^[a-z]?\d+[a-z]?$/.test(par[i + 1])) pairs.push([par[i], par[i + 1]]);
  }
  return { needed, pairs };
}

// Reasons this title fails the watch's parallel, if any.
//
// Strictness is CONDITIONAL on target.siblingParallels — the parallels of
// other catalog cards sharing this card's year+set+player+number:
//   * No siblings -> the parallel isn't discriminating, so absence proves
//     nothing. The 1993 SP Derek Jeter #279 is the only #279 Jeter; its
//     catalog label "Foil" is decorative and sellers never write it, so
//     demanding it would drop every real listing (live-measured: 79 of 445).
//   * Siblings exist -> the parallel is the ONLY thing separating four
//     different Stadium Club Jordan #1s, so it must actually appear, and a
//     sibling's distinctive words appearing instead means it's that card.
// A contradiction ("Row 0" watch, "Row 2" title) always fails, siblings or
// not — that's self-evidently a different card.
export function parallelFailures(target, titleTokenSet, titleSeq) {
  const { needed, pairs } = parallelEvidence(target);
  const out = [];

  for (const [word, id] of pairs) {
    for (let i = 0; i < titleSeq.length - 1; i++) {
      if (titleSeq[i] === word && /^[a-z]?\d+[a-z]?$/.test(titleSeq[i + 1]) && titleSeq[i + 1] !== id) {
        out.push(`parallel-conflict:${word} ${titleSeq[i + 1]} not ${id}`);
        break;
      }
    }
  }

  const siblings = target.siblingParallels ?? [];
  if (siblings.length === 0) return out; // not discriminating — stay lenient

  if (needed.length > 0 && !needed.some((t) => hasToken(titleTokenSet, t))) {
    out.push(`parallel:${needed.join(' ')}`);
  }

  // The reverse direction: a sibling's distinguishing words are all present
  // and this watch doesn't share them, so the title is the SIBLING's card.
  // This is what stops a base-card watch matching a "Members Only" listing.
  const mine = new Set(tokenize(target.parallel ?? ''));
  const covered = new Set([target.year, target.setName, target.playerName].flatMap(tokenize));
  for (const sp of siblings.filter(Boolean)) {
    const distinct = tokenize(sp).filter((t) => !mine.has(t) && !covered.has(t));
    if (distinct.length > 0 && distinct.every((t) => hasToken(titleTokenSet, t))) {
      out.push(`sibling-parallel:${sp}`);
      break;
    }
  }
  return out;
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
  // 1986 Fleer #1 Kareem exists as base AND Sticker — a base watch must not
  // score a Sticker listing at 100% (the Sticker watch names its parallel,
  // so it stays exempt via its own identity tokens).
  'sticker', 'stickers',
];

// Plural-insensitive exemption: a "Panini Stickers" watch must not be
// penalized for a "... Sticker ..." title (and vice versa). Live data has
// BOTH spellings as real set/parallel names, so exact-token matching
// silently pushed correct cards under the 50% visibility cutoff.
const variantExempt = (targetTokens, w) =>
  targetTokens.has(w) || targetTokens.has(`${w}s`) || (w.endsWith('s') && targetTokens.has(w.slice(0, -1)));

const variantWords = (titleTokens, targetTokens) =>
  VARIANT_WORDS.filter((w) => titleTokens.has(w) && !variantExempt(targetTokens, w));

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
    return {
      ok: true,
      score: Math.max(0, Math.min(1, score)),
      specificity: want.length,
      debug: { matched, missing, penalties },
    };
  }

  // -- catalog watch hard requirements
  if (target.year) {
    if (yearRegex(target.year).test(raw)) matched.push(`year:${target.year}`);
    else missing.push(`year:${target.year}`);
  }
  const { primary, aliases } = splitAliases(target.playerName ?? '');
  const nameTokens = tokenize(primary);
  const lastName = nameTokens[nameTokens.length - 1];
  if (lastName) {
    // The title may use either identity: "Abdul-Jabbar" or "Lew Alcindor".
    // ONLY multi-token aliases count as an alternate full name. Most
    // parentheticals in the Ladder catalog are mid-name NICKNAMES —
    // "Floyd (Babe) Herman", "Charles (Red) Dooin", "Frank (Home Run)
    // Baker" — and accepting "babe"/"red"/"run" as a surname let listings
    // for entirely different players clear the hard gate (a Babe Herman
    // watch matched Babe RUTH). "(Shoeless) Joe Jackson" still requires
    // "jackson"; "Kareem Abdul-Jabbar (Lew Alcindor)" still accepts
    // "alcindor".
    const aliasSurnames = aliases
      .map((a) => tokenize(a))
      .filter((t) => t.length >= 2)
      .map((t) => t[t.length - 1]);
    const surnames = [lastName, ...aliasSurnames];
    const hit = surnames.find((s) => tokens.has(s));
    if (hit) matched.push(`player:${hit}`);
    else missing.push(`player:${surnames.join('|')}`);
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
  // Parallel is identity, same as year/player/set — see parallelFailures.
  const parFails = parallelFailures(target, tokens, tokenize(raw));
  if (parFails.length > 0) missing.push(...parFails);
  else if (target.parallel) matched.push(`parallel:${target.parallel}`);
  if (missing.length > 0) {
    return { ok: false, score: 0, specificity: 0, debug: { matched, missing, penalties } };
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

  // How much of this title the watch's identity actually accounts for. Two
  // watches can both score 1.0 on the same listing when one's identity is a
  // strict SUBSET of the other's ("Members Only" vs "Beam Team Members
  // Only" — every token of the former appears in a Beam Team title). The
  // more specific watch explains more of the title, so it owns the listing.
  const specificity = [...identityTokens].filter((t) => tokens.has(t)).length;

  score = Math.max(0, Math.min(1, score));
  return { ok: true, score, specificity, debug: { matched, missing, penalties } };
}
