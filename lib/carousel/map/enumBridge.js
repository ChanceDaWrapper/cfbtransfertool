// The one rule the whole carousel hangs on (COACH_CAROUSEL_ROADMAP.md
// section 1.3): cross every enum by member NAME, never by numeric value.
//
// Verified against live schemas: getValueByKey() on an enum-typed field
// returns the member's NAME string (e.g. Coach.ContractStatus -> "FreeAgent"),
// and the write side accepts that same name string back (the existing
// player-transfer path already does this -- lib/pipeline.js's writeCareerFile
// does `slot.CharacterBodyType = p.CharacterBodyType`, a bare name-string
// assignment). So for any enum member whose NAME exists in both games'
// schemas, a plain string copy is ALREADY correct -- the destination
// schema's own enum resolves that name to whatever number IT uses. The
// danger the roadmap identified (ContractStatus.FreeAgent = 7 in CFB but = 1
// in Madden) only bites if you copy the NUMBER; copying the name sidesteps
// it entirely.
//
// What actually needs a lookup is the remainder: source members with NO
// same-named destination counterpart (CFB ContractStatus has 9 such members,
// e.g. PendingNFL, PendingHire -- see FINDINGS.md section 7). That's what
// `aliasMap` is for.

const { safe } = require('../../saveIO');

// Reads the live enum member list for `field` on `table` in `file`, so
// validation is always against the schema that's actually open -- never a
// remembered/hardcoded member list (see ROADMAP R3: schema drift on patches).
function liveEnumMembers(file, table, field) {
  const schema = file.schemaList.getSchema(table);
  if (!schema) throw new Error(`enumBridge: no "${table}" table in this save's schema.`);
  const attr = schema.attributes.find((a) => a.name === field);
  if (!attr) throw new Error(`enumBridge: "${table}.${field}" doesn't exist in this save's schema.`);
  if (!attr.enum) throw new Error(`enumBridge: "${table}.${field}" isn't an enum field (type=${attr.type}).`);
  return new Set(attr.enum.members.map((m) => m.name));
}

// Crosses one enum value from a source game's member-name string to a
// destination member-name string, validated against the destination save's
// LIVE schema.
//
//   destFile, destTable, destField -- where the value is going.
//   sourceValue                    -- the member-name string read from the source record.
//   aliasMap                       -- { sourceMemberName: destMemberName } for
//                                      names with no direct counterpart.
//   fallback                       -- destination member name to use if
//                                      sourceValue has no counterpart AND
//                                      isn't in aliasMap. Required for any
//                                      enum where a source member might not
//                                      resolve (crossEnum throws otherwise).
//
// Returns the destination member-name string, ready to assign directly:
// `destRecord[destField] = crossEnum(...)`.
function crossEnum({ destFile, destTable = 'Coach', destField, sourceValue, aliasMap = {}, fallback = null }) {
  const destMembers = liveEnumMembers(destFile, destTable, destField);

  // 1. The source value's name exists verbatim in the destination enum --
  //    the common case for every byte-identical enum (COACH_SPECIALTY,
  //    CharacterBodyType, Personality, TeamBuilding, TradingTendency, ...)
  //    and for any value-drifted enum's overlapping members (ContractStatus's
  //    Signed/FreeAgent/Retired/Expiring/Deleted/None all share a name).
  if (sourceValue !== undefined && sourceValue !== null && destMembers.has(sourceValue)) return sourceValue;

  // 2. An explicit alias for this exact source name.
  if (Object.prototype.hasOwnProperty.call(aliasMap, sourceValue)) {
    const aliased = aliasMap[sourceValue];
    if (destMembers.has(aliased)) return aliased;
    throw new Error(`enumBridge: aliasMap maps "${sourceValue}" -> "${aliased}", but "${aliased}" `
      + `isn't a member of ${destTable}.${destField} in this save (members: ${[...destMembers].join(', ')}).`);
  }

  // 3. Caller-supplied fallback.
  if (fallback !== null && destMembers.has(fallback)) return fallback;

  throw new Error(`enumBridge: no way to cross ${destTable}.${destField} value `
    + `${JSON.stringify(sourceValue)} -- not a shared member name, no aliasMap entry, `
    + `and no valid fallback. Destination members: ${[...destMembers].join(', ')}.`);
}

// Convenience: does the source record's field, read as-is, already carry a
// valid destination member name? (Used by callers deciding whether a plain
// passthrough is even worth attempting before reaching for crossEnum.)
function isSharedMemberName(destFile, destTable, destField, sourceValue) {
  return liveEnumMembers(destFile, destTable, destField).has(sourceValue);
}

module.exports = { crossEnum, liveEnumMembers, isSharedMemberName, safe };
