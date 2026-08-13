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
  isSchemaVersionCompatible, splitKnownTuningKeys, CONFIG_SCHEMA_VERSION, ALL_MIGRATIONS,
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
  // Spread ONTO the existing value, not a raw wholesale replace -- categoryOverrides
  // ships a non-empty default since 2026-08-11b (StrengthRating -> techhvy for
  // skill positions). A raw `=` here would discard those default entries from
  // `orig` while mergeConfig's shallow-spread merge (mergeInto) re-adds them on
  // the round trip, since it merges saved keys onto the default rather than
  // replacing it outright -- making `orig` and `roundTripped` differ for a
  // reason that has nothing to do with a real bug. This mirrors what an actual
  // saved config looks like: a user who customizes ONE position's override
  // still has every other position's shipped default sitting right next to it.
  orig.profiles.ufl.powerCurve.categoryOverrides = {
    ...orig.profiles.ufl.powerCurve.categoryOverrides,
    QB: { AwarenessRating: 'techhvy' },
  };
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

// M27_FIELD_FIXES_ROADMAP.md Phase 2. mergeInto merges a saved object-valued
// tuning key by iterating the DEFAULT's own sub-keys -- any key the DEFAULT
// doesn't already have can never survive a round trip. positionCaps used to
// default to only { K, P, LS }, so a user-set cap on any OTHER position (WR,
// CB, ...) was silently dropped on the very next save/load, and the Position
// Caps control appeared to do nothing for every position except
// Kicker/Punter/Long Snapper. Fixed by seeding every position into the
// default (blank = no cap) -- this section pins that fix directly, at the
// exact layer the bug lived in, rather than only in generation-level probes.
{
  const flat = activeConfig(mergeConfig(null), 'nfl');
  check('every position is present in the default so none can be dropped by mergeInto',
    Object.keys(DEFAULT_CONFIG.profiles.nfl.positionCaps).length, 22);
  check('a position with no shipped default cap starts blank (no cap), not absent',
    flat.positionCaps.WR, '');

  flat.positionCaps = { ...flat.positionCaps, WR: 10, CB: 8 };
  const roundTripped = activeConfig(mergeConfig(flat), 'nfl');
  check('a user-set cap on a position with no shipped default survives mergeConfig',
    roundTripped.positionCaps.WR, 10);
  check('...a second one does too, in the same round trip', roundTripped.positionCaps.CB, 8);
  check('the shipped K/P/LS defaults are untouched by the fix',
    roundTripped.positionCaps.K === 3 && roundTripped.positionCaps.P === 5 && roundTripped.positionCaps.LS === 3, true);

  const folded = foldIntoProfile(mergeConfig(null), flat);
  check('...and survives the canonical fold main.js actually uses at generation time',
    folded.profiles.nfl.positionCaps.WR, 10);
}

