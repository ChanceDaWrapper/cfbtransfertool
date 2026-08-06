// Regression test for lib/carousel/map/* -- Phase 1 of
// COACH_CAROUSEL_ROADMAP.md ("the map layer, no writes"). Pure-logic pieces
// only (enumBridge, archetypeMap, synthesis math, levelScale math,
// coachFieldMap) -- no real save file needed, same fixture convention as
// test/bioFields.spec.js and test/carouselPerson.spec.js.
// Run with: node test/carouselMap.spec.js (or npm test).

const assert = require('assert');
const { COACH_FIELD_MAP, getFieldMap } = require('../lib/carousel/map/coachFieldMap');
const { crossEnum, liveEnumMembers, isSharedMemberName } = require('../lib/carousel/map/enumBridge');
const {
  deriveSide, sideArchetype, mapArchetypeCfbToMadden, mapArchetypeMaddenToCfb,
} = require('../lib/carousel/map/archetypeMap');
const {
  letterGradeForPercentile, neutralIfZero, synthesizeSpecialtyType,
  synthesizeTeamBuildingAndTrading, synthesizeCoachBackstoryForMadden, synthesizeCoachBackstoryForCfb,
} = require('../lib/carousel/map/synthesis');
const { pctOf, valueAt, winsorize } = require('../lib/carousel/map/levelScale');
const { crossSchemeName, CFB_TO_MADDEN, MADDEN_TO_CFB } = require('../lib/carousel/map/schemeLookup');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// ---------------------------------------------------------------------
// coachFieldMap.js -- exact coverage (156 fields), already self-checked at
// require time; re-asserted here so a regression shows up as a normal test
// failure, not just a require-time crash.
// ---------------------------------------------------------------------
check('COACH_FIELD_MAP has exactly 156 fields', COACH_FIELD_MAP.length, 156);
check('getFieldMap resolves a known shared field', getFieldMap('Level').presence, 'both');
check('getFieldMap resolves a known CFB-only field', getFieldMap('CoachPrestigeScore').presence, 'cfb');
check('getFieldMap resolves a known Madden-only field', getFieldMap('Archetype').presence, 'madden');
check('getFieldMap returns null for an unknown field', getFieldMap('NotARealField'), null);
check('ContractStatus is name-mapped both directions (value drift)',
  [getFieldMap('ContractStatus').cfbToMadden, getFieldMap('ContractStatus').maddenToCfb], ['NAME', 'NAME']);
check('PrevPosition appears exactly once (the roadmap doc once had a duplicate row)',
  COACH_FIELD_MAP.filter((e) => e.field === 'PrevPosition').length, 1);

// ---------------------------------------------------------------------
// enumBridge.js -- the one rule everything hangs on: cross by name, not
// value. Fake destFile (just enough schema shape for liveEnumMembers).
// ---------------------------------------------------------------------
const fakeDestFile = {
  schemaList: {
    getSchema(name) {
      assert.strictEqual(name, 'Coach');
      return {
        attributes: [
          { name: 'ContractStatus', enum: { members: [{ name: 'Signed' }, { name: 'FreeAgent' }, { name: 'Retired' }] } },
        ],
      };
    },
  },
};
check('crossEnum: a name shared by both enums passes through unchanged',
  crossEnum({ destFile: fakeDestFile, destField: 'ContractStatus', sourceValue: 'FreeAgent' }), 'FreeAgent');
check('crossEnum: an aliased name resolves via aliasMap',
  crossEnum({ destFile: fakeDestFile, destField: 'ContractStatus', sourceValue: 'PendingNFL', aliasMap: { PendingNFL: 'Signed' } }), 'Signed');
check('crossEnum: falls back when neither a shared name nor an alias resolves',
  crossEnum({ destFile: fakeDestFile, destField: 'ContractStatus', sourceValue: 'PendingHire', fallback: 'FreeAgent' }), 'FreeAgent');
