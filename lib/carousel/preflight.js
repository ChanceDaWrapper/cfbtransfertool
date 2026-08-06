'use strict';

// Structural pre-flight: confirms a save actually CONTAINS everything a coach
// transfer is about to read and write, BEFORE a single byte is changed.
//
// WHY THIS EXISTS. Nothing here is a known bug today -- every check below
// passes on every real save this has been run against, and it is expected to
// stay that way. It is insurance against a specific, realistic future failure:
// EA ships a title update, a table gets renamed or a field disappears, and the
// transfer path silently does the wrong thing to somebody's dynasty.
//
// The two ways that goes wrong today, both of which this turns into a clear
// refusal instead:
//
//   1. A MISSING TABLE is a delayed crash. biggestTableByName returns null for
//      a table it can't find, and roughly thirty call sites across this module
//      immediately do `await t.readRecords()` on the result -- so the user gets
//      "Cannot read properties of null (reading 'readRecords')" from somewhere
//      deep in the engine, with no indication of which table or why. Worse, for
//      a multi-coach batch that can land AFTER earlier coaches have already
//      been written to disk.
//
//   2. A MISSING FIELD is worse than a crash, because it is SILENT. Every read
//      in this module goes through saveIO's `safe()`, which returns undefined
//      for a field that isn't there rather than throwing. If `Level` vanished,
//      `safe(coach,'Level')` would be undefined for everyone, every coach would
//      read as not-employed, and the engine would cheerfully conclude the
//      dynasty has zero employed coaches and act on it. No error, just a wrong
//      answer applied to a real save.
//
// So the rule is: anything whose absence would produce a WRONG RESULT rather
// than an obvious failure is fatal, and anything that already degrades
// gracefully is a warning. Those two lists are deliberately different sizes --
// see the tables below for which is which and why.

const { biggestTableByName } = require('../saveIO');

// Fields the engine READS to decide what to do. A missing one of these does not
// crash -- it silently reads as undefined and changes the answer, which is
// exactly why they are fatal rather than warnings.
const CFB_COACH_FATAL_FIELDS = [
  'TeamIndex',   // employment, team matching, the 255 free-agent sentinel
  'Level',       // employment test, donor selection, talent scaling
  'Position',    // placement, peer grouping, every positional baseline
  'FirstName',   // identity, written on every transfer
  'LastName',
];

// Absence changes nothing structural -- the feature that uses it reports that it
// was skipped and the transfer still completes correctly. Worth telling the user
// about, never worth refusing over.
const CFB_COACH_WARN_FIELDS = [
  'CurrentJobSecurityPercentageRank', // transferJobSecurityRank reports and moves on
  'CurrentContractExpectation',       // cfbNormalize's damage signal
  'ActiveTalentTree',                 // grantCfbTalentTree returns a skip report
  'CharacterVisuals',                 // appearance is explicitly cosmetic, already caught
  'CareerStats',
  'SeasonStats',
  'ContractStatus',
  'ContractLength',
  'ContractYearsRemaining',
  'PrevTeamIndex',
];

const CFB_TEAM_FATAL_FIELDS = [
  'TeamIndex',
  'HeadCoach',              // the three slots a coach is actually placed into
  'OffensiveCoordinator',
  'DefensiveCoordinator',
];

const CFB_TEAM_WARN_FIELDS = ['DisplayName'];

// Tables. `Coach` and `Team` are load-bearing; the rest already handle their own
// absence (findStaleOffers returns an empty result when the offer table is
// missing, rather than throwing) so they only warn.
const CFB_TABLES = [
  { name: 'Coach', severity: 'fatal', why: 'every coach read and write goes through it' },
  { name: 'Team', severity: 'fatal', why: 'a coach is placed into one of its coordinator/head-coach slots' },
  { name: 'StaffPersonContractOffer', severity: 'warn', why: 'pending contract offers cannot be repaired without it' },
];

function schemaFieldNames(file, tableName) {
  try {
    const schema = file.schemaList.getSchema(tableName);
    if (!schema || !schema.attributes) return null;
    return new Set(schema.attributes.map((a) => a.name));
  } catch (e) {
    return null;
  }
}

// Inspects one save. Returns { fatal: [...], warnings: [...] } -- never throws,
// so a caller can report everything wrong at once instead of one item per run.
function inspectCfbSave(cfbFile) {
  const fatal = [];
  const warnings = [];

  for (const t of CFB_TABLES) {
    const table = biggestTableByName(cfbFile, t.name);
    if (table) continue;
    const msg = `the "${t.name}" table is missing from this save (${t.why})`;
    if (t.severity === 'fatal') fatal.push(msg);
    else warnings.push(msg);
  }

  const checkFields = (tableName, fatalFields, warnFields) => {
    // Only meaningful if the table itself is present; a missing table is
    // already reported above and would otherwise produce a duplicate complaint
    // for every one of its fields.
    if (!biggestTableByName(cfbFile, tableName)) return;
    const names = schemaFieldNames(cfbFile, tableName);
    if (!names) {
      fatal.push(`this save's schema has no readable definition for the "${tableName}" table`);
      return;
    }
    for (const f of fatalFields) {
      if (!names.has(f)) fatal.push(`"${tableName}.${f}" is missing from this save's schema`);
    }
    for (const f of warnFields) {
      if (!names.has(f)) warnings.push(`"${tableName}.${f}" is missing -- the feature that uses it will be skipped`);
    }
  };

  checkFields('Coach', CFB_COACH_FATAL_FIELDS, CFB_COACH_WARN_FIELDS);
  checkFields('Team', CFB_TEAM_FATAL_FIELDS, CFB_TEAM_WARN_FIELDS);

  return { fatal, warnings, ok: fatal.length === 0 };
}

// Builds the message a user actually sees. Deliberately says what is missing,
// what it would have been used for, and that nothing was written -- the whole
// point is that they can tell it apart from a bug in their own dynasty.
function formatRefusal(result, { what = 'this save' } = {}) {
  const lines = [
    `Cannot safely transfer coaches into ${what} -- it is missing data this tool needs:`,
    '',
  ];
  for (const f of result.fatal) lines.push(`  - ${f}`);
  lines.push('');
  lines.push('NOTHING WAS WRITTEN. Your save is unchanged.');
  lines.push('');
  lines.push('This usually means the save was made by a different version of the game');
  lines.push('than this tool was built against. Writing to it anyway could corrupt the');
  lines.push('dynasty, so the transfer was stopped instead.');
  return lines.join('\n');
}

// The gate. Throws before any write if the destination cannot safely receive a
// transfer; otherwise returns the warnings so the caller can log them.
function assertCfbTransferReady(cfbFile, { what = 'this CFB dynasty', log = null } = {}) {
  const result = inspectCfbSave(cfbFile);
  if (!result.ok) throw new Error(formatRefusal(result, { what }));
  if (log) {
    for (const w of result.warnings) log(`  NOTE: ${w}`);
  }
  return result;
}

module.exports = {
  CFB_TABLES,
  CFB_COACH_FATAL_FIELDS,
  CFB_COACH_WARN_FIELDS,
  CFB_TEAM_FATAL_FIELDS,
  CFB_TEAM_WARN_FIELDS,
  inspectCfbSave,
  formatRefusal,
  assertCfbTransferReady,
};
