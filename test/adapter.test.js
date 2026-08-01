import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLadderHit, parseLadderPage, ladderCardKey } from '../src/scraper/cardladder/adapter.js';

// A realistic cards-index hit (see endpoints.js) — identity + one grade's value.
const hit = (over = {}) => ({
  id: 'abc123',
  year: '1986',
  set: 'Fleer',
  player: 'Michael Jordan',
  number: '57',
  variation: null,
  condition: 'SGC 10',
  currentValue: 25000,
  marketValue: 24000,
  lastSoldDate: '2026-05-01',
  pop: 120,
  numSales: 14,
  ...over,
});

test('parseLadderHit: identity, grade, and values from a plain hit', () => {
  const r = parseLadderHit(hit());
  assert.equal(r.price.company, 'SGC');
  assert.equal(r.price.grade, '10');
  assert.equal(r.price.clValue, 25000);
  assert.equal(r.price.lastSalePrice, 24000);
  assert.equal(r.price.numSales, 14);
  assert.equal(r.card.name, '1986 Fleer Michael Jordan #57');
  assert.equal(r.card.clUrl, 'https://app.cardladder.com/card/abc123');
});

test('parseLadderHit: SGC 10 Pristine is canonicalized to 10 PRI, never plain 10', () => {
  const r = parseLadderHit(hit({ condition: 'SGC 10 Pristine' }));
  assert.equal(r.price.grade, '10 PRI');
  // The short "Pri" form too.
  assert.equal(parseLadderHit(hit({ condition: 'SGC 10 Pri' })).price.grade, '10 PRI');
});

test('parseLadderHit: BGS Black Label becomes 10 BL; BGS Pristine stays 10', () => {
  assert.equal(parseLadderHit(hit({ condition: 'BGS 10 Black Label' })).price.grade, '10 BL');
  // For BGS, "Pristine" IS the ordinary numeric-10 label.
  assert.equal(parseLadderHit(hit({ condition: 'BGS 10 Pristine' })).price.grade, '10');
});

test('parseLadderHit: separate gradingCompany field with a bare numeric condition', () => {
  const r = parseLadderHit(hit({ condition: '9', gradingCompany: 'PSA' }));
  assert.equal(r.price.company, 'PSA');
  assert.equal(r.price.grade, '9');
});

test('parseLadderHit: unusable hits return null', () => {
  assert.equal(parseLadderHit(null), null);
  assert.equal(parseLadderHit(hit({ condition: 'GEM MINT' })), null); // no grader
  assert.equal(parseLadderHit(hit({ currentValue: null, marketValue: null })), null); // no values
});

test('parseLadderHit: "Base" variation is not part of the name or parallel', () => {
  const r = parseLadderHit(hit({ variation: 'Base' }));
  assert.equal(r.card.parallel, null);
  assert.equal(r.card.name, '1986 Fleer Michael Jordan #57');
  const r2 = parseLadderHit(hit({ variation: 'Sticker' }));
  assert.equal(r2.card.parallel, 'Sticker');
});

test('ladderCardKey: psaSpecId wins; fallback tuple treats Base and null as the same card', () => {
  assert.equal(ladderCardKey(hit({ psaSpecId: 'spec-9' })), 'spec:spec-9');
  // Cross-grade rows are inconsistent about base labeling — the SGC row may
  // say 'Base' where the PSA row says null. Both must land on ONE card row
  // or the disparity JOIN never pairs them.
  assert.equal(ladderCardKey(hit({ variation: 'Base' })), ladderCardKey(hit({ variation: null })));
  assert.equal(ladderCardKey(hit({ variation: 'Base' })), ladderCardKey(hit({ variation: '' })));
  assert.notEqual(ladderCardKey(hit({ variation: 'Sticker' })), ladderCardKey(hit({ variation: null })));
});

test('parseLadderPage: parses hits, skips the unusable, reports totalHits', () => {
  const body = {
    hits: [hit(), hit({ condition: 'nonsense' }), hit({ id: 'z9', condition: 'PSA 10' })],
    totalHits: 250,
  };
  const r = parseLadderPage(body);
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 2);
  assert.equal(r.totalHits, 250);
  assert.deepEqual(parseLadderPage({}), { ok: false, reason: 'no hits array' });
});

test('parseLadderHit: sales count falls back to an embedded sales array length', () => {
  const noCount = hit({ numSales: undefined, sales: [{}, {}, {}] });
  assert.equal(parseLadderHit(noCount).price.numSales, 3);
});
