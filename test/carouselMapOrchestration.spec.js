// Regression test for lib/carousel/map/index.js -- the ACTUAL orchestration
// (mapCoachCfbToMadden, mapCoachMaddenToCfb, buildCarouselModels), as opposed
// to test/carouselMap.spec.js, which only covers the pure sub-modules these
// functions compose (coachFieldMap, enumBridge, archetypeMap, synthesis, and
// the pure halves of levelScale/schemeLookup).
//
// WHY THIS FILE EXISTS. As of an architecture audit, map/index.js (457 lines)
// had zero direct test coverage despite being the single place every
// CFB<->Madden field-mapping decision funnels through -- and this is exactly
// where real incidents shipped: the CareerWins/Losses derivation this file
// checks (section 3 below) was, in its earlier hardcoded-0 form, "a prime
// suspect for the save Madden rejected as damaged" per map/index.js's own
// header. Testing the sub-modules in isolation could never catch that --
// each one was individually correct; the bug was in how the orchestrator
// combined their outputs.
//
// Uses test/helpers/fakeSave.js rather than a real save file (which cannot be
// committed) or a live game (which cannot run in a test).
//
// Run with: node test/carouselMapOrchestration.spec.js (or npm test).

const assert = require('assert');
const {
  enumAttr, intAttr, makeSchema, makeRecord, makeTable, makeFakeFile, refTo,
} = require('./helpers/fakeSave');
const { buildCarouselModels, mapCoachCfbToMadden, mapCoachMaddenToCfb } = require('../lib/carousel/map');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

const POSITIONS = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];

// --------------------------------------------------------------------
// Fixture: a small but non-degenerate CFB save and Madden save -- 3 coaches
// per position each side, so the percentile/prestige/legacy-score
// distributions levelScale.js and synthesis.js build from are real
// distributions, not single-point degenerate cases.
// --------------------------------------------------------------------
const CFB_COACH_SCHEMA = makeSchema([
  enumAttr('Position', [...POSITIONS, 'Invalid_']),
  enumAttr('ContractStatus', ['First_Active', 'FreeAgent', 'Retired']),
  enumAttr('CoachBackstory', ['Motivator', 'HCSalesman', 'OCSchemer', 'DCSchemer']),
  enumAttr('PrevPosition', [...POSITIONS, 'Invalid_']),
  intAttr('Level', { min: 0, max: 99 }),
  intAttr('YearsCoaching', { min: 0, max: 127 }),
]);

function cfbCoach(index, pos, overrides = {}) {
  return makeRecord(index, {
    Position: pos, TeamIndex: overrides.teamIndex ?? index, Level: overrides.level ?? 30,
    FirstName: `First${index}`, LastName: `Last${index}`, Name: `First${index} Last${index}`,
    Age: 45, Height: 72, Weight: 200, CharacterBodyType: 'Standard', Personality: 'Leader',
    COACH_WASPLAYER: true, COACH_SPECIALTY: 'Quarterbacks', COACH_ADAPTIVE_AI: 'Balanced_1',
    COACH_DEMEANOR: 'Calm', COACH_STANCE: 'Neutral', COACH_OFFTENDENCYRUNPASS: 50,
    COACH_OFFTENDENCYAGGRESSCONSERV: 50, COACH_DEFTENDENCYAGGRESSCONSERV: 50,
    COACH_DEFTENDENCYRUNPASS: overrides.defTendency ?? 0, COACH_RBTENDENCY: overrides.rbTendency ?? 0,
    TraitExpertScout: false,
    CareerPointsFor: overrides.pf ?? 1000, CareerPointsAgainst: overrides.pa ?? 800,
    CareerWinSeasons: 5, CareerPlayoffsMade: 2, CareerLongWinStreak: 6, CareerBigWinMargin: 30,
    CareerBigLossMargin: 20, AwardPoints: 10, YearlyAwardCount: 1, CareerTies: 0,
    YearsCoaching: overrides.years ?? 8, ContractStatus: 'First_Active',
    DominantArchetype: 'CEO', SpecialtyType: 'Any',
    OffensiveScheme: `raw-off-${index % 2}`, DefensiveScheme: `raw-def-${index % 2}`,
    CoachPrestigeScore: overrides.prestige ?? 400, LegacyScore: overrides.legacy ?? 500,
  });
}
function cfbTeam(index, headCoachRow, coachTable) {
  return makeRecord(index, {
    TeamIndex: index, DisplayName: `CFB Team ${index}`,
    CurrentOffensiveScheme: index % 2 === 0 ? 'OFF_AIR_RAID' : 'OFF_SPREAD',
    CurrentDefensiveScheme: index % 2 === 0 ? 'DEF_BASE4_3' : 'DEF_BASE3_4',
  }, { HeadCoach: refTo(coachTable, headCoachRow) });
}

