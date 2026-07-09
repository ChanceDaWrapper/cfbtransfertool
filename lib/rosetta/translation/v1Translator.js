// Adapts today's legacy rating-conversion logic (lib/pipeline.js's
// calibratePlayersV1, unmoved and unchanged) to the Translator contract.
//
// The legacy function is INJECTED via the constructor rather than required
// directly. pipeline.js already requires lib/rosetta (for Rosetta.
// buildSelection / makeSeededRng), so a direct `require('../../pipeline')`
// here would create a cycle -- and per this project's coupling rule,
// Rosetta subsystems shouldn't reach outside lib/rosetta/ at all. Injection
// also keeps this class honest about what it is: a thin adapter around
// code that stays in pipeline.js, unmoved, until a later phase replaces it
// for real.
const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');

class V1Translator extends Translator {
  constructor(legacyCalibratePlayers) {
    super();
    if (typeof legacyCalibratePlayers !== 'function') {
      throw new Error('V1Translator requires the legacy calibratePlayers function to be injected.');
    }
    this._legacyCalibratePlayers = legacyCalibratePlayers;
  }

  translate(hydratedPopulation, context) {
    const { config, log } = context;
    const result = this._legacyCalibratePlayers(hydratedPopulation, { config, log });
    return tagStage(result, 'translated', { strategy: 'v1' });
  }
}

module.exports = { V1Translator };
