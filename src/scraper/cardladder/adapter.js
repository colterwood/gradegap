// Pure, heuristic parsers for Card Ladder payloads.
//
// ⚠️  Card Ladder's response shapes are unknown until the first discovery run
// against a real logged-in session. These parsers work structurally: they
// hunt through a payload for things that *look like* card lists or per-grade
// prices, handling the three most likely encodings (plain JSON from a custom
// API, Firestore REST documents, Algolia search hits). If they miss, the raw
// payload lands in captures/failures/ and the matching logic here is the only
// file that needs updating.
//
// Every parser returns { ok: true, data } or { ok: false, reason }.

const GRADERS = ['PSA', 'SGC', 'BGS', 'CGC', 'CSG'];

// --- generic helpers -------------------------------------------------------

// Firestore REST encodes values as {stringValue: "x"}, {integerValue: "1"}, …
export function decodeFirestoreValue(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFirestoreFields(v.mapValue.fields ?? {});
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeFirestoreValue);
  return v;
}

export function decodeFirestoreFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) out[k] = decodeFirestoreValue(val);
  return out;
}

// Yields every plausible "record object" in a payload, whatever the envelope:
// plain arrays, {hits}, {results}, {data}, Firestore {documents}/[{document}].
export function* iterateRecords(node, depth = 0) {
  if (node == null || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        if (item.document?.fields) {
          yield { record: decodeFirestoreFields(item.document.fields), docPath: item.document.name };
        } else if (item.fields && typeof item.name === 'string') {
          yield { record: decodeFirestoreFields(item.fields), docPath: item.name };
        } else {
          yield { record: item, docPath: null };
        }
        yield* iterateRecords(item, depth + 1);
      }
    }
    return;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) yield* iterateRecords(value, depth + 1);
  }
}

const firstKey = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

// --- cards -----------------------------------------------------------------

const CARD_ID_KEYS = ['cardId', 'card_id', 'id', 'objectID', 'uid', 'slug'];
const CARD_NAME_KEYS = ['name', 'cardName', 'title', 'displayName', 'description'];

function looksLikeCard(record) {
  const name = firstKey(record, CARD_NAME_KEYS);
  if (typeof name !== 'string' || name.length < 6) return false;
  // card names virtually always carry a year and a number or set word
  return /\b(19|20)\d{2}\b/.test(name);
}

export function parseCards({ json }, player) {
  const found = new Map();
  for (const { record, docPath } of iterateRecords(json)) {
    if (!looksLikeCard(record)) continue;
    const name = firstKey(record, CARD_NAME_KEYS);
    if (player?.name && !name.toLowerCase().includes(player.name.toLowerCase().split(' ').pop())) {
      continue; // require at least the player's last name in the card title
    }
    let id = firstKey(record, CARD_ID_KEYS);
    if (id === undefined && docPath) id = docPath.split('/').pop();
    if (id === undefined) continue;
    id = String(id);
    const yearMatch = name.match(/\b(19|20)\d{2}\b/);
    found.set(id, {
      clCardId: id,
      name,
      setName: firstKey(record, ['setName', 'set', 'set_name', 'brand']) ?? null,
      year: yearMatch ? Number(yearMatch[0]) : null,
      cardNumber: firstKey(record, ['cardNumber', 'card_number', 'number']) ?? null,
      parallel: firstKey(record, ['parallel', 'variation', 'variant']) ?? null,
      clUrl: `https://app.cardladder.com/card/${id}`,
      raw: record,
    });
  }
  if (found.size === 0) return { ok: false, reason: 'no card-shaped records found' };
  return { ok: true, data: [...found.values()] };
}

// --- prices ----------------------------------------------------------------

