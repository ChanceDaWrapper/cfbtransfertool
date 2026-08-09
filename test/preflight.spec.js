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
  inspectCfbSave, formatRefusal, assertCfbTransferReady, tableLayoutMismatch,
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

// --------------------------------------------------------------------
// 7. TABLE LAYOUT MISMATCH -- a save from a NEWER game build than the
//    schema Pipeline ships.
//
//    From a real report. A user's dynasty had a Coach table declaring 138
//    members while every CFB 27 schema available declares 137. The franchise
//    library refuses to bind a schema whose member count disagrees with the
//    table header and silently substitutes a generic one whose fields are
//    named Field_0..Field_137 -- so all 497 coaches in the save read back
//    completely blank, with no error anywhere. The carousel then reported
//    "0 candidates" going out and "no disposable Coach row available" coming
//    in, neither of which points at the actual cause.
//
//    This is distinct from the missing-FIELD checks above: the schema LIST
//    still has every field name, so those checks all pass. Only the table's
//    own declared width reveals it.
// --------------------------------------------------------------------
function sizedSave({ coachMembers, teamMembers } = {}) {
  const widths = { Coach: coachMembers, Team: teamMembers };
  return {
    getAllTablesByName: (n) => (['Coach', 'Team', 'StaffPersonContractOffer'].includes(n)
      ? [{ name: n, header: { recordCapacity: 100, tableId: 1, ...(widths[n] !== undefined ? { numMembers: widths[n] } : {}) } }]
      : []),
    schemaList: { getSchema: (n) => (n === 'Coach' ? { attributes: ALL_COACH.map((f) => ({ name: f })) }
      : n === 'Team' ? { attributes: ALL_TEAM.map((f) => ({ name: f })) } : null) },
  };
}

{
  // Matching width: passes, exactly as before this check existed.
  const okSave = sizedSave({ coachMembers: ALL_COACH.length, teamMembers: ALL_TEAM.length });
  check('a save whose table width matches passes', inspectCfbSave(okSave).ok, true);
  check('and raises no warning', inspectCfbSave(okSave).warnings.length, 0);
  check('tableLayoutMismatch reports null when widths agree',
    tableLayoutMismatch(okSave, 'Coach'), null);

  // The real case: Coach one member wider than the schema knows about.
  const newer = sizedSave({ coachMembers: ALL_COACH.length + 1, teamMembers: ALL_TEAM.length });
  check('tableLayoutMismatch reports both numbers',
    tableLayoutMismatch(newer, 'Coach'), { declared: ALL_COACH.length + 1, known: ALL_COACH.length });
  const r = inspectCfbSave(newer);
  check('a wider Coach table is FATAL', r.ok, false);
  check('and is reported once', r.fatal.length, 1);
  check('the message gives both field counts',
    /has \d+ fields, but the version of College Football 27 Pipeline supports has \d+/.test(r.fatal[0]), true);
  check('the message points at a game update, not a broken dynasty',
    /game has been updated/.test(r.fatal[0]), true);
  assert.throws(() => assertCfbTransferReady(newer), /Coach" table has/,
    'a save from a newer game build must be refused');
  passed++;

  // A NARROWER table is equally unreadable -- the check must not assume the
  // save is always the newer of the two (a user on an older build than the
  // one Pipeline was made for hits this in reverse).
  const older = sizedSave({ coachMembers: ALL_COACH.length - 1, teamMembers: ALL_TEAM.length });
  check('a narrower Coach table is also fatal', inspectCfbSave(older).ok, false);

  // Team is deliberately only a WARNING: its layout has been observed to
  // disagree by one member on saves whose Coach table reads perfectly, and
  // the carousel reads only a handful of Team fields. Refusing there would
  // block dynasties that work.
  const teamOnly = sizedSave({ coachMembers: ALL_COACH.length, teamMembers: ALL_TEAM.length + 1 });
  const tr = inspectCfbSave(teamOnly);
  check('a Team-only width mismatch does NOT refuse the transfer', tr.ok, true);
  check('but it does warn', tr.warnings.length, 1);

  // A header with no numMembers at all (older library, or a fixture) must be
  // treated as "cannot tell", never as a mismatch -- silence beats a false
  // refusal on a save that is actually fine.
  const unknown = sizedSave({});
  check('an unknown table width is not treated as a mismatch',
    tableLayoutMismatch(unknown, 'Coach'), null);
  check('and such a save still passes', inspectCfbSave(unknown).ok, true);
}

console.log(`\n  Preflight spec: ${passed} assertions passed.`);
