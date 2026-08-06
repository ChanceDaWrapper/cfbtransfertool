// Regression test for lib/carousel/preflight.js -- the structural gate that
// refuses a transfer or repair when a save is missing something it needs.
//
// WHAT THIS IS INSURING AGAINST. Nothing here is a bug today; every check
// passes on every real save. It exists because of two failure modes that a
// future title update could introduce, which the engine handles badly:
//
//   - a missing TABLE becomes "Cannot read properties of null (reading
//     'readRecords')" from deep inside the engine, potentially AFTER earlier
//     coaches in a batch have already been written to disk;
//   - a missing FIELD is silent, because every read goes through saveIO's
//     safe(), which returns undefined rather than throwing. If Coach.Level
//     disappeared, every coach would read as not-employed and the engine would
//     act on a completely wrong picture of the dynasty without erroring once.
//
// The two invariants that actually matter, and that this file guards:
//   1. Anything whose absence gives a WRONG ANSWER is fatal (blocks the write).
//   2. Anything that already degrades gracefully only warns -- because a
//      pre-flight that refuses valid saves is worse than no pre-flight at all.
//
// Run with: node test/preflight.spec.js (or npm test).

const assert = require('assert');
const {
  inspectCfbSave, formatRefusal, assertCfbTransferReady,
  CFB_COACH_FATAL_FIELDS, CFB_COACH_WARN_FIELDS,
  CFB_TEAM_FATAL_FIELDS, CFB_TEAM_WARN_FIELDS,
} = require('../lib/carousel/preflight');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A stand-in save. Tables present iff listed; schema fields per table.
function fakeSave({ tables = {}, schemas = {} } = {}) {
  return {
    getAllTablesByName: (n) => (tables[n] ? [{ header: { recordCapacity: 100, tableId: 1 }, name: n }] : []),
    schemaList: { getSchema: (n) => (schemas[n] ? { attributes: schemas[n].map((f) => ({ name: f })) } : null) },
  };
}
const ALL_COACH = [...CFB_COACH_FATAL_FIELDS, ...CFB_COACH_WARN_FIELDS];
const ALL_TEAM = [...CFB_TEAM_FATAL_FIELDS, ...CFB_TEAM_WARN_FIELDS];
const healthy = () => fakeSave({
  tables: { Coach: 1, Team: 1, StaffPersonContractOffer: 1 },
  schemas: { Coach: ALL_COACH, Team: ALL_TEAM },
});

// --------------------------------------------------------------------
// 1. THE MOST IMPORTANT TEST: a complete save must pass, silently.
//    A gate that fires on valid saves would break every working install.
// --------------------------------------------------------------------
{
  const r = inspectCfbSave(healthy());
  check('a complete save passes', r.ok, true);
  check('with no fatal findings', r.fatal.length, 0);
  check('and no warnings', r.warnings.length, 0);
  assert.doesNotThrow(() => assertCfbTransferReady(healthy()), 'a complete save must never be refused');
  passed++;
}

// --------------------------------------------------------------------
// 2. Missing load-bearing TABLES block the write.
// --------------------------------------------------------------------
{
  for (const missing of ['Coach', 'Team']) {
    const tables = { Coach: 1, Team: 1, StaffPersonContractOffer: 1 };
    delete tables[missing];
    const r = inspectCfbSave(fakeSave({ tables, schemas: { Coach: ALL_COACH, Team: ALL_TEAM } }));
    check(`a missing ${missing} table is fatal`, r.ok, false);
    check(`and names ${missing} in the reason`, r.fatal.some((f) => f.includes(`"${missing}"`)), true);
    assert.throws(() => assertCfbTransferReady(fakeSave({ tables, schemas: { Coach: ALL_COACH, Team: ALL_TEAM } })),
      /Cannot safely transfer/, `a missing ${missing} table must throw`);
    passed++;
  }

  // A missing table must NOT also produce a complaint per field on that table.
  const r = inspectCfbSave(fakeSave({ tables: { Team: 1 }, schemas: { Coach: ALL_COACH, Team: ALL_TEAM } }));
  check('a missing table reports once, not once per field', r.fatal.length, 1);
}

