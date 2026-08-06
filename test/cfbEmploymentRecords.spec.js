// Regression test for lib/carousel/cfbEmploymentRecords.js -- the fix for a
// real user's dynasty that CRASHED every time they advanced past bowl week
// after a Madden->CFB transfer.
//
// The engine landed arriving coaches on blank free-agent shells and promoted
// them to employed without attaching CareerStats/SeasonStats/CharacterVisuals
// or fixing TeamPhilosophy. 408 of 408 genuine employed coaches owned all of
// those; all 6 transferred coaches owned none. The game walks every employed
// coach's records at season rollover, which is exactly where it died.
//
// Run with: node test/cfbEmploymentRecords.spec.js (or npm test).

const assert = require('assert');
const { freshStatsFieldValues, findEmploymentDonor, attachCfbEmploymentRecords } = require('../lib/carousel/cfbEmploymentRecords');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
async function throws(label, fn, pattern) {
  let threw = false, message = '';
  try { await fn(); } catch (e) { threw = true; message = e.message; }
  assert.ok(threw, `${label}: expected a throw, got none`);
  if (pattern) assert.ok(pattern.test(message), `${label}: ${JSON.stringify(message)} does not match ${pattern}`);
  passed++;
}

// --------------------------------------------------------------------
// Fixture kit -- records are their own fields, so a write by the code
// under test is visible to a later read (same convention as
// test/talentTree.spec.js; see its header).
// --------------------------------------------------------------------
// A real reference field reads back as a 32-bit BITSTRING via getValueByKey
// (15-bit tableId + 17-bit rowNumber) and as a {tableId,rowNumber} object via
// getReferenceDataByKey -- see lib/saveIO.js's own note. The fixture has to
// reproduce both, because the production copy path checks for the bitstring
// first. An earlier version of this fixture returned only objects, so that
// path never fired and the test "passed" a code path it never exercised.
const bits = (tableId, rowNumber) => tableId.toString(2).padStart(15, '0') + rowNumber.toString(2).padStart(17, '0');
const parseBits = (s) => ({ tableId: parseInt(s.slice(0, 15), 2), rowNumber: parseInt(s.slice(15), 2) });

function makeRecord(index, fields = {}) {
  const rec = { index, isEmpty: false };
  Object.assign(rec, fields);
  rec.getValueByKey = function (k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined; };
  rec.getReferenceDataByKey = function (k) {
    const v = this[k];
    if (v && typeof v === 'object' && ('tableId' in v || 'rowNumber' in v)) return v;
    if (typeof v === 'string' && /^[01]{32}$/.test(v)) return parseBits(v);
    return null;
  };
  return rec;
}
function makeEmpty(index) { return { index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null }; }
function dense(recs, minCap = 0) {
  const max = Math.max(minCap - 1, recs.reduce((m, r) => Math.max(m, r.index), -1));
  const a = new Array(max + 1);
  for (let i = 0; i < a.length; i++) a[i] = makeEmpty(i);
  for (const r of recs) a[r.index] = r;
  return a;
}
function makeTable(tableId, name, recs, attrNames = [], minCap = 0) {
  const records = dense(recs, minCap);
  return {
    name, header: { tableId, recordCapacity: records.length }, records,
    readRecords: async () => {},
    getBinaryReferenceToRecord: (i) => ({ tableId, rowNumber: i }),
    schema: { attributes: attrNames.map((n) => ({ name: n })) },
  };
}
function makeFile(tables) {
  const list = Object.values(tables);
  return {
    getTableById: (id) => tables[id] || null,
    getAllTablesByName: (n) => list.filter((t) => t.name === n),
  };
}
const REF = (tableId, rowNumber) => ({ tableId, rowNumber });

const T = { COACH: 4160, CAREER: 4235, SEASON: 4131, VIS: 4226 };
const CAREER_FIELDS = ['Wins', 'Losses', 'BowlWins', 'RecentYearNCWon'];
const BLOB = JSON.stringify({ loadouts: [{ loadoutType: 'CoachOnField', loadoutCategory: 'CoachApparel', loadoutElements: [{ slotType: 'OuterShirt', itemAssetName: 'CoachWardrobe_Polo' }] }] });

