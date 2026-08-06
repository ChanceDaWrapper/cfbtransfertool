// enumAlias.js -- canonicalizing enum members that share a numeric value.
//
// The case that motivates this: Madden 27's StaffArchetypeEnum declares
// `First` and `OffensiveGuru` both at value 0, so the franchise library
// resolves every OffensiveGuru coach's Archetype to the string "First".
// Downstream tables keyed by real archetype names then miss, and the coach
// silently takes a fallback path. Madden 26 has no such alias, so the M26
// half of these assertions is also the "changed nothing" regression guard.

const assert = require('assert');
const { enumAliasMap, canonicalEnumName, buildAliasMap, STRUCTURAL_NAMES } = require('../lib/carousel/enumAlias');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A schema whose enum members carry explicit numeric values, which is what
// aliasing is expressed through -- two names, one value.
function fileWithEnum(members, { table = 'Coach', field = 'Archetype' } = {}) {
  return {
    schemaList: {
      getSchema: (n) => (n === table
        ? { attributes: [{ name: field, type: 'enum', enum: { name: 'TestEnum', members } }] }
        : null),
    },
  };
}

const M27_ARCHETYPE = [
  { value: 0, name: 'First' }, { value: 0, name: 'OffensiveGuru' },
  { value: 1, name: 'DefensiveGenius' }, { value: 2, name: 'PersonnelCzar' },
  { value: 3, name: 'DevelopmentWizard' }, { value: 4, name: 'HeadScout' },
  { value: 5, name: 'HeadTrainer' }, { value: 6, name: 'MasterMotivator' },
  { value: 7, name: 'MasterMotivator_JohnMadden' },
  { value: 8, name: 'SharedCoach' }, { value: 9, name: 'Count' },
];
const M26_ARCHETYPE = [
  { value: 0, name: 'OffensiveGuru' }, { value: 1, name: 'DefensiveGenius' },
  { value: 2, name: 'PersonnelCzar' }, { value: 3, name: 'DevelopmentWizard' },
  { value: 4, name: 'HeadScout' }, { value: 5, name: 'HeadTrainer' },
  { value: 6, name: 'MasterMotivator' }, { value: 7, name: 'MasterMotivator_JohnMadden' },
  { value: 8, name: 'Count' },
];

// ---------------------------------------------------------------------
// The Madden 27 shape: exactly one alias, pointing at the real name.
// ---------------------------------------------------------------------
{
  const m = buildAliasMap(fileWithEnum(M27_ARCHETYPE), 'Coach', 'Archetype');
  check('M27 produces exactly one alias entry', m.size, 1);
  check('"First" canonicalizes to OffensiveGuru', m.get('First'), 'OffensiveGuru');
  // The real name must NOT be remapped onto the marker, which is the whole
  // point of preferring a non-structural name within a value group.
  check('OffensiveGuru is not itself remapped', m.has('OffensiveGuru'), false);
  // value 8 (SharedCoach) and 9 (Count) are unique values, not a group --
  // `Count` being a structural name is irrelevant when nothing shares it.
  check('unique-valued Count is left alone', m.has('Count'), false);
  check('unique-valued SharedCoach is left alone', m.has('SharedCoach'), false);
}

// ---------------------------------------------------------------------
// The Madden 26 shape: no duplicated values, so nothing to canonicalize.
// An empty map here is what keeps M26 behavior bit-identical.
// ---------------------------------------------------------------------
{
  const m = buildAliasMap(fileWithEnum(M26_ARCHETYPE), 'Coach', 'Archetype');
  check('M26 produces no aliases at all', m.size, 0);
  check('M26 OffensiveGuru passes through unchanged',
    canonicalEnumName(m, 'OffensiveGuru'), 'OffensiveGuru');
}

