// Regression test for lib/rosetta/translation/diceRoll.js -- the Dice Roll
// engine's pure math. Run with: node test/diceRoll.spec.js (or npm test).
//
// Every worked-example number below was hand-verified against the source
// spreadsheet's own output for a real row (Jaeden Roberts, RG, Alabama,
// OVR 93) at Strong class (-0.175) + Gem roll 12 (+0.06):
//   delta = 93 * (-0.175 + 0.06) = 93 * -0.115 = -10.695
// Confirmed exactly against the sheet for SPD, AGI, COD (trench-tier flat
// cuts), STR (always-physical), AWR (generic/full-delta), and CAR/BCV
// (generic/<50-dampened). See diceRoll.js's header for the one deliberate
// divergence from the sheet: ACC is tiered the same as SPD/AGI/COD here
// (the sheet's own ACC formula only exempted QB, not the full trench group --
// an evident copy-paste inconsistency, not a design choice worth preserving).

const assert = require('assert');
const {
  CLASS_STRENGTH_DEBUFF, classStrengthForRoll, bustGemModifierForRoll,
  positionTierCut, applyDelta, clampRound, TRENCH_TIER, SKILL_TIER, ALWAYS_PHYSICAL,
  GENERIC_DELTA_SCALE,
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

// 1. Class strength roll -> tier, full D12 range.
{
  check('roll 1 -> veryWeak', classStrengthForRoll(1), 'veryWeak');
  check('roll 2 -> weak', classStrengthForRoll(2), 'weak');
  check('roll 3 -> weak', classStrengthForRoll(3), 'weak');
  check('roll 4 -> normal', classStrengthForRoll(4), 'normal');
  check('roll 7 -> normal', classStrengthForRoll(7), 'normal');
  check('roll 8 -> strong', classStrengthForRoll(8), 'strong');
  check('roll 10 -> strong', classStrengthForRoll(10), 'strong');
  check('roll 11 -> veryStrong', classStrengthForRoll(11), 'veryStrong');
  check('roll 12 -> veryStrong', classStrengthForRoll(12), 'veryStrong');
  // out-of-range input is clamped, never throws
  check('roll 0 clamps to 1 -> veryWeak', classStrengthForRoll(0), 'veryWeak');
  check('roll 99 clamps to 12 -> veryStrong', classStrengthForRoll(99), 'veryStrong');
}

// 2. Class strength debuff values (Draft Class Debuff Rates table).
{
  // RETUNED 2026-08 -- see diceRoll.js's CLASS_STRENGTH_TABLE header. The
  // source spreadsheet's original rates (-0.25 .. -0.15) produced a real median
  // of 59 with three players at 70+, against Power Curve's 67/116 on the same
  // save. These values reproduce Power Curve's real baseline (67/115) and halve
  // the tier-to-tier step so one die roll can't swing a class ~10 points.
  check('veryWeak debuff', CLASS_STRENGTH_DEBUFF.veryWeak, -0.15);
  check('weak debuff', CLASS_STRENGTH_DEBUFF.weak, -0.1375);
  check('normal debuff', CLASS_STRENGTH_DEBUFF.normal, -0.125);
  check('strong debuff', CLASS_STRENGTH_DEBUFF.strong, -0.1125);
  check('veryStrong debuff', CLASS_STRENGTH_DEBUFF.veryStrong, -0.10);

  // The ordering and the all-negative property are the load-bearing invariants;
  // the exact values above are a tuning choice and may move again.
  const tiers = ['veryWeak', 'weak', 'normal', 'strong', 'veryStrong'];
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(CLASS_STRENGTH_DEBUFF[tiers[i]] > CLASS_STRENGTH_DEBUFF[tiers[i - 1]],
      `${tiers[i]} must be kinder than ${tiers[i - 1]}`);
    passed++;
  }
  for (const t of tiers) {
    assert.ok(CLASS_STRENGTH_DEBUFF[t] < 0, `${t} must stay a penalty -- college ratings never survive the jump intact`);
    passed++;
  }
}

// 3. Bust/Gem roll -> modifier, full D12 range.
{
  check('roll 1 -> -0.10 (bust)', bustGemModifierForRoll(1), -0.10);
  check('roll 3 -> -0.07 (bust)', bustGemModifierForRoll(3), -0.07);
  check('roll 4 -> -0.04 (normal)', bustGemModifierForRoll(4), -0.04);
  check('roll 6 -> 0 (normal)', bustGemModifierForRoll(6), 0);
  check('roll 9 -> 0.03 (normal)', bustGemModifierForRoll(9), 0.03);
  check('roll 10 -> 0.04 (gem)', bustGemModifierForRoll(10), 0.04);
  check('roll 12 -> 0.06 (gem)', bustGemModifierForRoll(12), 0.06);
}

