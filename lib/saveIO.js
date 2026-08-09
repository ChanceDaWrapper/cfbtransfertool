// Shared save-I/O core -- extracted from pipeline.js so a second engine
// (lib/carousel/, the coaching-carousel) can open CFB/Madden saves without
// duplicating the schema-override constants, the open/validate error
// messages, or the "which of the save's duplicate tables is the real one"
// logic. pipeline.js requires this back (see its own requires below) so
// there is exactly one place that knows how to open a save; no behavior
// changed for any existing caller.
//
// Per COACH_CAROUSEL_ROADMAP.md Phase 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FranchiseFile = require('madden-franchise');

const PROJECT = path.join(__dirname, '..');
// Full CFB 27 schema (Core+Football+Franchise, major 809). Unlocks the Team
// table's real fields plus SeasonStats/CareerStats -- needed for career
// production weighting and reliable school names. Replaces the old
// Franchise-only 468/2 schema. (Full-schema extraction approach adapted from
// seanpdwyer7/cfb2madden.)
const CFB_SCHEMA_GZ = path.join(PROJECT, 'data', 'schemas', 'CFB27_809_0.gz');
const CFB_SCHEMA_MAJOR = 809;
const CFB_SCHEMA_MINOR = 0;

// CFB 27 title updates change the Coach table's width, and the franchise
// library will not bind a schema whose member count disagrees with the table
// header -- it silently substitutes a generic one whose fields are named
// Field_0..Field_N, so every read comes back blank with no error raised.
// A dynasty from CFB 27's third release (build tag "College-27-RL3-...")
// carries a 138-field Coach table; one from launch (RL1) carries 137.
//
// So there is a schema per known layout, chosen by measuring the save rather
// than by trusting a version number: open with the default, read the Coach
// table's own declared width, and if it disagrees, reopen with whichever
// schema matches. Adding support for a future release means adding one row
// here.
//
// The RL3 entry is the 809 schema with one extra member spliced in. The save
// itself supplies every field's real offset and length (the library reads a
// per-field indexOffset straight out of the table), so a schema only has to
// supply NAMES in the right order and the correct COUNT -- which is why a
// placeholder for the one unidentified field is sufficient, and why that
// field is never written. Verified by reading the reported dynasty back:
// 497/497 valid positions, 492 real coach names (Dave Aranda Lv37 age 52,
// Tom Allen DC age 58, ...), matching the shape of a known-good save.
const CFB_SCHEMAS = [
  { major: 809, minor: 0, coachMembers: 137, path: CFB_SCHEMA_GZ, label: 'CFB 27 launch (RL1/RL2)' },
  {
    major: 810, minor: 0, coachMembers: 138,
    path: path.join(PROJECT, 'data', 'schemas', 'CFB27_810_0_RL3.gz'),
    label: 'CFB 27 third release (RL3)',
  },
];

const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

// getValueByKey() on a REFERENCE-typed field (Scheme, TeamPhilosophy,
// CareerStats, ...) returns a useless raw bitstring, not the pointer --
// verified against a live save (a Coach's OffensiveScheme reads back as
// "10000000011000111011001110001000" via safe(), not a {tableId,rowNumber}).
// getReferenceDataByKey() is the actual pointer accessor. Same
// throws-on-missing defensiveness as safe(), for the identical reason: a
// field absent from one game's schema (or a null reference) must not throw.
const safeRef = (r, k) => { try { return r.getReferenceDataByKey(k) || null; } catch (e) { return null; } };

// Default save-game folders for the two games, resolved for whatever machine
// this runs on. Windows often redirects Documents into OneDrive, so check
// both; first one that exists wins. Used only to pre-fill the native file
// dialog's starting directory.
function firstExistingDir(candidates) {
  for (const c of candidates) { try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* skip */ } }
  return null;
}
const HOME = os.homedir();
function defaultCfbSavesDir() {
  return firstExistingDir([
    path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves'),
    path.join(HOME, 'OneDrive', 'Documents', 'EA SPORTS College Football 27', 'saves'),
  ]);
}
// Newest installed Madden first. Scanning for "Madden NFL <year>" rather than
// listing 26 explicitly means a new title's saves folder is found the year it
// ships, instead of silently starting the file dialog in the wrong game's
// folder until someone edits this list. Falls back to the fixed pair so the
// behavior is unchanged on a machine where neither Documents root is
// readable.
const MADDEN_DIR_RE = /^Madden NFL (\d{2,4})$/;
function maddenSaveDirCandidates() {
  const roots = [path.join(HOME, 'Documents'), path.join(HOME, 'OneDrive', 'Documents')];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    for (const name of entries) {
      const m = MADDEN_DIR_RE.exec(name);
      if (m) found.push({ year: Number(m[1]), dir: path.join(root, name, 'Saves') });
    }
  }
  found.sort((a, b) => b.year - a.year);
  return [...found.map((f) => f.dir),
    path.join(HOME, 'Documents', 'Madden NFL 26', 'Saves'),
    path.join(HOME, 'OneDrive', 'Documents', 'Madden NFL 26', 'Saves')];
}
function defaultMaddenSavesDir() {
  return firstExistingDir(maddenSaveDirCandidates());
}

