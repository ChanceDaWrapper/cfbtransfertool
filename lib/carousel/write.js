// The Written stage (lifecycle.js) -- actually assigns a mapped field bag
// onto a destination record and persists the save. Mirrors
// lib/pipeline.js's writeCareerFile pattern exactly: fields are set via
// direct property assignment (verified against the vendored madden-franchise
// library -- FranchiseFileRecord is a Proxy whose setter writes through to
// the underlying field, and `autoUnempty: true` -- already passed by
// openMaddenSave -- un-empties a row the moment any field on it changes, so
// writing into a genuinely empty row needs no separate "activate" call).
//
// NEVER overwrites the source file in place: `outputPath` is always a
// distinct destination the caller chooses (a save-as dialog in the UI,
// exactly like main.js's existing 'write-career' IPC handler), matching
// writeCareerFile's own contract.

// Assigns every field in `fields` onto `record`, skipping any field whose
// value is `undefined` -- map/index.js deliberately leaves some fields
// unset (appearance, an unresolved scheme) rather than guessing, and an
// undefined write must mean "don't touch this field", not "write undefined".
function writeCoachFields(record, fields) {
  const written = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    try {
      record[key] = value;
      written.push(key);
    } catch (e) {
      throw new Error(`writeCoachFields: failed to set ${key} = ${JSON.stringify(value)} on `
        + `Coach row ${record.index}: ${e.message}`);
    }
  }
  return written;
}

async function saveAs(file, outputPath) {
  await file.save(outputPath);
}

module.exports = { writeCoachFields, saveAs };
