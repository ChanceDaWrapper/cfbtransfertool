// Translation stage front door. createTranslator() is the ONLY way a caller
// outside this directory should construct a live Translator -- it owns the
// strategy->implementation mapping so that mapping lives in exactly one place.
//
// WHAT A TRANSLATOR IS. Population-level, not per-player:
// translate(hydratedPopulation, context) takes the whole HydratedPopulation
// (see ../lifecycle.js) and returns the whole TranslatedPopulation in one
// call, tagged with the stage it just completed. The population is an explicit
// argument rather than something read off the context, because RosettaContext
// is services/environment only (see ../context.js) -- population data flows
// through as arguments and return values, never on a shared object.
//
// Coupling rule: the concrete conversion functions are INJECTED via
// createTranslator rather than required. They live in pipeline.js, where they
// can reuse the shared draft-projection / age / combine helpers, and
// lib/rosetta/ must never require pipeline.js (the no-back-edge rule). The
// power-curve NUMERICS, by contrast, live in this directory (powerCurve.js,
// powerCurveCategories.js, diceRoll.js) -- the math is owned by Translation
// even though the orchestration that stitches it into a draft class is not.
//
// WHY THIS IS ONE SMALL FILE. It used to be four: an abstract Translator base
// class plus a concrete subclass per strategy. That shape was built for a
// migration that never happened -- a percentile-mapping engine (internally
// "Two-Anchor") meant to replace the original V1 engine, whose base-class
// contract described cohort-relative math like reference-distribution
// percentile mapping and class-level frame statistics. That engine was
// abandoned before any of its translation math was written, and V1 itself was
// removed in 0.3.2. What survived was an abstract class documenting behavior
// no implementation had, and two concrete subclasses that were byte-identical
// to each other apart from one string. Both simply validated that a function
// had been injected, called it, and tagged the result.
//
// So there is one parameterized Translator now instead of a class hierarchy.
// If a genuinely different translation shape ever arrives -- one that needs
// cohort context, or returns something other than a calibrated row list --
// give it its own class then, when its actual contract is known. Inventing
// the abstraction ahead of the second implementation is what produced the
// version this replaces.
const { tagStage } = require('../lifecycle');
const { attributeClass, defaultAlpha } = require('../attributeTaxonomy');

// The strategies the engine picker offers. Anything else FALLS BACK to
// 'powercurve' rather than throwing: 'v1' and 'rosetta' were removed in 0.3.2
// (neither was ever reachable -- the picker has only ever offered these two,
// and the renderer rewrites any other saved value on load), but a config file
// hand-edited to one of them, or carried forward from an old install, must
// still open the app rather than crash it. Silently using the default is right
// here -- the saved value names an engine that no longer exists, and there is
// nothing closer to honor.
const STRATEGIES = ['powercurve', 'diceroll'];

class Translator {
  constructor(strategy, calibratePlayers) {
    if (typeof calibratePlayers !== 'function') {
      throw new Error(`Translator("${strategy}") requires its calibratePlayers function to be injected.`);
    }
    this.strategy = strategy;
    this._calibrate = calibratePlayers;
  }

  translate(hydratedPopulation, context) {
    const { config, log } = context;
    const result = this._calibrate(hydratedPopulation, { config, log });
    return tagStage(result, 'translated', { strategy: this.strategy });
  }
}

// deps.powerCurveCalibratePlayers / deps.diceRollCalibratePlayers -- see the
// coupling rule above for why these are injected rather than required.
//
// 'diceroll' is not a separate conversion model. It runs the Power-Curve
// conversion and then applies a per-player luck slide to the result, so the
// two strategies share one conversion and differ only in that final layer.
function createTranslator(strategy, deps = {}) {
  const key = STRATEGIES.includes(strategy) ? strategy : 'powercurve';
  const calibrate = key === 'diceroll'
    ? deps.diceRollCalibratePlayers
    : deps.powerCurveCalibratePlayers;
  return new Translator(key, calibrate);
}

module.exports = {
  Translator,
  STRATEGIES,
  createTranslator,
  attributeClass,
  defaultAlpha,
};
