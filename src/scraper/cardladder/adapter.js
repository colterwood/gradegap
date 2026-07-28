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
const VALUE_KEYS = ['value', 'clValue', 'indexValue', 'currentValue', 'estimatedValue', 'avg', 'average'];
const SALE_PRICE_KEYS = ['lastSalePrice', 'lastSale', 'last_sale_price', 'price', 'salePrice', 'amount'];
const SALE_DATE_KEYS = ['lastSaleDate', 'last_sale_date', 'date', 'saleDate', 'soldDate', 'timestamp'];

function extractCompanyGrade(record) {
  let company = firstKey(record, COMPANY_KEYS);
  let grade = firstKey(record, GRADE_KEYS);
  // combined labels like "PSA 10" / "SGC10" in any string field
  if (!company || grade === undefined) {
    for (const v of Object.values(record)) {
      if (typeof v !== 'string') continue;
      const m = v.match(new RegExp(`^(${GRADERS.join('|')})\\s*([0-9.]+)$`, 'i'));
      if (m) {
        company = company ?? m[1];
        grade = grade ?? m[2];
        break;
      }
    }
  }
  if (!company || grade === undefined) return null;
  company = String(company).toUpperCase().trim();
  if (!GRADERS.includes(company)) return null;
  return { company, grade: String(grade).trim() };
}

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

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