assert.throws(() => crossEnum({ destFile: fakeDestFile, destField: 'ContractStatus', sourceValue: 'Bogus' }), /no way to cross/);
passed++;
assert.throws(() => crossEnum({
  destFile: fakeDestFile, destField: 'ContractStatus', sourceValue: 'X', aliasMap: { X: 'NotAMember' },
}), /isn't a member/);
passed++;
check('isSharedMemberName true for a shared member', isSharedMemberName(fakeDestFile, 'Coach', 'ContractStatus', 'Retired'), true);
check('isSharedMemberName false for a non-member', isSharedMemberName(fakeDestFile, 'Coach', 'ContractStatus', 'PendingNFL'), false);
check('liveEnumMembers reads the live set', [...liveEnumMembers(fakeDestFile, 'Coach', 'ContractStatus')].sort(),
  ['FreeAgent', 'Retired', 'Signed']);

// ---------------------------------------------------------------------
// archetypeMap.js -- side derivation, and both mapping directions with a
// deterministic fake "rng" (a fixed-sequence function) instead of Math.random
// so the roll boundaries are exactly testable.
// ---------------------------------------------------------------------
check('deriveSide: SpecialtyType wins when present', deriveSide({ specialtyType: 'Defense', coachSpecialty: 'Quarterbacks' }), 'Defense');
check('deriveSide: falls back to COACH_SPECIALTY (offense group)', deriveSide({ coachSpecialty: 'OffensiveLine' }), 'Offense');
check('deriveSide: falls back to COACH_SPECIALTY (defense group)', deriveSide({ coachSpecialty: 'Linebackers' }), 'Defense');
check('deriveSide: SpecialTeams/unknown -> Any', deriveSide({ coachSpecialty: 'SpecialTeams' }), 'Any');
check('sideArchetype', [sideArchetype('Offense'), sideArchetype('Defense'), sideArchetype('Any')],
  ['OffensiveGuru', 'DefensiveGenius', 'DevelopmentWizard']);

const rngBelow = () => 0.01; // always rolls "true" (below any positive rollP)
const rngAbove = () => 0.99; // always rolls "false"

check('CFB->Madden: MasterMotivator is a 1:1 anchor regardless of side',
  mapArchetypeCfbToMadden({ dominantArchetype: 'MasterMotivator', side: 'Offense', rng: rngBelow }), 'MasterMotivator');
check('CFB->Madden: Any side always DevelopmentWizard, no roll',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Schemer', side: 'Any', rng: rngBelow }), 'DevelopmentWizard');
check('CFB->Madden: Invalid_ always DevelopmentWizard',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Invalid_', side: 'Offense', rng: rngBelow }), 'DevelopmentWizard');
check('CFB->Madden: Recruiter family defaults to DevelopmentWizard, rolls to side archetype under p',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Recruiter', side: 'Offense', rng: rngAbove }), 'DevelopmentWizard');
check('CFB->Madden: Recruiter family rolls to side archetype when the roll lands under 0.25',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Recruiter', side: 'Defense', rng: rngBelow }), 'DefensiveGenius');
check('CFB->Madden: Schemer family defaults to side archetype, rolls to DevelopmentWizard under p',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Schemer', side: 'Offense', rng: rngAbove }), 'OffensiveGuru');
check('CFB->Madden: Schemer family rolls to DevelopmentWizard when the roll lands under 0.15',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Schemer', side: 'Offense', rng: rngBelow }), 'DevelopmentWizard');
check('CFB->Madden: Motivator defaults to side archetype, rolls to MasterMotivator under p',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Motivator', side: 'Defense', rng: rngAbove }), 'DefensiveGenius');
check('CFB->Madden: Motivator rolls to MasterMotivator when the roll lands under 0.20',
  mapArchetypeCfbToMadden({ dominantArchetype: 'Motivator', side: 'Defense', rng: rngBelow }), 'MasterMotivator');

// Madden->CFB is POSITION-AWARE. CFB's DominantArchetype is strongly
// position-partitioned in the real data -- Schemer/Recruiter/Motivator are
// used by ZERO head coaches (coordinators only), while CEO/ProgramBuilder
// are used by zero coordinators. An earlier position-blind version handed
// arriving NFL head coaches `Schemer`, an archetype no real CFB head coach
// has. These assertions pin both families down.
check('Madden->CFB: fixed mappings ignore level entirely (HC)',
  [
    mapArchetypeMaddenToCfb({ archetype: 'MasterMotivator', level: 1, levelP70: 99, position: 'HeadCoach' }),
    mapArchetypeMaddenToCfb({ archetype: 'PersonnelCzar', level: 1, levelP70: 99, position: 'HeadCoach' }),
    mapArchetypeMaddenToCfb({ archetype: 'HeadTrainer', level: 1, levelP70: 99, position: 'HeadCoach' }),
  ],
  ['MasterMotivator', 'CEO', 'TalentDeveloper']);
check('Madden->CFB: PersonnelCzar->CEO is HC-only; a coordinator gets an in-distribution equivalent',
  mapArchetypeMaddenToCfb({ archetype: 'PersonnelCzar', level: 1, levelP70: 99, position: 'OffensiveCoordinator' }),
  'EliteRecruiter');

// Coordinators keep the original scheme-flavored tiering...
check('Madden->CFB: OffensiveGuru below P70, COORDINATOR -> Schemer',
  mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 10, levelP70: 20, position: 'DefensiveCoordinator' }), 'Schemer');
check('Madden->CFB: DevelopmentWizard below P70, COORDINATOR -> Recruiter',
  mapArchetypeMaddenToCfb({ archetype: 'DevelopmentWizard', level: 5, levelP70: 20, position: 'OffensiveCoordinator' }), 'Recruiter');

// ...but head coaches must never receive a coordinator-only archetype.
check('Madden->CFB: OffensiveGuru below P70, HEAD COACH -> Strategist (never Schemer)',
  mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 10, levelP70: 20, position: 'HeadCoach' }), 'Strategist');
check('Madden->CFB: DevelopmentWizard below P70, HEAD COACH -> EliteRecruiter (never Recruiter)',
  mapArchetypeMaddenToCfb({ archetype: 'DevelopmentWizard', level: 5, levelP70: 20, position: 'HeadCoach' }), 'EliteRecruiter');
check('Madden->CFB: an unrecognized archetype still never gives a HC a coordinator-only value',
  mapArchetypeMaddenToCfb({ archetype: 'NotARealArchetype', level: 5, levelP70: 20, position: 'HeadCoach' }), 'EliteRecruiter');

// The above-P70 tier is shared by both families and is unchanged.
check('Madden->CFB: OffensiveGuru at/above P70 -> SchemeGuru (both families)',
  [
    mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 25, levelP70: 20, position: 'HeadCoach' }),
    mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 25, levelP70: 20, position: 'OffensiveCoordinator' }),
  ], ['SchemeGuru', 'SchemeGuru']);
