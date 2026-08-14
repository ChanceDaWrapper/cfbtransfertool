// Regression test for renderer/decisions.js -- the pure UI decisions pulled
// out of renderer.js so they can be tested at all.
//
// renderer.js is the largest file in the project and had ZERO coverage. The
// two most recent self-inflicted bugs both lived in this kind of logic, and
// both were caught by driving a browser by hand while all 39 specs stayed
// green:
//
//   1. Every Power Curve tuning card was hidden under Dice Roll, leaving that
//      engine with nothing to tune.
//   2. The locked "Coming Soon" Write-to-Franchise button could be re-enabled
//      by the ordinary flow, and clicking it overwrote a franchise save.
//
// Both are asserted below. Run with: node test/rendererDecisions.spec.js
// (or npm test).

const assert = require('assert');
const D = require('../renderer/decisions');
const { DEFAULT_CONFIG, activeConfig, mergeConfig, POSITIONS } = require('../lib/defaults');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

// ---------------------------------------------------------------------------
// 1. Engine normalization -- removed and unknown strategies must resolve to
//    the default rather than leaving a page in a state no branch handles.
// ---------------------------------------------------------------------------
check('powercurve passes through', D.normalizeEngine('powercurve'), 'powercurve');
check('diceroll passes through', D.normalizeEngine('diceroll'), 'diceroll');
for (const dead of ['v1', 'rosetta', 'nonsense', '', null, undefined]) {
  check(`${JSON.stringify(dead)} falls back to the default`, D.normalizeEngine(dead), 'powercurve');
}

// ---------------------------------------------------------------------------
// 2. Card visibility -- BUG #1. Power Curve's cards must be visible under BOTH
//    engines, because Dice Roll runs the Power Curve conversion and those
//    dials are exactly what tunes it. Hiding them (which is what shipped)
//    leaves Dice Roll users unable to change anything at all.
// ---------------------------------------------------------------------------
const POWER_CURVE_CARDS = [
  'powerCurveGlobalStrengthCard', 'powerCurveControls', 'strengthControls', 'globalTranslationControls',
];
for (const engine of ['powercurve', 'diceroll']) {
  const v = D.translationCardVisibility(engine);
  for (const card of POWER_CURVE_CARDS) {
    check(`[${engine}] ${card} is visible`, v[card], true);
  }
}
// ...and the Dice Roll card IS engine-specific: its one live setting (how much
// luck) genuinely does nothing under Power Curve.
check('Dice Roll card shows under Dice Roll', D.translationCardVisibility('diceroll').diceRollControls, true);
check('Dice Roll card hidden under Power Curve', D.translationCardVisibility('powercurve').diceRollControls, false);
// A removed strategy must not hide the tuning UI either.
check('a dead strategy still shows the Power Curve cards',
  D.translationCardVisibility('v1').powerCurveControls, true);

check('the categories notice is for Dice Roll only',
  [D.showsPhysicalEngineNotice('diceroll'), D.showsPhysicalEngineNotice('powercurve')], [true, false]);

// ---------------------------------------------------------------------------
// 3. Write to Franchise -- BUG #2. This button overwrites a franchise save IN
//    PLACE, and the feature ships locked. The lock must beat every readiness
//    condition, because the readiness conditions are exactly what re-enabled
//    it: the Madden-save picker is shared with the Dashboard hub (unlocked,
//    because the Coach Carousel needs it), so "pick a save, generate a class"
//    used to clear the lock.
// ---------------------------------------------------------------------------
const READY = { featureEnabled: true, playerCount: 402, maddenPath: 'C:/x', outMode: 'edit', outputPath: null };

check('enabled when the feature is on and everything is ready',
  D.writeButtonEnabled(READY), true);

// The exact state that used to unlock the locked card.
check('LOCKED beats a fully ready state',
  D.writeButtonEnabled({ ...READY, featureEnabled: false }), false);
check('...and beats it in copy mode too',
  D.writeButtonEnabled({ ...READY, featureEnabled: false, outMode: 'copy', outputPath: 'C:/out' }), false);
// The flag as actually shipped.
ok('the feature ships locked', D.writeButtonEnabled({ ...READY, featureEnabled: false }) === false);

