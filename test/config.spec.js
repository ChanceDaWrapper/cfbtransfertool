// Regression test for the per-league config layer (lib/defaults.js's
// mergeConfig/activeConfig/foldIntoProfile/classifyConfigFile -- see
// LEAGUE_PROFILES_ROADMAP.md and CONFIG_HARDENING_ROADMAP.md Phase 4).
//
// Nothing in this file exercises generation math -- it's entirely about
// whether config SHAPES survive merging, flattening, folding, and migration
// correctly. Every assertion here maps to a specific bug found during the
// Phase-5 / hardening audit; see the comment above each section for which.
// Run with: node test/config.spec.js (or npm test).

const assert = require('assert');
const {
  DEFAULT_CONFIG, SESSION_KEYS, TUNING_KEYS,
  mergeConfig, activeConfig, foldIntoProfile, classifyConfigFile,
  isSchemaVersionCompatible, splitKnownTuningKeys, CONFIG_SCHEMA_VERSION,
  enforceMinClassSize, MIN_CLASS_SIZE,
} = require('../lib/defaults');

let passed = 0;
function check(label, got, want) {
  if (typeof want === 'number' && typeof got === 'number') {
    assert.ok(Math.abs(got - want) < 1e-9, `${label}: got ${got}, expected ${want}`);
  } else {
    assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  passed++;
}
function checkDeepEqual(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: values differ`);
  passed++;
}

// 1. Key-coverage invariant. Every top-level key of DEFAULT_CONFIG must be
// registered in SESSION_KEYS, TUNING_KEYS (inside a profile), or be
// `profiles` itself. This is the single test that catches the entire "added
// a config section, forgot to register it, it silently never persists" bug
// class -- a key that exists on DEFAULT_CONFIG but isn't in either list
// would be merged by neither mergeInto() pass, so any edit to it would be
// silently dropped on the next save.
{
  const topKeys = Object.keys(DEFAULT_CONFIG);
  const registered = new Set([...SESSION_KEYS, 'profiles']);
  for (const key of topKeys) {
    check(`DEFAULT_CONFIG top-level key "${key}" is registered`, registered.has(key), true);
  }
  check('no stray keys beyond DEFAULT_CONFIG\'s own', topKeys.length, registered.size);
}

// 2. TUNING_KEYS must be EXACTLY the key set each default profile actually
// has -- checked in BOTH directions. A one-directional check (TUNING_KEYS ->
// profile only) can't catch a key silently REMOVED from TUNING_KEYS: the
// loop just iterates fewer times and nothing fails. Confirmed this the hard
// way -- deliberately removed 'legacy' from TUNING_KEYS while building this
// suite; a one-directional version of this check, AND a version of test 3's
// round-trip that mutated fields by walking TUNING_KEYS itself, both passed
// anyway, because both inherited the same blind spot from consulting the
// broken list as their own source of truth. Only comparing against
// Object.keys() of the profile object directly -- which still has `legacy`,
// since only the TUNING_KEYS array was broken -- catches it.
{
  for (const league of ['nfl', 'ufl']) {
    const profileKeys = new Set(Object.keys(DEFAULT_CONFIG.profiles[league]));
    const tuningSet = new Set(TUNING_KEYS);
    for (const key of TUNING_KEYS) {
      check(`profiles.${league} has tuning key "${key}"`, profileKeys.has(key), true);
    }
    for (const key of profileKeys) {
      check(`profiles.${league}'s own key "${key}" is registered in TUNING_KEYS`, tuningSet.has(key), true);
    }
  }
}

