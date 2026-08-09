// Regression test for lib/carousel/timing.js -- the coach hiring-window gate
// ("we'll only place a coach in if the team has an opening right after Super
// Bowl week"). Pure logic only (isCoachHiringWindow, assertCoachHiringAllowed);
// no real save needed.
//
// UPDATED (2026-08): this gate used to apply to HeadCoach only, with OC/DC
// passing through untouched. It now applies to all three positions -- see
// section "assertCoachHiringAllowed" below for the behavior change itself.
// Run with: node test/carouselTiming.spec.js (or npm test).

const assert = require('assert');
const { isCoachHiringWindow, describeWindow, assertCoachHiringAllowed } = require('../lib/carousel/timing');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function seasonInfo(overrides) {
  return {
    currentStage: 'NFLSeason', currentWeekType: 'RegularSeason', currentWeek: 2, currentSeasonYear: 2030,
    isCoachDemandReleasePeriodActive: false, isStaffHiringPeriodActive: false,
    isStaffHiringCreateOfferPeriodActive: false, isStaffHiringEvaluateOfferPeriodActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// isCoachHiringWindow -- the real state observed in the sample save
// (NFLSeason, week 2) must read as closed; each of the four named offseason
// flags independently opens the window.
// ---------------------------------------------------------------------
check('mid-regular-season (the sample save\'s actual state) is NOT the hiring window',
  isCoachHiringWindow(seasonInfo()), false);

// WIDENED (2026-08-07). The offseason as a whole now qualifies. This case --
// OffSeason with none of the four flags set -- is the exact state a real
// user's dynasty reported from CFB's draft-results week
// (CurrentOffseasonStage=3, every flag false), which the old rule refused.
check('offseason alone, with no hiring/release flag active, IS now the window',
  isCoachHiringWindow(seasonInfo({ currentStage: 'OffSeason' })), true);

// A hiring period is now sufficient on its own, whatever stage is reported --
// the stage and the flags are independent ways in, not a conjunction.
check('PreSeason + an active hiring flag now opens the window',
  isCoachHiringWindow(seasonInfo({ currentStage: 'PreSeason', isStaffHiringPeriodActive: true })), true);
// ...but a plain PreSeason/in-season save with nothing set stays closed, which
// is what keeps this gate from being a no-op.
check('PreSeason with nothing set stays closed',
  isCoachHiringWindow(seasonInfo({ currentStage: 'PreSeason', currentWeekType: 'PreSeason' })), false);

for (const flag of ['isCoachDemandReleasePeriodActive', 'isStaffHiringPeriodActive',
  'isStaffHiringCreateOfferPeriodActive', 'isStaffHiringEvaluateOfferPeriodActive']) {
  check(`offseason + ${flag} opens the window`,
    isCoachHiringWindow(seasonInfo({ currentStage: 'OffSeason', [flag]: true })), true);
  check(`${flag} alone opens the window regardless of stage`,
    isCoachHiringWindow(seasonInfo({ [flag]: true })), true);
}

// ---------------------------------------------------------------------
// describeWindow -- human-readable, used directly in the thrown error.
// ---------------------------------------------------------------------
check('describeWindow names the actual stage/week when not the offseason',
  describeWindow(seasonInfo()), 'not the offseason (currently NFLSeason, week 2 / RegularSeason)');
check('describeWindow confirms an open offseason window',
  describeWindow(seasonInfo({ currentStage: 'OffSeason', currentWeekType: 'OffSeason', isStaffHiringPeriodActive: true })),
  'the offseason (OffSeason)');
check('describeWindow names a hiring period that fires outside the offseason',
  describeWindow(seasonInfo({ isStaffHiringPeriodActive: true })),
  'the coach hiring/demand-release window is active');
// The old "offseason, but outside the window" refusal no longer exists --
// that state now passes, and describing it as a refusal would be a lie.
check('a bare offseason describes as open, not as a refusal',
  describeWindow(seasonInfo({ currentStage: 'OffSeason', currentWeekType: 'OffSeason' })),
  'the offseason (OffSeason)');

// ---------------------------------------------------------------------
// CFB's own carousel window. Verified against a real CFB save
// (DYNASTY-DATATESTYEAR1-TEST): CFB runs its carousel at the END OF THE
// POSTSEASON, not in OffSeason -- CurrentStage=NFLSeason, week 20,
// NationalChampionship -- and signals it with a field Madden does not have,
// IsCarouselPeriodActive. The original OffSeason-only rule rejected every
// legitimate CFB window.
// ---------------------------------------------------------------------
const cfbCarousel = seasonInfo({
  currentStage: 'NFLSeason', currentWeekType: 'NationalChampionship', currentWeek: 20,
  isCarouselPeriodActive: true,
});
check('CFB\'s carousel period opens the window even though the stage is not OffSeason',
  isCoachHiringWindow(cfbCarousel), true);
check('describeWindow names the carousel period specifically',
  describeWindow(cfbCarousel), 'the coaching carousel period is active');
check('a CFB save OUTSIDE its carousel period is still closed',
  isCoachHiringWindow(seasonInfo({ currentStage: 'PreSeason', currentWeekType: 'PreSeason', isCarouselPeriodActive: false })), false);
// The Madden path must be untouched: no Madden SeasonInfo carries this field,
// so it reads undefined and every rule above it still governs.
check('an absent isCarouselPeriodActive (every Madden save) changes nothing',
  isCoachHiringWindow(seasonInfo({ currentStage: 'OffSeason', isStaffHiringPeriodActive: true })), true);

// ---------------------------------------------------------------------
// assertCoachHiringAllowed -- the actual gate placeOnTeam.js/placeOnCfbTeam.js
// enforce. THE BEHAVIOR CHANGE: this used to gate HeadCoach only and let
// OffensiveCoordinator/DefensiveCoordinator through regardless of the window.
// It now applies the identical window check to all three positions.
// ---------------------------------------------------------------------
const closedWindow = seasonInfo();
const openWindow = seasonInfo({ currentStage: 'OffSeason', isCoachDemandReleasePeriodActive: true });

for (const position of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
  assert.throws(() => assertCoachHiringAllowed(position, closedWindow), /wrong week to use this tool/,
    `${position} must be blocked outside the hiring window`);
  passed++;
  assert.doesNotThrow(() => assertCoachHiringAllowed(position, openWindow),
    `${position} must be allowed inside the hiring window`);
  passed++;
  assert.doesNotThrow(() => assertCoachHiringAllowed(position, closedWindow, { allowOffWindowHeadCoachHire: true }),
    `${position} must respect the override`);
  passed++;
}

// The error message actually explains WHY, using describeWindow's text --
// an operator (or a UI) should never have to guess. Checked for a coordinator
// specifically, since that's the position this gate is NEW for.
try {
  assertCoachHiringAllowed('OffensiveCoordinator', closedWindow);
  assert.fail('expected a throw');
} catch (e) {
  check('the thrown message explains the current state', e.message.includes(describeWindow(closedWindow)), true);
  check('the thrown message names the override', e.message.includes('allowOffWindowHeadCoachHire'), true);
  // The raw flags ride along so a blocked user's screenshot is self-diagnosing
  // rather than costing a round trip of "what does your save say?".
  check('the thrown message carries the raw season flags',
    /stage=NFLSeason .*staffHiring=false/.test(e.message), true);
}

console.log(`\n  Carousel timing spec: ${passed} assertions passed.`);
