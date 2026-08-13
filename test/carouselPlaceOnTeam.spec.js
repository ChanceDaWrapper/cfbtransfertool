// Regression test for lib/carousel/placeOnTeam.js -- Mode B (direct
// placement into a named team/job). Fixture-based: fake Team/Coach tables
// that satisfy just enough of the madden-franchise record/table interface
// (.isEmpty, .index, .getValueByKey, .getReferenceDataByKey,
// getAllTablesByName/readRecords) for findMaddenTeam/findIncumbent/
// displaceIncumbent to run against, without a real save file.
// Run with: node test/carouselPlaceOnTeam.spec.js (or npm test).

const assert = require('assert');
const { findMaddenTeam, findIncumbent, displaceIncumbent } = require('../lib/carousel/placeOnTeam');
const { findDisposableSlot, synthesizeContractSalary } = require('../lib/carousel/place');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A record is just a mutable plain object with the handful of methods
// biggestTableByName's callers need -- real FranchiseFileRecords are Proxy
// objects that support the same `.field = value` / `.getValueByKey` shape,
// which is exactly what write.js and placeOnTeam.js rely on.
function fakeRecord(index, fields, refs = {}) {
  return {
    index,
    isEmpty: false,
    getValueByKey(key) { return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined; },
    getReferenceDataByKey(key) { return Object.prototype.hasOwnProperty.call(refs, key) ? refs[key] : null; },
    // property assignment (record.Field = value) is how write.js/placeOnTeam.js
    // actually write -- a plain object supports that natively, no proxy needed
    // for the test.
  };
}

function fakeEmptyRecord(index) { return { index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null }; }

function fakeFile({ teamRecords, coachRecords, coachTableId = 4160 }) {
  // A real FranchiseFileTable's .records is a DENSE array indexed BY ROW
  // NUMBER (records[17] is the record whose .index === 17; every unused row
  // still holds a real record object, just isEmpty:true -- never a hole).
  // findIncumbent relies on that indexing (`coachTable.records[ref.rowNumber]`),
  // so the fixture must build the same dense shape, not a compacted list.
  const dense = (recs) => {
    const maxIndex = recs.reduce((m, r) => Math.max(m, r.index), -1);
    const a = new Array(maxIndex + 1);
    for (let i = 0; i < a.length; i++) a[i] = fakeEmptyRecord(i);
    for (const r of recs) a[r.index] = r;
    return a;
  };
  const teamTable = { header: { recordCapacity: teamRecords.length, tableId: 5000 }, records: dense(teamRecords), readRecords: async () => {} };
  const coachTable = {
    header: { recordCapacity: coachRecords.length, tableId: coachTableId },
    records: dense(coachRecords),
    readRecords: async () => {},
    getBinaryReferenceToRecord(index) { return { tableId: coachTableId, rowNumber: index }; },
  };
  return {
    getAllTablesByName(name) {
      if (name === 'Team') return [teamTable];
      if (name === 'Coach') return [coachTable];
      return [];
    },
  };
}

// ---------------------------------------------------------------------
// findMaddenTeam -- resolves by TeamIndex or by DisplayName (case-insensitive),
// and skips pseudo-teams (no DisplayName).
// ---------------------------------------------------------------------
const giantsCoachRow17 = fakeRecord(17, { Name: 'D. Canales', Position: 'HeadCoach', Level: 9, CareerWins: 40, CareerLosses: 64 });
const giantsTeam = fakeRecord(0, { DisplayName: 'Giants', TeamIndex: 15 }, { HeadCoach: { tableId: 4160, rowNumber: 17 } });
const pseudoTeam = fakeRecord(1, { DisplayName: undefined, TeamIndex: 32 });
const file1 = fakeFile({ teamRecords: [pseudoTeam, giantsTeam], coachRecords: [] });

