// Translation stage front door. createTranslator() is the ONLY way a caller
// outside this directory should construct a LIVE Translator (the strategy
// dispatch still only knows 'v1'/'rosetta') -- it owns the
// strategy->implementation mapping so that mapping lives in exactly one
// place. TwoAnchorTranslator is exported for discoverability/standalone
// testing but is NOT wired into createTranslator yet -- see its own file
// header for why.
const { Translator } = require('./translator');
const { V1Translator } = require('./v1Translator');
const { RosettaTranslator } = require('./rosettaTranslator');
const { TwoAnchorTranslator } = require('./twoAnchorTranslator');
const { PowerCurveTranslator } = require('./powerCurveTranslator');
const { attributeClass, defaultAlpha } = require('../attributeTaxonomy');

// deps.legacyCalibratePlayers / deps.powerCurveCalibratePlayers: the injected
// concrete conversion functions (see the translator classes' header comments
// for why these are injected, not required -- lib/rosetta/ must not require
// pipeline.js). 'powercurve' is the live default.
function createTranslator(strategy, deps = {}) {
  if (strategy === 'powercurve') return new PowerCurveTranslator(deps.powerCurveCalibratePlayers);
  const v1 = new V1Translator(deps.legacyCalibratePlayers);
  if (strategy === 'v1') return v1;
  if (strategy === 'rosetta') return new RosettaTranslator(v1);
  throw new Error(`Unknown translation strategy: "${strategy}" (expected 'powercurve', 'v1', or 'rosetta').`);
}

module.exports = {
  Translator, V1Translator, RosettaTranslator, TwoAnchorTranslator, PowerCurveTranslator,
  attributeClass, defaultAlpha,
  createTranslator,
};
