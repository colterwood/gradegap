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
export function buildQueries({ year, setName, playerName, cardNumber, parallel, company, grade }) {
  const slab = `${company} ${grade}`;
  const tight = [year, setName, playerName, parallel, slab].filter(Boolean).join(' ');
  const loose = [year, playerName, cardNumber ? `#${cardNumber}` : null, slab]
    .filter(Boolean)
    .join(' ');
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

// "PSA 10", "PSA10", "PSA-10", "PSA GEM MINT 10", "PSA GEM MT 10" all hit;
// "PSA 10.5"/"PSA 9" for a PSA-10 target do not (grade must match exactly).
export function slabRegex(company, grade) {
  const g = esc(String(grade));
  // No \b between company and grade: "PSA10" has no letter/digit boundary.
  return new RegExp(
    `\\b${esc(company)}[\\s:–-]*(?:gem\\s*(?:mint|mt)[\\s:–-]*)?${g}(?![\\d.])`,
    'i'
  );
}

// Every "GRADER n" mention in a title, for wrong-slab penalties.
const ANY_SLAB_RE = new RegExp(`\\b(${GRADERS.join('|')})[\\s:–-]*(\\d{1,2}(?:\\.5)?)(?![\\d.])`, 'gi');

// Words that mean "this is not the real slab you watched".
const BAD_WORDS = ['reprint', 'replica', 'custom', 'proxy', 'digital', 'novelty', 'lot', 'break'];

// --- scoring ---------------------------------------------------------------

// target: { playerName, year, setName, cardNumber, parallel, company, grade }
// Returns { ok, score, debug: { matched, missing, penalties } }.
// ok=false → hard requirement failed, listing must not be stored.
export function scoreListing(target, title) {
  const raw = String(title ?? '').toLowerCase();
  const tokens = new Set(tokenize(raw));
  const matched = [];
  const missing = [];
  const penalties = [];

  // -- hard requirements
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
  if (slabRegex(target.company, target.grade).test(raw)) {
    matched.push(`slab:${target.company} ${target.grade}`);
  } else {
    missing.push(`slab:${target.company} ${target.grade}`);
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
  for (const m of raw.matchAll(ANY_SLAB_RE)) {
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
  for (const w of BAD_WORDS) {
    if (tokens.has(w)) {
      score -= 0.4;
      penalties.push(`word:${w}`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  return { ok: true, score, debug: { matched, missing, penalties } };
}