check('Madden->CFB: DevelopmentWizard at/above P70 -> TalentDeveloper',
  mapArchetypeMaddenToCfb({ archetype: 'DevelopmentWizard', level: 30, levelP70: 20, position: 'HeadCoach' }), 'TalentDeveloper');

check('Madden->CFB: variety roll is OFF by default -- no Architect/Strategist/etc. leak through',
  mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 30, levelP70: 20, rng: rngBelow }), 'SchemeGuru');
check('Madden->CFB: variety roll, when explicitly enabled, produces an HC-legal archetype for an HC',
  ['Architect', 'Strategist', 'ProgramBuilder', 'Rainmaker', 'Visionary'].includes(
    mapArchetypeMaddenToCfb({ archetype: 'OffensiveGuru', level: 30, levelP70: 20, position: 'HeadCoach', allowVarietyRoll: true, rng: rngBelow })), true);
check('Madden->CFB: the variety roll never hands a HEAD COACH the coordinator-only Motivator',
  Array.from({ length: 40 }, (_, i) => mapArchetypeMaddenToCfb({
    archetype: 'OffensiveGuru', level: 30, levelP70: 20, position: 'HeadCoach',
    allowVarietyRoll: true, rng: () => (i % 20) / 20,
  })).includes('Motivator'), false);

// ---------------------------------------------------------------------
// synthesis.js -- pure pieces (letterGradeForPercentile, neutralIfZero,
// SpecialtyType derivation, TeamBuilding/TradingTendency defaults,
// CoachBackstory both directions).
// ---------------------------------------------------------------------
check('letterGradeForPercentile: p=0.70 (an NFL coach) lands well above average', letterGradeForPercentile(0.70), 'Bplus');
check('letterGradeForPercentile: p=0.40 (a normal college hire) lands mid/low', letterGradeForPercentile(0.40), 'C');
check('letterGradeForPercentile: p=1.0 is the best grade', letterGradeForPercentile(1.0), 'Aplus');
check('letterGradeForPercentile: p=0 is the worst grade', letterGradeForPercentile(0), 'F');

check('neutralIfZero: a zero source value becomes the neutral', neutralIfZero(0), 50);
check('neutralIfZero: a nonzero value passes through', neutralIfZero(72), 72);
check('neutralIfZero: a custom neutral is respected', neutralIfZero(0, 40), 40);

check('synthesizeSpecialtyType: offense group', synthesizeSpecialtyType('OffensiveLine'), 'Offense');
check('synthesizeSpecialtyType: defense group', synthesizeSpecialtyType('DefensiveLine'), 'Defense');
check('synthesizeSpecialtyType: special teams -> Any', synthesizeSpecialtyType('SpecialTeams'), 'Any');

