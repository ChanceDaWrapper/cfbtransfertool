// Pre-write validation -- checks every field in a mapped bag against the
// DESTINATION save's live schema before anything is written.
//
// This exists because of a real incident: a 95-field coach write produced a
// save Madden refused to load ("damaged"), and the only reason it wasn't
// caught earlier is that the verification method at the time was "re-open the
// written file with madden-franchise" -- which only proves the library can
// read its own output, never that the GAME accepts it. A no-op save (open,
// change nothing, save) was confirmed to load fine, which isolated the fault
// to the field writes themselves rather than the library's save round-trip.
//
// So: every value gets checked against the schema that will actually receive
// it -- int range, enum membership, string length -- and anything outside is
// reported rather than written. Cheap, and it turns a "damaged save" into a
// readable error message before the file is touched.

const SCALAR_INT_TYPES = new Set(['int', 'float']);

function schemaAttrs(file, table = 'Coach') {
  const schema = file.schemaList.getSchema(table);
  if (!schema) throw new Error(`validate: this save's schema has no "${table}" table.`);
  const byName = new Map();
  for (const a of schema.attributes) byName.set(a.name, a);
  return byName;
}

// Returns { ok, problems: [{field, value, reason}] }. Never throws on a bad
// value -- the caller decides whether to refuse the write or just log.
function validateCoachFields(destFile, fields, { table = 'Coach' } = {}) {
  const attrs = schemaAttrs(destFile, table);
  const problems = [];

  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue; // deliberately unset -- writer skips these

    const attr = attrs.get(field);
    if (!attr) {
      problems.push({ field, value, reason: `not a field on ${table} in the destination schema` });
      continue;
    }

    // Enum: the value must be a member NAME the destination enum actually has.
    if (attr.enum) {
      const members = new Set(attr.enum.members.map((m) => m.name));
      if (!members.has(value)) {
        problems.push({ field, value, reason: `not a member of enum ${attr.enum.name} (valid: ${[...members].slice(0, 12).join(', ')}${members.size > 12 ? ', ...' : ''})` });
      }
      continue;
    }

    if (attr.type === 'bool') {
      if (typeof value !== 'boolean') problems.push({ field, value, reason: 'expected a boolean' });
      continue;
    }

    if (attr.type === 'string') {
      if (typeof value !== 'string') { problems.push({ field, value, reason: 'expected a string' }); continue; }
      const max = Number(attr.maxLength);
      // String fields live in the file's secondary string table; overrunning
      // the declared length is a prime suspect for structural damage.
      if (Number.isFinite(max) && value.length > max) {
        problems.push({ field, value, reason: `string is ${value.length} chars, schema maxLength is ${max}` });
      }
      continue;
    }

    if (SCALAR_INT_TYPES.has(attr.type)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push({ field, value, reason: `expected a finite number for ${attr.type}` });
        continue;
      }
      if (attr.type === 'int' && !Number.isInteger(value)) {
        problems.push({ field, value, reason: 'non-integer written to an int field' });
        continue;
      }
      // Fields with a nonzero minValue are OFFSET-ENCODED: getValueByKey
      // returns (and the setter expects) the RAW stored value, i.e.
      // actual - minValue. Verified: Coach.Weight declares [150..512] but
      // every live Madden coach reads back 10, and writing 70/230/150 all
      // round-trip unchanged. So the legal raw range is [0, max-min], NOT
      // [min, max] -- checking against the declared min produces a false
      // positive on every offset-encoded field (this check originally
      // flagged a perfectly valid Weight of 70 as "below minimum 150").
      const min = Number(attr.minValue);
      const max = Number(attr.maxValue);
      const offsetEncoded = Number.isFinite(min) && min !== 0;
      const lo = offsetEncoded ? 0 : min;
      const hi = offsetEncoded ? (max - min) : max;
      if (Number.isFinite(lo) && value < lo) {
        problems.push({ field, value, reason: `below the writable minimum ${lo}${offsetEncoded ? ` (offset-encoded field declared [${min}..${max}])` : ''}` });
      }
      if (Number.isFinite(hi) && value > hi) {
        problems.push({ field, value, reason: `above the writable maximum ${hi}${offsetEncoded ? ` (offset-encoded field declared [${min}..${max}])` : ''}` });
      }
      continue;
    }

    // Everything else is a REFERENCE-typed field. The only safe value is a
    // 32-char binary string (what getValueByKey returns for these, and what
    // a borrowed/constructed reference looks like).
    if (typeof value !== 'string' || !/^[01]{32}$/.test(value)) {
      problems.push({ field, value, reason: `reference field (${attr.type}) needs a 32-bit binary string, got ${typeof value}` });
    }
  }

  return { ok: problems.length === 0, problems };
}

function formatProblems(problems) {
  return problems.map((p) => `  ${p.field} = ${JSON.stringify(p.value)} -- ${p.reason}`).join('\n');
}

module.exports = { validateCoachFields, formatProblems, schemaAttrs };