// The Saves folder for ONE specific Madden year, so an export can default to the
// folder of the game it was actually built for rather than whichever install
// happens to be newest. Falls back to the general search when that year isn't
// installed. (Madden 26 ships the folder as "Saves"; Madden 27 as "saves" --
// Windows is case-insensitive so either resolves, but both spellings are tried
// for safety.)
function maddenSavesDirForYear(year) {
  const roots = [path.join(HOME, 'Documents'), path.join(HOME, 'OneDrive', 'Documents')];
  const candidates = [];
  for (const root of roots) {
    for (const saves of ['Saves', 'saves']) {
      candidates.push(path.join(root, `Madden NFL ${year}`, saves));
    }
  }
  return firstExistingDir(candidates) || defaultMaddenSavesDir();
}

// Opens a CFB 27 save with the schema override the whole extraction path
// needs, and derives its int Rating* field list from that schema. Kept
// verbatim from its original home in pipeline.js (same open call, same error
// messages, same ratingFields derivation) -- callers that don't need
// ratingFields (e.g. the coach carousel) just ignore that half of the return.
async function openWithCfbSchema(cfbSavePath, entry) {
  return FranchiseFile.create(cfbSavePath, {
    schemaOverride: { major: entry.major, minor: entry.minor, gameYear: 27, path: entry.path },
    gameYearOverride: 27, autoUnempty: true,
  });
}

async function openCfbSave(cfbSavePath) {
  let cfbFile;
  try {
    cfbFile = await openWithCfbSchema(cfbSavePath, CFB_SCHEMAS[0]);

    // Does this dynasty's Coach table actually match the schema we just used?
    // Measured, not assumed -- a title update changes the width and the library
    // reports no error, it just reads everything back blank. See CFB_SCHEMAS.
    const coachTable = biggestTableByName(cfbFile, 'Coach');
    const declared = coachTable && coachTable.header ? coachTable.header.numMembers : undefined;
    if (typeof declared === 'number' && declared !== CFB_SCHEMAS[0].coachMembers) {
      const better = CFB_SCHEMAS.find((s) => s.coachMembers === declared && fs.existsSync(s.path));
      // No match is not an error here: preflight raises the actionable refusal
      // (naming the widths and the save's build tag), and every other caller
      // still gets a usable file object rather than a throw from the opener.
      if (better) cfbFile = await openWithCfbSchema(cfbSavePath, better);
    }
  } catch (e) {
    throw new Error(
      `Could not open "${cfbSavePath}" as a CFB 27 dynasty save (${e.message}). `
      + `Make sure you picked a CFB 27 save file, not a Madden save or something else.`
    );
  }

  const playerTable = cfbFile.getTableByName('Player');
  if (!playerTable) {
    throw new Error(
      `"${cfbSavePath}" opened, but it has no Player table -- this isn't a CFB 27 dynasty save `
      + `(did you pick a Madden save by mistake?).`
    );
  }

  const playerSchema = cfbFile.schemaList.getSchema('Player');
  const ratingFields = playerSchema.attributes
    .filter((a) => a.type === 'int' && /Rating$/.test(a.name))
    .map((a) => a.name);

  return { cfbFile, ratingFields };
}

// Opens a Madden franchise save. Bare opener only -- unlike openCfbSave,
// this does NOT assert a Player table exists, because callers want different
// tables (writeCareerFile wants Player, the coach carousel wants Coach); each
// caller does its own table check right after opening, same as before this
// was extracted.
//
// No schema override: the library picks the bundled schema matching the
// save's own gameYear/major/minor, so Madden 26 and 27 both open through this
// one path. Which of them a given FEATURE supports is a separate question the
// caller answers -- the coach carousel handles both; see maddenTalentLayout.js
// for the shape difference it absorbs.
async function openMaddenSave(maddenSavePath) {
  try {
    const maddenFile = await FranchiseFile.create(maddenSavePath, { autoUnempty: true });
    return { maddenFile };
  } catch (e) {
    throw new Error(
      `Could not open "${maddenSavePath}" as a Madden franchise save (${e.message}). `
      + `Make sure you picked a Madden career save file, not a CFB save or something else.`
    );
  }
}

// Both games keep more than one table under some names (e.g. two Coach
// tables, two Team tables in these sample saves). The one actually in use is
// the one with the larger record capacity -- pipeline.js's buildTeamNames
// already did this dance for 'Team'; this generalizes it for any table name
// so the carousel doesn't have to duplicate the reduce.
function biggestTableByName(file, name) {
  const tables = file.getAllTablesByName(name) || [];
  return tables.reduce((best, t) => (
    t.header.recordCapacity > (best ? best.header.recordCapacity : 0) ? t : best
  ), null);
}

module.exports = {
  PROJECT,
  CFB_SCHEMA_GZ,
  CFB_SCHEMA_MAJOR,
  CFB_SCHEMA_MINOR,
  CFB_SCHEMAS,
  safe,
  safeRef,
  firstExistingDir,
  defaultCfbSavesDir,
  defaultMaddenSavesDir,
  maddenSavesDirForYear,
  openCfbSave,
  openMaddenSave,
  biggestTableByName,
};
