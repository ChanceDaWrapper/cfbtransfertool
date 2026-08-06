// Translation stage front door. createTranslator() is the ONLY way a caller
// outside this directory should construct a LIVE Translator -- it owns the
// strategy->implementation mapping so that mapping lives in exactly one
// place.
const { Translator } = require('./translator');
const { V1Translator } = require('./v1Translator');
const { RosettaTranslator } = require('./rosettaTranslator');
const { PowerCurveTranslator } = require('./powerCurveTranslator');
const { DiceRollTranslator } = require('./diceRollTranslator');
const { attributeClass, defaultAlpha } = require('../attributeTaxonomy');

// deps.legacyCalibratePlayers / deps.powerCurveCalibratePlayers /
// deps.diceRollCalibratePlayers: the injected concrete conversion functions
// (see the translator classes' header comments for why these are injected,
// not required -- lib/rosetta/ must not require pipeline.js). 'powercurve'
// is the live default; 'diceroll' is a second, independently selectable
// engine (see diceRoll.js) -- not a variant of Power Curve, a fully separate
// conversion model.
function createTranslator(strategy, deps = {}) {
  if (strategy === 'powercurve') return new PowerCurveTranslator(deps.powerCurveCalibratePlayers);
  if (strategy === 'diceroll') return new DiceRollTranslator(deps.diceRollCalibratePlayers);
  const v1 = new V1Translator(deps.legacyCalibratePlayers);
  if (strategy === 'v1') return v1;
  if (strategy === 'rosetta') return new RosettaTranslator(v1);
  throw new Error(`Unknown translation strategy: "${strategy}" (expected 'powercurve', 'diceroll', 'v1', or 'rosetta').`);
}

module.exports = {
  Translator, V1Translator, RosettaTranslator, PowerCurveTranslator, DiceRollTranslator,
  attributeClass, defaultAlpha,
  createTranslator,
};
