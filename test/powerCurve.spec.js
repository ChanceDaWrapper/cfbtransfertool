// Dependency-free regression test for the Power-Curve translation engine.
// Run with: node test/powerCurve.spec.js  (or npm test)
//
// Two independent things are locked here, deliberately kept apart:
//
//   1. ENGINE FIDELITY (spec-pinned): the model spec's Section 9 worked
//      examples ("if your implementation reproduces these numbers, the
//      transform is correct"), reproduced using the ORIGINAL spec's anchor
//      points AND ORIGINAL spec per-position strengths -- passed explicitly,
//      not read from lib/defaults.js. This proves the MATH (powerCurve.js +
//      powerCurveCategories.js) and the WIRING (calibratePlayers ->
//      createTranslator -> makePowerCurveAdjuster) still correctly
//      implement the documented model, independent of whatever the app's
//      shipped defaults currently are.
//
//   2. SHIPPED DEFAULTS (product-tuned, not spec-pinned): lib/defaults.js's
//      defaultPositionStrength() has been retuned against real in-game
//      Madden overalls (see POWERCURVE_ROADMAP.md) and now deliberately
//      diverges from the original spec's per-position numbers for several
//      positions (WR, HB, TE, LS, etc.) -- that's a product decision, not a
//      bug. This section locks THOSE specific tuned values so a future edit
//      can't silently drift them back toward the spec's numbers.
//
// Splitting these two means retuning a position's defaults (section 2) can
// never accidentally break the proof that the engine itself is spec-correct
// (section 1), and vice versa.

const assert = require('assert');