// --------------------------------------------------------------------
// freshStatsFieldValues -- THE rule that decides a new row's contents.
// --------------------------------------------------------------------
(function testFreshStatsFieldValues() {
  // Mirrors real data: RecentYearNCWon is -2 for most coaches but a real year
  // for the few who won one, so it VARIES -- an earlier "copy only constant
  // fields" rule zeroed it and asserted a title win in year 0.
  const donors = [
    makeRecord(0, { Wins: 10, Losses: 3, BowlWins: 1, RecentYearNCWon: -2 }),
    makeRecord(1, { Wins: 4, Losses: 8, BowlWins: 0, RecentYearNCWon: -2 }),
    makeRecord(2, { Wins: 12, Losses: 1, BowlWins: 2, RecentYearNCWon: 2025 }),
    makeRecord(3, { Wins: 7, Losses: 5, BowlWins: 0, RecentYearNCWon: -2 }),
  ];
  const table = makeTable(T.CAREER, 'CareerCoachStats', donors, CAREER_FIELDS);
  const starts = freshStatsFieldValues(table, donors);

  check('an accumulator starts at 0 (Wins)', starts.get('Wins'), 0);
  check('an accumulator starts at 0 (Losses)', starts.get('Losses'), 0);
  check('an accumulator starts at 0 even when 0 is common (BowlWins)', starts.get('BowlWins'), 0);
  check('a NEGATIVE-mode field is a "never" sentinel and is preserved, not zeroed',
    starts.get('RecentYearNCWon'), -2);

  // The sentinel must survive even when the real-year winners outnumber a
  // naive "is it constant" check -- mode, not constancy, is the rule.
  const mostlyWinners = [
    makeRecord(0, { RecentYearNCWon: -2 }), makeRecord(1, { RecentYearNCWon: -2 }),
    makeRecord(2, { RecentYearNCWon: 2024 }), makeRecord(3, { RecentYearNCWon: 2025 }),
  ];
  const t2 = makeTable(T.CAREER, 'CareerCoachStats', mostlyWinners, ['RecentYearNCWon']);
  check('sentinel still wins when it is merely the most common value',
    freshStatsFieldValues(t2, mostlyWinners).get('RecentYearNCWon'), -2);
})();

// --------------------------------------------------------------------
// findEmploymentDonor -- must model on a coach who actually has a job AND
// owns every structure; never a free agent, never a blank shell.
// --------------------------------------------------------------------
(function testFindEmploymentDonor() {
  const complete = { CareerStats: REF(T.CAREER, 0), SeasonStats: REF(T.SEASON, 0), CharacterVisuals: REF(T.VIS, 0) };
  const freeAgent = makeRecord(0, { TeamIndex: 255, Level: 30, ...complete });
  const blankShell = makeRecord(1, { TeamIndex: 5, Level: 0, ...complete });
  const missingStats = makeRecord(2, { TeamIndex: 5, Level: 30, CharacterVisuals: REF(T.VIS, 0) });
  const good = makeRecord(3, { TeamIndex: 5, Level: 30, ...complete });

  const recs = dense([freeAgent, blankShell, missingStats, good]);
  check('skips free agents, blank shells and coaches missing structures', findEmploymentDonor(recs).index, 3);
  check('honours excludeRows', findEmploymentDonor(recs, { excludeRows: [3] }), null);
})();

