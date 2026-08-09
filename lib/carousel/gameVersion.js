'use strict';

// Which game, and which build of it, a save came from -- resolved ONCE and
// then carried, rather than re-derived wherever a decision needs it.
//
// WHY THIS EXISTS. Version-specific behavior had accumulated in three
// unrelated places, each answering the question its own way: saveIO picks a
// CFB schema by measuring the Coach table's width, maddenTalentLayout decides
// where talent categories live by inspecting the Coach schema, and preflight
// reads the build tag out of the file header. All three are correct, but
// nothing tied them together, so a log line saying which game the user was
// actually writing to did not exist -- and when a transfer produced a save
// the game rejected, the first question ("which Madden was this?") took a
// round trip to answer.
//
// This is deliberately DETECTION, not a user-facing switch. A Madden save
// states its own year in the header and its own build in the container, so
// asking the user to pick would only introduce a way to be wrong. What was
// missing was making the answer explicit, single-sourced and visible.
//
// The draft-class exporter is the one place a real CHOICE exists, because
// M26 and M27 class files are different formats and the target save is not
// in hand at export time. That stays a user pick; this is not that.

const { safe } = require('../saveIO');

// The build stamp both games write as plain text just after the FBCHUNKS
// magic -- "Madden-26-RL12-9029966", "College-27-RL3-9080944". `RL<n>` is the
// title update: a launch save reads RL1, a patched one counts up. It is the
// only place a save records which patch produced it.
function buildTag(file) {
  try {
    const buf = file && (file.packedFileContents || file.unpackedFileContents);
    if (!buf || !buf.slice) return null;
    const m = buf.slice(0, 256).toString('latin1').match(/(?:College|Madden)-\d{2}-RL\d+-\d+/);
    return m ? m[0] : null;
  } catch (e) {
    return null;
  }
}

// The release number out of a build tag, or null when it carries none.
function releaseNumber(tag) {
  const m = /-RL(\d+)-/.exec(String(tag || ''));
  return m ? Number(m[1]) : null;
}

// Identifies an opened MADDEN save. `year` comes from the file itself (the
// library reads it out of the header and picks its schema from it), so this
// never guesses.
//
// `coachTalentsOnCoachRecord` is the one shape difference the coach carousel
// actually branches on, surfaced here so a caller can report it without
// having to walk the schema again. Madden 26 hangs the talent categories off
// the Coach record; Madden 27 puts them behind a StaffTalents holder. See
// maddenTalentLayout.js, which does the real work.
function detectMaddenVersion(maddenFile) {
  const year = maddenFile && typeof maddenFile.gameYear === 'number' ? maddenFile.gameYear : null;
  const tag = buildTag(maddenFile);
  const release = releaseNumber(tag);

  let coachTalentsOnCoachRecord = null;
  try {
    const schema = maddenFile.schemaList.getSchema('Coach');
    if (schema && schema.attributes) {
      coachTalentsOnCoachRecord = schema.attributes.some((a) => a.type === 'Talent[]');
    }
  } catch (e) { /* leave unknown */ }

  return {
    game: 'madden',
    year,
    buildTag: tag,
    release,
    coachTalentsOnCoachRecord,
    label: describe('Madden', year, release),
  };
}

// Identifies an opened CFB save. `coachFields` is the Coach table's declared
// width, which is what a title update actually changed between RL1 and RL3
// (137 -> 138) and what saveIO selects a schema on -- so reporting it makes a
// version-mismatch refusal self-explanatory.
function detectCfbVersion(cfbFile) {
  const year = cfbFile && typeof cfbFile.gameYear === 'number' ? cfbFile.gameYear : null;
  const tag = buildTag(cfbFile);
  const release = releaseNumber(tag);

  let coachFields = null;
  try {
    const schema = cfbFile.schemaList.getSchema('Coach');
    if (schema && schema.attributes) coachFields = schema.attributes.length;
  } catch (e) { /* leave unknown */ }

  return {
    game: 'cfb',
    year,
    buildTag: tag,
    release,
    coachFields,
    label: describe('College Football', year, release),
  };
}

function describe(name, year, release) {
  const y = year == null ? '?' : year;
  return release == null ? `${name} ${y}` : `${name} ${y} (RL${release})`;
}

// One line naming both saves, for the log a user reads before anything is
// written. This is the line that was missing.
function describePairing(cfbVersion, maddenVersion) {
  const cfb = cfbVersion ? cfbVersion.label : 'unknown CFB save';
  const mad = maddenVersion ? maddenVersion.label : 'unknown Madden save';
  return `${cfb}  <->  ${mad}`;
}

module.exports = {
  detectMaddenVersion, detectCfbVersion, describePairing, buildTag, releaseNumber,
};