// Ordinary readiness, with the feature unlocked.
check('needs a generated class', D.writeButtonEnabled({ ...READY, playerCount: 0 }), false);
check('needs a Madden save', D.writeButtonEnabled({ ...READY, maddenPath: null }), false);
check('copy mode needs an output path', D.writeButtonEnabled({ ...READY, outMode: 'copy', outputPath: null }), false);
check('copy mode is fine once given one',
  D.writeButtonEnabled({ ...READY, outMode: 'copy', outputPath: 'C:/out' }), true);
check('edit mode needs no output path', D.writeButtonEnabled({ ...READY, outMode: 'edit', outputPath: null }), true);

// ---------------------------------------------------------------------------
// 4. Modified-settings counts. A FRESH install must report zero on every page
//    -- the dashboard shows "Using Default Settings" only when all are 0.
//
//    This caught a real bug: the previous rule counted every entry in
//    powerCurve.categoryOverrides, which stopped being empty when skill
//    positions started routing StrengthRating to techhvy by default. A fresh
//    install reported "Rating Categories (5 modified)" and never showed
//    "Using Default Settings" at all.
// ---------------------------------------------------------------------------
const defaults = activeConfig(mergeConfig({}));
const fresh = JSON.parse(JSON.stringify(defaults));
const counts = D.countSectionDiffs(fresh, defaults, POSITIONS);
check('a fresh install reports nothing modified', counts, { weights: 0, physical: 0, advanced: 0, translation: 0 });

// Each page counts its own edits, and only its own.
const clone = () => JSON.parse(JSON.stringify(defaults));

const t1 = clone(); t1.positionStrength.WR.tech = 0.5;
check('a position strength edit counts on Rating Translation',
  D.countSectionDiffs(t1, defaults, POSITIONS), { weights: 0, physical: 0, advanced: 0, translation: 1 });

const t2 = clone(); t2.diceRoll.spread = 2.5;
check('the Luck dial counts', D.countSectionDiffs(t2, defaults, POSITIONS).translation, 1);

const t3 = clone(); t3.powerCurve.anchors.physical.y1 = 90;
check('an anchor edit counts', D.countSectionDiffs(t3, defaults, POSITIONS).translation, 1);

const w1 = clone(); w1.positionCaps.WR = 10;
check('a position cap counts on Position Weights',
  D.countSectionDiffs(w1, defaults, POSITIONS), { weights: 1, physical: 0, advanced: 0, translation: 0 });

const p1 = clone(); p1.powerCurve.ratingCategory.SpeedRating = 'mental';
check('a rating reclassification counts on Rating Categories',
  D.countSectionDiffs(p1, defaults, POSITIONS).physical, 1);

// A per-position exception the USER adds counts; the shipped ones do not.
const p2 = clone(); p2.powerCurve.categoryOverrides.QB = { AwarenessRating: 'techmod' };
check('a user-added per-position exception counts',
  D.countSectionDiffs(p2, defaults, POSITIONS).physical, 1);
const p3 = clone(); p3.powerCurve.categoryOverrides.WR.StrengthRating = 'physical';
check('changing a SHIPPED exception counts too',
  D.countSectionDiffs(p3, defaults, POSITIONS).physical, 1);

const a1 = clone(); a1.general.seed = 'abc';
check('a seed counts on Advanced',
  D.countSectionDiffs(a1, defaults, POSITIONS), { weights: 0, physical: 0, advanced: 1, translation: 0 });

const a2 = clone(); a2.devTraits.starPercentTarget = 99;
check('a dev-trait target counts on Advanced', D.countSectionDiffs(a2, defaults, POSITIONS).advanced, 1);

// Edits accumulate rather than saturating at 1.
const many = clone();
many.positionStrength.WR.tech = 0.5;
many.positionStrength.TE.mental = 0.5;
many.powerCurve.globalStrength = 9;
check('multiple edits on one page all count',
  D.countSectionDiffs(many, defaults, POSITIONS).translation, 3);

// A config missing whole sections (an old file) must not throw.
const sparse = { translation: { strategy: 'powercurve' }, powerCurve: {}, general: {} };
let threw = false;
try { D.countSectionDiffs(sparse, defaults, POSITIONS); } catch (e) { threw = true; }
check('a sparse/legacy config does not throw', threw, false);

console.log(`\n  Renderer decisions spec: ${passed} assertions passed.`);
