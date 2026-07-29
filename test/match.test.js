import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQueries, scoreListing, yearRegex, slabRegex } from '../src/marketplace/match.js';

const luka = {
  playerName: 'Luka Doncic',
  year: 2018,
  setName: 'Prizm',
  cardNumber: '280',
  parallel: null,
  company: 'PSA',
  grade: '10',
};

const jordan = {
  playerName: 'Michael Jordan',
  year: 1986,
  setName: 'Fleer',
  cardNumber: '57',
  parallel: null,
  company: 'SGC',
  grade: '10',
};

test('buildQueries: tight carries set+slab, loose swaps in #number', () => {
  const q = buildQueries(luka);
  assert.equal(q.tight, '2018 Prizm Luka Doncic PSA 10');
  assert.equal(q.loose, '2018 Luka Doncic #280 PSA 10');
});

test('yearRegex accepts plain, full-season, and short-season formats', () => {
  const re = yearRegex(1986);
  for (const t of ['1986 Fleer', '1986-87 Fleer', '1986/87 Fleer', '86-87 Fleer']) {
    assert.ok(re.test(t), t);
  }
  assert.ok(!re.test('1987 Fleer'));
  assert.ok(!yearRegex(2018).test('2017-18 Prizm')); // previous season ≠ this card
});

test('slabRegex is tolerant of formatting but exact on grade', () => {
  const re = slabRegex('PSA', '10');
  for (const t of ['psa 10', 'PSA10', 'PSA-10', 'PSA GEM MINT 10', 'PSA GEM MT 10', 'psa: 10']) {
    assert.ok(re.test(t), t);
  }
  assert.ok(!re.test('PSA 9'));
  assert.ok(!re.test('PSA 10.5'));
  assert.ok(!re.test('BGS 10'));
});

test('slabRegex accepts word-label grades (Heritage style) but not arbitrary words', () => {
  // Real Heritage title forms
  assert.ok(slabRegex('PSA', '9').test('1986 Fleer Sticker Michael Jordan #8 PSA Mint 9.'));
  assert.ok(slabRegex('PSA', '8').test('2006 Fleer Michael Jordan #MJA-2 PSA NM-MT 8, PSA/DNA Auto 10'));
  assert.ok(slabRegex('PSA', '7').test('1986 Fleer Michael Jordan Rookie #57 PSA NM 7.'));
  assert.ok(slabRegex('PSA', '10').test('#57 PSA Gem Mint 10.'));
  // Arbitrary words between company and number must not bridge the gap
  assert.ok(!slabRegex('PSA', '9').test('PSA lot of 9 cards'));
  assert.ok(!slabRegex('PSA', '10').test('PSA graded set of 10'));
});

test('real-world-shaped title matches with a high score', () => {
  const r = scoreListing(luka, '2018-19 Panini Prizm Luka Doncic #280 Rookie RC PSA 10 GEM MINT');
  assert.equal(r.ok, true);
  assert.ok(r.score >= 0.9, `score ${r.score}`);
  assert.ok(r.debug.matched.some((m) => m.startsWith('slab:')));
});

test('hard requirements: wrong grader, wrong grade, wrong player, wrong year all discard', () => {
  const wrong = [
    '2018-19 Panini Prizm Luka Doncic #280 BGS 10',      // wrong grader
    '2018-19 Panini Prizm Luka Doncic #280 PSA 9',       // wrong grade
    '2018-19 Panini Prizm Trae Young #78 PSA 10',        // wrong player
    '2019-20 Panini Prizm Luka Doncic #75 PSA 10',       // wrong year
  ];
  for (const t of wrong) {
    assert.equal(scoreListing(luka, t).ok, false, t);
  }
});

test('missing set/number lowers score but keeps the listing (low-confidence)', () => {
  const r = scoreListing(jordan, '1986 Michael Jordan rookie SGC 10');
  assert.equal(r.ok, true);
  assert.ok(r.score < 0.5, `score ${r.score}`);
  assert.ok(r.debug.missing.some((m) => m.startsWith('set:')));
});

test('penalties: reprint and a second same-grader grade drag the score down', () => {
  const clean = scoreListing(jordan, '1986 Fleer Michael Jordan #57 SGC 10').score;
  const reprint = scoreListing(jordan, '1986 Fleer Michael Jordan #57 SGC 10 REPRINT');
  assert.ok(reprint.score < clean - 0.3);
  assert.ok(reprint.debug.penalties.includes('word:reprint'));

  const lot = scoreListing(jordan, '1986 Fleer Michael Jordan #57 SGC 10 + SGC 8 pair');
  assert.ok(lot.score < clean);
  assert.ok(lot.debug.penalties.some((p) => p.startsWith('slab:SGC 8')));
});

test('parallel tokens count when the watch has one', () => {
  const silver = { ...luka, parallel: 'Silver' };
  const withPar = scoreListing(silver, '2018-19 Panini Prizm Silver Luka Doncic #280 PSA 10');
  const withoutPar = scoreListing(silver, '2018-19 Panini Prizm Luka Doncic #280 PSA 10');
  assert.ok(withPar.score > withoutPar.score);
});