// 4. The worked example's delta.
//
// PINNED to the source spreadsheet's own value rather than re-derived from
// CLASS_STRENGTH_DEBUFF. The sheet's row was captured at the sheet's Strong
// rate of -0.175, and the whole point of sections 5-7 below is to verify
// applyDelta's PER-RATING rules against that hand-checked row -- those rules
// are unchanged, so the example must stay anchored to the delta it was
// verified at. Deriving it from the table instead made this example silently
// re-baseline whenever the table was tuned, which is exactly backwards: it
// would keep "passing" while testing a different number every time.
// Today's table (retuned 2026-08) gives a Strong+Gem-12 delta of -4.88;
// that the two now differ is expected and is asserted below.
const cfbOvr = 93;
const SHEET_STRONG_RATE = -0.175; // the source spreadsheet's Strong class rate
const delta = cfbOvr * (SHEET_STRONG_RATE + bustGemModifierForRoll(12));
{
  check('Strong class + Gem-12 delta matches the sheet', delta, -10.695);
  // The live table is deliberately kinder than the sheet it came from.
  assert.ok(CLASS_STRENGTH_DEBUFF.strong > SHEET_STRONG_RATE,
    'the retuned Strong rate must be kinder than the source spreadsheet it replaced');
  passed++;
}

// 5. Position tiers: trench (OL/DT/QB) and skill, all four threshold bands,
//    plus the "not in either tier" (specialist) case.
{
  check('trench >89 -> -5', positionTierCut('RG', 92), 87);
  check('trench >79 -> -8', positionTierCut('RG', 82), 74);
  check('trench >69 -> -9 (Roberts SPD 73->64)', positionTierCut('RG', 73), 64);
  check('trench <=69 -> unchanged', positionTierCut('RG', 69), 69);
  check('trench <=69 -> unchanged (Roberts COD 65->65)', positionTierCut('RG', 65), 65);

  check('skill >89 -> -2', positionTierCut('WR', 91), 89);
  check('skill >79 -> -3', positionTierCut('WR', 85), 82);
  check('skill >69 -> -4', positionTierCut('WR', 75), 71);
  check('skill <=69 -> unchanged', positionTierCut('WR', 69), 69);

  check('specialist (K) matches no tier', positionTierCut('K', 90), null);
  check('specialist (P) matches no tier', positionTierCut('P', 40), null);
  check('specialist (LS) matches no tier', positionTierCut('LS', 60), null);

  // every trench position is covered
  for (const pos of ['QB', 'DT', 'LE', 'RE', 'RT', 'LG', 'C', 'RG', 'LT']) {
    assert.ok(TRENCH_TIER.has(pos), `TRENCH_TIER missing ${pos}`); passed++;
  }
  // every skill position is covered
  for (const pos of ['HB', 'FB', 'WR', 'TE', 'CB', 'SS', 'FS', 'LOLB', 'MLB', 'ROLB']) {
    assert.ok(SKILL_TIER.has(pos), `SKILL_TIER missing ${pos}`); passed++;
  }
}