const { deriveCurve, transform } = require('../lib/rosetta/translation/powerCurve');
const { categoryFor } = require('../lib/rosetta/translation/powerCurveCategories');
const { defaultPowerCurveAnchors, defaultPositionStrength, mergeConfig, activeConfig, ALL_MIGRATIONS } = require('../lib/defaults');
const { calibratePlayers, generateClass, GLOBAL_STRENGTH_BASELINE } = require('../lib/pipeline');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${got}, expected ${want}`);
  passed++;
}

// ===========================================================================
// 1. Engine fidelity -- original model spec, pinned independent of defaults.
// ===========================================================================
// The ORIGINAL model spec's Sec 5 anchor points -- hardcoded, exactly like
// SPEC_STRENGTH below and for the same reason.
//
// These used to be read from defaultPowerCurveAnchors(), on the assumption
// that anchors were spec-fixed while only per-position strengths were product-
// tuned. That assumption expired on 2026-08-11, when `physical` was retuned
// from near-identity (99->99, 80->79) to real compression (99->94, 80->72)
// after EA's own Madden 27 draft classes showed college athleticism was
// crossing over untouched. Reading the live default made this section silently
// re-baseline against whatever product tuning had done -- the exact
// self-referential failure the file header warns about, and it turned a
// deliberate retune into a spec-fidelity failure.
//
// Section 2 below locks the SHIPPED values; this section proves the ENGINE.
const SPEC_ANCHORS = {
  physical: { x1: 99, y1: 99, x2: 80, y2: 79 },
  techmod: { x1: 99, y1: 90, x2: 80, y2: 73 },
  techhvy: { x1: 99, y1: 87, x2: 80, y2: 68 },
  mental: { x1: 97, y1: 77, x2: 86, y2: 62 },
};
const CURVES = Object.fromEntries(Object.entries(SPEC_ANCHORS).map(([k, a]) => [k, deriveCurve(a)]));
// The ORIGINAL model spec's Sec 6 position strengths -- hardcoded here, not
// read from lib/defaults.js, precisely so retuning the shipped defaults
// (section 2 below) can't break this proof.
const SPEC_STRENGTH = {
  WR: { tech: 0.68, mental: 0.80 },
  QB: { tech: 0.65, mental: 0.75 },
};

function pureConvert(pos, rating, x, strengthTable) {
  const cat = categoryFor(pos, rating);
  const s = cat === 'physical' ? 1.0
    : (cat === 'mental' ? strengthTable[pos].mental : strengthTable[pos].tech);
  return transform(x, CURVES[cat], s);
}

// Spec Sec 9 -- WR "Larry Porter IV" and QB "Bowe Bentley". ThrowPower is
// deliberately excluded: the original spec routed it through a fifth ARMLEG
// category (99->97, 80->78) that no longer exists in the shipped product --
// throw/kick power were folded into PHYSICAL per product decision (see
// POWERCURVE_ROADMAP.md), so the categorization system can no longer
// reproduce that one example. The standalone check just below proves the
// underlying ALGEBRA still matches the spec even though the routing changed.
const SPEC_EXAMPLES = [
  ['WR', 'SpeedRating', 88, 87],
  ['WR', 'AccelerationRating', 92, 92],
  ['WR', 'AgilityRating', 99, 99],
  ['WR', 'ChangeOfDirectionRating', 99, 99],
  ['WR', 'CatchingRating', 83, 78],
  ['WR', 'SpectacularCatchRating', 97, 89],
  ['WR', 'ShortRouteRunningRating', 80, 72],
  ['WR', 'DeepRouteRunningRating', 77, 69],
  ['WR', 'ReleaseRating', 79, 71],
  ['WR', 'JukeMoveRating', 99, 91],
  ['WR', 'AwarenessRating', 91, 73],
  ['QB', 'ThrowAccuracyShortRating', 87, 79],
  ['QB', 'ThrowAccuracyDeepRating', 88, 80],
  ['QB', 'ThrowOnTheRunRating', 96, 88],
  ['QB', 'AwarenessRating', 83, 64],
  ['QB', 'SpeedRating', 86, 85],
];
for (const [pos, rating, x, want] of SPEC_EXAMPLES) {
  check(`engine ${pos} ${rating} ${x}`, pureConvert(pos, rating, x, SPEC_STRENGTH), want);
}

// Standalone: the original spec's ARMLEG curve (99->97, 80->78, strength
// fixed 1.0) fed directly to the pure transform, bypassing categoryFor/
// CATEGORY_STRENGTH_KIND entirely (ARMLEG isn't a routable category anymore).
// Proves the core algebra hasn't drifted even though ThrowPower's routing has.
const SPEC_ARMLEG_CURVE = deriveCurve({ x1: 99, y1: 97, x2: 80, y2: 78 });
check('pure algebra: spec ARMLEG curve still reproduces ThrowPower 91->89', transform(91, SPEC_ARMLEG_CURVE, 1.0), 89);

// Same numbers again through the real calibratePlayers() pipeline path --
// with the spec's strengths passed as an explicit config override, so this
// verifies engine + wiring end-to-end without depending on shipped defaults.
function row(over, pos, ratings) {
  return Object.assign({
    FirstName: 'T', LastName: pos, OverallRating: over, Position: pos,
    Height: 74, Weight: 200, JerseyNum: 1, SchoolYear: 'Junior',
    TraitDevelopment: 'College_Star', AwardsScore: 0, CareerStats: null, ProjectRound: 1,
  }, ratings);
}
const porter = row(93, 'WR', {
  SpeedRating: 88, AccelerationRating: 92, AgilityRating: 99, ChangeOfDirectionRating: 99,
  CatchingRating: 83, SpectacularCatchRating: 97, ShortRouteRunningRating: 80,
  DeepRouteRunningRating: 77, ReleaseRating: 79, JukeMoveRating: 99, AwarenessRating: 91,
});
const bentley = row(91, 'QB', {
  ThrowPowerRating: 91, ThrowAccuracyShortRating: 87, ThrowAccuracyDeepRating: 88,
  ThrowOnTheRunRating: 96, AwarenessRating: 83, SpeedRating: 86,
});
const specConfig = {
  general: { seed: 'spec', classSize: 10 },
  translation: { strategy: 'powercurve' },
  positionStrength: {
    WR: { physical: 1.0, tech: SPEC_STRENGTH.WR.tech, mental: SPEC_STRENGTH.WR.mental },
    QB: { physical: 1.0, tech: SPEC_STRENGTH.QB.tech, mental: SPEC_STRENGTH.QB.mental },
  },
  // Zeroed out, not left at the shipped defaults: positionExtraDrop (Phase 3)
  // is a real, live, product-tuned flat adjustment (e.g. QB's shipped -1) --
  // exactly the kind of thing this section is deliberately independent of.
  // Without this override the pipeline-level check would silently start
  // failing every time positionExtraDrop's defaults get retuned, even though
  // the engine itself remains spec-correct. Same reasoning for an empty
  // ratingCategory (Phase 4a) and ratingTweaks (Phase 4b) -- pin both so
  // future defaults in either can't break the engine-fidelity proof.
  positionExtraDrop: { WR: 0, QB: 0 },
  // globalStrength set so its EFFECTIVE value (after pipeline.js's hidden
  // GLOBAL_STRENGTH_BASELINE multiplier) is a true 1.0 no-op -- this section
  // proves engine fidelity against the ORIGINAL spec's numbers, independent
  // of both lib/defaults.js's shipped default AND the baseline stacked on
  // top of the dial at calculation time.
  // `anchors` pinned to the spec's own curves for the same reason as
  // everything else in this object. Missing it was a real gap: when `physical`
  // was retuned on 2026-08-11 this section started failing, not because the
  // engine drifted but because it was silently measuring the shipped product
  // tuning. Section 2 is where shipped anchors belong.
  // Declares itself already-migrated. The 2026-08-11 physical-anchor migration
  // rewrites a config still sitting on the pre-retune curve -- which is exactly
  // the curve this section pins on purpose -- so without this marker the
  // migration would helpfully "upgrade" the spec fixture out from under the
  // fidelity proof.
  // Both retune migrations, not just the first -- SPEC_ANCHORS.physical is
  // {99,99,80,79}, which is EXACTLY the pre-any-retune stale value the SECOND
  // migration also checks for (a profile can be stale relative to either
  // retune). Missing this marker re-triggered the migration against this
  // deliberately-pinned fixture and silently overwrote it with the live
  // shipped anchor -- caught by this test failing after the second retune
  // landed, which is exactly the self-referential trap this file's own header
  // warns about.
  migrations: [...ALL_MIGRATIONS],
  powerCurve: {
    anchors: SPEC_ANCHORS,
    globalStrength: 1 / GLOBAL_STRENGTH_BASELINE,
    ratingCategory: {},
    ratingTweaks: {},
  },
};
const out = calibratePlayers([porter, bentley], { config: specConfig, log: () => {} });
const byPos = Object.fromEntries(out.map((p) => [p.CFB_Position, p]));
for (const [pos, rating, , want] of SPEC_EXAMPLES) {
  check(`pipeline(spec strengths) ${pos} ${rating}`, byPos[pos][`Madden_${rating}`], want);
}

// Determinism: no jitter by default -> identical across runs.
const again = calibratePlayers([porter], { config: specConfig, log: () => {} });
check('deterministic WR Awareness', again[0].Madden_AwarenessRating, byPos.WR.Madden_AwarenessRating);

// globalStrength omitted from a config must be a true no-op vs explicitly
// passing whatever lib/defaults.js currently ships (read dynamically via
// mergeConfig rather than hardcoded, so this doesn't break every time the
// shipped default is retuned -- only the omitted-falls-back-correctly wiring
// is being proven here, not any particular number). specConfig itself pins
// globalStrength:1.0 (for the spec-fidelity section above), so build this
// section's base config WITHOUT that pin -- otherwise "omitted" wouldn't be.
const { globalStrength: _pinnedGS, ...powerCurveNoGS } = specConfig.powerCurve;
const shippedGlobalStrength = activeConfig(mergeConfig(null), 'nfl').powerCurve.globalStrength;
const explicitShipped = calibratePlayers([porter, bentley], {
  config: { ...specConfig, powerCurve: { ...powerCurveNoGS, globalStrength: shippedGlobalStrength } }, log: () => {},
});
const omitted = calibratePlayers([porter, bentley], { config: { ...specConfig, powerCurve: powerCurveNoGS }, log: () => {} });
check('globalStrength omitted matches explicit shipped default -- WR Awareness',
  explicitShipped.find((p) => p.CFB_Position === 'WR').Madden_AwarenessRating,
  omitted.find((p) => p.CFB_Position === 'WR').Madden_AwarenessRating);
check('globalStrength omitted matches explicit shipped default -- QB ThrowAccuracyShort',
  explicitShipped.find((p) => p.CFB_Position === 'QB').Madden_ThrowAccuracyShortRating,
  omitted.find((p) => p.CFB_Position === 'QB').Madden_ThrowAccuracyShortRating);

// ===========================================================================
// 1b. Per-position Extra Drop (Phase 3) -- flat, category-agnostic, scoped.
// ===========================================================================
// Validates the roadmap's Phase 3 criteria directly: a position's flat drop
// shifts ONLY that position, applies uniformly across ALL categorized ratings
// (physical AND technical AND mental alike -- not just skill, unlike V1's
// original quantile-only-adjacent behavior). Every convertible rating is
// categorized now (no copy-raw concept remains -- see the Phase 4a/4c
// interlude), so this always applies.
const flatDropCases = [
  ['WR', 'SpeedRating', 88],           // physical
  ['WR', 'CatchingRating', 83],        // techmod
  ['WR', 'ShortRouteRunningRating', 80], // techhvy
  ['WR', 'AwarenessRating', 91],        // mental
];
const noDropOut = calibratePlayers([porter, bentley], {
  config: { ...specConfig, positionExtraDrop: { WR: 0, QB: 0 } }, log: () => {},
}).find((p) => p.CFB_Position === 'WR');
const droppedOut = calibratePlayers([porter, bentley], {
  config: { ...specConfig, positionExtraDrop: { WR: 3, QB: 0 } }, log: () => {},
}).find((p) => p.CFB_Position === 'WR');
const qbUnaffected = calibratePlayers([porter, bentley], {
  config: { ...specConfig, positionExtraDrop: { WR: 3, QB: 0 } }, log: () => {},
}).find((p) => p.CFB_Position === 'QB');
const qbBaseline = calibratePlayers([porter, bentley], {
  config: { ...specConfig, positionExtraDrop: { WR: 0, QB: 0 } }, log: () => {},
}).find((p) => p.CFB_Position === 'QB');

for (const [pos, rating] of flatDropCases) {
  check(`extraDrop=3 shifts ${pos} ${rating} by exactly 3`,
    noDropOut[`Madden_${rating}`] - droppedOut[`Madden_${rating}`], 3);
}
check('extraDrop on WR leaves QB Awareness untouched', qbUnaffected.Madden_AwarenessRating, qbBaseline.Madden_AwarenessRating);
check('extraDrop on WR leaves QB ThrowPower untouched', qbUnaffected.Madden_ThrowPowerRating, qbBaseline.Madden_ThrowPowerRating);

// ===========================================================================
// 1c. Global rating reclassification (Phase 4a).
// ===========================================================================
// A global ratingCategory entry re-buckets a rating for EVERY position.
// Verified through the real pipeline. Catching is techmod by default; moving
// it to techhvy (a harsher curve) must lower it.
const wrCfg = (ratingCategory) => ({
  general: { seed: 'spec', classSize: 10 },
  translation: { strategy: 'powercurve' },
  positionStrength: { WR: { physical: 1.0, tech: SPEC_STRENGTH.WR.tech, mental: SPEC_STRENGTH.WR.mental } },
  positionExtraDrop: { WR: 0 },
  powerCurve: { ratingCategory },
});
const catchDefault = calibratePlayers([porter], { config: wrCfg({}), log: () => {} })[0].Madden_CatchingRating;
const catchHeavier = calibratePlayers([porter], { config: wrCfg({ CatchingRating: 'techhvy' }), log: () => {} })[0].Madden_CatchingRating;
check('reclassify Catching techmod->techhvy lowers it', catchHeavier < catchDefault, true);
// Physical bucket via reclassification: Awareness (mental) forced to physical
// should barely move (near-identity curve) vs. its heavy default mental drop.
const awrDefault = calibratePlayers([porter], { config: wrCfg({}), log: () => {} })[0].Madden_AwarenessRating;
const awrPhysical = calibratePlayers([porter], { config: wrCfg({ AwarenessRating: 'physical' }), log: () => {} })[0].Madden_AwarenessRating;
check('reclassify Awareness mental->physical raises it sharply', awrPhysical > awrDefault + 10, true);

// ===========================================================================
// 1d. Per-rating Extra Drop / Max Drop (Phase 4b).
// ===========================================================================
const wrTweakCfg = (ratingTweaks, ratingCategory) => ({
  general: { seed: 'spec', classSize: 10 },
  translation: { strategy: 'powercurve' },
  positionStrength: { WR: { physical: 1.0, tech: SPEC_STRENGTH.WR.tech, mental: SPEC_STRENGTH.WR.mental } },
  positionExtraDrop: { WR: 0 },
  powerCurve: { ratingCategory: ratingCategory || {}, ratingTweaks },
});
const catchBaseline = calibratePlayers([porter], { config: wrTweakCfg({}), log: () => {} })[0].Madden_CatchingRating;
const catchExtraDropped = calibratePlayers([porter], { config: wrTweakCfg({ CatchingRating: { extraDrop: 4 } }), log: () => {} })[0].Madden_CatchingRating;
check('ratingTweaks.extraDrop=4 shifts Catching by exactly 4', catchBaseline - catchExtraDropped, 4);

// Catching(83) baselines to 78 under spec WR strength -- a drop of 5 puts it
// at exactly the floor a maxDrop=1 would allow (83-1=82), so this proves the
// cap actually binds (without it, extraDrop=5 alone would take it to 73).
const catchCapped = calibratePlayers([porter], {
  config: wrTweakCfg({ CatchingRating: { extraDrop: 5, maxDrop: 1 } }), log: () => {},
})[0].Madden_CatchingRating;
check('ratingTweaks.maxDrop=1 caps Catching at college(83)-1=82, overriding extraDrop', catchCapped, 82);

// ===========================================================================
// 1e. Per-position category exceptions (Phase 4c).
// ===========================================================================
// categoryOverrides[position][rating] must win over the global ratingCategory
// for THAT position only, and leave every other position resolving through
// the global/structural layers exactly as before.
const bothPositionsCfg = (categoryOverrides, ratingCategory) => ({
  general: { seed: 'spec', classSize: 10 },
  translation: { strategy: 'powercurve' },
  positionStrength: {
    WR: { physical: 1.0, tech: SPEC_STRENGTH.WR.tech, mental: SPEC_STRENGTH.WR.mental },
    QB: { physical: 1.0, tech: SPEC_STRENGTH.QB.tech, mental: SPEC_STRENGTH.QB.mental },
  },
  positionExtraDrop: { WR: 0, QB: 0 },
  powerCurve: { categoryOverrides: categoryOverrides || {}, ratingCategory: ratingCategory || {} },
});
// Baseline (no override at all) vs. global reclassifies Catching to MENTAL for
// EVERYONE (a much harsher curve than its techmod default); a WR-only
// exception then overrides that global choice back to techhvy for WR specifically.
const noOverrideOut = calibratePlayers([porter, bentley], {
  config: bothPositionsCfg({}, {}), log: () => {},
});
const globalMentalOut = calibratePlayers([porter, bentley], {
  config: bothPositionsCfg({}, { CatchingRating: 'mental' }), log: () => {},
});
const wrExceptionOut = calibratePlayers([porter, bentley], {
  config: bothPositionsCfg({ WR: { CatchingRating: 'techhvy' } }, { CatchingRating: 'mental' }), log: () => {},
});
const noOverrideWR = noOverrideOut.find((p) => p.CFB_Position === 'WR');
const globalMentalWR = globalMentalOut.find((p) => p.CFB_Position === 'WR');
const exceptionWR = wrExceptionOut.find((p) => p.CFB_Position === 'WR');
check('global mental reclassification changes WR Catching from its techmod default',
  globalMentalWR.Madden_CatchingRating !== noOverrideWR.Madden_CatchingRating, true);
check('WR-only exception overrides the global mental choice back to a different value',
  exceptionWR.Madden_CatchingRating !== globalMentalWR.Madden_CatchingRating, true);
// Bentley is a QB and has no CatchingRating input at all, so nothing to check
// there directly -- instead confirm the WR exception doesn't leak onto QB by
// checking a rating QB DOES have (ThrowPower) is unaffected by the WR-only override.
const globalMentalQB = globalMentalOut.find((p) => p.CFB_Position === 'QB');
const exceptionQB = wrExceptionOut.find((p) => p.CFB_Position === 'QB');
check('WR-only exception leaves QB completely untouched', exceptionQB.Madden_ThrowPowerRating, globalMentalQB.Madden_ThrowPowerRating);

// ===========================================================================
// 2. Shipped defaults -- product-tuned values, locked so they don't drift.
// ===========================================================================
// Retuned per POWERCURVE_ROADMAP.md against real in-game Madden overalls
// (RBs were landing way too low under the original spec-tuned defaults; WR
// needed harder compression than the spec's split allowed). These
// intentionally diverge from SPEC_STRENGTH above for several positions.
//
// HB raised again 2026-08-11b (0.5/0.6 -> 0.7/0.7) -- see
// defaultPositionStrength's own HB comment. Not a drift, a second deliberate
// retune: `physical` went back to near-identity to fix speed realism, so HB's
// technical/mental compression had to pick up the slack or its overall
// reproduces the exact "too high" complaint the FIRST retune fixed.
//
// WR lowered 2026-08-11e (1.0/1.0 -> 0.85/0.85) after a 99-overall college
// receiver came out near 70. WR had been the only skill position at a bare
// 1.0, which stacked with the raised global baseline into the harshest
// treatment in the class.
//
// TE lowered 2026-08-11f (0.9/0.75 -> 0.55/0.55), then that boost REMOVED
// ENTIRELY 2026-08-12 on a report that tight ends were now coming out too
// high (1.0/1.0) -- which itself overcorrected the other way (high 70s
// average -> mid 60s). 2026-08-12b splits the difference: 0.775 is exactly
// halfway between the removed 0.55 boost and neutral 1.0.
const SHIPPED = defaultPositionStrength();
const SHIPPED_EXPECTED = {
  QB: { tech: 0.75, mental: 1 },
  HB: { tech: 0.7, mental: 0.7 },
  WR: { tech: 0.85, mental: 0.85 },
  TE: { tech: 0.775, mental: 0.775 },
  LT: { tech: 1.0, mental: 1.0 }, LG: { tech: 1.0, mental: 1.0 }, C: { tech: 1.0, mental: 1.0 },
  RG: { tech: 1.0, mental: 1.0 }, RT: { tech: 1.0, mental: 1.0 },
  LE: { tech: 0.9, mental: 0.9 }, RE: { tech: 0.9, mental: 0.9 }, DT: { tech: 0.9, mental: 1.0 },
  LOLB: { tech: 0.8, mental: 1.0 }, MLB: { tech: 0.8, mental: 1.0 }, ROLB: { tech: 0.8, mental: 1.0 },
  CB: { tech: 0.95, mental: 1.0 },
  FS: { tech: 0.85, mental: 1.0 }, SS: { tech: 0.85, mental: 1.0 },
  K: { tech: 1.0, mental: 1.25 }, P: { tech: 1.0, mental: 1.25 },
  LS: { tech: 1.2, mental: 1.25 },
};
for (const [pos, { tech, mental }] of Object.entries(SHIPPED_EXPECTED)) {
  check(`shipped default ${pos} tech`, SHIPPED[pos].tech, tech);
  check(`shipped default ${pos} mental`, SHIPPED[pos].mental, mental);
}

// GLOBAL_STRENGTH_BASELINE belongs in THIS section (shipped, product-tuned)
// but had no assertion at all until 2026-08-11d. Every other test in this file
// deliberately CANCELS it out (they pass globalStrength: 1 / BASELINE so the
// effective value is a clean 1.0), which is correct for proving engine
// fidelity -- but it meant the shipped value itself was completely unpinned:
// changing it broke nothing. Verified by sabotage, reverting it from 1.56 to
// 1.155 passed the entire file before this check existed.
//
// It is the single strongest class-wide dial in Power Curve (it scales every
// position's technical AND mental compression at once), so it is exactly the
// value most worth locking against silent drift.
check('shipped GLOBAL_STRENGTH_BASELINE', GLOBAL_STRENGTH_BASELINE, 1.56);
check('...and it compresses rather than inflating (must exceed 1.0)',
  GLOBAL_STRENGTH_BASELINE > 1.0, true);

// Shipped rating->bucket defaults that were deliberately re-placed away from
// the original spec's Sec 5 table (user placements, the BC Vision fix, and
// the ARMLEG/copy-raw removal -- every rating now has a real, explicit
// bucket). Locked so a future edit to CATEGORY_OF can't silently drift them back.
const { CATEGORY_OF } = require('../lib/rosetta/translation/powerCurveCategories');
const SHIPPED_CATEGORY_EXPECTED = {
  ThrowPowerRating: 'physical', // spec: armleg (removed)
  KickPowerRating: 'physical',  // spec: armleg (removed)
  HitPowerRating: 'techmod',    // spec: techhvy
  LongSnapRating: 'techmod',    // spec: copy-raw (removed; was unlisted)
  KickReturnRating: 'techmod',  // spec: copy-raw (removed; was unlisted)
  PersonalityRating: 'techmod', // spec: copy-raw (removed; was unlisted)
  BCVisionRating: 'techhvy',    // spec: techmod
};
for (const [rating, cat] of Object.entries(SHIPPED_CATEGORY_EXPECTED)) {
  check(`shipped bucket ${rating}`, CATEGORY_OF[rating], cat);
}
// No rating is ever left uncategorized (no copy-raw / ARMLEG concept remains).
check('CATEGORY_STRENGTH_KIND has exactly 4 buckets (armleg removed)',
  Object.keys(require('../lib/rosetta/translation/powerCurveCategories').CATEGORY_STRENGTH_KIND).length, 4);

// ===========================================================================
// 2b. Migration robustness -- a config saved before ARMLEG was removed.
// ===========================================================================
// mergeConfig shallow-merges powerCurve.anchors, so a stale `armleg` anchor
// from an older save survives the merge. The engine must not crash on it, and
// generation must ignore it (nothing routes to a non-existent category).
// (The renderer separately prunes it; this locks the ENGINE half.)
const staleArmlegCfg = mergeConfig({
  powerCurve: { anchors: { armleg: { x1: 99, y1: 97, x2: 80, y2: 78 } } },
});
check('stale armleg anchor survives merge (mergeConfig is shallow)',
  'armleg' in staleArmlegCfg.profiles.nfl.powerCurve.anchors, true);
const staleOut = calibratePlayers([porter], {
  config: {
    general: { seed: 'spec', classSize: 10 }, translation: { strategy: 'powercurve' },
    positionStrength: { WR: { physical: 1.0, tech: SPEC_STRENGTH.WR.tech, mental: SPEC_STRENGTH.WR.mental } },
    positionExtraDrop: { WR: 0 },
    // globalStrength pinned to a true 1.0 EFFECTIVE value exactly as
    // specConfig does, because this result is compared against specConfig's
    // output below. Without it the two configs differ in a second variable
    // (the hidden GLOBAL_STRENGTH_BASELINE) and the comparison stops being
    // about the stale `armleg` anchor at all -- which is what this section
    // actually tests. Caught when that baseline was retuned on 2026-08-11.
    powerCurve: {
      anchors: { armleg: { x1: 99, y1: 97, x2: 80, y2: 78 } },
      globalStrength: 1 / GLOBAL_STRENGTH_BASELINE,
    },
  }, log: () => {},
})[0];
check('generation ignores a stale armleg anchor (Catching still converts normally)',
  staleOut.Madden_CatchingRating, byPos.WR.Madden_CatchingRating);

// ===========================================================================
// 3. EstMaddenOverall is cosmetic -- dev-trait assignment must not move when
//    rating-conversion knobs move.
// ===========================================================================
// devTraitWeight() reads overallAnchorFor(CFB_Overall) -- a pure function of
// the player's real college overall -- specifically so a user reshaping
// Rating Categories / Per-Position Strength / Extra Drop / jitter can never
// change who gets Star/Superstar/X-Factor or how old they are. This proves
// that end-to-end through generateClass() (which is what the app actually
// calls), with two configs that differ as wildly as possible on every
// rating-conversion knob while sharing the same seed. FRESH row objects per
// call are essential here -- projectDraftClass stamps mutable _rank/_prodScore/
// _athScore fields onto each row in place, so reusing row objects across two
// generateClass() calls would let the second run see stale annotations from
// the first and manufacture a false failure.
function makeDevTraitTestRows() {
  const base = {
    FirstName: 'A', Height: 74, Weight: 220, JerseyNum: 9, SchoolYear: 'Senior',
    AwardsScore: 2, CareerStats: null, ProjectRound: 2,
    SpeedRating: 88, AccelerationRating: 87, AgilityRating: 86, ChangeOfDirectionRating: 85,
    StrengthRating: 75, JumpingRating: 85, AwarenessRating: 82, PlayRecognitionRating: 80,
    CatchingRating: 84, ShortRouteRunningRating: 83, DeepRouteRunningRating: 81,
    ManCoverageRating: 83, ZoneCoverageRating: 82, RunBlockRating: 80, PassBlockRating: 80,
    ThrowPowerRating: 88, ThrowAccuracyShortRating: 85, BCVisionRating: 88, TackleRating: 80,
  };
  const rows = [];
  for (const pos of ['QB', 'WR', 'HB', 'CB', 'LT']) {
    for (const ovr of [93, 88, 84, 80]) {
      rows.push({ ...base, LastName: `${pos}${ovr}`, OverallRating: ovr, Position: pos,
        TraitDevelopment: ovr >= 90 ? 'College_Elite' : 'College_Star' });
    }
  }
  return rows;
}
const devTraitDefaultCfg = { general: { seed: 'devtrait-stable', classSize: 20 }, translation: { strategy: 'powercurve' } };
const devTraitWildCfg = {
  general: { seed: 'devtrait-stable', classSize: 20 },
  translation: { strategy: 'powercurve' },
  powerCurve: {
    globalStrength: 0.3,
    ratingCategory: { AwarenessRating: 'physical', SpeedRating: 'mental', CatchingRating: 'mental', BCVisionRating: 'techmod' },
  },
  positionStrength: { WR: { physical: 1.9, tech: 0.1, mental: 1.9 } },
  positionExtraDrop: { WR: 15, QB: -15 },
};
const devA = generateClass(makeDevTraitTestRows(), devTraitDefaultCfg, () => {});
const devB = generateClass(makeDevTraitTestRows(), devTraitWildCfg, () => {});
const devByName = (arr) => Object.fromEntries(arr.map((p) => [p.LastName, p]));
const dA = devByName(devA), dB = devByName(devB);
for (const key of Object.keys(dA)) {
  check(`DevTrait invariant to rating-conversion tuning (${key})`, dB[key].DevTrait, dA[key].DevTrait);
}
check('Age invariant to rating-conversion tuning (WR93)', dB['WR93'].Age, dA['WR93'].Age);
// Sanity: prove the two configs actually convert differently (otherwise the
// invariance above would be vacuous) -- Awareness must differ given the wild
// config's globalStrength=0.3 and reclassification.
check('sanity: the two configs really do convert WR93 Awareness differently',
  dA['WR93'].Madden_AwarenessRating !== dB['WR93'].Madden_AwarenessRating, true);

// ===========================================================================
// 3. Speed realism (2026-08-11b) -- end-to-end, real shipped config, no
//    per-test overrides. A real report: on the shipped 2026-08-11 (first
//    retune) config, only 2 of 51 WRs in a generated class exceeded 90 speed,
//    against 25 of 42 in EA's own real Madden 27 classes. Root cause: the
//    `physical` bucket compressed SpeedRating and StrengthRating with the
//    SAME curve, so fixing overalls (which needed strength compressed) also
//    crushed speed (which didn't). Locks the actual fix: a burner's speed
//    should barely move from their college value, while their strength -- a
//    skill position's least football-relevant physical trait -- compresses
//    hard, using the SHIPPED config end to end (mergeConfig(null) ->
//    activeConfig, not a hand-built override object), so this fails if
//    anyone ever reverts the shipped defaults without updating this test.
// ===========================================================================
{
  const shipped = activeConfig(mergeConfig(null), 'nfl');
  shipped.general.seed = 'speed-realism';
  shipped.general.classSize = 10;
  shipped.translation.strategy = 'powercurve';

  // A realistic elite WR profile: fast AND strong, same shape as the real
  // report. Speed is deliberately 92, NOT a near-max 96-99 -- near the
  // curve's top anchor almost any reasonable curve stays close to identity
  // (that end barely moved between the over-compressed and fixed versions),
  // so a near-max value can't actually distinguish them. 92 sits where the
  // two anchors visibly diverge: the over-compressed curve maps it to 86
  // (fails the >=90 check below), the fixed one to 91. This is also a more
  // representative "fast, not a physical freak" CFB input than 96+ would be.
  const burner = {
    FirstName: 'Elite', LastName: 'Burner', OverallRating: 94, Position: 'WR',
    Height: 73, Weight: 195, JerseyNum: 1, SchoolYear: 'Junior',
    TraitDevelopment: 'College_Elite', AwardsScore: 0, CareerStats: null, ProjectRound: 1,
    SpeedRating: 92, AccelerationRating: 91, AgilityRating: 90, ChangeOfDirectionRating: 89,
    StrengthRating: 85, JumpingRating: 88, CatchingRating: 80, AwarenessRating: 75,
  };
  // The SHAPE of the shipped physical curve, pinned directly. The end-to-end
  // player checks below use a SPD 92 input, which several different curves all
  // map above 90 -- so they cannot distinguish "small hit" from "moderate hit"
  // on their own (verified: reverting to the previous 96/82 curve passed every
  // one of them). These two assertions are what actually encode the
  // requirement: a small hit at the top, and no inflation anywhere.
  const shippedPhysical = deriveCurve(defaultPowerCurveAnchors().physical);
  check('a 99 physical takes only a small hit (lands at 97)',
    transform(99, shippedPhysical, 1.0), 97);
  check('the curve never RAISES a physical rating -- 80 must not inflate',
    transform(80, shippedPhysical, 1.0) <= 80, true);
  check('...nor in the middle of the range (85)',
    transform(85, shippedPhysical, 1.0) <= 85, true);

  const [out] = calibratePlayers([burner], { config: shipped, log: () => {} });

  check('a fast college WR keeps most of their speed (within 6 of their CFB value)',
    out.Madden_SpeedRating >= burner.SpeedRating - 6, true);
  check('...specifically stays at or above 90 for a burner this fast',
    out.Madden_SpeedRating >= 90, true);
  check('the SAME WR\'s strength compresses meaningfully more than their speed did',
    (burner.StrengthRating - out.Madden_StrengthRating) > (burner.SpeedRating - out.Madden_SpeedRating) + 3, true);

  // Trench strength must NOT get the same harsh treatment -- categoryOverrides
  // is deliberately scoped to skill positions only.
  const lineman = {
    FirstName: 'Big', LastName: 'Tackle', OverallRating: 90, Position: 'LT',
    Height: 78, Weight: 320, JerseyNum: 70, SchoolYear: 'Senior',
    TraitDevelopment: 'College_Star', AwardsScore: 0, CareerStats: null, ProjectRound: 1,
    StrengthRating: 95, RunBlockRating: 82, PassBlockRating: 80, AwarenessRating: 70,
  };
  const [outLine] = calibratePlayers([lineman], { config: shipped, log: () => {} });
  check('a tackle\'s strength stays close to their CFB value (unlike a WR\'s)',
    outLine.Madden_StrengthRating >= lineman.StrengthRating - 6, true);
}

console.log(`\n  Power-Curve spec: ${passed} assertions passed.`);