// The Power-Curve physical retune -- TWO of them, same day (2026-08-11 then
// 2026-08-11b) -- and the migrations that make each actually reach people.
// Anchors live under a TUNING key, so a saved config's copy beats the new
// default -- without a migration every existing user keeps stale numbers and
// the retune ships to nobody. Same failure mode as the positionCaps bug above.
{
  const STALE_V1 = { x1: 99, y1: 99, x2: 80, y2: 79 }; // pre-any-retune
  const STALE_V2 = { x1: 99, y1: 94, x2: 80, y2: 72 }; // first retune only
  const STALE_V3 = { x1: 99, y1: 96, x2: 80, y2: 82 }; // second retune only
  const FRESH = DEFAULT_CONFIG.profiles.nfl.powerCurve.anchors.physical;
  const STALE_HB = { physical: 1, tech: 0.5, mental: 0.6 };
  const FRESH_HB = DEFAULT_CONFIG.profiles.nfl.positionStrength.HB;
  const otherCurves = {
    techmod: { x1: 99, y1: 90, x2: 80, y2: 73 },
    techhvy: { x1: 99, y1: 87, x2: 80, y2: 68 },
    mental: { x1: 97, y1: 77, x2: 86, y2: 62 },
  };
  const savedWith = (physical, hb) => ({
    profiles: {
      nfl: {
        powerCurve: { anchors: { physical, ...otherCurves } },
        positionStrength: { HB: hb || { ...FRESH_HB } },
      },
      ufl: {},
    },
  });

  // The second retune moved physical BACK toward near-identity (fixing speed
  // realism after the first retune over-compressed it) -- so "compresses more
  // than the pre-retune default" is no longer the invariant. What's true now:
  // it stays close to identity, and it is NOT byte-identical to either stale
  // shape (proving something actually shipped).
  check('the shipped physical curve is close to identity (speed/agility barely move)',
    FRESH.y1 >= 90 && FRESH.y1 <= 99, true);
  check('...and differs from both prior stale values',
    JSON.stringify(FRESH) !== JSON.stringify(STALE_V1) && JSON.stringify(FRESH) !== JSON.stringify(STALE_V2), true);
  check('HB keeps some leniency but far less than before (0.5/0.6 -> higher)',
    FRESH_HB.tech > STALE_HB.tech && FRESH_HB.mental > STALE_HB.mental, true);

  // A config still on EITHER prior anchor value is upgraded straight to current.
  for (const [label, stale] of [['pre-any-retune', STALE_V1], ['first-retune-only', STALE_V2], ['second-retune-only', STALE_V3]]) {
    const upgraded = mergeConfig(savedWith({ ...stale }, { ...STALE_HB }));
    checkDeepEqual(`a ${label} anchor is upgraded to current`,
      upgraded.profiles.nfl.powerCurve.anchors.physical, FRESH);
    checkDeepEqual(`...on the UFL profile too (${label})`,
      upgraded.profiles.ufl.powerCurve.anchors.physical, FRESH);
    checkDeepEqual(`a ${label} config's stale HB strength is upgraded too`,
      upgraded.profiles.nfl.positionStrength.HB, FRESH_HB);
  }

  // Markers, not value comparisons. Value sniffing could never tell "never
  // touched this" from "deliberately picked exactly that", so it would revert a
  // user who genuinely wants the old numbers on every single load.
  // ALL_MIGRATIONS rather than a hardcoded list: this section previously named
  // its markers inline and silently broke every time a new migration shipped,
  // because a config declaring only the OLD markers still gets the new one
  // applied (correctly) and then fails an assertion that assumed otherwise.
  const declaredAll = {
    migrations: [...ALL_MIGRATIONS],
    ...savedWith({ ...STALE_V1 }, { ...STALE_HB }),
  };
  checkDeepEqual('a config that ran EVERY migration keeps the old anchor if it wants it',
    mergeConfig(declaredAll).profiles.nfl.powerCurve.anchors.physical, STALE_V1);
  checkDeepEqual('...and the old HB strength too',
    mergeConfig(declaredAll).profiles.nfl.positionStrength.HB, STALE_HB);
  check('every migration marker is recorded so none runs twice',
    ALL_MIGRATIONS.every((m) => mergeConfig(savedWith({ ...STALE_V1 }, { ...STALE_HB })).migrations.includes(m)), true);
  check('a fresh install ships already-migrated on all of them',
    ALL_MIGRATIONS.every((m) => DEFAULT_CONFIG.migrations.includes(m)), true);

  // Only having run the FIRST migration does not protect against the second --
  // a user in that state has NOT received the speed-realism fix yet, so it
  // must still apply even though their anchor happens to equal STALE_V1 (the
  // same value the second migration also treats as stale).
  const onlyFirst = {
    migrations: [ALL_MIGRATIONS[0]],
    ...savedWith({ ...STALE_V1 }, { ...STALE_HB }),
  };
  checkDeepEqual('a config that only ran the FIRST migration still receives the later ones',
    mergeConfig(onlyFirst).profiles.nfl.powerCurve.anchors.physical, FRESH);
  // And the realistic upgrade path for anyone who ran an intermediate build.
  const ranFirstTwo = {
    migrations: ALL_MIGRATIONS.slice(0, 2),
    ...savedWith({ ...STALE_V3 }, { physical: 1, tech: 0.7, mental: 0.7 }),
  };
  checkDeepEqual('a config from an intermediate build receives the newest migration',
    mergeConfig(ranFirstTwo).profiles.nfl.powerCurve.anchors.physical, FRESH);

  // The whole point of matching EXACTLY: someone who tuned this deliberately
  // must not have their setting silently overwritten by an app update.
  const custom = { x1: 99, y1: 95, x2: 80, y2: 85 };
  checkDeepEqual('a user-customised physical curve is left completely alone',
    mergeConfig(savedWith(custom)).profiles.nfl.powerCurve.anchors.physical, custom);
  const oneOff = { x1: 99, y1: 97, x2: 80, y2: 78 }; // differs from FRESH by one number
  checkDeepEqual('...even when it differs from the current default by one number',
    mergeConfig(savedWith(oneOff)).profiles.nfl.powerCurve.anchors.physical, oneOff);
  const customHb = { physical: 1, tech: 0.85, mental: 0.85 };
  checkDeepEqual('a user-customised HB strength is left completely alone',
    mergeConfig(savedWith({ ...FRESH }, customHb)).profiles.nfl.positionStrength.HB, customHb);

  checkDeepEqual('a config already on the current curve is unchanged',
    mergeConfig(savedWith({ ...FRESH })).profiles.nfl.powerCurve.anchors.physical, FRESH);

  // Legacy flat configs predate every migration by definition.
  checkDeepEqual('a legacy flat config is upgraded too',
    mergeConfig({ powerCurve: { anchors: { physical: { ...STALE_V1 }, ...otherCurves } } })
      .profiles.nfl.powerCurve.anchors.physical, FRESH);

  // Only `physical` and HB moved -- the migration must not touch anything else.
  const after = mergeConfig(savedWith({ ...STALE_V1 }, { ...STALE_HB })).profiles.nfl;
  checkDeepEqual('the migration leaves techmod alone', after.powerCurve.anchors.techmod, otherCurves.techmod);
  checkDeepEqual('the migration leaves techhvy alone', after.powerCurve.anchors.techhvy, otherCurves.techhvy);
  checkDeepEqual('the migration leaves mental alone', after.powerCurve.anchors.mental, otherCurves.mental);
  check('the migration leaves QB strength alone', after.positionStrength.QB.tech, DEFAULT_CONFIG.profiles.nfl.positionStrength.QB.tech);
}