const GRADE_KEYS = ['grade', 'gradeNumber', 'grade_number', 'gradeLabel'];
const COMPANY_KEYS = ['company', 'grader', 'gradingCompany', 'grading_company', 'service'];
const CONDITION_KEYS = ['condition', 'conditionLabel', 'conditionName', 'gradeName', 'qualifier', 'label'];
const VALUE_KEYS = ['value', 'clValue', 'indexValue', 'currentValue', 'estimatedValue', 'avg', 'average'];
const SALE_PRICE_KEYS = ['lastSalePrice', 'lastSale', 'last_sale_price', 'price', 'salePrice', 'amount'];
const SALE_DATE_KEYS = ['lastSaleDate', 'last_sale_date', 'date', 'saleDate', 'soldDate', 'timestamp'];

// SGC's numeric 10 exists as both "10 Gem Mint" and the rarer, pricier
// "10 Pristine". We canonicalize SGC Pristine to grade '10 PRI' so the
// SGC-10-Gem-Mint vs PSA-10 comparison can never accidentally use a Pristine
// value. Only SGC gets this treatment: for BGS "Pristine" IS the standard 10
// label, and PSA 10 is always Gem Mint.
const PRISTINE_RE = /\bpri(?:stine)?\b/i;

function normalizeGrade(company, gradeRaw, contextText) {
  let text = String(gradeRaw).trim();
  const num = text.match(/[0-9]{1,2}(?:\.[05])?/);
  if (!num) return null;
  let grade = num[0];
  if (company === 'SGC' && grade === '10' && (PRISTINE_RE.test(text) || PRISTINE_RE.test(contextText))) {
    grade = '10 PRI';
  }
  return grade;
}

function extractCompanyGrade(record) {
  let company = firstKey(record, COMPANY_KEYS);
  let grade = firstKey(record, GRADE_KEYS);
  // condition/qualifier text that may carry "Gem Mint" / "Pristine"
  let contextText = [grade, firstKey(record, CONDITION_KEYS)]
    .filter((v) => typeof v === 'string')
    .join(' ');
  // combined labels like "PSA 10", "SGC 10 - Gem Mint", "SGC 10 Pristine"
  if (!company || grade === undefined) {
    for (const v of Object.values(record)) {
      if (typeof v !== 'string') continue;
      const m = v.match(new RegExp(`\\b(${GRADERS.join('|')})\\b[\\s-]*([0-9]{1,2}(?:\\.[05])?[a-zA-Z\\s-]*)`, 'i'));
      if (m) {
        company = company ?? m[1];
        grade = grade ?? m[2];
        contextText += ' ' + v;
        break;
      }
    }
  }
  if (!company || grade === undefined || grade === null) return null;
  company = String(company).toUpperCase().trim();
  if (!GRADERS.includes(company)) return null;
  const normalized = normalizeGrade(company, grade, contextText);
  if (normalized === null) return null;
  return { company, grade: normalized };
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

export function parsePrices({ json }) {
  const byKey = new Map();
  for (const { record } of iterateRecords(json)) {
    const cg = extractCompanyGrade(record);
    if (!cg) continue;
    const clValue = toNumber(firstKey(record, VALUE_KEYS));
    const lastSalePrice = toNumber(firstKey(record, SALE_PRICE_KEYS));
    const lastSaleDate = firstKey(record, SALE_DATE_KEYS) ?? null;
    if (clValue === null && lastSalePrice === null) continue;
    const key = `${cg.company}|${cg.grade}`;
    const prev = byKey.get(key) ?? {};
    byKey.set(key, {
      company: cg.company,
      grade: cg.grade,
      clValue: clValue ?? prev.clValue ?? null,
      lastSalePrice: lastSalePrice ?? prev.lastSalePrice ?? null,
      lastSaleDate: lastSaleDate ?? prev.lastSaleDate ?? null,
    });
  }
  if (byKey.size === 0) return { ok: false, reason: 'no grade-price-shaped records found' };
  return { ok: true, data: [...byKey.values()] };
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
  const tuple = [hit.year, hit.set, hit.player, hit.number, hit.variation]
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