check('synthesizeTeamBuildingAndTrading: CFB has no real signal, so a fixed default ships',
  synthesizeTeamBuildingAndTrading(), { TeamBuilding: 'Balanced', TradingTendency: 'DoesNotTrade' });

check('synthesizeCoachBackstoryForMadden: DevelopmentWizard -> TeamBuilder', synthesizeCoachBackstoryForMadden('DevelopmentWizard'), 'TeamBuilder');
check('synthesizeCoachBackstoryForMadden: MasterMotivator -> Motivator', synthesizeCoachBackstoryForMadden('MasterMotivator'), 'Motivator');
check('synthesizeCoachBackstoryForMadden: OffensiveGuru/DefensiveGenius -> Strategist',
  [synthesizeCoachBackstoryForMadden('OffensiveGuru'), synthesizeCoachBackstoryForMadden('DefensiveGenius')], ['Strategist', 'Strategist']);

check('synthesizeCoachBackstoryForCfb: Strategist + position -> {prefix}Schemer',
  [
    synthesizeCoachBackstoryForCfb('Strategist', 'HeadCoach'),
    synthesizeCoachBackstoryForCfb('Strategist', 'OffensiveCoordinator'),
    synthesizeCoachBackstoryForCfb('Strategist', 'DefensiveCoordinator'),
  ], ['HCSchemer', 'OCSchemer', 'DCSchemer']);
check('synthesizeCoachBackstoryForCfb: TeamBuilder -> {prefix}Salesman', synthesizeCoachBackstoryForCfb('TeamBuilder', 'HeadCoach'), 'HCSalesman');
check('synthesizeCoachBackstoryForCfb: Motivator -> {prefix}Motivator', synthesizeCoachBackstoryForCfb('Motivator', 'DefensiveCoordinator'), 'DCMotivator');

// ---------------------------------------------------------------------
// levelScale.js math helpers -- percentile-in/value-out is monotonic by
// construction (no separate "fix" pass needed), winsorize caps the top tail.
// ---------------------------------------------------------------------
const sortedSample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
check('pctOf: minimum value is percentile 0-ish (midpoint convention)', pctOf(sortedSample, 10), 0.05);
check('pctOf: maximum value is percentile ~1', pctOf(sortedSample, 100), 0.95);
check('valueAt: p=0 returns the minimum', valueAt(sortedSample, 0), 10);
check('valueAt: p=1 returns the maximum', valueAt(sortedSample, 1), 100);
check('winsorize: caps every value above the q-th percentile at that value',
  winsorize(sortedSample, 0.5), [10, 20, 30, 40, 50, 60, 60, 60, 60, 60]);
check('winsorize: q>=1 is a no-op', winsorize(sortedSample, 1), sortedSample);
// monotonicity holds without an explicit fix step: higher input -> equal or higher output
let lastOut = -Infinity;
for (const v of sortedSample) {
  const out = valueAt(sortedSample, pctOf(sortedSample, v));
  assert.ok(out >= lastOut, `monotonicity broke at v=${v}`);
  lastOut = out;
}
passed++;

// ---------------------------------------------------------------------
// schemeLookup.js -- the static CFB<->Madden name table covers every real
// BaseScheme member on each side, and crossSchemeName throws on garbage.
// ---------------------------------------------------------------------
check('CFB_TO_MADDEN covers all 11 real CFB offensive scheme names', Object.keys(CFB_TO_MADDEN.offensive).length, 11);
check('CFB_TO_MADDEN covers all 9 real CFB defensive scheme names', Object.keys(CFB_TO_MADDEN.defensive).length, 9);
check('MADDEN_TO_CFB covers all 11 real Madden offensive scheme names', Object.keys(MADDEN_TO_CFB.offensive).length, 11);
check('MADDEN_TO_CFB covers all 10 real Madden defensive scheme names', Object.keys(MADDEN_TO_CFB.defensive).length, 10);
check('crossSchemeName: a name-identical row', crossSchemeName('OFF_AIR_RAID', 'offensive', 'cfbToMadden'), { name: 'AirRaid', verified: true });
check('crossSchemeName: a judgement-call row is marked unverified', crossSchemeName('DEF_4_2_5', 'defensive', 'cfbToMadden').verified, false);
assert.throws(() => crossSchemeName('NOT_A_SCHEME', 'offensive', 'cfbToMadden'), /no cfbToMadden mapping/);
passed++;

console.log(`\n  Carousel map spec: ${passed} assertions passed.`);
