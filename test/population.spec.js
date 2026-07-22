// Regression test for lib/rosetta/population.js -- who actually left college.
// Run with: node test/population.spec.js (or npm test).
//
// Locks the persuaded-player fix: a player who declares early and is then
// TALKED OUT OF IT keeps their EarlyNFL_* LeaveType and only flips
// LeaveStatus to 'Staying'. Filtering on LeaveType alone therefore lets them
// into the draft class even though they're returning to college -- the exact
// bug reported against a real 2030 Boise State save (an 89 OVR WR who came
// back for another year but still showed up in the exported class).
//
// Uses hand-built fakes rather than a real save so the suite runs anywhere.
// buildExitSelection resolves a LeavingPlayer reference via
// playerTable.records[rowNumber], so in these fakes a player's array position
// IS its row number -- keep them aligned.

const assert = require('assert');
const path = require('path');
const populationPath = path.join(__dirname, '..', 'lib', 'rosetta', 'population.js');
const { buildExitSelection, EARLY_NFL_LEAVE_TYPES } = require(populationPath);

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

// --- minimal fakes matching the madden-franchise surface we actually use ---
const reader = (fields) => (k) => {
  if (!(k in fields)) throw new Error(`no field ${k}`);
  return fields[k];
};
// array position == row index, matching how the real Player table behaves
const mkPlayers = (specs) => specs.map((fields, i) => ({
  index: i, isEmpty: false, getValueByKey: reader(fields),
}));
const leavingRec = (fields, playerRow) => ({
  isEmpty: false,
  getValueByKey: reader(fields),
  getReferenceDataByKey: (k) => (k === 'Player' ? { tableId: 1, rowNumber: playerRow } : null),
});
function fakeCfb(players, leaving) {
  const playerTable = { header: { tableId: 1 }, records: players, readRecords: async () => {} };
  const leavingTable = { records: leaving, readRecords: async () => {} };
  return {
    getTableByName: (n) => (n === 'Player' ? playerTable : null),
    getAllTablesByName: (n) => (n === 'LeavingPlayer' && leaving ? [leavingTable] : []),
  };
}
const TEAMS = { 11: 'Boise State' };
const ctx = (cfbFile) => ({ cfbFile, teamNames: TEAMS, config: {}, log: () => {} });
const nameOf = (s) => s.prec.getValueByKey('LastName');

const T = 11; // an FBS TeamIndex
const PERSUADED = { SchoolYear: 'Sophomore', TeamIndex: T, LastName: 'Potoae', OverallRating: 89, TraitDevelopment: 'Normal' };
const ENTRANT = { SchoolYear: 'Junior', TeamIndex: T, LastName: 'RealEntrant', OverallRating: 88, TraitDevelopment: 'Normal' };
const SENIOR = { SchoolYear: 'Senior', TeamIndex: T, LastName: 'Senior', OverallRating: 70, TraitDevelopment: 'Normal' };

