// Regression test for lib/rosetta/translation/diceRoll.js -- the Dice Roll
// LUCK LAYER. Run with: node test/diceRoll.spec.js (or npm test).
//
// REWRITTEN 2026-08-11g alongside the model itself. Dice Roll used to be a
// second, complete conversion engine with its own class-strength table,
// per-position dampening and rating rules; this file tested all of that. It is
// now a thin layer OVER Power Curve: Power Curve produces the base ratings and
// this slides them, up or down, to create steals and busts.
//
// What that means for testing: the interesting properties are no longer
// "does this reproduce a spreadsheet's numbers" but the statistical shape of
// the slide -- is it centred on zero, are extremes rare, does it leave
// athleticism alone, does it stay inside the rating range. Those are what this
// file pins.

const assert = require('assert');
const {
  SLIDE_TABLE, CATEGORY_SLIDE_WEIGHT, DEPTH_FLOOR, TAPER_BAND, TAPER_FLOOR,
  roll2d6, slideForRoll, depthScale, taperFactor, applySlide, clampRound,
} = require('../lib/rosetta/translation/diceRoll');

let passed = 0;
function check(label, got, want) {
  if (typeof want === 'number' && typeof got === 'number') {
    assert.ok(Math.abs(got - want) < 1e-9, `${label}: got ${got}, expected ${want}`);
  } else {
    assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }
function checkDeep(label, got, want) { assert.deepStrictEqual(got, want, label); passed++; }

// 1. The slide table is symmetric and zero-centred.
//
// This is THE load-bearing property of the whole layer. If the table has any
// net bias, a Dice Roll class systematically drifts away from the Power Curve
// class it is supposed to be a variation on -- which is exactly the
// double-counting the rewrite existed to remove (the old engine's best possible
// outcome was still a -0.11 cut, so a "gem" never actually boosted anyone).
{
  const rolls = Object.keys(SLIDE_TABLE).map(Number).sort((a, b) => a - b);
  checkDeep('table covers exactly 2..12', rolls, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  check('the middle roll is a no-op', SLIDE_TABLE[7], 0);
  for (let r = 2; r <= 6; r++) {
    check(`roll ${r} mirrors roll ${14 - r}`, SLIDE_TABLE[r], -SLIDE_TABLE[14 - r]);
  }
  // Weighted by 2d6 probability, not just arithmetically symmetric.
  const WAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  let expected = 0;
  for (const r of rolls) expected += SLIDE_TABLE[r] * WAYS[r];
  check('probability-weighted mean slide is exactly zero', expected, 0);

  // Monotonic: a better roll is never a worse outcome.
  for (let r = 3; r <= 12; r++) {
    ok(`roll ${r} is at least as good as ${r - 1}`, SLIDE_TABLE[r] > SLIDE_TABLE[r - 1]);
  }
  ok('the table is bounded -- no single roll is a huge swing',
    rolls.every((r) => Math.abs(SLIDE_TABLE[r]) <= 4));
}

// 2. Extremes are rare BY CONSTRUCTION -- this is why it is 2d6 and not d12.
//
// A flat d12 would make the maximum swing exactly as likely as no swing at all.
// The bell is the reason "most players barely move, a few move a lot" holds
// without any extra machinery.
{
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const counts = {};
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const r = roll2d6(rng);
    counts[r] = (counts[r] || 0) + 1;
  }
  ok('every 2d6 face lands in 2..12', Object.keys(counts).every((k) => Number(k) >= 2 && Number(k) <= 12));
  const p = (r) => counts[r] / N;
  // 7 is 6/36 = .1667, 2 and 12 are 1/36 = .0278 each. Loose bounds -- this is
  // checking the SHAPE, not the RNG's quality.
  ok('7 is the most common roll (~16.7%)', p(7) > 0.14 && p(7) < 0.19);
  ok('a maximum swing is rare (~2.8% per end)', p(2) < 0.05 && p(12) < 0.05);
  ok('both extremes are about equally likely', Math.abs(p(2) - p(12)) < 0.01);
  const extreme = p(2) + p(12);
  ok('full-magnitude swings hit roughly 5-6% of players', extreme > 0.03 && extreme < 0.09);
}

// 3. Depth decay: the top of the board moves most, the deep class moves least,
//    and it NEVER reaches zero.
{
  check('the top pick gets the full slide', depthScale(0), 1);
  check('the last pick gets the floor', depthScale(1), DEPTH_FLOOR);
  ok('decay is monotonic', depthScale(0) > depthScale(0.5) && depthScale(0.5) > depthScale(1));
  // The floor is the point: a late-round steal has to stay possible. The old
  // engine's own rank-bias comment stated this principle while implementing
  // the opposite behaviour (it made late picks roll WORSE).
  ok('the deep class still gets a real slide, not a token one', DEPTH_FLOOR >= 0.5);
  check('out-of-range input is clamped, never throws', depthScale(5), DEPTH_FLOOR);
  check('negative input clamps to the top', depthScale(-1), 1);
}

// 4. Athleticism is near-immune. A bust does not get slower -- he fails to
//    develop technique and awareness. This also protects the physical
//    calibration Power Curve owns from being churned by luck.
{
  ok('physical moves far less than technical', CATEGORY_SLIDE_WEIGHT.physical < CATEGORY_SLIDE_WEIGHT.techhvy * 0.5);
  ok('mental moves at least as much as technical', CATEGORY_SLIDE_WEIGHT.mental >= CATEGORY_SLIDE_WEIGHT.techhvy);
  // A big slide should barely move a speed rating.
  const spd = applySlide(90, 3.75, 'physical');
  ok(`a maximum slide moves a 90 speed by at most 1 (got ${spd})`, Math.abs(spd - 90) <= 1);
  const rr = applySlide(75, 3.75, 'techhvy');
  ok(`the same slide moves a technical rating meaningfully (got ${rr})`, rr - 75 >= 3);
}

// 5. Taper: nothing is driven through the ceiling or the floor.
//
// Replaces the old engine's hard cliff at exactly 50 (a 49 took 5% of the
// delta, a 51 took 100%) with a smooth fade at both ends.
{
  check('a boost is dead at the ceiling', taperFactor(99, 1), 0);
  check('a drop is dead at the floor', taperFactor(TAPER_FLOOR, -1), 0);
  check('mid-range ratings take the full slide up', taperFactor(70, 1), 1);
  check('mid-range ratings take the full slide down', taperFactor(70, -1), 1);
  ok('the taper is gradual, not a cliff',
    taperFactor(99 - TAPER_BAND / 2, 1) > 0.4 && taperFactor(99 - TAPER_BAND / 2, 1) < 0.6);

  // The properties that actually matter downstream.
  check('a huge boost cannot exceed 99', applySlide(99, 4, 'techhvy'), 99);
  check('a 98 barely moves', applySlide(98, 4, 'techhvy'), 98);
  ok('a huge drop cannot go below the floor', applySlide(32, -4, 'techhvy') >= TAPER_FLOOR - 1);
  for (const v of [1, 20, 50, 75, 99]) {
    for (const s of [-4, -1, 1, 4]) {
      const out = applySlide(v, s, 'techhvy');
      ok(`applySlide(${v}, ${s}) stays in range (got ${out})`, out >= 1 && out <= 99);
    }
  }
}

// 6. A zero slide is a true no-op -- most players should come out of this layer
//    exactly where Power Curve left them.
{
  for (const v of [40, 65, 88]) {
    check(`slide 0 leaves ${v} untouched`, applySlide(v, 0, 'techhvy'), v);
  }
  check('an unknown category still converts (falls back to full weight)',
    applySlide(70, 2, 'nonsense-category'), clampRound(72));
  // NaN !== NaN, so this has to be asserted with Number.isNaN rather than an
  // equality check. The behaviour under test is that a junk rating passes
  // straight through instead of becoming a number.
  ok('a non-numeric rating is returned unchanged, not coerced',
    Number.isNaN(applySlide(NaN, 2, 'techhvy')));
  ok('an undefined rating passes through', applySlide(undefined, 2, 'techhvy') === undefined
    || Number.isNaN(applySlide(undefined, 2, 'techhvy')));
}

// 7. clampRound bounds and rounding (unchanged behaviour, still relied on).
{
  check('clampRound rounds', clampRound(82.3), 82);
  check('clampRound rounds up at .5', clampRound(82.5), 83);
  check('clampRound floors at 1', clampRound(-5), 1);
  check('clampRound ceilings at 99', clampRound(150), 99);
}

console.log(`\n  Dice Roll slide spec: ${passed} assertions passed.`);
