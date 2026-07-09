// Translation stage front door. createTranslator() is the ONLY way a caller
// outside this directory should construct a Translator -- it owns the
// strategy->implementation mapping so that mapping lives in exactly one
// place.
const { Translator } = require('./translator');
const { V1Translator } = require('./v1Translator');
const { RosettaTranslator } = require('./rosettaTranslator');

// deps.legacyCalibratePlayers: the injected legacy function (see
// V1Translator's header comment for why this is injected, not required).
function createTranslator(strategy, deps = {}) {
  const v1 = new V1Translator(deps.legacyCalibratePlayers);
  if (strategy === 'v1') return v1;
  if (strategy === 'rosetta') return new RosettaTranslator(v1);
  throw new Error(`Unknown translation strategy: "${strategy}" (expected 'v1' or 'rosetta').`);
}

module.exports = { Translator, V1Translator, RosettaTranslator, createTranslator };
