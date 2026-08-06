// Regression test for lib/carousel/run.js -- the headless entry point behind
// the Coach Carousel UI (PIPELINE_APP_INTEGRATION_SPEC.md Part C.1).
//
// scanCoaches/proposeMoves/commitMoves themselves open real saves
// (openCfbSave/openMaddenSave) and orchestrate the whole engine end to end,
// so -- matching this project's own convention (no test/*.spec.js touches a
// real save; full-orchestration paths like planTeamPlacement are instead
// validated against real saves under research/) -- they're validated by
// research/probe28-run-integration.js, not here.
//
// What IS fixture-testable without a save file is resolveTone and
// checkAppearanceHeadroom: the two pieces of genuinely new logic run.js adds
// on top of the already-tested lower modules. Both are exported from run.js
// specifically for this.
//
// Run with: node test/carouselRun.spec.js (or npm test).

const assert = require('assert');
const { resolveTone, checkAppearanceHeadroom } = require('../lib/carousel/run');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// ---------------------------------------------------------------------
// resolveTone -- precedence: explicit config tone > override map > the
// coach's own head name > null ("would be guessed").
// ---------------------------------------------------------------------
(function testResolveTone() {
  const overrides = new Map([['Unique_C_FreemanMarcus_659', 7]]);

  check('reads tone directly off a Generic_* head name',
    resolveTone('Generic_0011_C_T0010_H_8_1', overrides), { tone: 8, toneWasGuessed: false });

  check('falls back to the override map for a Unique_* head with no encoded tone',
    resolveTone('Unique_C_FreemanMarcus_659', overrides), { tone: 7, toneWasGuessed: false });

  check('is guessed (null) for a Unique_* head with no override',
    resolveTone('Unique_C_SomeCoach_123', overrides), { tone: null, toneWasGuessed: true });

  check('an explicit tone always wins, even over a readable head name',
    resolveTone('Generic_0011_C_T0010_H_8_1', overrides, 3), { tone: 3, toneWasGuessed: false });

  check('an explicit tone wins over an override too',
    resolveTone('Unique_C_FreemanMarcus_659', overrides, 2), { tone: 2, toneWasGuessed: false });

  check('empty overrides map + unreadable head -> guessed',
    resolveTone('Unique_C_Nobody_1', new Map()), { tone: null, toneWasGuessed: true });
})();

// ---------------------------------------------------------------------
// checkAppearanceHeadroom -- counts free CharacterVisuals rows via whichever
// coach record's own reference points at that table (mirrors
// research/probe25-transfer-bug-audit.js's own approach, now reused as a
// pre-commit safety rail -- COACH_TRANSFER_AUDIT.md P7).
// ---------------------------------------------------------------------
function fakeCoachRow(index, ref) {
  return { index, isEmpty: false, getReferenceDataByKey: (k) => (k === 'CharacterVisuals' ? ref : null) };
}
function fakeVisualsRow(index, isEmpty) { return { index, isEmpty }; }
function fakeMaddenFile({ coachRows, visualsTableId, visualsRows }) {
  const coachTable = { header: { recordCapacity: coachRows.length, tableId: 4160 }, records: coachRows, readRecords: async () => {} };
  const visualsTable = { header: { recordCapacity: visualsRows.length, tableId: visualsTableId }, records: visualsRows, readRecords: async () => {} };
  return {
    getAllTablesByName: (name) => (name === 'Coach' ? [coachTable] : []),
    getTableById: (id) => (id === visualsTableId ? visualsTable : null),
  };
}

(async () => {
  const file1 = fakeMaddenFile({
    coachRows: [
      fakeCoachRow(0, null), // no ref -- skipped while searching for the table id
      fakeCoachRow(1, { tableId: 7000, rowNumber: 0 }),
    ],
    visualsTableId: 7000,
    visualsRows: [fakeVisualsRow(0, false), fakeVisualsRow(1, true), fakeVisualsRow(2, true), fakeVisualsRow(3, false)],
  });
  const room = await checkAppearanceHeadroom(file1, 2);
  check('finds the CharacterVisuals table via the first coach that has a reference to it', room.free, 2);
  check('ok when exactly enough free rows exist', room.ok, true);

  const tooFew = await checkAppearanceHeadroom(file1, 3);
  check('not ok when more rows are needed than are free', tooFew.ok, false);
  check('reports how many were needed', tooFew.needed, 3);

  const file2 = fakeMaddenFile({ coachRows: [fakeCoachRow(0, null)], visualsTableId: 7000, visualsRows: [] });
  const noRef = await checkAppearanceHeadroom(file2, 5);
  check('cannot find the visuals table (no coach has a reference) -- does not block on a check it cannot run',
    [noRef.free, noRef.ok], [null, true]);

  console.log(`\n  Carousel run spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