// 3. Round trip: canonical -> JSON -> mergeConfig must reproduce the
// original exactly, including nested structures a shallow merge could lose
// (anchors, ratingCategory, categoryOverrides, ratingTweaks,
// ratingAdjustments). Touches at least one leaf inside EVERY TUNING_KEYS
// section programmatically, rather than hand-picking a handful of fields --
// a hand-picked list can't prove coverage of a key nobody remembered to
// pick. (Confirmed the difference matters: an earlier hand-picked version of
// this test did NOT fail when 'legacy' was deliberately removed from
// TUNING_KEYS, because it never happened to touch a legacy.* field --
// removing a key from that list just makes the merge silently skip it,
// which only a generic "touch everything" sweep is guaranteed to notice.)
function touchFirstLeaf(obj, marker) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) { touchFirstLeaf(v, marker); return true; }
    if (typeof v === 'number') { obj[k] = marker; return true; }
    if (typeof v === 'boolean') { obj[k] = !v; return true; }
    if (typeof v === 'string') { obj[k] = `${marker}`; return true; }
  }
  return false;
}
function touchEveryTuningKey(profile, marker) {
  for (const key of TUNING_KEYS) {
    const val = profile[key];
    if (typeof val === 'number') { profile[key] = marker; continue; }
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const touched = touchFirstLeaf(val, marker);
      assert.ok(touched, `touchEveryTuningKey found no touchable leaf under "${key}" -- update the helper`);
    }
  }
}
{
  const orig = mergeConfig(null);
  touchEveryTuningKey(orig.profiles.nfl, 111111);
  touchEveryTuningKey(orig.profiles.ufl, 222222);
  // A couple of shapes touchFirstLeaf's "first leaf" walk wouldn't reach on
  // its own (empty-by-default objects, and map-shaped keys where the
  // interesting case is MULTIPLE distinct entries, not just one) -- covered
  // explicitly so the nested-object merge path in mergeInto is actually
  // exercised, not just the top-level "assign a leaf" path.
  orig.profiles.nfl.powerCurve.ratingCategory = { AwarenessRating: 'physical' };
  orig.profiles.ufl.powerCurve.categoryOverrides = { QB: { AwarenessRating: 'techhvy' } };
  orig.profiles.nfl.powerCurve.ratingTweaks = { SpeedRating: { extraDrop: 2, maxDrop: 5 } };
  orig.profiles.ufl.positionValue.QB = 22;
  orig.profiles.nfl.positionValue.HB = 33;

  const roundTripped = mergeConfig(JSON.parse(JSON.stringify(orig)));
  checkDeepEqual('canonical -> JSON -> mergeConfig reproduces the original exactly (every TUNING_KEYS leaf touched)', roundTripped, orig);
}

// 4. Isolation: folding a FLAT config for one league must leave the OTHER
// league's profile byte-identical. This is the property CONFIG_HARDENING
// finding "generate-class leaked the active league into the inactive
// profile" violated before the Phase-3 fix -- foldIntoProfile itself was
// always correct; the bug was calling mergeConfig on a flat object instead.
{
  let canonical = mergeConfig(null);
  const uflBefore = JSON.parse(JSON.stringify(canonical.profiles.ufl));
  const nflFlat = activeConfig(canonical, 'nfl');
  nflFlat.positionValue.QB = 99;
  nflFlat.diceRoll.classStrength = 'veryStrong';
  canonical = foldIntoProfile(canonical, nflFlat);
  checkDeepEqual('folding an NFL-flat config leaves profiles.ufl untouched', canonical.profiles.ufl, uflBefore);
  check('...and the NFL edit actually landed', canonical.profiles.nfl.positionValue.QB, 99);

  const nflBefore = JSON.parse(JSON.stringify(canonical.profiles.nfl));
  const uflFlat = activeConfig(canonical, 'ufl');
  uflFlat.positionValue.QB = 88;
  canonical = foldIntoProfile(canonical, uflFlat);
  checkDeepEqual('folding a UFL-flat config leaves profiles.nfl untouched', canonical.profiles.nfl, nflBefore);
  check('...and the UFL edit actually landed', canonical.profiles.ufl.positionValue.QB, 88);
}

