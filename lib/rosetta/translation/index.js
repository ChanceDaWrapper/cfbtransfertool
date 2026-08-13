// Translation stage front door. createTranslator() is the ONLY way a caller
// outside this directory should construct a LIVE Translator -- it owns the
// strategy->implementation mapping so that mapping lives in exactly one
// place.
const { Translator } = require('./translator');
const { PowerCurveTranslator } = require('./powerCurveTranslator');
const { DiceRollTranslator } = require('./diceRollTranslator');
const { attributeClass, defaultAlpha } = require('../attributeTaxonomy');

// deps.powerCurveCalibratePlayers / deps.diceRollCalibratePlayers: the injected
// concrete conversion functions (see the translator classes' header comments
// for why these are injected, not required -- lib/rosetta/ must not require
// pipeline.js).
//
// 'diceroll' is no longer a separate conversion model. It runs the Power-Curve
// conversion and then applies a per-player luck slide to the result, so the two
// strategies share one translation and differ only in that final layer.
//
// UNKNOWN STRATEGIES FALL BACK rather than throwing. The 'v1' and 'rosetta'
// strategies were removed in 0.3.2 (neither was ever reachable from the engine
// picker, and the renderer rewrites any other saved value back to 'powercurve'
// on load) -- but a config file hand-edited to one of them, or carried forward
// from an old install, must still open the app rather than crash it. Silently
// using the default is right here: the user's saved value names an engine that
// no longer exists, and there is nothing closer to honor.
const KNOWN = new Set(['powercurve', 'diceroll']);

function createTranslator(strategy, deps = {}) {
  const key = KNOWN.has(strategy) ? strategy : 'powercurve';
  if (key === 'diceroll') return new DiceRollTranslator(deps.diceRollCalibratePlayers);
  return new PowerCurveTranslator(deps.powerCurveCalibratePlayers);
}

module.exports = {
  Translator, PowerCurveTranslator, DiceRollTranslator,
  attributeClass, defaultAlpha,
  createTranslator,
};