// categoryOverrides ships non-empty since 2026-08-11b (StrengthRating ->
// techhvy for skill positions -- see defaultPowerCurveAnchors' PART 2
// comment). No migration marker needed for this one: unlike the anchor/HB
// cases above, a saved config's categoryOverrides has (almost) never been
// populated (there's no UI for it), so it round-trips as `{}`, and mergeInto
// SPREADS an object-valued subkey rather than replacing it wholesale -- an
// empty saved value can never clobber the new default's entries.
{
  const skillPositions = ['WR', 'CB', 'HB', 'FS', 'SS'];
  const shipped = DEFAULT_CONFIG.profiles.nfl.powerCurve.categoryOverrides;
  check('every skill position routes StrengthRating to techhvy by default',
    skillPositions.every((p) => shipped[p] && shipped[p].StrengthRating === 'techhvy'), true);
  check('trench positions are deliberately absent -- their strength stays on physical',
    ['LT', 'RG', 'DT', 'MLB'].every((p) => shipped[p] === undefined), true);

  // An old config that never had this key at all still receives it.
  const noKey = mergeConfig({ profiles: { nfl: { powerCurve: {} }, ufl: {} } });
  checkDeepEqual('a config missing categoryOverrides entirely receives the shipped default',
    noKey.profiles.nfl.powerCurve.categoryOverrides, shipped);

  // A config that explicitly customized ONE position keeps that customization
  // AND still receives the shipped defaults for every position it never touched.
  const partial = mergeConfig({
    profiles: { nfl: { powerCurve: { categoryOverrides: { QB: { AwarenessRating: 'techhvy' } } } }, ufl: {} },
  });
  check('a customized position survives alongside the shipped defaults',
    partial.profiles.nfl.powerCurve.categoryOverrides.QB.AwarenessRating, 'techhvy');
  checkDeepEqual('...and every shipped-default position is still present',
    skillPositions.map((p) => partial.profiles.nfl.powerCurve.categoryOverrides[p]),
    skillPositions.map((p) => shipped[p]));
}

// The 2026-08-11f skill-position weight retune (WR and TE), and its migration.
// This one is here because it SHIPPED BROKEN once: the WR change went out, the
// reporter re-ran it, and their saved 1.0/1.0 silently beat the new default --
// so the fix reached nobody who had ever opened the app. positionStrength is a
// TUNING key, same trap as positionCaps and the physical anchor before it.
{
  const FRESH = DEFAULT_CONFIG.profiles.nfl.positionStrength;
  const savedWithPS = (wr, te) => ({
    profiles: {
      nfl: { positionStrength: { WR: { physical: 1, ...wr }, TE: { physical: 1, ...te } } },
      ufl: {},
    },
  });
  const STALE_WR = { tech: 1.0, mental: 1.0 };
  const STALE_TE = { tech: 0.9, mental: 0.75 };

  check('shipped WR is more lenient than the bare 1.0 it used to be',
    FRESH.WR.tech < 1.0 && FRESH.WR.mental < 1.0, true);

  const upPS = mergeConfig(savedWithPS(STALE_WR, STALE_TE));
  checkDeepEqual('a config on the old WR weights is upgraded',
    upPS.profiles.nfl.positionStrength.WR, FRESH.WR);
  checkDeepEqual('a config on the old TE weights is upgraded',
    upPS.profiles.nfl.positionStrength.TE, FRESH.TE);
  checkDeepEqual('...on the UFL profile too', upPS.profiles.ufl.positionStrength.WR, FRESH.WR);

  // Deliberate choices survive, both via the marker and via a custom value.
  const declaredPS = { migrations: [...ALL_MIGRATIONS], ...savedWithPS(STALE_WR, STALE_TE) };
  checkDeepEqual('a config that already ran this migration keeps the old WR weights',
    mergeConfig(declaredPS).profiles.nfl.positionStrength.WR, { physical: 1, ...STALE_WR });
  const customWR = { tech: 0.6, mental: 0.7 };
  checkDeepEqual('a user-customised WR weight is never touched',
    mergeConfig(savedWithPS(customWR, STALE_TE)).profiles.nfl.positionStrength.WR, { physical: 1, ...customWR });

  // Nothing else in positionStrength moves.
  const afterPS = mergeConfig(savedWithPS(STALE_WR, STALE_TE)).profiles.nfl.positionStrength;
  checkDeepEqual('the migration leaves QB alone', afterPS.QB, FRESH.QB);
  checkDeepEqual('the migration leaves HB alone', afterPS.HB, FRESH.HB);
  checkDeepEqual('the migration leaves CB alone', afterPS.CB, FRESH.CB);
}

