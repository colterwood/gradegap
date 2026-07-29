import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, syncPlayersFromConfig } from '../src/db/db.js';
import { makeQueries } from '../src/db/queries.js';

function seedDb() {
  const db = openDb(':memory:');
  syncPlayersFromConfig(db, [{ name: 'Michael Jordan', searchTerm: 'Michael Jordan' }]);
  const q = makeQueries(db);
  const playerId = q.getPlayerByName.get('Michael Jordan').id;

  const cards = [
    // [clCardId, name, sgc {value, sale}, psa {value, sale}]
    ['c1', '1986 Fleer #57', { v: 1000, s: 950 }, { v: 5000, s: 5200 }],   // big gap, SGC cheaper
    ['c2', '1987 Fleer #59', { v: 400, s: 380 }, { v: 500, s: 490 }],      // small gap
    ['c3', '1989 Hoops #200', { v: 300, s: 310 }, { v: 150, s: 140 }],     // PSA cheaper
    ['c4', '1990 Skybox #41', { v: 50, s: 45 }, { v: 90, s: null }],       // PSA no sale
    ['c5', '1991 UD #44', { v: null, s: null }, { v: 200, s: 210 }],       // SGC missing entirely
  ];

  for (const [clCardId, name, sgc, psa] of cards) {
    const info = q.upsertCard.run({
      playerId, clCardId, name,
      setName: null, year: null, cardNumber: null, parallel: null,
      clUrl: `https://app.cardladder.com/card/${clCardId}`, rawJson: null,
    });
    const cardId = q.getCardByClId.get(clCardId).id;
    if (sgc.v !== null || sgc.s !== null) {
      q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10', clValue: sgc.v, lastSalePrice: sgc.s, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
    }
    q.upsertGradePrice.run({ cardId, company: 'PSA', grade: '10', clValue: psa.v, lastSalePrice: psa.s, lastSaleDate: '2026-07-02', population: null, numSales: null, syncRunId: null });
  }
  return { db, q };
}

const base = { basis: 'cl_value', sort: 'pct', direction: 'all', minPrice: 0, playerId: null, limit: 100, offset: 0 };

test('cl_value basis, pct sort, both directions', () => {
  const { q } = seedDb();
  const r = q.resultsQuery(base);
  // c5 has no SGC row at all -> excluded as missing grade
  assert.equal(r.excludedMissingGrade, 1);
  assert.equal(r.total, 4);
  // pct diffs: c1 +400%, c2 +25%, c3 -50%, c4 +80% -> order by |pct|: c1, c4, c3, c2
  assert.deepEqual(r.rows.map((x) => x.name), [
    '1986 Fleer #57', '1990 Skybox #41', '1989 Hoops #200', '1987 Fleer #59',
  ]);
  assert.equal(r.rows[0].pct_diff, 400);
  assert.equal(r.rows[0].abs_diff, 4000);
});

test('abs sort ranks by dollar gap', () => {
  const { q } = seedDb();
  const r = q.resultsQuery({ ...base, sort: 'abs' });
  // abs diffs: c1 4000, c2 100, c3 -150, c4 40 -> c1, c3, c2, c4
  assert.deepEqual(r.rows.map((x) => x.name), [
    '1986 Fleer #57', '1989 Hoops #200', '1987 Fleer #59', '1990 Skybox #41',
  ]);
});

test('last_sale basis drops rows lacking a sale', () => {
  const { q } = seedDb();
  const r = q.resultsQuery({ ...base, basis: 'last_sale' });
  // c4 PSA has no last sale -> not comparable on this basis; c5 still missing
  assert.equal(r.excludedMissingGrade, 2);
  assert.equal(r.total, 3);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.grader_price, 950);
  assert.equal(c1.psa_price, 5200);
});

test('direction filters work', () => {
  const { q } = seedDb();
  const sgcCheaper = q.resultsQuery({ ...base, direction: 'grader_cheaper' });
  assert.deepEqual(sgcCheaper.rows.map((x) => x.name).sort(), [
    '1986 Fleer #57', '1987 Fleer #59', '1990 Skybox #41',
  ]);
  const psaCheaper = q.resultsQuery({ ...base, direction: 'psa_cheaper' });
  assert.deepEqual(psaCheaper.rows.map((x) => x.name), ['1989 Hoops #200']);
});

