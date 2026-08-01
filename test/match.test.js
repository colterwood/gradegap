import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueries,
  scoreListing,
  splitAliases,
  yearRegex,
  slabRegex,
  slabMatcher,
  isUngraded,
} from '../src/marketplace/match.js';

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

test('a title with NONE of the set tokens is discarded (wrong-set false positives)', () => {
  // Live failure mode: "1997 Kobe SGC 9" matched every 1997 Kobe SGC 9 on
  // COMC regardless of set. Set-token presence is now a hard requirement.
  const r = scoreListing(jordan, '1986 Michael Jordan rookie SGC 10');
  assert.equal(r.ok, false);
  assert.ok(r.debug.missing.some((m) => m.startsWith('set:')));

  const wrongSet = scoreListing(
    { ...luka, setName: 'Prizm' },
    '2018-19 Panini Select Luka Doncic #25 PSA 10'
  );
  assert.equal(wrongSet.ok, false);
});

test('partial set match passes the gate but lowers the score', () => {
  const target = { ...luka, setName: 'Panini Prizm' };
  const partial = scoreListing(target, '2018-19 Prizm Luka Doncic #280 PSA 10');
  assert.equal(partial.ok, true);
  const full = scoreListing(target, '2018-19 Panini Prizm Luka Doncic #280 PSA 10');
  assert.ok(full.score > partial.score);
});