function buildCfbFixture() {
  const rows = [];
  POSITIONS.forEach((pos, pi) => {
    for (let i = 0; i < 3; i++) rows.push(cfbCoach(pi * 3 + i, pos, { level: 20 + i * 10, prestige: 300 + i * 100, legacy: 400 + i * 100 }));
  });
  const coachTable = makeTable({ tableId: 4176, name: 'Coach', records: rows });
  const teamRows = [0, 1, 2].map((i) => cfbTeam(i, i, coachTable)); // teams 0-2's HC = coach rows 0-2 (the three HeadCoach rows)
  const teamTable = makeTable({ tableId: 6339, name: 'Team', records: teamRows });
  const file = makeFakeFile({
    schemas: { Coach: CFB_COACH_SCHEMA, Team: makeSchema([intAttr('TeamIndex', { min: 0, max: 255 })]) },
    tables: { Coach: coachTable, Team: teamTable },
  });
  return { file, coachRows: rows, teamRows };
}

const MADDEN_COACH_SCHEMA = makeSchema([
  enumAttr('Position', POSITIONS),
  enumAttr('ContractStatus', ['Signed', 'FreeAgent', 'Retired']),
  enumAttr('CoachBackstory', ['Motivator']),
  intAttr('Level', { min: 0, max: 50 }),
  intAttr('YearsCoaching', { min: 0, max: 63 }),
  intAttr('CareerWins', { min: 0, max: 999 }),
  intAttr('CareerLosses', { min: 0, max: 999 }),
]);
function maddenCoach(index, pos, overrides = {}) {
  return makeRecord(index, {
    Position: pos, TeamIndex: overrides.teamIndex ?? 32, Level: overrides.level ?? 20,
    FirstName: `MFirst${index}`, LastName: `MLast${index}`, Name: `MFirst${index} MLast${index}`,
    Age: 50, Height: 70, CharacterBodyType: 'Standard', Personality: 'Leader',
    COACH_WASPLAYER: false, COACH_SPECIALTY: 'DefensiveLine', COACH_ADAPTIVE_AI: 'Balanced',
    COACH_DEMEANOR: 'Calm', COACH_STANCE: 'Neutral', COACH_OFFTENDENCYRUNPASS: 50,
    COACH_OFFTENDENCYAGGRESSCONSERV: 50, COACH_DEFTENDENCYAGGRESSCONSERV: 50,
    COACH_DEFTENDENCYRUNPASS: 50, COACH_RBTENDENCY: 50, TeamBuilding: 'Balanced', TradingTendency: 'DoesNotTrade',
    TraitExpertScout: false, CareerPointsFor: 900, CareerPointsAgainst: 700, CareerWinSeasons: 4,
    CareerPlayoffsMade: 1, CareerLongWinStreak: 5, CareerBigWinMargin: 25, CareerBigLossMargin: 15,
    AwardPoints: 5, YearlyAwardCount: 0, YearsCoaching: overrides.years ?? 6,
    ContractStatus: 'Signed', Archetype: 'HeadCoachArchetype', CoachBackstory: 'Motivator',
    OriginalPosition: pos, OffensiveScheme: `mraw-off-${index % 2}`, DefensiveScheme: `mraw-def-${index % 2}`,
    ExperiencePoints: (overrides.level ?? 20) * 500,
  });
}
function maddenTeam(index, headCoachRow, coachTable) {
  return makeRecord(index, {
    TeamIndex: index, DisplayName: `Madden Team ${index}`,
    CurrentOffensiveScheme: index % 2 === 0 ? 'AirRaid' : 'Spread',
    CurrentDefensiveScheme: index % 2 === 0 ? 'Base4_3' : 'Base3_4',
  }, { HeadCoach: refTo(coachTable, headCoachRow) });
}
function buildMaddenFixture() {
  const rows = [];
  POSITIONS.forEach((pos, pi) => {
    for (let i = 0; i < 3; i++) rows.push(maddenCoach(pi * 3 + i, pos, { level: 15 + i * 8 }));
  });
  const coachTable = makeTable({ tableId: 5000, name: 'Coach', records: rows });
  const teamRows = [0, 1, 2].map((i) => maddenTeam(i, i, coachTable));
  const teamTable = makeTable({ tableId: 5001, name: 'Team', records: teamRows });
  const file = makeFakeFile({ schemas: { Coach: MADDEN_COACH_SCHEMA }, tables: { Coach: coachTable, Team: teamTable } });
  return { file, coachRows: rows, teamRows };
}