(async () => {
  const byIndex = await findMaddenTeam(file1, { teamIndex: 15 });
  check('findMaddenTeam resolves by teamIndex', byIndex.index, giantsTeam.index);

  const byName = await findMaddenTeam(file1, { teamName: 'giants' });
  check('findMaddenTeam resolves by name, case-insensitively', byName.index, giantsTeam.index);

  let threw = false;
  try { await findMaddenTeam(file1, { teamName: 'Nonexistent' }); } catch (e) { threw = /no team named/.test(e.message); }
  check('findMaddenTeam throws on an unknown team', threw, true);

  let pseudoThrew = false;
  try { await findMaddenTeam(file1, { teamIndex: 32 }); } catch (e) { pseudoThrew = true; }
  check('findMaddenTeam never resolves a pseudo-team (no DisplayName)', pseudoThrew, true);

  // Both args must agree -- a mismatch is a caller bug, not a coin flip on row
  // order (the Jets/Commanders incident: teamIndex 25 + "Jets" silently placed
  // on the Commanders because 25 matched first in the table).
  const ravensTeam = fakeRecord(2, { DisplayName: 'Ravens', TeamIndex: 24 }, {});
  const file1b = fakeFile({ teamRecords: [pseudoTeam, giantsTeam, ravensTeam], coachRecords: [] });
  let mismatchThrew = false;
  try { await findMaddenTeam(file1b, { teamIndex: 24, teamName: 'Giants' }); } catch (e) { mismatchThrew = /but teamName is/.test(e.message); }
  check('findMaddenTeam throws when teamIndex and teamName disagree', mismatchThrew, true);

  const agree = await findMaddenTeam(file1b, { teamIndex: 15, teamName: 'Giants' });
  check('findMaddenTeam accepts consistent teamIndex + teamName', agree.index, giantsTeam.index);

  // ---------------------------------------------------------------------
  // findIncumbent -- resolves the coach a team's slot reference points at,
  // and returns null for a vacant slot or a dangling/foreign-table reference.
  // ---------------------------------------------------------------------
  const file2 = fakeFile({ teamRecords: [giantsTeam], coachRecords: [giantsCoachRow17] });
  const incumbent = await findIncumbent(file2, giantsTeam, 'HeadCoach');
  check('findIncumbent resolves the referenced coach', incumbent && incumbent.index, 17);

  const vacantTeam = fakeRecord(2, { DisplayName: 'Vacant', TeamIndex: 99 }, {});
  const noIncumbent = await findIncumbent(file2, vacantTeam, 'HeadCoach');
  check('findIncumbent returns null for a vacant slot', noIncumbent, null);

  const danglingTeam = fakeRecord(3, { DisplayName: 'Dangling', TeamIndex: 98 }, { HeadCoach: { tableId: 9999, rowNumber: 0 } });
  const foreignRef = await findIncumbent(file2, danglingTeam, 'HeadCoach');
  check('findIncumbent returns null for a reference into a foreign/non-Coach table', foreignRef, null);

  // ---------------------------------------------------------------------
  // displaceIncumbent -- fires the incumbent into free agency IN PLACE
  // (same row, same identity/career/appearance -- only employment fields
  // change), and returns a snapshot of who they were before.
  // ---------------------------------------------------------------------
  const before = { ...giantsCoachRow17 };
  const snapshot = displaceIncumbent(giantsCoachRow17, 15);
  check('displaceIncumbent returns a snapshot of the pre-displacement state', snapshot, { row: 17, name: 'D. Canales', position: 'HeadCoach' });

  giantsCoachRow17.ContractStatus = giantsCoachRow17.ContractStatus; // no-op, just documents the field exists post-assignment
  check('displaced coach becomes a free agent', giantsCoachRow17.ContractStatus, 'FreeAgent');
  check('displaced coach lands in the FA-pool TeamIndex sentinel', giantsCoachRow17.TeamIndex, 32);
  check('displaced coach records who fired them', giantsCoachRow17.PrevTeamIndex, 15);
  check('COACH_LASTTEAMFIRED records the firing team', giantsCoachRow17.COACH_LASTTEAMFIRED, 15);
  check('contract is zeroed out', [giantsCoachRow17.ContractLength, giantsCoachRow17.ContractYearsRemaining, giantsCoachRow17.ContractSalary], [0, 0, 0]);
  check('the coach keeps their own identity (row, name) -- displacement never erases who they are',
    [giantsCoachRow17.index, giantsCoachRow17.getValueByKey('Name')], [17, 'D. Canales']);

  check('displaceIncumbent(null, ...) is a safe no-op', displaceIncumbent(null, 15), null);

  // ---------------------------------------------------------------------
  // findDisposableSlot -- preference order, and the excludeRows option that
  // makes MULTI-COACH batch planning honest.
  //
  // Without excludeRows, every coach in a batch is handed the same best row
  // (each plan runs against one unmodified save). That made a plan's reported
  // destRow wrong for everyone after the first, AND hid an oversized batch
  // until the commit was already partway through writing.
  // ---------------------------------------------------------------------
  const oldFA = fakeRecord(3, { Name: 'Old Timer', Position: 'HeadCoach', ContractStatus: 'FreeAgent', Age: 78, Level: 5, CareerWins: 20, CareerLosses: 20 });
  const nobodyA = fakeRecord(4, { Name: 'Nobody A', Position: 'HeadCoach', ContractStatus: 'FreeAgent', Age: 35, Level: 0, CareerWins: 0, CareerLosses: 0 });
  const nobodyB = fakeRecord(5, { Name: 'Nobody B', Position: 'HeadCoach', ContractStatus: 'FreeAgent', Age: 45, Level: 0, CareerWins: 0, CareerLosses: 0 });
  const established = fakeRecord(6, { Name: 'Real Coach', Position: 'HeadCoach', ContractStatus: 'FreeAgent', Age: 50, Level: 30, CareerWins: 90, CareerLosses: 40 });
  const slotFile = fakeFile({ teamRecords: [giantsTeam], coachRecords: [oldFA, nobodyA, nobodyB, established] });

  const pick1 = await findDisposableSlot(slotFile, 'HeadCoach');
  check('picks the retirement-age free agent first', pick1.record.index, 3);

  const pick2 = await findDisposableSlot(slotFile, 'HeadCoach', { excludeRows: [3] });
  check('with the old-timer claimed, falls to the YOUNGEST level-0 nobody', pick2.record.index, 4);

  const pick3 = await findDisposableSlot(slotFile, 'HeadCoach', { excludeRows: [3, 4] });
  check('claiming both falls to the next nobody, never the established coach', pick3.record.index, 5);

  // Tier 3: with every free-agent candidate claimed, a genuinely EMPTY row is
  // still a perfectly good landing slot (the fixture's dense array leaves
  // rows 0-2 empty, exactly like a real save's unused capacity).
  const pick4 = await findDisposableSlot(slotFile, 'HeadCoach', { excludeRows: [3, 4, 5] });
  check('falls through to an empty row before ever considering the established coach', pick4.record.isEmpty, true);
  check('and says so', pick4.reason, 'empty Coach row');

  // The whole point of the guard: an established coach with a real career is
  // never a landing slot, even when NOTHING else is left (the H. Flohr
  // incident). With every empty row and every disposable free agent claimed,
  // it must THROW rather than clobber him -- row 6 is still sitting there.
  let exhaustedThrew = false;
  try {
    await findDisposableSlot(slotFile, 'HeadCoach', { excludeRows: [0, 1, 2, 3, 4, 5] });
  } catch (e) { exhaustedThrew = /no disposable Coach row available/.test(e.message); }
  check('a fully exhausted pool throws rather than overwriting an established coach', exhaustedThrew, true);

  // excludeRowIndex (the original single-row guard) and excludeRows compose.
  const composed = await findDisposableSlot(slotFile, 'HeadCoach', { excludeRowIndex: 3, excludeRows: [4] });
  check('excludeRowIndex and excludeRows both apply', composed.record.index, 5);

  // -------------------------------------------------------------------
  // synthesizeContractSalary -- shared by the Madden and CFB placement
  // paths (it lived duplicated in both until it moved into place.js).
  //
  // It had NO coverage at all before this: replacing its return value with
  // a constant left all 39 specs green, which is how a rule that decides
  // what salary gets written into a real save was going unverified.
  // -------------------------------------------------------------------
  const salaryFile = (coaches) => fakeFile({ teamRecords: [], coachRecords: coaches });
  const coach = (index, position, salary, level, status = 'Signed') =>
    fakeRecord(index, { Position: position, ContractSalary: salary, Level: level, ContractStatus: status });

  // Median of the nearest-level peers, NOT the mean -- the whole point is
  // that one absurd contract cannot drag the number with it. Peers at
  // levels 4/5/6 with salaries 10/12/1000 must yield 12, not ~340.
  const outlier = salaryFile([
    coach(0, 'HeadCoach', 10, 4), coach(1, 'HeadCoach', 12, 5), coach(2, 'HeadCoach', 1000, 6),
  ]);
  check('takes the median of near-level peers, so one huge contract cannot skew it',
    await synthesizeContractSalary(outlier, 'HeadCoach', 5), 12);

  // Only peers at the SAME position count.
  const mixed = salaryFile([
    coach(0, 'HeadCoach', 100, 5), coach(1, 'OffensiveCoordinator', 7, 5), coach(2, 'HeadCoach', 100, 5),
  ]);
  check('ignores other positions', await synthesizeContractSalary(mixed, 'HeadCoach', 5), 100);

  // Only SIGNED peers count -- an unsigned coach's salary is not a market rate.
  const unsigned = salaryFile([
    coach(0, 'HeadCoach', 100, 5), coach(1, 'HeadCoach', 5, 5, 'FreeAgent'), coach(2, 'HeadCoach', 100, 5),
  ]);
  check('ignores coaches who are not Signed', await synthesizeContractSalary(unsigned, 'HeadCoach', 5), 100);

  // Zero/absent salaries are not evidence and must not be averaged in.
  const zeros = salaryFile([
    coach(0, 'HeadCoach', 0, 5), coach(1, 'HeadCoach', 50, 5), coach(2, 'HeadCoach', 50, 5),
  ]);
  check('ignores zero salaries', await synthesizeContractSalary(zeros, 'HeadCoach', 5), 50);

  // Nothing to learn from -> 0, which callers read as "leave it alone".
  // Returning an invented number here is what the function exists to avoid.
  check('returns 0 when the save has no signed peer at this position',
    await synthesizeContractSalary(salaryFile([coach(0, 'HeadCoach', 80, 5, 'FreeAgent')]), 'HeadCoach', 5), 0);
  check('returns 0 when nobody plays the requested position',
    await synthesizeContractSalary(salaryFile([coach(0, 'OffensiveCoordinator', 80, 5)]), 'HeadCoach', 5), 0);
  // (A zero-capacity Coach table is deliberately NOT tested: biggestTableByName
  // returns null for one, so this would crash -- but a real save always has a
  // populated Coach table, and a missing one is a broken-save problem that
  // belongs to preflight, not to salary synthesis.)

  // Level proximity actually drives the pick: the same pool queried at a low
  // vs high level leans toward the peers nearest that level.
  const spread = salaryFile([
    coach(0, 'HeadCoach', 10, 1), coach(1, 'HeadCoach', 20, 2), coach(2, 'HeadCoach', 30, 3),
    coach(3, 'HeadCoach', 800, 20), coach(4, 'HeadCoach', 900, 21), coach(5, 'HeadCoach', 1000, 22),
  ]);
  const lowEnd = await synthesizeContractSalary(spread, 'HeadCoach', 1);
  const highEnd = await synthesizeContractSalary(spread, 'HeadCoach', 22);
  check('a low-level coach draws from low-level peers', lowEnd < 100, true);
  check('a high-level coach draws from high-level peers', highEnd > 500, true);

  console.log(`\n  Carousel placeOnTeam spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
