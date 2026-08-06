// Canonical names for enum members that share a numeric value.
//
// THE PROBLEM. Madden 27's StaffArchetypeEnum declares two members at value 0:
//
//   value=0  name=First          <-- C++ bookkeeping (`First = OffensiveGuru`)
//   value=0  name=OffensiveGuru  <-- the real archetype
//   ...
//   value=8  name=SharedCoach
//   value=9  name=Count
//
// Madden 26 had no such alias -- value 0 was `OffensiveGuru` and nothing else.
// The franchise library resolves a stored value to the FIRST member name
// matching it, so on an M27 save every OffensiveGuru coach reads back as
// "First". Nothing is wrong with the data; the byte on disk is 0 either way.
// But the app compares that NAME against tables keyed by real archetype
// names, and "First" matches none of them:
//
//   - archetypeMap.js's MADDEN_TO_CFB_TIERED lookup misses, so all 58 of the
//     M27 save's OffensiveGuru coaches fall through to UNRECOGNIZED_FALLBACK
//     instead of their proper CFB archetype.
//   - talentTree.js's donor search never finds an exact archetype match for
//     an OffensiveGuru target, silently downgrading every such transfer to
//     the any-archetype fallback donor.
//
// Both bugs are one root cause at the READ boundary, so the fix belongs here
// rather than as a special case in each consumer: canonicalize the name as it
// comes off the record, and everything downstream keeps comparing real names.
//
// WHICH NAME WINS. Among members sharing a value, the canonical one is the
// first whose name is not C++ enum bookkeeping. `First`/`Last`/`Count`/`Max`
// are range markers every EA schema carries; they are never a coach's actual
// archetype, scheme, or position. If a group somehow contains only markers,
// the first is kept -- canonicalizing to something is always better than
// dropping the value.

// Deliberately NOT including `Invalid_` or `None`: those ARE real, meaningful
// members in these schemas (CFB's Position and PrevPosition both use
// `Invalid_` to mean "no previous job"), not range bookkeeping.
const STRUCTURAL_NAMES = new Set(['First', 'Last', 'Count', 'Max', 'Num', 'Begin', 'End']);

// One map per (file, table, field). Keyed on the file object so a long-lived
// process holding two saves open never crosses their schemas, and so the map
// dies with the file rather than pinning it in memory.
const CACHE = new WeakMap();

function buildAliasMap(file, table, field) {
  const out = new Map();
  const schema = file?.schemaList?.getSchema?.(table);
  const attr = schema?.attributes?.find((a) => a.name === field);
  if (!attr?.enum?.members) return out;

  const byValue = new Map();
  for (const m of attr.enum.members) {
    if (!byValue.has(m.value)) byValue.set(m.value, []);
    byValue.get(m.value).push(m.name);
  }
  for (const names of byValue.values()) {
    if (names.length < 2) continue; // no alias, nothing to canonicalize
    const canonical = names.find((n) => !STRUCTURAL_NAMES.has(n)) ?? names[0];
    for (const n of names) if (n !== canonical) out.set(n, canonical);
  }
  return out;
}

// Map of aliasName -> canonicalName for one enum field. Empty (and cheap) for
// any save whose schema has no aliases at all, which is every Madden 26 save.
function enumAliasMap(file, { table = 'Coach', field = 'Archetype' } = {}) {
  if (!file) return new Map();
  let perFile = CACHE.get(file);
  if (!perFile) { perFile = new Map(); CACHE.set(file, perFile); }
  const key = `${table}.${field}`;
  if (!perFile.has(key)) perFile.set(key, buildAliasMap(file, table, field));
  return perFile.get(key);
}

// Resolves one value read off a record. Passthrough for anything that is not
// a known alias -- including undefined/null, so callers can wrap a safe()
// read directly without a guard.
function canonicalEnumName(aliasMap, value) {
  if (!aliasMap || typeof value !== 'string') return value;
  return aliasMap.get(value) ?? value;
}

module.exports = { enumAliasMap, canonicalEnumName, buildAliasMap, STRUCTURAL_NAMES };
