// Dependency-free regression test for bio-field passthrough (CharacterBodyType,
// Height, Weight) through calibratePlayers -- separate from powerCurve.spec.js
// because this is identical logic in BOTH the v1 and powercurve engines and has
// nothing to do with rating conversion itself (curves/categories/strengths).
// Run with: node test/bioFields.spec.js (or npm test, which runs both files).
//
// Context (see FACES_AND_DRAFT_ROADMAP.md Phase 1): CharacterBodyType is a
// field shared byte-identically between the CFB27 and Madden 26 schemas
// (same 17-member enum, including the 5 real values Standard/Thin/Muscular/
// Heavy/Freshman -- verified against both games' real schemas). Before this
// fix, calibratePlayers never carried it from the extracted row through to
// the generated class, so writeCareerFile had nothing to write and a
// transferred player kept the overwritten Madden slot's original body build
// (the "WRs look like DTs" bug). This locks the passthrough at the
// calibrate stage for both engines.

const assert = require('assert');
const { calibratePlayers } = require('../lib/pipeline');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${got}, expected ${want}`);
  passed++;
}

function row(overrides) {
  return Object.assign({
    FirstName: 'Test', LastName: 'Player', OverallRating: 85, Position: 'WR',
    Height: 73, Weight: 39, JerseyNum: 1, SchoolYear: 'Senior', // Weight is CFB-raw (-160 offset); decodeWeight applies +160 upstream in extraction, so calibrate receives the already-decoded lb value
    TraitDevelopment: 'College_Star', AwardsScore: 0, CareerStats: null, ProjectRound: 3,
    SpeedRating: 88, AccelerationRating: 87, AgilityRating: 86, CatchingRating: 84,
  }, overrides);
}

const baseConfig = { general: { seed: 'bio-test', classSize: 10 } };

for (const strategy of ['powercurve', 'v1']) {
  const config = { ...baseConfig, translation: { strategy } };

  // 1. CharacterBodyType passes through unchanged for every real value.
  for (const bodyType of ['Standard', 'Thin', 'Muscular', 'Heavy', 'Freshman']) {
    const out = calibratePlayers([row({ LastName: bodyType, CharacterBodyType: bodyType })], { config, log: () => {} });
    check(`[${strategy}] CharacterBodyType passthrough (${bodyType})`, out[0].CharacterBodyType, bodyType);
  }

  // 2. Missing/undefined CharacterBodyType on the source row falls back to
  //    'Standard' (a valid enum member, Madden's own schema default) rather
  //    than undefined/null/'' -- guards the write step's enum-safety.
  const missingOut = calibratePlayers([row({ LastName: 'NoBody', CharacterBodyType: undefined })], { config, log: () => {} });
  check(`[${strategy}] missing CharacterBodyType defaults to Standard`, missingOut[0].CharacterBodyType, 'Standard');

  // 3. Height/Weight fidelity: values within the clamp bounds ([65,82] in,
  //    [160,415] lb) must round-trip through calibrate exactly unchanged --
  //    this is a real, decoded lb value (CFB's raw-1 storage +160 offset is
  //    handled upstream in extraction, not in calibrate).
  const hw = calibratePlayers([row({ LastName: 'HW', Height: 74, Weight: 210 })], { config, log: () => {} })[0];
  check(`[${strategy}] Height fidelity`, hw.Height, 74);
  check(`[${strategy}] Weight fidelity`, hw.Weight, 210);
}

console.log(`\n  Bio-field spec: ${passed} assertions passed.`);