// ---------------------------------------------------------------------
// Which name wins inside a value group.
// ---------------------------------------------------------------------
{
  // Marker listed second rather than first -- order must not decide it.
  const m1 = buildAliasMap(fileWithEnum([{ value: 0, name: 'RealThing' }, { value: 0, name: 'First' }]), 'Coach', 'Archetype');
  check('marker listed second still loses', m1.get('First'), 'RealThing');

  // Every name in the group is a marker: keep the first rather than dropping
  // the value on the floor.
  const m2 = buildAliasMap(fileWithEnum([{ value: 0, name: 'First' }, { value: 0, name: 'Begin' }]), 'Coach', 'Archetype');
  check('all-marker group falls back to the first name', m2.get('Begin'), 'First');

  // Three-way group with one real name.
  const m3 = buildAliasMap(fileWithEnum([
    { value: 2, name: 'First' }, { value: 2, name: 'Count' }, { value: 2, name: 'Genuine' },
  ]), 'Coach', 'Archetype');
  check('three-way group: both markers map to the real name',
    [m3.get('First'), m3.get('Count')], ['Genuine', 'Genuine']);
}

// ---------------------------------------------------------------------
// `Invalid_` is a REAL member in these schemas (CFB's PrevPosition uses it to
// mean "no previous job"), so it must never be treated as bookkeeping.
// ---------------------------------------------------------------------
{
  check('Invalid_ is not in the structural set', STRUCTURAL_NAMES.has('Invalid_'), false);
  const posFile = fileWithEnum([{ value: 0, name: 'Invalid_' }, { value: 0, name: 'HeadCoach' }], { field: 'Position' });
  const m = buildAliasMap(posFile, 'Coach', 'Position');
  check('Invalid_ can win its group', m.get('HeadCoach'), 'Invalid_');
}

// ---------------------------------------------------------------------
// canonicalEnumName is a total function -- callers wrap a raw safe() read
// with it, which can be undefined for a field absent from this schema.
// ---------------------------------------------------------------------
{
  const m = buildAliasMap(fileWithEnum(M27_ARCHETYPE), 'Coach', 'Archetype');
  check('undefined passes through', canonicalEnumName(m, undefined), undefined);
  check('null passes through', canonicalEnumName(m, null), null);
  check('unknown name passes through', canonicalEnumName(m, 'NotAnArchetype'), 'NotAnArchetype');
  check('a number passes through untouched', canonicalEnumName(m, 7), 7);
  check('a missing map is tolerated', canonicalEnumName(null, 'First'), 'First');
}

// ---------------------------------------------------------------------
// Degenerate schemas must yield an empty map, never throw -- this runs on
// whatever file the user picked.
// ---------------------------------------------------------------------
{
  check('no file', enumAliasMap(null).size, 0);
  check('no schemaList', enumAliasMap({}).size, 0);
  check('no such table', enumAliasMap(fileWithEnum(M27_ARCHETYPE), { table: 'Nope' }).size, 0);
  check('no such field', enumAliasMap(fileWithEnum(M27_ARCHETYPE), { field: 'Nope' }).size, 0);
  const nonEnum = { schemaList: { getSchema: () => ({ attributes: [{ name: 'Level', type: 'int' }] }) } };
  check('non-enum field', enumAliasMap(nonEnum, { field: 'Level' }).size, 0);
}

// ---------------------------------------------------------------------
// Caching: same file+table+field returns the identical map object, and two
// different files never share one (they may be two games' saves at once).
// ---------------------------------------------------------------------
{
  const f27 = fileWithEnum(M27_ARCHETYPE);
  const f26 = fileWithEnum(M26_ARCHETYPE);
  check('same file+key is cached', enumAliasMap(f27) === enumAliasMap(f27), true);
  check('different files do not share', enumAliasMap(f27) === enumAliasMap(f26), false);
  check('different fields on one file do not share',
    enumAliasMap(f27, { field: 'Archetype' }) === enumAliasMap(f27, { field: 'Position' }), false);
  check('the cached M27 map is the real one', enumAliasMap(f27).get('First'), 'OffensiveGuru');
}

console.log(`\n  Enum alias spec: ${passed} assertions passed.\n`);