(async () => {
  // 1. THE BUG: a persuaded early entrant must be excluded entirely.
  {
    const players = mkPlayers([PERSUADED, ENTRANT, SENIOR]);
    const cfb = fakeCfb(players, [
      // keeps its EarlyNFL type -- only LeaveStatus marks the reversal
      leavingRec({ LeaveType: 'EarlyNFL_5', LeaveStatus: 'Staying', ProjectRound: 5, PersuadeAttempts: 1 }, 0),
      leavingRec({ LeaveType: 'EarlyNFL_2', LeaveStatus: 'Unknown', ProjectRound: 2, PersuadeAttempts: 0 }, 1),
    ]);
    const sel = await buildExitSelection(ctx(cfb));
    const names = sel.map(nameOf);
    check('persuaded player is excluded', names.includes('Potoae'), false);
    check('genuine early entrant still included', names.includes('RealEntrant'), true);
    check('graduating senior still included', names.includes('Senior'), true);
    check('selection size', sel.length, 2);
    check('diagnostics count the persuaded player', sel.diagnostics.stayingCount, 1);
  }

  // 2. 'Unknown' must NOT be treated as staying -- that's the normal state at
  //    the Draft Stage, and excluding it would empty the whole class.
  {
    const cfb = fakeCfb(mkPlayers([ENTRANT]),
      [leavingRec({ LeaveType: 'EarlyNFL_1', LeaveStatus: 'Unknown', ProjectRound: 1, PersuadeAttempts: 0 }, 0)]);
    const sel = await buildExitSelection(ctx(cfb));
    check("LeaveStatus 'Unknown' still counts as leaving", sel.length, 1);
    check('no false staying count', sel.diagnostics.stayingCount, 0);
  }

  // 3. An explicit 'Leaving' status is obviously still leaving.
  {
    const cfb = fakeCfb(mkPlayers([ENTRANT]),
      [leavingRec({ LeaveType: 'EarlyNFL_3', LeaveStatus: 'Leaving', ProjectRound: 3, PersuadeAttempts: 1 }, 0)]);
    const sel = await buildExitSelection(ctx(cfb));
    check("LeaveStatus 'Leaving' counts as leaving", sel.length, 1);
  }

  // 4. The senior path must respect it too: a rostered SENIOR marked staying
  //    can't be quietly re-added by the roster scan after being filtered out
  //    of the declared list.
  {
    const STAYING_SENIOR = { SchoolYear: 'Senior', TeamIndex: T, LastName: 'StayingSenior', OverallRating: 80, TraitDevelopment: 'Normal' };
    const cfb = fakeCfb(mkPlayers([STAYING_SENIOR, ENTRANT]), [
      leavingRec({ LeaveType: 'EarlyNFL_4', LeaveStatus: 'Staying', ProjectRound: 4, PersuadeAttempts: 1 }, 0),
      leavingRec({ LeaveType: 'EarlyNFL_2', LeaveStatus: 'Unknown', ProjectRound: 2, PersuadeAttempts: 0 }, 1),
    ]);
    const sel = await buildExitSelection(ctx(cfb));
    const names = sel.map(nameOf);
    check('staying senior is NOT re-added by the roster scan', names.includes('StayingSenior'), false);
    check('only the genuine entrant remains', sel.length, 1);
  }

  // 5. Non-EarlyNFL leave types (transfers etc.) stay excluded -- the staying
  //    filter must not have widened the allowlist.
  //
  //    Tested under Regime A (at least one real EarlyNFL entry present). With
  //    ONLY a transfer row there'd be no EarlyNFL entries at all, so the code
  //    would fall back to Regime B and PREDICT declarations from the roster --
  //    which legitimately picks up a draft-worthy junior regardless of any
  //    LeavingPlayer row, and would be testing the wrong thing.
  {
    const TRANSFER = { SchoolYear: 'Junior', TeamIndex: T, LastName: 'Transfer', OverallRating: 85, TraitDevelopment: 'Normal' };
    const cfb = fakeCfb(mkPlayers([ENTRANT, TRANSFER]), [
      leavingRec({ LeaveType: 'EarlyNFL_2', LeaveStatus: 'Unknown', ProjectRound: 2, PersuadeAttempts: 0 }, 0),
      leavingRec({ LeaveType: 'Transfer_Playtime', LeaveStatus: 'Unknown', ProjectRound: 0, PersuadeAttempts: 0 }, 1),
    ]);
    const sel = await buildExitSelection(ctx(cfb));
    const names = sel.map(nameOf);
    check('transfers are still excluded', names.includes('Transfer'), false);
    check('the real early entrant is kept', names.includes('RealEntrant'), true);
    check('only the entrant is selected', sel.length, 1);
    ok('EarlyNFL allowlist is intact', EARLY_NFL_LEAVE_TYPES.has('EarlyNFL_1') && !EARLY_NFL_LEAVE_TYPES.has('Transfer_Playtime'));
  }

  console.log(`\n  Population spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
