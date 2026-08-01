// Pure parsers for Card Ladder's confirmed bulk endpoint
// (search.cardladder.com, see endpoints.js): one hit carries card identity
// AND a per-grade value, so a paginated crawl per condition yields
// everything. The discovery-era heuristic pipeline (Firestore decoding,
// structural card/price hunting) was deleted once this endpoint was
// confirmed — see git history if a per-card fallback is ever needed.

const GRADERS = ['PSA', 'SGC', 'BGS', 'CGC', 'CSG'];

// SGC's numeric 10 exists as both "10 Gem Mint" and the rarer, pricier
// "10 Pristine", and CGC's does too — the Ladder serves "CGC 10 Pristine"
// as its own condition (212 rows, live-checked 2026-08-01). Canonicalize
// both to grade '10 PRI' so a Pristine value can never be used as the
// plain Gem-Mint-10 price in a comparison. NOT for BGS, where "Pristine"
// IS the standard 10 label, nor PSA, whose 10 is always Gem Mint.
const PRISTINE_COMPANIES = new Set(['SGC', 'CGC']);
const PRISTINE_RE = /\bpri(?:stine)?\b/i;
// BGS's numeric 10 likewise has a rarer, far pricier tier: "Black Label"
// (all subgrades 10). Canonicalize it to '10 BL' so such a row can never
// overwrite the standard BGS 10 value. (For BGS, plain "Pristine" IS the
// ordinary 10 label, so only Black Label needs this treatment.)
const BLACK_LABEL_RE = /\bblack\s*label\b/i;

function normalizeGrade(company, gradeRaw, contextText) {
  let text = String(gradeRaw).trim();
  const num = text.match(/[0-9]{1,2}(?:\.[05])?/);
  if (!num) return null;
  let grade = num[0];
  if (PRISTINE_COMPANIES.has(company) && grade === '10' && (PRISTINE_RE.test(text) || PRISTINE_RE.test(contextText))) {
    grade = '10 PRI';
  }
  if (company === 'BGS' && grade === '10' && (BLACK_LABEL_RE.test(text) || BLACK_LABEL_RE.test(contextText))) {
    grade = '10 BL';
  }
  return grade;
}

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// The Ladder's "Number of Sales" count. Its exact key on a search hit isn't
// pinned down, so try the likely spellings (and fall back to the length of an
// embedded sales array) rather than assuming a single field name.
const SALES_COUNT_KEYS = [
  'numSales', 'numberOfSales', 'salesCount', 'saleCount', 'totalSales',
  'salesTotal', 'numSalesTotal', 'numberSales', 'saleQty', 'salesQty',
  'transactionCount', 'numTransactions', 'tradeCount', 'salesVolume',
];

function extractSalesCount(hit) {
  for (const k of SALES_COUNT_KEYS) {
    const v = hit[k];
    if (v === undefined || v === null || v === '') continue;
    const n = toNumber(v);
    if (n !== null) return n;
  }
  // Some shapes carry the individual sales as an array; its length is the count.
  for (const k of ['sales', 'saleHistory', 'salesHistory', 'transactions']) {
    if (Array.isArray(hit[k])) return hit[k].length;
  }
  return null;
}

// --- the Ladder (search.cardladder.com bulk list) --------------------------
// A hit from index=cards carries both card identity AND a per-grade value, so
// one paginated crawl per condition yields everything with no per-card visits.

// psaSpecId is Card Ladder's canonical card identity — the SAME value appears
// on a card's SGC and PSA rows — so it's the join key between the two grade
// passes. Fall back to a normalized identity tuple when it's absent.
export function ladderCardKey(hit) {
  if (hit.psaSpecId !== undefined && hit.psaSpecId !== null && hit.psaSpecId !== '') {
    return `spec:${hit.psaSpecId}`;
  }
  // Variation is normalized the same way parseLadderHit treats it: 'Base'
  // and a missing variation are the SAME card. Cross-grade rows are
  // inconsistent about base labeling (SGC row 'Base', PSA row null), and
  // keying them apart silently dropped the card from the comparison.
  const v = String(hit.variation ?? '').trim().toLowerCase();
  const tuple = [hit.year, hit.set, hit.player, hit.number, v === 'base' ? '' : v]
    .map((x) => String(x ?? '').trim().toLowerCase())
    .join('|');
  return `id:${tuple}`;
}

// Parse a condition string like "SGC 10" / "PSA 10" / "SGC 10 Pristine".
function parseCondition(condition, gradingCompany) {
  let company;
  let gradeRaw;
  const m = String(condition ?? '').match(new RegExp(`\\b(${GRADERS.join('|')})\\b[\\s-]*([0-9]{1,2}(?:\\.[05])?[a-zA-Z\\s-]*)`, 'i'));
  if (m) {
    company = m[1];
    gradeRaw = m[2];
  } else if (gradingCompany) {
    company = gradingCompany;
    gradeRaw = String(condition ?? '').replace(/[^0-9.]/g, '');
  }
  if (!company || gradeRaw === undefined || gradeRaw === '') return null;
  company = company.toUpperCase().trim();
  if (!GRADERS.includes(company)) return null;
  const grade = normalizeGrade(company, gradeRaw, condition ?? '');
  return grade === null ? null : { company, grade };
}

// Turn one Ladder hit into { cardKey, card, price } or null if unusable.
export function parseLadderHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const cg = parseCondition(hit.condition, hit.gradingCompany);
  if (!cg) return null;

  const variation = hit.variation && String(hit.variation).toLowerCase() !== 'base' ? hit.variation : null;
  const name = [
    hit.year,
    hit.set,
    hit.player,
    variation,
    hit.number != null && hit.number !== '' ? `#${hit.number}` : null,
  ].filter(Boolean).join(' ').trim() || (hit.label ? String(hit.label).replace(/\s+(SGC|PSA|BGS|CGC|CSG)\s+[0-9.].*$/i, '').trim() : null);

  const clValue = toNumber(hit.currentValue);
  const lastSalePrice = toNumber(hit.marketValue);
  if (clValue === null && lastSalePrice === null) return null;

  return {
    cardKey: ladderCardKey(hit),
    card: {
      name: name || cg.company + ' card',
      player: hit.player ?? null,
      setName: hit.set ?? null,
      year: hit.year ? parseInt(hit.year, 10) || null : null,
      cardNumber: hit.number != null ? String(hit.number) : null,
      parallel: variation,
      clUrl: hit.id
        ? `https://app.cardladder.com/card/${hit.id}`
        : (hit.slug ? `https://app.cardladder.com/card/${hit.slug}` : null),
    },
    price: {
      company: cg.company,
      grade: cg.grade,
      clValue,
      lastSalePrice,
      lastSaleDate: hit.lastSoldDate ?? null,
      population: hit.pop != null ? toNumber(hit.pop) : null,
      numSales: extractSalesCount(hit),
    },
  };
}

// Parse a whole { hits, totalHits } page. Returns { ok, cards:[{cardKey,card,price}], totalHits }.
export function parseLadderPage(body) {
  if (!body || !Array.isArray(body.hits)) return { ok: false, reason: 'no hits array' };
  const cards = [];
  for (const hit of body.hits) {
    const parsed = parseLadderHit(hit);
    if (parsed) cards.push(parsed);
  }
  return { ok: true, cards, totalHits: Number(body.totalHits ?? cards.length) };
}