test('min price filter uses the grader price, not the higher of the two', () => {
  const { q } = seedDb();
  // c2 is SGC 400 / PSA 500. At minPrice 450 an SGC-based filter drops it,
  // whereas a max-of-both filter would keep it (PSA 500). Only c1 (SGC 1000)
  // clears the bar.
  const r = q.resultsQuery({ ...base, minPrice: 450 });
  assert.deepEqual(r.rows.map((x) => x.name), ['1986 Fleer #57']);
  assert.equal(r.total, 1);
  assert.equal(r.excludedMissingGrade, 1); // c5 still missing a grade
});

test('SGC 10 Pristine rows never enter the Gem Mint comparison', () => {
  const { q } = seedDb();
  const cardId = q.getCardByClId.get('c1').id;
  // a Pristine 10 worth 20x the Gem Mint 10 — must not change the comparison
  q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10 PRI', clValue: 20000, lastSalePrice: 19500, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
  const r = q.resultsQuery(base);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.grader_price, 1000);
  assert.equal(c1.pct_diff, 400);
});

test('default results carry a grade column of 10', () => {
  const { q } = seedDb();
  const r = q.resultsQuery(base);
  assert.ok(r.rows.every((x) => x.grade === '10'));
});

// Seed a distinct SGC 9 / PSA 9 pair on top of the grade-10 fixture.
function seedWithNines() {
  const { db, q } = seedDb();
  const cardId = q.getCardByClId.get('c1').id; // 1986 Fleer #57
  q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '9', clValue: 400, lastSalePrice: 380, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
  q.upsertGradePrice.run({ cardId, company: 'PSA', grade: '9', clValue: 900, lastSalePrice: 880, lastSaleDate: '2026-07-02', population: null, numSales: null, syncRunId: null });
  // c2 gets an SGC 9 but NO PSA 9 — must never pair against c2's PSA 10.
  const c2 = q.getCardByClId.get('c2').id;
  q.upsertGradePrice.run({ cardId: c2, company: 'SGC', grade: '9', clValue: 100, lastSalePrice: 95, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
  return { db, q };
}

test('grade 9 is compared only against grade 9, never crossed with 10', () => {
  const { q } = seedWithNines();
  const r = q.resultsQuery({ ...base, grades: ['9'] });
  // Only c1 has a full SGC9/PSA9 pair. c2 has SGC9 but no PSA9 -> excluded.
  assert.deepEqual(r.rows.map((x) => x.name), ['1986 Fleer #57']);
  assert.equal(r.rows[0].grade, '9');
  assert.equal(r.rows[0].grader_price, 400);
  assert.equal(r.rows[0].psa_price, 900); // the PSA 9, not the PSA 10 (5000)
});

test('both grades checked = union of the two comparisons (a card can appear per grade)', () => {
  const { q } = seedWithNines();
  const r = q.resultsQuery({ ...base, grades: ['10', '9'] });
  const c1Rows = r.rows.filter((x) => x.name === '1986 Fleer #57');
  assert.equal(c1Rows.length, 2);
  assert.deepEqual(c1Rows.map((x) => x.grade).sort(), ['10', '9']);
  // grade 10 keeps its own prices; grade 9 keeps its own.
  assert.equal(c1Rows.find((x) => x.grade === '10').psa_price, 5000);
  assert.equal(c1Rows.find((x) => x.grade === '9').psa_price, 900);
});

test('no grade selected yields an empty result set', () => {
  const { q } = seedWithNines();
  const r = q.resultsQuery({ ...base, grades: [] });
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
});

test('minDiff filters on the absolute dollar gap', () => {
  const { q } = seedDb();
  // abs diffs (cl_value): c1 4000, c2 100, c3 -150, c4 40.
  // minDiff 200 keeps only |gap| >= 200: c1 (4000) — c3 is 150, dropped.
  const r = q.resultsQuery({ ...base, minDiff: 200 });
  assert.deepEqual(r.rows.map((x) => x.name), ['1986 Fleer #57']);
  assert.equal(r.total, 1);
});

test('upsert replaces prices instead of duplicating', () => {
  const { q } = seedDb();
  const cardId = q.getCardByClId.get('c1').id;
  q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10', clValue: 1100, lastSalePrice: 1050, lastSaleDate: '2026-07-20', population: null, numSales: null, syncRunId: null });
  const r = q.resultsQuery(base);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.grader_price, 1100);
});

// Seed BGS rows on top of the SGC/PSA grade-10 fixture: c1 gets a BGS 10,
// c3 gets a BGS 10 too, c2 does NOT (so it must drop out under grader BGS).
function seedWithBgs() {
  const { db, q } = seedDb();
  const c1 = q.getCardByClId.get('c1').id;
  q.upsertGradePrice.run({ cardId: c1, company: 'BGS', grade: '10', clValue: 2000, lastSalePrice: 1900, lastSaleDate: '2026-07-03', population: null, numSales: null, syncRunId: null });
  const c3 = q.getCardByClId.get('c3').id;
  q.upsertGradePrice.run({ cardId: c3, company: 'BGS', grade: '10', clValue: 120, lastSalePrice: 118, lastSaleDate: '2026-07-04', population: null, numSales: null, syncRunId: null });
  return { db, q };
}

test('grader BGS compares BGS vs PSA and ignores SGC rows', () => {
  const { q } = seedWithBgs();
  const r = q.resultsQuery({ ...base, graders: ['BGS'] });
  // Only c1 and c3 have BGS 10 rows; c2/c4 (SGC-only) drop out.
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['1986 Fleer #57', '1989 Hoops #200']);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.grader, 'BGS');
  assert.equal(c1.grader_price, 2000); // the BGS value, not SGC's 1000
  assert.equal(c1.psa_price, 5000);
  assert.equal(c1.pct_diff, 150);
});

