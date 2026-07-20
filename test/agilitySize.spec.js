// Regression test for the optional WR/CB size-based Agility/COD realism pass
// (lib/pipeline.js applyAgilitySizePenalty). Run: node test/agilitySize.spec.js.

const assert = require('assert');
const { applyAgilitySizePenalty, sizeAgilityCeiling, AGI_SIZE_PARAMS } = require('../lib/pipeline');

let passed = 0;
function check(label, cond) { assert.ok(cond, label); passed++; }

// A tiny deterministic RNG stand-in so tests don't depend on the real seeder.
// Returns a fixed sequence, looping. `mid` avoids the 3% spare (roll >= SPARE).
function seq(values) { let i = 0; return () => values[(i++) % values.length]; }
const noSpare = () => 0.5; // constant 0.5: never spared, zero jitter, gap = 1.5

// 1. Non-WR/CB positions are never touched.
{
  const r = { AgilityRating: 99, ChangeOfDirectionRating: 98 };
  applyAgilitySizePenalty('HB', r, 70, 230, noSpare);
  check('HB agility untouched', r.AgilityRating === 99);
  check('HB COD untouched', r.ChangeOfDirectionRating === 98);
}

// 2. A big WR gets Agility pulled well down from 99.
{
  const r = { AgilityRating: 99, ChangeOfDirectionRating: 97 };
  applyAgilitySizePenalty('WR', r, 76, 230, noSpare); // 6'4", 230
  check('big WR agility pulled below 92', r.AgilityRating < 92);
  check('big WR agility stays realistic (>=82)', r.AgilityRating >= 82);
  check('big WR COD <= agility', r.ChangeOfDirectionRating <= r.AgilityRating);
  check('big WR COD not raised above original', r.ChangeOfDirectionRating <= 97);
}

// 3. A small, shifty WR under the ceiling is left alone.
{
  const r = { AgilityRating: 95, ChangeOfDirectionRating: 90 };
  applyAgilitySizePenalty('WR', r, 70, 185, noSpare); // 5'10", 185
  check('small WR agility unchanged (below ceiling, no jitter)', r.AgilityRating === 95);
  check('small WR COD unchanged (already below agility)', r.ChangeOfDirectionRating === 90);
}

// 4. Monotonic: heavier WR gets a lower (or equal) agility than a lighter one.
{
  const a = { AgilityRating: 99, ChangeOfDirectionRating: 99 };
  const b = { AgilityRating: 99, ChangeOfDirectionRating: 99 };
  applyAgilitySizePenalty('CB', a, 74, 200, noSpare);
  applyAgilitySizePenalty('CB', b, 74, 225, noSpare);
  check('heavier CB has <= agility than lighter CB', b.AgilityRating <= a.AgilityRating);
  check('both CB COD <= their agility', a.ChangeOfDirectionRating <= a.AgilityRating && b.ChangeOfDirectionRating <= b.AgilityRating);
}

// 5. The freak exception (spare) leaves a big WR completely untouched.
{
  const r = { AgilityRating: 99, ChangeOfDirectionRating: 98 };
  applyAgilitySizePenalty('WR', r, 76, 235, () => 0.0); // roll 0 < 0.03 -> spared
  check('spared WR keeps agility', r.AgilityRating === 99);
  check('spared WR keeps COD', r.ChangeOfDirectionRating === 98);
}

// 6. Deterministic for a given rng sequence.
{
  const mk = () => { const r = { AgilityRating: 98, ChangeOfDirectionRating: 96 }; applyAgilitySizePenalty('WR', r, 75, 222, seq([0.5, 0.4, 0.6, 0.3])); return r; };
  const x = mk(); const y = mk();
  check('same rng sequence -> identical result', x.AgilityRating === y.AgilityRating && x.ChangeOfDirectionRating === y.ChangeOfDirectionRating);
}

// 7. Ceiling shape: lighter frame -> higher ceiling than heavier frame.
{
  check('ceiling decreases with weight', sizeAgilityCeiling(74, 200) > sizeAgilityCeiling(74, 250));
  check('ceiling decreases with height', sizeAgilityCeiling(78, 210) < sizeAgilityCeiling(72, 210));
  check('lightest frame ceiling equals Cmax (<99, so 99s thin out)', Math.abs(sizeAgilityCeiling(70, 180) - AGI_SIZE_PARAMS.Cmax) < 0.01 && AGI_SIZE_PARAMS.Cmax < 99);
  check('params sane', AGI_SIZE_PARAMS.W0 > 0 && AGI_SIZE_PARAMS.SPARE > 0 && AGI_SIZE_PARAMS.SPARE < 0.2);
}

// 8. Even a small WR's flat 99 gets nudged down (ceiling Cmax < 99).
{
  const r = { AgilityRating: 99, ChangeOfDirectionRating: 99 };
  applyAgilitySizePenalty('WR', r, 70, 185, () => 0.5); // small, not spared, mid drag
  check('small WR 99 agility nudged under 99', r.AgilityRating < 99);
}

// 9. COD may sit a hair above AGI when the (rare) overage roll fires.
//    Sequence: spare-miss, agi-drag, cod-drag, overage-hit (<CODOVER_PROB), floor-hi.
{
  const r = { AgilityRating: 99, ChangeOfDirectionRating: 99 };
  applyAgilitySizePenalty('WR', r, 76, 230, seq([0.5, 0.5, 0.5, 0.0, 0.99]));
  check('COD can be a hair above AGI on the rare overage', r.ChangeOfDirectionRating >= r.AgilityRating);
  check('COD overage stays within CODOVER_MAX', r.ChangeOfDirectionRating - r.AgilityRating <= AGI_SIZE_PARAMS.CODOVER_MAX);
}

console.log(`\n  Agility-size realism spec: ${passed} assertions passed.`);