// --------------------------------------------------------------------
// 3. Missing FIELDS whose absence would silently change the answer.
//    Coach.Level is the archetype: without it every coach reads as
//    not-employed and the engine proceeds on a false picture.
// --------------------------------------------------------------------
{
  for (const field of CFB_COACH_FATAL_FIELDS) {
    const r = inspectCfbSave(fakeSave({
      tables: { Coach: 1, Team: 1, StaffPersonContractOffer: 1 },
      schemas: { Coach: ALL_COACH.filter((f) => f !== field), Team: ALL_TEAM },
    }));
    check(`a missing Coach.${field} is fatal`, r.ok, false);
    check(`and names Coach.${field}`, r.fatal.some((f) => f.includes(`Coach.${field}`)), true);
  }
  for (const field of CFB_TEAM_FATAL_FIELDS) {
    const r = inspectCfbSave(fakeSave({
      tables: { Coach: 1, Team: 1, StaffPersonContractOffer: 1 },
      schemas: { Coach: ALL_COACH, Team: ALL_TEAM.filter((f) => f !== field) },
    }));
    check(`a missing Team.${field} is fatal`, r.ok, false);
  }
}

// --------------------------------------------------------------------
// 4. THE OTHER HALF OF THE CONTRACT: optional pieces must NOT block.
//    Each of these already degrades gracefully in the engine, so refusing
//    over them would turn a working transfer into a hard failure.
// --------------------------------------------------------------------
{
  // Every optional Coach field gone at once, plus the optional table.
  const r = inspectCfbSave(fakeSave({
    tables: { Coach: 1, Team: 1 }, // StaffPersonContractOffer absent
    schemas: { Coach: CFB_COACH_FATAL_FIELDS, Team: ALL_TEAM },
  }));
  check('a save missing ONLY optional pieces still passes', r.ok, true);
  check('but every one of them is reported as a warning',
    r.warnings.length, CFB_COACH_WARN_FIELDS.length + 1); // +1 for the offer table
  assert.doesNotThrow(() => assertCfbTransferReady(fakeSave({
    tables: { Coach: 1, Team: 1 },
    schemas: { Coach: CFB_COACH_FATAL_FIELDS, Team: ALL_TEAM },
  })), 'optional-only gaps must never be refused');
  passed++;

  // Specifically the fields tied to features known to self-skip.
  for (const field of ['CharacterVisuals', 'ActiveTalentTree', 'CurrentJobSecurityPercentageRank']) {
    const s = inspectCfbSave(fakeSave({
      tables: { Coach: 1, Team: 1, StaffPersonContractOffer: 1 },
      schemas: { Coach: ALL_COACH.filter((f) => f !== field), Team: ALL_TEAM },
    }));
    check(`a missing Coach.${field} only warns`, s.ok, true);
  }
}

// --------------------------------------------------------------------
// 5. The message a user actually sees has to be usable: say what's wrong,
//    and say plainly that nothing was written.
// --------------------------------------------------------------------
{
  const r = inspectCfbSave(fakeSave({ tables: { Coach: 1 }, schemas: { Coach: ALL_COACH, Team: ALL_TEAM } }));
  const msg = formatRefusal(r, { what: 'DYNASTY-TEST' });
  check('the refusal names the save', msg.includes('DYNASTY-TEST'), true);
  check('states nothing was written', msg.includes('NOTHING WAS WRITTEN'), true);
  check('and lists the missing item', msg.includes('"Team"'), true);
}

// --------------------------------------------------------------------
// 6. A save whose schema can't be read at all is fatal, not a crash.
// --------------------------------------------------------------------
{
  const r = inspectCfbSave({
    getAllTablesByName: () => [{ header: { recordCapacity: 10, tableId: 1 } }],
    schemaList: { getSchema: () => { throw new Error('schema exploded'); } },
  });
  check('an unreadable schema is reported, not thrown', r.ok, false);
  check('and says so clearly', r.fatal.some((f) => f.includes('no readable definition')), true);
}

console.log(`\n  Preflight spec: ${passed} assertions passed.`);