// 6. applyDelta -- the full worked example, Jaeden Roberts (RG), delta=-10.695.
{
  // SPD/AGI/COD: trench flat cut, delta never enters into it.
  check('SPD 73 (RG, trench) -> 64', applyDelta('SpeedRating', 73, 'RG', delta), 64);
  check('AGI 78 (RG, trench) -> 69', applyDelta('AgilityRating', 78, 'RG', delta), 69);
  check('COD 65 (RG, trench, <=69) -> unchanged 65', applyDelta('ChangeOfDirectionRating', 65, 'RG', delta), 65);

  // ACC: same tiering as SPD/AGI/COD here (intentional fix -- see file header).
  check('ACC 79 (RG, trench) -> 70', applyDelta('AccelerationRating', 79, 'RG', delta), 70);

  // STR: always-physical, quarter delta. 99 + (-10.695*0.25) = 96.32625.
  check('STR 99 (always-physical) -> 96.32625', applyDelta('StrengthRating', 99, 'RG', delta), 96.32625);

  // THROW POWER: added 2026-08 -- it was falling through to the full-delta
  // generic rule (indistinguishable from a mental rating) purely because it
  // wasn't in either special-cased set. Arm strength is physical, same
  // treatment as STR, and the app already classifies it that way everywhere
  // else (defaults.js's PHYSICAL_RATINGS, powerCurveCategories.js). Same math
  // as STR above: 90 + (-10.695*0.25) = 87.32625.
  check('ThrowPower is classified as always-physical', ALWAYS_PHYSICAL.has('ThrowPowerRating'), true);
  check('ThrowPower 90 (QB, always-physical) -> 87.32625', applyDelta('ThrowPowerRating', 90, 'QB', delta), 87.32625);

  // AWR: generic, full delta (94 not < 50). 94 + -10.695 = 83.305.
  check('AWR 94 (generic, full delta) -> 83.305', applyDelta('AwarenessRating', 94, 'RG', delta), 83.305);

  // QB/HB DAMPENING: added 2026-08 after measuring both notably underperform
  // Power Curve on the same college pool (QB median 59 vs 66, HB 60 vs 68) --
  // every generic (non-tiered, non-physical) rating for these two positions
  // takes 0.55x delta instead of the full 1.0x every other position gets. Same
  // AWR 94 example as above, RG vs QB: RG got the full -10.695;
  // QB gets 94 + (-10.695 * 0.55) = 88.11775.
  assert.deepStrictEqual(Object.keys(GENERIC_DELTA_SCALE).sort(), ['HB', 'QB'], 'QB/HB are the only positions in GENERIC_DELTA_SCALE');
  passed++;
  check('AWR 94 (QB, dampened generic) -> 88.11775', applyDelta('AwarenessRating', 94, 'QB', delta), 88.11775);
  check('AWR 94 (HB, dampened generic) -> 88.11775', applyDelta('AwarenessRating', 94, 'HB', delta), 88.11775);
  check('a position outside the table is unaffected (WR gets full delta same as RG)',
    applyDelta('AwarenessRating', 94, 'WR', delta), 83.305);
  // The dampening must NOT touch physical or tiered ratings for QB/HB --
  // those already have their own, position-neutral rules (see the header).
  check('ThrowPower for QB is untouched by GENERIC_DELTA_SCALE (still quarter-strength, not 0.55x of that)',
    applyDelta('ThrowPowerRating', 90, 'QB', delta), 87.32625);
  check('STR for HB is untouched by GENERIC_DELTA_SCALE (still quarter-strength)',
    applyDelta('StrengthRating', 90, 'HB', delta), 90 + delta * 0.25);

  // CAR/BCV: generic, but BOTH below 50 -> dampened to 5% of delta.
  check('CAR 34 (<50, dampened) -> 33.46525', applyDelta('CarryingRating', 34, 'RG', delta), 33.46525);
  check('BCV 41 (<50, dampened) -> 40.46525', applyDelta('BCVisionRating', 41, 'RG', delta), 40.46525);

  // Specialist fallback: SPD for a kicker (no tier match) falls to the
  // generic physical rule, same as STR/JMP/etc.
  check('SPD 60 (K, no tier, >=50) -> physical quarter delta', applyDelta('SpeedRating', 60, 'K', delta), 60 + delta * 0.25);
  check('SPD 40 (K, no tier, <50) -> dampened', applyDelta('SpeedRating', 40, 'K', delta), 40 + delta * 0.05);
}

// 7. A positive (gem-heavy, strong-class) delta pushes ratings UP, not just down.
{
  const smallClassDebuff = CLASS_STRENGTH_DEBUFF.veryStrong; // -0.10 after the 2026-08 retune
  const bigGem = bustGemModifierForRoll(12); // +0.06
  assert.ok(smallClassDebuff + bigGem < 0, 'sanity: even the best roll combo stays net negative');
  passed++;
  // The "best case" ceiling: no roll combination ever produces a positive
  // class-wide delta, so no player is ever translated UP overall. The retune
  // moved this from -0.09 to -0.04 -- a much softer cut, still a cut.
  let bestCase = -Infinity;
  for (const tier of Object.keys(CLASS_STRENGTH_DEBUFF)) {
    for (let r = 1; r <= 12; r++) {
      const combo = CLASS_STRENGTH_DEBUFF[tier] + bustGemModifierForRoll(r);
      if (combo > bestCase) bestCase = combo;
    }
  }
  check('best possible (class+player) combo is -0.04 (Very Strong + Gem 12)', Math.round(bestCase * 1000) / 1000, -0.04);
}

// 8. clampRound bounds and rounding.
{
  check('clampRound rounds', clampRound(82.305), 82);
  check('clampRound rounds up at .5', clampRound(82.5), 83);
  check('clampRound floors at 1', clampRound(-5), 1);
  check('clampRound ceilings at 99', clampRound(150), 99);
  check('clampRound respects custom bounds', clampRound(150, 1, 200), 150);
}

console.log(`\n  Dice Roll spec: ${passed} assertions passed.`);
