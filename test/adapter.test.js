import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, parsePrices, decodeFirestoreFields } from '../src/scraper/cardladder/adapter.js';

const player = { name: 'Michael Jordan' };

test('parseCards: plain JSON API shape', () => {
  const json = {
    results: [
      { id: 'abc123', name: '1986 Fleer Michael Jordan #57', set: 'Fleer', number: '57' },
      { id: 'def456', name: '1989 Hoops Michael Jordan #200' },
      { id: 'zzz', name: 'not a card' },
      { id: 'other', name: '1986 Fleer Larry Bird #9' },
    ],
  };
  const r = parseCards({ json }, player);
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 2);
  const c = r.data.find((x) => x.clCardId === 'abc123');
  assert.equal(c.year, 1986);
  assert.equal(c.setName, 'Fleer');
  assert.equal(c.clUrl, 'https://app.cardladder.com/card/abc123');
});

test('parseCards: Algolia hits shape', () => {
  const json = {
    hits: [
      { objectID: 'algolia-1', name: '1997 Metal Universe Michael Jordan #23' },
    ],
    nbHits: 1,
  };
  const r = parseCards({ json }, player);
  assert.equal(r.ok, true);
  assert.equal(r.data[0].clCardId, 'algolia-1');
});

test('parseCards: Firestore runQuery shape', () => {
  const json = [
    {
      document: {
        name: 'projects/cl/databases/(default)/documents/cards/fs-card-1',
        fields: {
          name: { stringValue: '1993 Topps Finest Michael Jordan #1' },
          setName: { stringValue: 'Topps Finest' },
          year: { integerValue: '1993' },
        },
      },
    },
  ];
  const r = parseCards({ json }, player);
  assert.equal(r.ok, true);
  assert.equal(r.data[0].clCardId, 'fs-card-1');
  assert.equal(r.data[0].setName, 'Topps Finest');
});

test('parseCards: rejects payloads without cards', () => {
  const r = parseCards({ json: { user: { plan: 'pro' }, notifications: [] } }, player);
  assert.equal(r.ok, false);
});

test('parsePrices: explicit company/grade fields', () => {
  const json = {
    prices: [
      { company: 'PSA', grade: 10, value: 5000, lastSalePrice: 5200, lastSaleDate: '2026-07-01' },
      { company: 'SGC', grade: 10, value: 1000 },
      { company: 'PSA', grade: 9, value: 800, price: 790 },
    ],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 3);
  const psa10 = r.data.find((p) => p.company === 'PSA' && p.grade === '10');
  assert.equal(psa10.clValue, 5000);
  assert.equal(psa10.lastSalePrice, 5200);
  const sgc10 = r.data.find((p) => p.company === 'SGC' && p.grade === '10');
  assert.equal(sgc10.lastSalePrice, null);
});

test('parsePrices: combined "PSA 10" label + string dollars', () => {
  const json = {
    grades: [
      { label: 'PSA 10', value: '$5,000', lastSale: '$4,900' },
      { label: 'SGC 10', value: '$1,200' },
      { label: 'Raw', value: '$300' },
    ],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 2);
  assert.equal(r.data[0].clValue, 5000);
  assert.equal(r.data[0].lastSalePrice, 4900);
});

test('parsePrices: Firestore document shape', () => {
  const json = {
    documents: [
      {
        name: 'projects/cl/databases/(default)/documents/prices/p1',
        fields: {
          grader: { stringValue: 'SGC' },
          grade: { stringValue: '10' },
          indexValue: { doubleValue: 1450.5 },
        },
      },
    ],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data[0].company, 'SGC');
  assert.equal(r.data[0].clValue, 1450.5);
});

test('parsePrices: merges value and sale from separate records', () => {
  const json = {
    summary: [{ company: 'PSA', grade: '10', currentValue: 900 }],
    sales: [{ company: 'PSA', grade: '10', price: 875, date: '2026-07-16' }],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].clValue, 900);
  assert.equal(r.data[0].lastSalePrice, 875);
  assert.equal(r.data[0].lastSaleDate, '2026-07-16');
});

test('parsePrices: SGC Gem Mint vs Pristine are distinct grades', () => {
  const json = {
    conditions: [
      { label: 'SGC 10 - Gem Mint', value: 24500 },
      { label: 'SGC 10 Pristine', value: 120000 },
      { label: 'SGC 10 PRI', lastSale: 118000 },
      { label: 'PSA 10 - Gem Mint', value: 175000 },
    ],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  const gm = r.data.find((p) => p.company === 'SGC' && p.grade === '10');
  const pri = r.data.find((p) => p.company === 'SGC' && p.grade === '10 PRI');
  const psa = r.data.find((p) => p.company === 'PSA' && p.grade === '10');
  assert.equal(gm.clValue, 24500);
  assert.equal(pri.clValue, 120000);
  assert.equal(pri.lastSalePrice, 118000);
  assert.equal(psa.clValue, 175000);
});

test('parsePrices: pristine in a separate condition field', () => {
  const json = {
    rows: [
      { company: 'SGC', grade: 10, condition: 'Pristine', value: 90000 },
      { company: 'SGC', grade: 10, condition: 'Gem Mint', value: 20000 },
    ],
  };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data.find((p) => p.grade === '10 PRI').clValue, 90000);
  assert.equal(r.data.find((p) => p.grade === '10').clValue, 20000);
});

test('parsePrices: BGS Pristine stays grade 10 (Pristine IS the BGS 10 label)', () => {
  const json = { rows: [{ label: 'BGS 10 Pristine', value: 5000 }] };
  const r = parsePrices({ json });
  assert.equal(r.ok, true);
  assert.equal(r.data[0].company, 'BGS');
  assert.equal(r.data[0].grade, '10');
});

test('decodeFirestoreFields handles nested maps and arrays', () => {
  const out = decodeFirestoreFields({
    tags: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
    meta: { mapValue: { fields: { n: { integerValue: '3' } } } },
  });
  assert.deepEqual(out, { tags: ['a', 'b'], meta: { n: 3 } });
});
