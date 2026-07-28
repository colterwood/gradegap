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
      q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10', clValue: sgc.v, lastSalePrice: sgc.s, lastSaleDate: '2026-07-01', syncRunId: null });
    }
    q.upsertGradePrice.run({ cardId, company: 'PSA', grade: '10', clValue: psa.v, lastSalePrice: psa.s, lastSaleDate: '2026-07-02', syncRunId: null });
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
  assert.equal(c1.sgc_price, 950);
  assert.equal(c1.psa_price, 5200);
});

test('direction filters work', () => {
  const { q } = seedDb();
  const sgcCheaper = q.resultsQuery({ ...base, direction: 'sgc_cheaper' });
  assert.deepEqual(sgcCheaper.rows.map((x) => x.name).sort(), [
    '1986 Fleer #57', '1987 Fleer #59', '1990 Skybox #41',
  ]);
  const psaCheaper = q.resultsQuery({ ...base, direction: 'psa_cheaper' });
  assert.deepEqual(psaCheaper.rows.map((x) => x.name), ['1989 Hoops #200']);
});

test('min price filter uses the higher of the two prices', () => {
  const { q } = seedDb();
  const r = q.resultsQuery({ ...base, minPrice: 200 });
  // c4 max(50,90)=90 < 200 -> filtered out, but NOT counted as missing-grade
  assert.equal(r.total, 3);
  assert.equal(r.excludedMissingGrade, 1);
});

test('SGC 10 Pristine rows never enter the Gem Mint comparison', () => {
  const { q } = seedDb();
  const cardId = q.getCardByClId.get('c1').id;
  // a Pristine 10 worth 20x the Gem Mint 10 — must not change the comparison
  q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10 PRI', clValue: 20000, lastSalePrice: 19500, lastSaleDate: '2026-07-01', syncRunId: null });
  const r = q.resultsQuery(base);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.sgc_price, 1000);
  assert.equal(c1.pct_diff, 400);
});

test('upsert replaces prices instead of duplicating', () => {
  const { q } = seedDb();
  const cardId = q.getCardByClId.get('c1').id;
  q.upsertGradePrice.run({ cardId, company: 'SGC', grade: '10', clValue: 1100, lastSalePrice: 1050, lastSaleDate: '2026-07-20', syncRunId: null });
  const r = q.resultsQuery(base);
  const c1 = r.rows.find((x) => x.name === '1986 Fleer #57');
  assert.equal(c1.sgc_price, 1100);
});
