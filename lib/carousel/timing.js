// Reads Madden's own season/offseason state (SeasonInfo) and answers the
// one timing question the carousel needs: is this a legitimate window for a
// coaching change?
//
// UPDATED (2026-08): this used to gate ONLY HeadCoach hires, on a locked
// scoping decision that OC/DC moves happen any time. That was intentional at
// the time, but the restriction is now extended to every position -- a
// coordinator hire is gated by the exact same destination-save window a head
// coach hire always was. `config.allowOffWindowHeadCoachHire` still overrides
// it for all three positions; the config key name is unchanged (not renamed)
// so an existing saved "on" preference keeps working rather than silently
// reverting to restricted.
//
// COACH_CAROUSEL_ROADMAP.md's Q7 flagged the destination game's own hiring
// system as the single highest-risk unknown for carousel automation --
// writing a coach change mid-season risks the next advance fighting or
// undoing it. Rather than guessing a week number ("right after Super Bowl
// week"), this reads the EXACT flags Madden's own Staff Hiring / Coach
// Demand Release UI is gated by -- verified live against SeasonInfo's real
// schema and the sample save's actual state (currently
// CurrentStage=NFLSeason, week 2 of the regular season -- i.e. NOT this
// window, which is itself a useful sanity check that the gate isn't a no-op).

const { safe } = require('../saveIO');

async function readSeasonInfo(maddenFile) {
  const t = maddenFile.getTableByName('SeasonInfo');
  if (!t) throw new Error('readSeasonInfo: this save has no SeasonInfo table.');
  await t.readRecords();
  const r = t.records.find((x) => !x.isEmpty);
  if (!r) throw new Error('readSeasonInfo: SeasonInfo table has no populated record.');
  return {
    currentStage: safe(r, 'CurrentStage'), // 'PreSeason' | 'NFLSeason' | 'OffSeason'
    currentWeekType: safe(r, 'CurrentWeekType'), // ...'SuperBowl' | 'PostSeason' | 'OffSeason' | ...
    currentWeek: safe(r, 'CurrentWeek'),
    currentSeasonYear: safe(r, 'CurrentSeasonYear'),
    isCoachDemandReleasePeriodActive: !!safe(r, 'IsCoachDemandReleasePeriodActive'),
    isStaffHiringPeriodActive: !!safe(r, 'IsStaffHiringPeriodActive'),
    isStaffHiringCreateOfferPeriodActive: !!safe(r, 'IsStaffHiringCreateOfferPeriodActive'),
    isStaffHiringEvaluateOfferPeriodActive: !!safe(r, 'IsStaffHiringEvaluateOfferPeriodActive'),
    // CFB-ONLY. Madden's SeasonInfo has no such field, so `safe` returns
    // undefined there and every Madden decision below is unchanged.
    isCarouselPeriodActive: !!safe(r, 'IsCarouselPeriodActive'),
  };
}

// "Right after Super Bowl Week" -- the real-world coaching-carousel window --
// maps onto Madden's own offseason coach-turnover window: the Coach Demand
// Release period (teams shed coaches) and the Staff Hiring period (teams
// hire replacements, in either its offer-creation or offer-evaluation
// stage). Gating on these named flags is far more robust than pinning an
// exact week number, and it is literally what the game's own hiring UI uses.
// CORRECTION (2026-07-24). An earlier note in this file's history claimed
// timing.js "works against a CFB save unmodified". It READS one fine -- CFB's
// SeasonInfo carries the same four field names -- but its DECISION was
// Madden-shaped and wrong for CFB, in two ways found by testing against a
// real CFB save sitting in its own carousel window:
//
//   1. CFB's carousel does NOT run in `OffSeason`. It runs at the end of the
//      postseason -- DYNASTY-DATATESTYEAR1-TEST reads CurrentStage=NFLSeason,
//      week 20, CurrentWeekType=NationalChampionship. The `OffSeason` gate
//      alone therefore rejected every legitimate CFB hiring window.
//   2. CFB has its OWN direct signal the four shared flags never capture:
//      `IsCarouselPeriodActive`, true in exactly that save. (The save's table
//      list corroborates it -- CoachCarouselStartEvent,
//      CoachCarousel_PostSeasonWeekStart/EndReaction.)
//
// So CFB gets its own branch, checked first. Madden saves have no
// IsCarouselPeriodActive field at all, so `safe` yields undefined there and
// every Madden decision -- including all of carouselTiming.spec.js's original
// assertions -- is bit-for-bit unchanged.
// WIDENED (2026-08-07): the whole offseason now counts, not just the weeks
// when one of the four named hiring flags happens to be set.
//
// The old rule required BOTH `CurrentStage === 'OffSeason'` AND one of those
// flags. That was modelled on Madden's own Staff Hiring UI, which is a
// defensible thing to mirror -- but it turned out to reject saves that are
// plainly in a sensible place to move a coach. A real report: a dynasty
// sitting at CFB's draft-results week reads
//
//   CurrentStage = OffSeason, CurrentOffseasonStage = 3,
//   IsCarouselPeriodActive = false, all four hiring flags = false
//
// which the old rule refused, with a message ("offseason, but outside the
// coach hiring/demand-release window") that reads like a bug to anyone
// looking at their own offseason menu. The four flags mark the weeks the
// GAME runs its own hiring logic; they are not a statement about when a save
// is safe to edit, which is the question this gate actually needs answered.
//
// So the flags are no longer required -- they are now only one of the ways
// in. Kept as an explicit branch rather than deleted because a save can sit
// in a hiring period without the stage reading OffSeason (exactly how CFB's
// carousel behaves), and that case must still pass.
function isCoachHiringWindow(seasonInfo) {
  // CFB's carousel period -- fires at the end of the postseason, while the
  // stage still reads NFLSeason, so it must be checked independently.
  if (seasonInfo.isCarouselPeriodActive) return true;
  // Any hiring/demand-release period, whatever stage the save reports.
  if (seasonInfo.isCoachDemandReleasePeriodActive
    || seasonInfo.isStaffHiringPeriodActive
    || seasonInfo.isStaffHiringCreateOfferPeriodActive
    || seasonInfo.isStaffHiringEvaluateOfferPeriodActive) return true;
  // The whole offseason, flags or not.
  return seasonInfo.currentStage === 'OffSeason';
}