// The 2026-08-12 TE boost removal. Needs its own marker even though it's the
// SAME field the skill-weights migration above touches: SKILL_WEIGHTS_MIGRATION
// already fired for anyone who ran 0.3.1 (it shipped the 0.55/0.55 boost this
// migration removes), so a config on 0.55/0.55 would never be re-examined
// without a fresh marker of its own.
{
  const FRESH = DEFAULT_CONFIG.profiles.nfl.positionStrength;
  const savedWithTE = (te) => ({
    profiles: { nfl: { positionStrength: { TE: { physical: 1, ...te } } }, ufl: {} },
  });
  const STALE_TE_BOOST = { tech: 0.55, mental: 0.55 };

  check('shipped TE sits halfway between the removed boost and neutral',
    FRESH.TE.tech === 0.775 && FRESH.TE.mental === 0.775, true);

  const upTE = mergeConfig(savedWithTE(STALE_TE_BOOST));
  checkDeepEqual('a config on the original TE boost lands on the halved value',
    upTE.profiles.nfl.positionStrength.TE, FRESH.TE);
  checkDeepEqual('...on the UFL profile too', upTE.profiles.ufl.positionStrength.TE, FRESH.TE);

  const customTE = { tech: 0.6, mental: 0.65 };
  checkDeepEqual('a user-customised TE weight is never touched',
    mergeConfig(savedWithTE(customTE)).profiles.nfl.positionStrength.TE, { physical: 1, ...customTE });

  checkDeepEqual('nothing else moves', mergeConfig(savedWithTE(STALE_TE_BOOST)).profiles.nfl.positionStrength.WR, FRESH.WR);
}

// 2026-08-12b: removing the TE boost entirely was itself an overcorrection,
// so it's now halved instead of gone. This needs to reach someone who ALREADY
// ran the removal-only build (TE_BOOST_REMOVAL_MIGRATION recorded, TE saved as
// plain 1.0/1.0) -- a value-only check under that old marker would never fire
// for them again, which is exactly the trap SKILL_WEIGHTS_MIGRATION vs.
// TE_BOOST_REMOVAL_MIGRATION hit one section up.
{
  const FRESH = DEFAULT_CONFIG.profiles.nfl.positionStrength;
  const ranRemovalOnly = {
    migrations: ALL_MIGRATIONS.filter((m) => m !== 'teHalfBoost-2026-08-12b'),
    profiles: {
      nfl: { positionStrength: { TE: { physical: 1, tech: 1.0, mental: 1.0 } } },
      ufl: { positionStrength: { TE: { physical: 1, tech: 1.0, mental: 1.0 } } },
    },
  };
  checkDeepEqual('a config that only ran the removal migration is upgraded to the halved boost',
    mergeConfig(ranRemovalOnly).profiles.nfl.positionStrength.TE, FRESH.TE);
  checkDeepEqual('...on the UFL profile too', mergeConfig(ranRemovalOnly).profiles.ufl.positionStrength.TE, FRESH.TE);

  const declaredAllTE = {
    migrations: [...ALL_MIGRATIONS],
    profiles: ranRemovalOnly.profiles,
  };
  checkDeepEqual('a config that already ran every migration keeps a deliberate plain 1.0/1.0',
    mergeConfig(declaredAllTE).profiles.nfl.positionStrength.TE, { physical: 1, tech: 1.0, mental: 1.0 });
}

console.log(`\n  Config layer spec: ${passed} assertions passed.`);