test('multiple graders at once: each produces its own tagged rows', () => {
  const { q } = seedWithBgs();
  const r = q.resultsQuery({ ...base, graders: ['SGC', 'BGS'] });
  const c1 = r.rows.filter((x) => x.name === '1986 Fleer #57');
  assert.deepEqual(c1.map((x) => [x.grader, x.grader_price]).sort(), [['BGS', 2000], ['SGC', 1000]]);
});

test('graders defaults to the first configured grader; unknown graders are dropped', () => {
  const { q } = seedWithBgs();
  const byDefault = q.resultsQuery(base);
  assert.ok(byDefault.rows.length > 0);
  assert.ok(byDefault.rows.every((x) => x.grader === 'SGC'));
  assert.equal(byDefault.rows.find((x) => x.name === '1986 Fleer #57').grader_price, 1000); // SGC value
  // Injection-shaped grader names are dropped entirely -> empty result, no SQL reaches them.
  const bogus = q.resultsQuery({ ...base, graders: ['CGC; DROP TABLE cards'] });
  assert.deepEqual(bogus.rows, []);
  assert.equal(bogus.total, 0);
});

test('minPctDiff filters on the absolute percentage gap', () => {
  const { q } = seedDb();
  // pct diffs: c1 +400%, c2 +25%, c3 -50%, c4 +80%. minPctDiff 60 keeps |pct| >= 60.
  const r = q.resultsQuery({ ...base, minPctDiff: 60 });
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['1986 Fleer #57', '1990 Skybox #41']);
});

test('grades 8 and 7 pair like-for-like', () => {
  const { q } = seedDb();
  const c1 = q.getCardByClId.get('c1').id;
  q.upsertGradePrice.run({ cardId: c1, company: 'SGC', grade: '8', clValue: 200, lastSalePrice: 190, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
  q.upsertGradePrice.run({ cardId: c1, company: 'PSA', grade: '8', clValue: 500, lastSalePrice: 480, lastSaleDate: '2026-07-02', population: null, numSales: null, syncRunId: null });
  q.upsertGradePrice.run({ cardId: c1, company: 'SGC', grade: '7', clValue: 100, lastSalePrice: 95, lastSaleDate: '2026-07-01', population: null, numSales: null, syncRunId: null });
  // no PSA 7 -> the 7 comparison must produce nothing.
  const r8 = q.resultsQuery({ ...base, grades: ['8'] });
  assert.deepEqual(r8.rows.map((x) => [x.name, x.grade, x.grader_price, x.psa_price]), [['1986 Fleer #57', '8', 200, 500]]);
  const r7 = q.resultsQuery({ ...base, grades: ['7'] });
  assert.equal(r7.total, 0);
  assert.deepEqual(r7.missingGrades, ['SGC 7']); // PSA side has no 7s at all
});
