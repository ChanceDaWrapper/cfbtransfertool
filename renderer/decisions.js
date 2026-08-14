// Pure UI decisions, extracted from renderer.js so they can be tested.
//
// WHY THIS FILE EXISTS. renderer.js is the largest file in the project and had
// no test coverage at all, and the two most recent self-inflicted bugs both
// lived in exactly this kind of logic:
//
//   1. Every Power Curve tuning card was hidden whenever Dice Roll was
//      selected. That was correct when Dice Roll was a separate engine, and
//      became wrong the moment Dice Roll started running Power Curve -- it
//      left Dice Roll users with nothing to tune.
//   2. The locked "Coming Soon" Write to Franchise button could be re-enabled
//      by the ordinary flow, because `disabled` in markup is only an initial
//      state and two other code paths reassigned it from real state. Clicking
//      it overwrote the user's franchise save in place.
//
// Both were decision bugs, not rendering bugs -- pure "given this state, what
// should be true" questions with no DOM in them. Both were found by driving a
// browser by hand while the suite stayed green. Answering them here, in
// functions that take explicit arguments and return plain values, is what
// makes them testable at all.
//
// RULES FOR THIS FILE: no DOM, no globals, no `cfg`/`META` reads. Everything
// comes in as an argument and goes out as a return value. Anything that
// touches an element belongs in renderer.js.
//
// Loaded as a plain <script> before renderer.js (which is not an ES module),
// and also require()-able from Node so test/rendererDecisions.spec.js can
// exercise it -- hence the dual export at the bottom.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Decisions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The engines the picker offers. Anything else -- a config from before Dice
  // Roll existed, or the removed 'v1'/'rosetta' hand-edited in -- resolves to
  // the default rather than leaving the page in a state no branch handles.
  const ENGINES = ['powercurve', 'diceroll'];
  const DEFAULT_ENGINE = 'powercurve';

  function normalizeEngine(strategy) {
    return ENGINES.includes(strategy) ? strategy : DEFAULT_ENGINE;
  }

  // Which cards the Rating Translation page shows for a given engine.
  //
  // The Power Curve cards are visible for BOTH engines and that is the whole
  // point: Dice Roll runs the Power Curve conversion and only adds a luck
  // slide on top, so those dials are precisely what tunes it. Only the Dice
  // Roll card is engine-specific, because its one live setting (how much luck)
  // genuinely does nothing under Power Curve.
  function translationCardVisibility(strategy) {
    const engine = normalizeEngine(strategy);
    return {
      diceRollControls: engine === 'diceroll',
      powerCurveGlobalStrengthCard: true,
      powerCurveControls: true,
      strengthControls: true,
      globalTranslationControls: true,
    };
  }

  // Whether the Rating Categories page's "these buckets apply to both engines"
  // notice should show. It is only interesting under Dice Roll, where a user
  // might reasonably assume the page does not apply to them.
  function showsPhysicalEngineNotice(strategy) {
    return normalizeEngine(strategy) === 'diceroll';
  }

  // Whether "Write to Franchise" may be clicked.
  //
  // `featureEnabled` is first and non-negotiable: the feature ships locked, and
  // this button overwrites a franchise save IN PLACE. Every other condition is
  // ordinary readiness.
  function writeButtonEnabled({
    featureEnabled, playerCount, maddenPath, outMode, outputPath,
  }) {
    if (!featureEnabled) return false;
    if (!playerCount) return false;
    if (!maddenPath) return false;
    if (outMode === 'copy' && !outputPath) return false;
    return true;
  }

  // Counts how many settings on each page differ from the shipped defaults --
  // the "(3 modified)" badges on the dashboard summary.
  //
  // Takes cfg/defaults/positions explicitly rather than reading globals. The
  // page keys are historical: 'physical' is the Rating Categories page (that
  // page was repurposed and the key was kept).
  function countSectionDiffs(cfg, defaults, positions) {
    const d = defaults;
    let weights = 0, physical = 0, advanced = 0, translation = 0;
    const num = (v) => (v ?? null);

    // --- Rating Translation -------------------------------------------------
    if (normalizeEngine(cfg.translation && cfg.translation.strategy)
        !== normalizeEngine(d.translation && d.translation.strategy)) translation++;

    if (cfg.positionStrength && d.positionStrength) {
      for (const pos of positions) {
        const s = cfg.positionStrength[pos] || {}, ds = d.positionStrength[pos] || {};
        for (const k of ['tech', 'mental', 'physical']) if (s[k] !== ds[k]) translation++;
      }
    }
    // Extra Drop lives in its own config section (positionExtraDrop) but its
    // control sits on this page, so it counts toward this page's total.
    if (cfg.positionExtraDrop && d.positionExtraDrop) {
      for (const pos of positions) {
        if (cfg.positionExtraDrop[pos] !== d.positionExtraDrop[pos]) translation++;
      }
    }
    if (cfg.powerCurve && d.powerCurve) {
      for (const cat of Object.keys(d.powerCurve.anchors || {})) {
        const a = (cfg.powerCurve.anchors || {})[cat] || {};
        const da = (d.powerCurve.anchors || {})[cat] || {};
        for (const k of ['x1', 'y1', 'x2', 'y2']) if (a[k] !== da[k]) translation++;
      }
      for (const k of ['globalStrength', 'jitter', 'clampFloor', 'clampCeiling']) {
        if (cfg.powerCurve[k] !== d.powerCurve[k]) translation++;
      }
    }
    // Only `spread` counts. classStrength/debuff are inert since the Dice Roll
    // rewrite and have no UI, so counting them would light the "modified"
    // badge over a value the user cannot see or change.
    if (cfg.diceRoll && d.diceRoll) {
      if (num(cfg.diceRoll.spread) !== num(d.diceRoll.spread)) translation++;
    }
    if (cfg.overallBoost && d.overallBoost) {
      for (const k of ['enabled', 'points']) {
        if (cfg.overallBoost[k] !== d.overallBoost[k]) translation++;
      }
    }

    // --- Position Weights ---------------------------------------------------
    if (cfg.positionValue && d.positionValue) {
      for (const pos of positions) {
        if (cfg.positionValue[pos] !== d.positionValue[pos]) weights++;
      }
    }
    const capKeys = new Set([
      ...Object.keys(cfg.positionCaps || {}),
      ...Object.keys(d.positionCaps || {}),
    ]);
    for (const pos of capKeys) {
      if (num((cfg.positionCaps || {})[pos]) !== num((d.positionCaps || {})[pos])) weights++;
    }

    // --- Rating Categories ('physical' key kept for history) ----------------
    const pc = cfg.powerCurve || {};
    physical += Object.keys(pc.ratingCategory || {}).length;
    physical += Object.keys(pc.ratingTweaks || {}).length;
    const co = pc.categoryOverrides || {};
    const dco = (d.powerCurve && d.powerCurve.categoryOverrides) || {};
    // Only exceptions the USER added count. categoryOverrides ships non-empty
    // (skill positions route StrengthRating to techhvy by default), so counting
    // every entry would report a fresh install as modified.
    for (const pos of Object.keys(co)) {
      for (const rating of Object.keys(co[pos] || {})) {
        if (!dco[pos] || dco[pos][rating] !== co[pos][rating]) physical++;
      }
    }

    // --- Advanced -----------------------------------------------------------
    if (cfg.general && d.general) {
      if (cfg.general.classSize !== d.general.classSize) advanced++;
      if ((cfg.general.seed || '') !== (d.general.seed || '')) advanced++;
    }
    if (cfg.devTraits && d.devTraits) {
      for (const k of ['xfactorPercentTarget', 'superstarPercentTarget', 'starPercentTarget']) {
        if (cfg.devTraits[k] !== d.devTraits[k]) advanced++;
      }
    }
    if (cfg.draftValue && d.draftValue) {
      for (const k of ['positionValueWeight', 'awardsWeight', 'athleticismWeight',
        'productionWeight', 'roundWeight', 'boardVariance', 'generationalEnabled']) {
        if (cfg.draftValue[k] !== d.draftValue[k]) advanced++;
      }
    }
    if (cfg.realism && d.realism
        && cfg.realism.agilityCodSizePenalty !== d.realism.agilityCodSizePenalty) advanced++;

    return { weights, physical, advanced, translation };
  }

  return {
    ENGINES,
    DEFAULT_ENGINE,
    normalizeEngine,
    translationCardVisibility,
    showsPhysicalEngineNotice,
    writeButtonEnabled,
    countSectionDiffs,
  };
}));