// --------------------------------------------------------------------
// attachCfbEmploymentRecords -- end to end on a shell that mirrors the
// user's actual damage.
// --------------------------------------------------------------------
(async () => {
  function buildFile() {
    const careerRows = [
      makeRecord(0, { Wins: 10, Losses: 3, BowlWins: 1, RecentYearNCWon: -2 }),
      makeRecord(1, { Wins: 5, Losses: 7, BowlWins: 0, RecentYearNCWon: -2 }),
    ];
    const seasonRows = [makeRecord(0, { Wins: 3, Losses: 1 }), makeRecord(1, { Wins: 2, Losses: 2 })];
    const visRows = [makeRecord(0, { RawData: BLOB }), makeRecord(1, { RawData: BLOB })];

    // Two healthy employed coaches, plus the broken shell we just wrote onto.
    const healthyA = makeRecord(10, {
      Name: 'Real HC', TeamIndex: 7, Level: 40, Position: 'HeadCoach',
      CareerStats: REF(T.CAREER, 0), SeasonStats: REF(T.SEASON, 0), CharacterVisuals: REF(T.VIS, 0),
      TeamPhilosophy: bits(16453, 900), DefaultTeamPhilosophy: bits(16453, 900),
    });
    const healthyB = makeRecord(11, {
      Name: 'Real OC', TeamIndex: 7, Level: 20, Position: 'OffensiveCoordinator',
      CareerStats: REF(T.CAREER, 1), SeasonStats: REF(T.SEASON, 1), CharacterVisuals: REF(T.VIS, 1),
      TeamPhilosophy: bits(16453, 901), DefaultTeamPhilosophy: bits(16453, 901),
    });
    // The damaged coach: employed, but shell-shaped -- exactly the user's save.
    const broken = makeRecord(12, {
      Name: 'Transferred HC', TeamIndex: 7, Level: 30, Position: 'HeadCoach',
      TeamPhilosophy: bits(16433, 5), DefaultTeamPhilosophy: bits(16433, 5),
    });

    const coachTable = makeTable(T.COACH, 'Coach', [healthyA, healthyB, broken]);
    const careerTable = makeTable(T.CAREER, 'CareerCoachStats', careerRows, CAREER_FIELDS, 6);
    const seasonTable = makeTable(T.SEASON, 'SeasonCoachStats', seasonRows, ['Wins', 'Losses'], 6);
    const visTable = makeTable(T.VIS, 'CharacterVisuals', visRows, ['RawData'], 6);
    const teamRecord = makeRecord(0, {
      TeamIndex: 7, DisplayName: 'Test U',
      HeadCoach: REF(T.COACH, 12), OffensiveCoordinator: REF(T.COACH, 11),
    });
    const teamTable = makeTable(5000, 'Team', [teamRecord]);
    const file = makeFile({ [T.COACH]: coachTable, [T.CAREER]: careerTable, [T.SEASON]: seasonTable, [T.VIS]: visTable, 5000: teamTable });
    return { file, broken, healthyA, healthyB, teamRecord, careerTable, visTable };
  }

  const { file, broken, teamRecord, careerTable } = buildFile();
  const report = await attachCfbEmploymentRecords(file, broken, { teamRecord, incumbent: null });

  check('attaches all three missing structures', report.attached.length, 3);
  check('CareerStats now set', !!broken.getReferenceDataByKey('CareerStats'), true);
  check('SeasonStats now set', !!broken.getReferenceDataByKey('SeasonStats'), true);
  check('CharacterVisuals now set', !!broken.getReferenceDataByKey('CharacterVisuals'), true);

  const newCareerRow = careerTable.records[broken.CareerStats.rowNumber];
  check('the new career row zeroes accumulators', [newCareerRow.Wins, newCareerRow.Losses, newCareerRow.BowlWins], [0, 0, 0]);
  check('and preserves the never-won-a-title sentinel', newCareerRow.RecentYearNCWon, -2);

  check('the allocated career row is NOT one an existing coach already uses',
    [0, 1].includes(broken.CareerStats.rowNumber), false);

  // THE SELF-INHERITANCE BUG. When repairing, the damaged coach is already
  // installed in the team's HeadCoach slot -- an unguarded peer walk finds
  // THEM and "inherits" the very broken value being repaired. Caught live on
  // two head coaches during the first repair run of the user's save.
  check('philosophy is NOT inherited from the coach being repaired', parseBits(broken.TeamPhilosophy).tableId, 16453);
  check('it came from a genuine staff peer', /staff peer \(Real OC\)/.test(report.philosophy), true);

  // Already-healthy coach: nothing to do, nothing clobbered.
  const second = buildFile();
  const healthyReport = await attachCfbEmploymentRecords(second.file, second.healthyA, { teamRecord: second.teamRecord, incumbent: null });
  check('a coach who already owns their records has none re-allocated', healthyReport.attached.length, 0);
  check('and their existing rows are reported as kept', healthyReport.reused.sort(),
    ['CareerStats', 'CharacterVisuals', 'SeasonStats']);

  // Capacity exhaustion must throw, not silently write a crashing coach.
  const third = buildFile();
  for (const r of third.careerTable.records) if (r.isEmpty) { r.isEmpty = false; }
  await throws('a full stats table throws rather than writing a coach that would crash on advance',
    () => attachCfbEmploymentRecords(third.file, third.broken, { teamRecord: third.teamRecord, incumbent: null }),
    /no free rows left in CareerStats/);

  console.log(`\n  CFB employment records spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