function describeWindow(seasonInfo) {
  // CFB's carousel window, named for what it actually is -- checked before the
  // stage test, since it legitimately fires outside `OffSeason`.
  if (seasonInfo.isCarouselPeriodActive) return 'the coaching carousel period is active';
  if (isCoachHiringWindow(seasonInfo)) {
    return seasonInfo.currentStage === 'OffSeason'
      ? `the offseason (${seasonInfo.currentWeekType || seasonInfo.currentStage})`
      : 'the coach hiring/demand-release window is active';
  }
  // The only remaining case: in-season. There is no longer an "offseason but
  // outside the window" refusal -- the whole offseason passes.
  return `not the offseason (currently ${seasonInfo.currentStage}, week ${seasonInfo.currentWeek} / ${seasonInfo.currentWeekType})`;
}

// The raw flags behind a refusal, for a user-reportable error. Guessing at a
// blocked user's save state over chat cost a full round trip more than once;
// printing the actual values makes a screenshot self-diagnosing.
function windowFlagSummary(seasonInfo) {
  return `stage=${seasonInfo.currentStage} week=${seasonInfo.currentWeek} `
    + `type=${seasonInfo.currentWeekType} carousel=${seasonInfo.isCarouselPeriodActive} `
    + `demandRelease=${seasonInfo.isCoachDemandReleasePeriodActive} `
    + `staffHiring=${seasonInfo.isStaffHiringPeriodActive} `
    + `createOffer=${seasonInfo.isStaffHiringCreateOfferPeriodActive} `
    + `evalOffer=${seasonInfo.isStaffHiringEvaluateOfferPeriodActive}`;
}

// The gate itself, as a pure decision (no I/O). Applies to EVERY position --
// HeadCoach, OffensiveCoordinator, DefensiveCoordinator all require the
// destination save to be in its own hiring window (previously only HeadCoach
// was gated; OC/DC passed through untouched). `config.allowOffWindowHeadCoachHire`
// is an explicit, named override for testing/exploration -- never a silent
// bypass -- and still covers all three positions under its original name.
// Kept separate from readSeasonInfo (which needs an open save) so the actual
// branching logic is directly unit-testable with a fixture.
function assertCoachHiringAllowed(position, seasonInfo, config = {}) {
  if (config.allowOffWindowHeadCoachHire) return;
  if (!isCoachHiringWindow(seasonInfo)) {
    // Names the DESTINATION save's own window, not a specific game's. This
    // gate always reads whichever save the coach is landing in -- CFB's
    // carousel period for a CFB destination, Madden's hiring/demand-release
    // window for a Madden one. The old wording said "Madden's" unconditionally,
    // which read as though a CFB-bound move was being blocked by the Madden
    // save's calendar.
    throw new Error('This is the wrong week to use this tool for a coach hire -- the '
      + `destination save is currently ${describeWindow(seasonInfo)}. `
      + 'Coach moves are allowed any time during the offseason. '
      + 'To place coaches anyway, turn on '
      + '"Allow coach hires outside the hiring window" on the Coach Settings page '
      + `(config: allowOffWindowHeadCoachHire). [${windowFlagSummary(seasonInfo)}]`);
  }
}

// I/O-touching wrapper: reads the live save only when the gate could actually
// apply (no override) -- a dry-run/no-op call never pays for a SeasonInfo read
// it doesn't need.
async function enforceCoachHiringWindow(maddenFile, position, config = {}) {
  if (config.allowOffWindowHeadCoachHire) return;
  const seasonInfo = await readSeasonInfo(maddenFile);
  assertCoachHiringAllowed(position, seasonInfo, config);
}

module.exports = {
  readSeasonInfo, isCoachHiringWindow, describeWindow, windowFlagSummary,
  assertCoachHiringAllowed, enforceCoachHiringWindow,
};