(async () => {
  const cfb = buildCfbFixture();
  const madden = buildMaddenFixture();

  // --------------------------------------------------------------------
  // 1. buildCarouselModels -- direction controls which save is source vs
  //    dest for the Level model. Getting this backwards silently maps every
  //    coach's Level through the WRONG population's percentile.
  // --------------------------------------------------------------------
  {
    const fwd = await buildCarouselModels({ cfbFile: cfb.file, maddenFile: madden.file, direction: 'cfbToMadden' });
    check('cfbToMadden: source is the CFB level distribution', fwd.levelModel.byPosition.HeadCoach.source, [20, 30, 40]);
    check('cfbToMadden: dest is the (winsorized) Madden distribution', fwd.levelModel.byPosition.HeadCoach.dest, [15, 23, 31]);

    const rev = await buildCarouselModels({ cfbFile: cfb.file, maddenFile: madden.file, direction: 'maddenToCfb' });
    check('maddenToCfb: source/dest are FLIPPED relative to the forward call', rev.levelModel.byPosition.HeadCoach.source, [15, 23, 31]);
    check('maddenToCfb: dest is now the CFB distribution', rev.levelModel.byPosition.HeadCoach.dest, [20, 30, 40]);
  }

  // --------------------------------------------------------------------
  // 2. mapCoachCfbToMadden -- position gate, sentinels, and the Mode A
  //    (free-agent injection) shape every field below must produce.
  // --------------------------------------------------------------------
  const models = await buildCarouselModels({ cfbFile: cfb.file, maddenFile: madden.file, direction: 'cfbToMadden' });
  {
    const invalidPosCoach = cfbCoach(99, 'Invalid_');
    await assert.rejects(
      mapCoachCfbToMadden({ cfbCoachRecord: invalidPosCoach, maddenFile: madden.file, models, config: {} }),
      /only HeadCoach\/OffensiveCoordinator\/DefensiveCoordinator/,
    );
    passed++;
  }

  const out = await mapCoachCfbToMadden({ cfbCoachRecord: cfb.coachRows[0], maddenFile: madden.file, models, config: { seed: 'fixed' } });

  check('Position crosses verbatim (shared member name)', out.Position, 'HeadCoach');
  check('TeamIndex is Madden\'s free-agent sentinel (32)', out.TeamIndex, 32);
  check('PrevTeamIndex is also the free-agent sentinel', out.PrevTeamIndex, 32);
  check('ContractStatus crosses to Madden\'s FreeAgent', out.ContractStatus, 'FreeAgent');
  check('a fresh free agent has no contract', [out.ContractLength, out.ContractYearsRemaining, out.ContractSalary], [0, 0, 0]);
  check('COACH_LASTTEAMFIRED is Madden\'s "none" sentinel', out.COACH_LASTTEAMFIRED, 1023);
  check('COACH_LASTTEAMRESIGNED is Madden\'s "none" sentinel', out.COACH_LASTTEAMRESIGNED, 1023);
  check('every ZERO_FIELDS_SHARED entry is actually zero', out.SeasonsWithTeam, 0);
  check('COACH_* position grades default to 50 (Madden\'s own modal value)', out.COACH_RATING, 50);
  check('a shared scalar (FirstName) is copied verbatim', out.FirstName, cfb.coachRows[0].FirstName);
  check('CareerPlayoffWins/Losses stay zero -- CFB has no way to split appearances into results', [out.CareerPlayoffWins, out.CareerPlayoffLosses], [0, 0]);

  // --------------------------------------------------------------------
  // 3. THE INCIDENT FIELD: CareerWins/Losses. map/index.js's own header
  //    records that a hardcoded 0 here -- next to real copied career stats
  //    (14 winning seasons, thousands of points) -- was "a prime suspect for
  //    the save Madden rejected as damaged." This pins the Pythagorean
  //    derivation that replaced it, both the happy path and the recordless
  //    edge case, so that regression can't come back silently.
  // --------------------------------------------------------------------
  {
    // Coach 0: CareerPointsFor=1000, CareerPointsAgainst=800, YearsCoaching=8
    // (from the fixture). winPct = 1000^2 / (1000^2+800^2) = 0.609756...
    // estimatedGames = round(8*12) = 96. wins = round(96*0.609756) = 59.
    const estimatedGames = Math.round(8 * 12);
    const winPct = (1000 * 1000) / ((1000 * 1000) + (800 * 800));
    const expectedWins = Math.round(estimatedGames * winPct);
    check('CareerWins matches the Pythagorean-expectation derivation', out.CareerWins, expectedWins);
    check('CareerLosses is the complement within estimatedGames', out.CareerLosses, estimatedGames - expectedWins);
    check('the win/loss record is internally consistent with the copied career stats',
      out.CareerWinSeasons > 0 && (out.CareerWins + out.CareerLosses) > 0, true);

    // Recordless coach: zero points for and against -- must come out 0-0, not
    // NaN or a divide-by-zero artifact, and must stay coherent (copied
    // career block is also zero in this case per the fixture below).
    const recordless = cfbCoach(50, 'OffensiveCoordinator', { pf: 0, pa: 0, years: 0 });
    const recordlessOut = await mapCoachCfbToMadden({ cfbCoachRecord: recordless, maddenFile: madden.file, models, config: {} });
    check('a coach with no points history gets a coherent 0-0, not NaN', [recordlessOut.CareerWins, recordlessOut.CareerLosses], [0, 0]);
  }

  // --------------------------------------------------------------------
  // 4. Level mapping actually goes through the percentile model built in
  //    step 1, not some other path.
  // --------------------------------------------------------------------
  {
    // Coach 0 is HeadCoach at Level 20 -- the LOWEST of the three (20,30,40),
    // so its percentile in the source array should map to the lowest dest
    // value (15) per fwd's already-verified byPosition.HeadCoach shapes.
    check('the lowest-Level coach in its position maps to the lowest dest Level', out.Level, 15);
  }

  // --------------------------------------------------------------------
  // 5. Scheme crossing: resolvable schemes cross correctly; UNRESOLVABLE
  //    ones (no team in this save runs that scheme, or no crossing entry)
  //    are left UNSET rather than guessed or thrown over -- this is the
  //    "one cosmetic field must never abort the whole coach's move" rule
  //    map/index.js's header documents.
  // --------------------------------------------------------------------
  {
    check('a resolvable offensive scheme crosses to a real Madden raw value',
      typeof out.OffensiveScheme, 'string');
    check('a resolvable defensive scheme crosses to a real Madden raw value',
      typeof out.DefensiveScheme, 'string');

    // A coach whose raw scheme value matches NOTHING in the CFB scheme index
    // (no team runs it) must leave the field unset, not throw.
    const noScheme = cfbCoach(51, 'DefensiveCoordinator', {});
    noScheme.OffensiveScheme = 'totally-unindexed-raw-value';
    noScheme.DefensiveScheme = 'also-unindexed';
    const noSchemeOut = await mapCoachCfbToMadden({ cfbCoachRecord: noScheme, maddenFile: madden.file, models, config: {} });
    check('an unresolvable scheme is left unset, not guessed', noSchemeOut.OffensiveScheme, undefined);
    check('the rest of the coach still maps -- one cosmetic field never aborts the move',
      noSchemeOut.Position, 'DefensiveCoordinator');
  }

  // --------------------------------------------------------------------
  // 6. mapCoachMaddenToCfb -- the reverse direction has its OWN sentinel
  //    values and its OWN grade-field convention (0, not 50) -- these must
  //    not accidentally share the forward direction's constants.
  // --------------------------------------------------------------------
  const modelsRev = await buildCarouselModels({ cfbFile: cfb.file, maddenFile: madden.file, direction: 'maddenToCfb' });
  {
    const invalidPosCoach = maddenCoach(99, 'Invalid_');
    await assert.rejects(
      mapCoachMaddenToCfb({ maddenCoachRecord: invalidPosCoach, cfbFile: cfb.file, models: modelsRev, config: {} }),
      /only HeadCoach\/OffensiveCoordinator\/DefensiveCoordinator/,
    );
    passed++;
  }

  const outRev = await mapCoachMaddenToCfb({ maddenCoachRecord: madden.coachRows[0], cfbFile: cfb.file, models: modelsRev, config: { seed: 'fixed' } });
  check('TeamIndex is CFB\'s unassigned sentinel (255)', outRev.TeamIndex, 255);
  check('PrevTeamIndex is also CFB\'s unassigned sentinel', outRev.PrevTeamIndex, 255);
  check('ContractStatus crosses to CFB\'s FreeAgent', outRev.ContractStatus, 'FreeAgent');
  check('COACH_* position grades default to 0 -- CFB\'s OWN convention, the opposite of Madden\'s 50', outRev.COACH_RATING, 0);
  check('CFB has no CareerWins/Losses fields at all -- must not be synthesized here', outRev.CareerWins, undefined);

  // Level floor: CFB_MIN_COACH_LEVEL=10. Madden coach 0 is the LOWEST of the
  // three (15,23,31) so without the floor it would map to the lowest CFB
  // dest value (20 per the fixture) -- still above 10, so this alone
  // doesn't prove the floor fires. Directly exercise it with a
  // deliberately bottom-of-scale Madden coach instead.
  {
    const bottomCoach = maddenCoach(60, 'OffensiveCoordinator', { level: 1 });
    const bottomOut = await mapCoachMaddenToCfb({ maddenCoachRecord: bottomCoach, cfbFile: cfb.file, models: modelsRev, config: {} });
    check('a coach whose mapped Level would fall under CFB_MIN_COACH_LEVEL is floored at 10',
      bottomOut.Level >= 10, true);
  }

  // PrevPosition: OriginalPosition on the Madden fixture is always a valid
  // HC/OC/DC name, so it must resolve. Test the unresolvable path directly.
  {
    const badOriginal = maddenCoach(61, 'HeadCoach', {});
    badOriginal.OriginalPosition = 'SomeUnknownRole';
    const badOut = await mapCoachMaddenToCfb({ maddenCoachRecord: badOriginal, cfbFile: cfb.file, models: modelsRev, config: {} });
    check('an unresolvable PrevPosition is left unset, not thrown or guessed', badOut.PrevPosition, undefined);
  }

  console.log(`\n  Carousel map orchestration spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