// 5. Legacy migration. A fixture matching the REAL pre-profiles flat shape
// (hand-built here rather than loaded from a real user file, so this test
// stays portable and has no dependency on anyone's disk) -- top-level tuning
// keys shared by both leagues, plus the old small `ufl` override block that
// used to be the only per-league divergence. Confirms migration reproduces
// exactly what the old runtime override used to compute, now baked into the
// UFL profile at rest.
{
  const legacyFixture = {
    league: 'ufl',
    translation: { strategy: 'diceroll' },
    general: { classSize: 402, seed: 'legacy-seed', dropLeniency: 0.4, defaultDrop: 12, calibrationJitter: 3, quantileJitter: 1 },
    diceRoll: { classStrength: 'weak' },
    powerCurve: { anchors: DEFAULT_CONFIG.profiles.nfl.powerCurve.anchors, globalStrength: 0.85, clampFloor: 1, clampCeiling: 99, jitter: 0, ratingCategory: {}, categoryOverrides: {}, ratingTweaks: {} },
    positionValue: { ...DEFAULT_CONFIG.profiles.nfl.positionValue, QB: 8 },
    positionStrength: DEFAULT_CONFIG.profiles.nfl.positionStrength,
    positionExtraDrop: DEFAULT_CONFIG.profiles.nfl.positionExtraDrop,
    positionCaps: { K: 2, P: 4, LS: 2 },
    devTraits: { xfactorPercentTarget: 0.1, superstarPercentTarget: 1.5, starPercentTarget: 30 },
    draftValue: DEFAULT_CONFIG.profiles.nfl.draftValue,
    overallAnchor: DEFAULT_CONFIG.profiles.nfl.overallAnchor,
    realism: { agilityCodSizePenalty: false },
    ufl: {
      powerCurveGlobalStrength: 0.42,
      diceRollDebuff: -0.13,
      overallBoostEnabled: true,
      overallBoostPoints: 6,
      devTraits: { xfactorPercentTarget: 0, superstarPercentTarget: 0.5, starPercentTarget: 18 },
    },
  };
  const migrated = mergeConfig(legacyFixture);

  check('classifyConfigFile recognizes this fixture as legacyFlat', classifyConfigFile(legacyFixture), 'legacyFlat');
  check('session key `league` carried through', migrated.league, 'ufl');
  check('session key `general.seed` carried through', migrated.general.seed, 'legacy-seed');

  check('shared value (positionValue.QB) landed on NFL profile', migrated.profiles.nfl.positionValue.QB, 8);
  check('shared value (positionValue.QB) landed on UFL profile too (was truly shared pre-migration)', migrated.profiles.ufl.positionValue.QB, 8);
  check('shared value (powerCurve.globalStrength) landed on NFL profile', migrated.profiles.nfl.powerCurve.globalStrength, 0.85);

  check('legacy.dropLeniency carved out of old shared general block (NFL)', migrated.profiles.nfl.legacy.dropLeniency, 0.4);
  check('legacy.dropLeniency carved out of old shared general block (UFL)', migrated.profiles.ufl.legacy.dropLeniency, 0.4);

  check('old ufl.powerCurveGlobalStrength -> UFL profile\'s powerCurve.globalStrength', migrated.profiles.ufl.powerCurve.globalStrength, 0.42);
  check('...NFL profile keeps the shared value, NOT the ufl override', migrated.profiles.nfl.powerCurve.globalStrength, 0.85);
  check('old ufl.diceRollDebuff -> UFL profile\'s diceRoll.debuff', migrated.profiles.ufl.diceRoll.debuff, -0.13);
  check('old ufl.overallBoostEnabled -> UFL profile\'s overallBoost.enabled', migrated.profiles.ufl.overallBoost.enabled, true);
  check('old ufl.overallBoostPoints -> UFL profile\'s overallBoost.points', migrated.profiles.ufl.overallBoost.points, 6);
  check('old ufl.devTraits -> UFL profile\'s devTraits (xfactor)', migrated.profiles.ufl.devTraits.xfactorPercentTarget, 0);
  check('old ufl.devTraits -> UFL profile\'s devTraits (star)', migrated.profiles.ufl.devTraits.starPercentTarget, 18);
  check('...NFL profile keeps the shared devTraits, NOT the ufl override', migrated.profiles.nfl.devTraits.starPercentTarget, 30);
}

// 6. activeConfig deep-clone safety. Found during the Phase-5 audit:
// activeConfig()'s spread only copies TOP-LEVEL keys, so mutating a returned
// flat config's nested values used to mutate whatever object was passed in
// -- including, for flatConfigAndDefaults()'s `defaults` field in main.js,
// the raw DEFAULT_CONFIG module singleton itself. Fixed by deep-cloning the
// flattened result before returning.
{
  const before = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const flat = activeConfig(DEFAULT_CONFIG, 'ufl');
  flat.diceRoll.spread = 999;
  flat.positionValue.QB = 999;
  checkDeepEqual('mutating activeConfig(DEFAULT_CONFIG, ...)\'s result never mutates DEFAULT_CONFIG', DEFAULT_CONFIG, before);
}

// 7. classifyConfigFile, table-driven over every shape it needs to
// distinguish. This is the fix for CONFIG_HARDENING finding #1: a
// single-league file handed to the whole-app import path used to reach
// mergeConfig's legacy-flat fallback (no recognized top-level tuning keys)
// and silently reset every setting to defaults.
{
  const canonicalFile = mergeConfig(null);
  const leagueProfileFile = { league: 'ufl', profile: DEFAULT_CONFIG.profiles.ufl };
  const legacyFlatFile = { positionValue: DEFAULT_CONFIG.profiles.nfl.positionValue, general: { classSize: 402, seed: '' } };

  check('canonical shape classified correctly', classifyConfigFile(canonicalFile), 'canonical');
  check('leagueProfile shape classified correctly', classifyConfigFile(leagueProfileFile), 'leagueProfile');
  check('legacyFlat shape classified correctly', classifyConfigFile(legacyFlatFile), 'legacyFlat');
  check('{} classified as unknown', classifyConfigFile({}), 'unknown');
  check('null classified as unknown', classifyConfigFile(null), 'unknown');
  check('undefined classified as unknown', classifyConfigFile(undefined), 'unknown');
  check('an array classified as unknown', classifyConfigFile([1, 2, 3]), 'unknown');
  check('a bare string classified as unknown', classifyConfigFile('not an object'), 'unknown');
  // No top-level `league`/other recognized key here on purpose -- with one
  // present this would legitimately fall through to legacyFlat (a
  // recognized SESSION_KEYS/TUNING_KEYS key at top level IS a real legacy
  // signal); this isolates just the Array.isArray guard on `profile` itself.
  check('a bare array `profile` (no other recognized keys) is unknown', classifyConfigFile({ profile: [1, 2] }), 'unknown');
}