test('plural junk words still trip the penalty (Fleer Reprints at 69% was the bug)', () => {
  const r = scoreListing(jordan, '1997-00 23KT Gold Card Fleer Reprints Michael Jordan 1986-87 SGC 10');
  assert.equal(r.ok, true); // fleer matches the set gate
  assert.ok(r.debug.penalties.includes('word:reprint'));
  assert.ok(r.score < 0.5, `score ${r.score}`);
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

test('variant words in the title but not the watch drag the score down', () => {
  // A base-card watch must not 100%-match a parallel of the same card.
  const base = scoreListing(luka, '2018-19 Panini Prizm Luka Doncic #280 PSA 10');
  const refractor = scoreListing(luka, '2018-19 Panini Prizm Luka Doncic #280 Silver PSA 10');
  assert.ok(base.score >= 0.9);
  assert.ok(refractor.score <= base.score - 0.3, `score ${refractor.score}`);
  assert.ok(refractor.debug.penalties.includes('variant:silver'));

  // A watch that itself names the parallel is exempt from the penalty.
  const silverWatch = { ...luka, parallel: 'Silver' };
  const exact = scoreListing(silverWatch, '2018-19 Panini Prizm Luka Doncic #280 Silver PSA 10');
  assert.ok(exact.debug.penalties.length === 0);
  assert.ok(exact.score >= 0.9);
});

test('manual watch: "vs" battle cards and parallels are penalized too', () => {
  const galactus = { description: '1990 Marvel Galactus', company: 'PSA', grade: '10' };
  const vs = scoreListing(galactus, '1990 Marvel Fantastic Four vs Galactus PSA 10');
  assert.equal(vs.ok, true);
  assert.ok(vs.score <= 0.65, `score ${vs.score}`);
  assert.ok(vs.debug.penalties.includes('variant:vs'));

  // A description that contains "vs" itself is exempt.
  const battle = { description: 'Fantastic Four vs Galactus', company: 'PSA', grade: '10' };
  const hit = scoreListing(battle, '1990 Marvel Fantastic Four vs Galactus PSA 10');
  assert.equal(hit.score, 1);

  const brady = { description: '2000 Bowman Chrome Tom Brady', company: 'PSA', grade: '10' };
  const refr = scoreListing(brady, '2000 Bowman Chrome Tom Brady Refractor PSA 10');
  assert.ok(refr.score <= 0.65, `score ${refr.score}`);
  assert.ok(refr.debug.penalties.includes('variant:refractor'));
});

test('parallel tokens count when the watch has one', () => {
  const silver = { ...luka, parallel: 'Silver' };
  const withPar = scoreListing(silver, '2018-19 Panini Prizm Silver Luka Doncic #280 PSA 10');
  const withoutPar = scoreListing(silver, '2018-19 Panini Prizm Luka Doncic #280 PSA 10');
  assert.ok(withPar.score > withoutPar.score);
});

// --- parenthetical aliases (the live Kareem miss) ---------------------------

const kareem = {
  playerName: 'Kareem Abdul-Jabbar (Lew Alcindor)',
  year: 1986,
  setName: 'Fleer',
  cardNumber: '1',
  parallel: null,
  company: 'BGS',
  grade: '9',
};

test('splitAliases: parentheticals become aliases, wherever they sit', () => {
  assert.deepEqual(splitAliases('Kareem Abdul-Jabbar (Lew Alcindor)'), {
    primary: 'Kareem Abdul-Jabbar',
    aliases: ['Lew Alcindor'],
  });
  assert.deepEqual(splitAliases('(Shoeless) Joe Jackson'), {
    primary: 'Joe Jackson',
    aliases: ['Shoeless'],
  });
  assert.deepEqual(splitAliases('Michael Jordan'), { primary: 'Michael Jordan', aliases: [] });
});

test('queries carry the primary name only — an alias in the query zeroes eBay results', () => {
  // Live-verified 2026-07-31: the query WITH "(Lew Alcindor)" returned 0
  // listings; without it, the exact card the user found by hand came back.
  const q = buildQueries(kareem);
  assert.equal(q.tight, '1986 Fleer Kareem Abdul-Jabbar BGS 9');
  assert.equal(q.loose, '1986 Kareem Abdul-Jabbar #1 BGS 9');
});

test('player gate accepts the primary surname OR an alias surname', () => {
  // The real listing the old gate hard-dropped (required "alcindor"):
  const jabbar = scoreListing(kareem, '1986-87 Fleer - Kareem Abdul-Jabbar #1 BGS 9 True 9');
  assert.equal(jabbar.ok, true);
  assert.ok(jabbar.score >= 0.8, `score ${jabbar.score}`);

  // A vintage-style title using the alias identity still matches.
  const alcindor = scoreListing(kareem, '1986 Fleer Lew Alcindor #1 BGS 9');
  assert.equal(alcindor.ok, true);

  // Neither identity present -> still a hard drop.
  assert.equal(scoreListing(kareem, '1986 Fleer Magic Johnson #53 BGS 9').ok, false);
});

test('a base watch does not score the Sticker parallel at 100%', () => {
  // 1986 Fleer #1 Kareem exists as base AND Sticker; the user watches both.
  const sticker = scoreListing(kareem, '1986 Fleer Sticker Basketball #1 Kareem Abdul-Jabbar BGS 9');
  assert.equal(sticker.ok, true);
  assert.ok(sticker.score <= 0.7, `score ${sticker.score}`);
  assert.ok(sticker.debug.penalties.includes('variant:sticker'));

  // The Sticker watch itself names the parallel -> exempt, full marks.
  const stickerWatch = { ...kareem, parallel: 'Sticker' };
  const exact = scoreListing(stickerWatch, '1986 Fleer Sticker Basketball #1 Kareem Abdul-Jabbar BGS 9');
  assert.ok(exact.debug.penalties.length === 0);
  assert.ok(exact.score >= 0.9, `score ${exact.score}`);
});

test('nicknames in parentheses are NOT accepted as a surname', () => {
  // Live catalog is full of mid-name nicknames — "Floyd (Babe) Herman",
  // "Charles (Red) Dooin". Treating the nickname as an alternate surname
  // let a Babe HERMAN watch match a Babe RUTH listing.
  const herman = {
    playerName: 'Floyd (Babe) Herman', year: 1933, setName: 'Goudey',
    cardNumber: null, parallel: null, company: 'PSA', grade: '3',
  };
  assert.equal(scoreListing(herman, '1933 Goudey Babe Ruth #144 PSA 3').ok, false);
  assert.equal(scoreListing(herman, '1933 Goudey Babe Herman #5 PSA 3').ok, true);

  // Multi-token aliases ARE alternate full names and still count.
  assert.equal(scoreListing(kareem, '1986 Fleer Lew Alcindor #1 BGS 9').ok, true);
  // "(Shoeless) Joe Jackson" must still require the real surname.
  const jackson = {
    playerName: '(Shoeless) Joe Jackson', year: 1915, setName: 'Cracker Jack',
    cardNumber: null, parallel: null, company: 'PSA', grade: '2',
  };
  assert.equal(scoreListing(jackson, '1915 Cracker Jack Shoeless Ty Cobb PSA 2').ok, false);
  assert.equal(scoreListing(jackson, '1915 Cracker Jack Joe Jackson PSA 2').ok, true);
});

test('variant exemption is plural-insensitive (a Stickers watch fits a Sticker title)', () => {
  const stickersWatch = {
    playerName: 'Lionel Messi', year: 2004, setName: 'Panini Stickers',
    cardNumber: '64', parallel: null, company: 'PSA', grade: '9',
  };
  const r = scoreListing(stickersWatch, '2004 Panini Sticker #64 Lionel Messi Rookie PSA 9');
  assert.equal(r.ok, true);
  assert.ok(!r.debug.penalties.some((p) => p.startsWith('variant:sticker')), 'no false sticker penalty');
  // Was 0.4 with the exact-token exemption — hidden by the default
  // "Hide low-confidence (<50%)" filter. Now clears both that cutoff and
  // the 70% low-confidence badge. (It isn't 1.0 because the plural set
  // token genuinely doesn't appear in the title — that's honest fuzz.)
  assert.ok(r.score > 0.7, `score ${r.score}`);

  // Same tolerance the other way round: singular watch, plural title.
  const singular = { ...stickersWatch, setName: 'Panini Sticker' };
  const r2 = scoreListing(singular, '2004 Panini Stickers #64 Lionel Messi Rookie PSA 9');
  assert.ok(!r2.debug.penalties.some((p) => p.startsWith('variant:sticker')));
});

test('specificity: the subset watch and the superset watch both score, the specific one is more specific', () => {
  // The live mis-assignment: a "Beam Team Members Only" listing was owned
  // by the plain "Members Only" watch, which scores 1.0 because ALL its
  // tokens appear in the title. Specificity is what separates them.
  const title = '1992-93 Stadium Club Beam Team Members Only Michael Jordan #1 BGS 9';
  const base = {
    playerName: 'Michael Jordan', year: 1992, setName: 'Stadium Club',
    cardNumber: '1', parallel: 'Members Only', company: 'BGS', grade: '9',
  };
  const beamTeam = { ...base, parallel: 'Beam Team Members Only' };

  const b = scoreListing(base, title);
  const bt = scoreListing(beamTeam, title);
  assert.equal(b.ok, true);
  assert.equal(bt.ok, true);
  // Both are perfect on score — which is exactly why score alone can't decide.
  assert.equal(b.score, 1);
  assert.equal(bt.score, 1);
  // The Beam Team watch explains strictly more of the title.
  assert.ok(bt.specificity > b.specificity, `${bt.specificity} vs ${b.specificity}`);
});

// --- the parallel gate -----------------------------------------------------

// 1992 Stadium Club Jordan #1 exists four ways; the parallel is the ONLY
// thing telling them apart, so every one of these carries its siblings.
const sc = (parallel) => ({
  playerName: 'Michael Jordan', year: 1992, setName: 'Stadium Club', cardNumber: '1',
  parallel, company: 'BGS', grade: '9',
  siblingParallels: [null, 'Members Only', 'Beam Team', 'Beam Team Members Only'].filter((p) => p !== parallel),
});

test('parallel gate: a parallel watch rejects the plain base-card title', () => {
  const base = '1992-93 Topps Stadium Club Michael Jordan #1 BGS 9 Chicago Bulls';
  // Live failure: this scored 0.80 against BOTH Members-Only watches.
  assert.equal(scoreListing(sc('Members Only'), base).ok, false);
  assert.equal(scoreListing(sc('Beam Team Members Only'), base).ok, false);
  // The base-card watch is the one that should take it.
  assert.equal(scoreListing(sc(null), base).ok, true);
});

test('parallel gate: the base-card watch rejects a parallel title', () => {
  const beam = '1992-93 Stadium Club Beam Team Members Only Michael Jordan #1 BGS 9';
  assert.equal(scoreListing(sc(null), beam).ok, false, 'base watch must not take a Beam Team listing');
  assert.equal(scoreListing(sc('Beam Team Members Only'), beam).ok, true);
});

test('parallel gate: a contradicted identifier is a hard fail (Row 0 vs Row 2)', () => {
  const row = (n) => ({
    playerName: 'Michael Jordan', year: 1996, setName: 'Flair Showcase', cardNumber: '23',
    parallel: `Row ${n}`, company: 'BGS', grade: '9',
    siblingParallels: ['Row 0', 'Row 1', 'Row 2'].filter((p) => p !== `Row ${n}`),
  });
  const title = '1996-97 Flair Showcase Row 2 #23 Michael Jordan BGS 9';
  assert.equal(scoreListing(row(0), title).ok, false);
  assert.equal(scoreListing(row(1), title).ok, false);
  assert.equal(scoreListing(row(2), title).ok, true);
});

test('parallel gate stays lenient when the parallel is not discriminating', () => {
  // The 1993 SP #279 Jeter is the ONLY card with that identity — its
  // catalog "Foil" label is decorative and sellers never write it.
  // Demanding it dropped 79 of 445 real listings when first measured.
  const jeter = {
    playerName: 'Derek Jeter', year: 1993, setName: 'SP', cardNumber: '279',
    parallel: 'Foil', company: 'BGS', grade: '9', siblingParallels: [],
  };
  for (const t of [
    '1993 UD SP Derek Jeter RC # 279 BGS 9 MINT',
    '1993 Upper Deck SP Derek Jeter #279 RC BGS 9 Mint',
    '1993 SP DEREK JETER BGS 9',
  ]) {
    assert.equal(scoreListing(jeter, t).ok, true, t);
  }
});

test('parallel gate: "Base" is catalog vocabulary, never required of a seller', () => {
  const brady = {
    playerName: 'Tom Brady', year: 2000, setName: 'Fleer Showcase', cardNumber: '136',
    parallel: 'Base /2000', company: 'BGS', grade: '8', siblingParallels: ['Legacy'],
  };
  assert.equal(scoreListing(brady, '2000 FLEER SHOWCASE #136 TOM BRADY BGS 8').ok, true);
  // But a real sibling's word showing up still hands it to the sibling.
  assert.equal(scoreListing(brady, '2000 Fleer Showcase Legacy #136 Tom Brady BGS 8').ok, false);
});

// --- manual watches (hand-added on the Watched tab) ------------------------

const manual = (over = {}) => ({
  description: '1986 Fleer Michael Jordan #57',
  company: 'SGC',
  grade: '10',
  ...over,
});

test('manual watch: every typed word must appear in the title', () => {
  const hit = scoreListing(manual(), '1986 Fleer Michael Jordan #57 Rookie SGC 10 GEM');
  assert.equal(hit.ok, true);
  assert.equal(hit.score, 1);

  // missing "fleer" -> rejected
  assert.equal(scoreListing(manual(), '1986 Michael Jordan #57 SGC 10').ok, false);
  // right words, wrong slab -> rejected
  assert.equal(scoreListing(manual(), '1986 Fleer Michael Jordan #57 PSA 10').ok, false);
});

test('manual watch: buildQueries appends the slab, loose drops it', () => {
  const q = buildQueries(manual());
  assert.equal(q.tight, '1986 Fleer Michael Jordan #57 SGC 10');
  assert.equal(q.loose, '1986 Fleer Michael Jordan #57');

  // Any/Any and ungraded contribute no slab words to the query
  assert.equal(buildQueries(manual({ company: 'Any', grade: 'Any' })).tight, '1986 Fleer Michael Jordan #57');
  assert.equal(buildQueries(manual({ company: 'None', grade: 'Raw' })).tight, '1986 Fleer Michael Jordan #57');
  assert.equal(buildQueries(manual({ company: 'Any', grade: '10' })).tight, '1986 Fleer Michael Jordan #57 10');
});

test('slabMatcher: Any grader matches any company at that grade', () => {
  const m = slabMatcher('Any', '10');
  assert.ok(m.test('1986 fleer jordan psa 10'));
  assert.ok(m.test('1986 fleer jordan bgs 10'));
  assert.ok(!m.test('1986 fleer jordan psa 9'));
  assert.ok(!m.test('1986 fleer jordan raw ungraded'));
});

test('slabMatcher: Any grade matches that company at any grade', () => {
  const m = slabMatcher('PSA', 'Any');
  assert.ok(m.test('jordan psa 9'));
  assert.ok(m.test('jordan psa 1.5'));
  assert.ok(m.test('jordan psa authentic'));
  assert.ok(!m.test('jordan sgc 9'));
});

test('slabMatcher: Any/Any accepts anything; ungraded rejects slabbed cards', () => {
  assert.ok(slabMatcher('Any', 'Any').test('anything at all'));

  const raw = slabMatcher('None', 'Raw');
  assert.equal(raw.label, 'ungraded');
  assert.ok(raw.test('1986 fleer michael jordan #57 rookie nice centering'));
  assert.ok(!raw.test('1986 fleer michael jordan #57 psa 8'));
  assert.ok(!raw.test('1986 fleer michael jordan #57 bgs 9.5'));
  // either half of the pairing means the same thing
  assert.ok(isUngraded('None', '10') && isUngraded('SGC', 'Raw'));
  assert.equal(slabMatcher('SGC', 'Raw').label, 'ungraded');
});

test('manual watch: ungraded finds raw cards and skips slabs', () => {
  const target = manual({ company: 'None', grade: 'Raw' });
  assert.equal(scoreListing(target, '1986 Fleer Michael Jordan #57 rookie sharp raw').ok, true);
  assert.equal(scoreListing(target, '1986 Fleer Michael Jordan #57 PSA 8').ok, false);
});

test('half grades and Authentic are matched exactly', () => {
  assert.ok(slabRegex('BGS', '9.5').test('2003 topps lebron bgs 9.5 gem'));
  assert.ok(!slabRegex('BGS', '9').test('2003 topps lebron bgs 9.5 gem'));
  assert.ok(!slabRegex('BGS', '9.5').test('2003 topps lebron bgs 9 gem'));
  assert.ok(slabRegex('PSA', 'Authentic').test('1986 fleer jordan psa authentic'));
  assert.ok(slabRegex('PSA', 'Authentic').test('1986 fleer jordan PSA AUTH'));
  assert.ok(!slabRegex('PSA', 'Authentic').test('1986 fleer jordan psa 10'));
});

test('generational suffixes: the required surname skips Jr./II', () => {
  const griffey = {
    playerName: 'Ken Griffey Jr.', year: 1989, setName: 'Upper Deck',
    cardNumber: '1', parallel: null, company: 'PSA', grade: '10',
  };
  // Sellers routinely omit the suffix — the real surname must carry the gate.
  assert.equal(scoreListing(griffey, '1989 Upper Deck Ken Griffey Rookie #1 PSA 10').ok, true);
  // And "jr" alone must NOT satisfy the gate for a different "... Jr." player.
  const trent = {
    playerName: 'Gary Trent Jr.', year: 2018, setName: 'Panini Prizm',
    cardNumber: '269', parallel: null, company: 'PSA', grade: '10',
  };
  const jackson = {
    playerName: 'Jaren Jackson Jr.', year: 2018, setName: 'Panini Prizm',
    cardNumber: '265', parallel: null, company: 'PSA', grade: '10',
  };
  const trentTitle = '2018-19 Panini Prizm Gary Trent Jr. #269 PSA 10';
  assert.equal(scoreListing(trent, trentTitle).ok, true);
  assert.equal(scoreListing(jackson, trentTitle).ok, false);
});

test('yearRegex: the second year of a full season range is not this year', () => {
  assert.ok(!yearRegex(2018).test('2017-2018 Panini Prizm Luka'));
  assert.ok(!yearRegex(1987).test('1986-1987 Fleer Jordan'));
  assert.ok(!yearRegex(1987).test('1986 - 1987 Fleer Jordan')); // spaced range too
  // The first year of the range still is, in every format.
  assert.ok(yearRegex(2017).test('2017-2018 Panini Prizm Luka'));
  assert.ok(yearRegex(1986).test('1986-1987 Fleer Jordan'));
  assert.ok(yearRegex(1986).test('1986-87 Fleer Jordan'));
  // An auction-house lot prefix is NOT a season range: requiring a full
  // four-digit year before the dash keeps "Lot 003 - 1951 Bowman" matching
  // (a looser guard hard-failed every CIA lot on the year gate).
  assert.ok(yearRegex(1951).test('Lot 003 - 1951 Bowman #253 Mickey Mantle'));
  assert.ok(yearRegex(1952).test('Lot 1 - 1952 Topps #311 Mantle'));
  assert.ok(yearRegex(1986).test('#57 - 1986 Fleer Jordan'));
});

test('manual watch: a single-digit card number is required, not dropped', () => {
  const target = { description: '1986 Fleer Sticker Michael Jordan #8', company: 'PSA', grade: '9' };
  assert.equal(scoreListing(target, '1986 Fleer Sticker Michael Jordan #8 PSA 9').ok, true);
  // "#11" tokenizes to "11", so requiring "8" correctly rejects it.
  assert.equal(scoreListing(target, '1986 Fleer Sticker Michael Jordan #11 PSA 9').ok, false);
});

test('punctuated and padded card numbers can still hit the number component', () => {
  const mja = {
    playerName: 'Michael Jordan', year: 2006, setName: 'Fleer',
    cardNumber: 'MJA-2', parallel: null, company: 'PSA', grade: '8',
  };
  // Real Heritage-style title: the raw string "mja-2" never appears as one token.
  const r = scoreListing(mja, '2006 Fleer Michael Jordan #MJA-2 PSA NM-MT 8');
  assert.equal(r.ok, true);
  assert.ok(r.debug.matched.some((m) => m.startsWith('number:')), JSON.stringify(r.debug));
  assert.equal(r.score, 1);
  const padded = { ...mja, cardNumber: ' 11' };
  const r2 = scoreListing(padded, '2006 Fleer Michael Jordan #11 PSA 8');
  assert.ok(r2.debug.matched.some((m) => m.startsWith('number:')));
});

test('ungraded watch rejects non-half decimals and the short Auth form', () => {
  const target = { description: 'Pokemon Charizard', company: 'None', grade: 'Raw' };
  assert.equal(scoreListing(target, '1999 Pokemon Charizard CGC 9.8').ok, false);
  assert.equal(scoreListing(target, 'Pokemon Charizard PSA Auth').ok, false);
  assert.equal(scoreListing(target, '1999 Pokemon Charizard raw sharp').ok, true);
});

test('buildQueries: catalog-only parallel words are dropped from the tight query', () => {
  const q = buildQueries({
    playerName: 'Tom Brady', year: 2000, setName: 'Fleer Showcase',
    cardNumber: '20', parallel: 'Base /1000', company: 'BGS', grade: '8',
  });
  assert.equal(q.tight, '2000 Fleer Showcase Tom Brady /1000 BGS 8');
  const q2 = buildQueries({ ...luka, parallel: 'Base' });
  assert.equal(q2.tight, '2018 Prizm Luka Doncic PSA 10');
});