// 8. Unknown keys in a flat config are dropped by foldIntoProfile -- a
// hand-edited or foreign file with an extra top-level key must not leak a
// new, unregistered field into a saved profile.
{
  const canonical = mergeConfig(null);
  const withBogusKey = { league: 'nfl', ...activeConfig(canonical, 'nfl'), bogusFutureKey: { a: 1 } };
  const folded = foldIntoProfile(canonical, withBogusKey);
  check('unregistered top-level key is dropped, not persisted into the profile', 'bogusFutureKey' in folded.profiles.nfl, false);
}

// 9. enforceMinClassSize operates correctly on a CANONICAL (not just flat)
// config -- this is the shape it actually receives in main.js's config-set
// path (enforceMinClassSize(mergeConfig(config))).
{
  const tooSmall = mergeConfig(null);
  tooSmall.general.classSize = 5;
  const clamped = enforceMinClassSize(tooSmall);
  check('classSize below the floor gets clamped up', clamped.general.classSize, MIN_CLASS_SIZE);

  const fine = mergeConfig(null);
  fine.general.classSize = 300;
  const untouched = enforceMinClassSize(fine);
  check('classSize above the floor is left alone', untouched.general.classSize, 300);
}

// 10. isSchemaVersionCompatible -- CONFIG_HARDENING_ROADMAP.md Phase 5.
// A file stamped by a NEWER schema than this build understands must be
// rejected; everything else (no stamp at all, an older stamp, today's own
// stamp) must be accepted. Deliberately table-driven over the boundary
// cases, not just one example on each side.
{
  check('newer schema is incompatible', isSchemaVersionCompatible({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 }), false);
  check('current schema is compatible', isSchemaVersionCompatible({ schemaVersion: CONFIG_SCHEMA_VERSION }), true);
  check('schema 0 is compatible', isSchemaVersionCompatible({ schemaVersion: 0 }), true);
  check('no schemaVersion at all (every pre-Phase-5 export) is compatible', isSchemaVersionCompatible({ league: 'nfl' }), true);
  check('a non-numeric schemaVersion is treated as unversioned, not rejected', isSchemaVersionCompatible({ schemaVersion: 'not a number' }), true);
  check('null is compatible (nothing to reject on)', isSchemaVersionCompatible(null), true);
  check('a bare number is compatible (nothing to reject on)', isSchemaVersionCompatible(42), true);
}

// 11. Unrecognized profile keys are dropped and reported, not silently
// applied -- CONFIG_HARDENING_ROADMAP.md Phase 5, closing finding #6 (the
// import preview used to diff raw file keys, so it could list a change that
// foldIntoProfile would drop anyway; the actual stripping logic lives in
// main.js's config-import-profile, since it needs the parsed file -- this
// locks the same rule in isolation: TUNING_KEYS membership is what decides
// "real" vs "ignored," and only TUNING_KEYS should ever be trusted for it).
{
  const cleanSource = activeConfig(mergeConfig(null), 'ufl');
  const dirtyProfile = {};
  for (const key of TUNING_KEYS) dirtyProfile[key] = cleanSource[key];
  dirtyProfile.bogusFutureKey = { a: 1 };
  dirtyProfile.misspelledOveralBoost = 4;

  // Calls the REAL splitKnownTuningKeys that main.js's import handler uses,
  // not a copy of its loop. An earlier draft of this section reimplemented
  // that loop inline, which meant it would have kept passing even if the
  // shipped one broke -- the same self-referential blind spot found while
  // building the Phase 4 key-coverage checks, so the function was extracted
  // to lib/defaults.js specifically to make this assertion meaningful.
  const { profile: cleanProfile, ignoredKeys } = splitKnownTuningKeys(dirtyProfile);
  checkDeepEqual('bogus keys reported in ignoredKeys, in the order encountered', ignoredKeys, ['bogusFutureKey', 'misspelledOveralBoost']);
  check('bogus key absent from the cleaned profile', 'bogusFutureKey' in cleanProfile, false);
  check('every real TUNING_KEYS entry survives cleaning', TUNING_KEYS.every((k) => k in cleanProfile), true);
  // The point of stripping BEFORE diffing (not after): a stripped profile
  // folded into a canonical config must be indistinguishable from one that
  // never had the bogus keys at all.
  const foldedClean = foldIntoProfile(mergeConfig(null), { league: 'ufl', ...cleanProfile });
  check('a bogus key never reaches the saved profile either', 'bogusFutureKey' in foldedClean.profiles.ufl, false);
}

console.log(`\n  Config layer spec: ${passed} assertions passed.`);
