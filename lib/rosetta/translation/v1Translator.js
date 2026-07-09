// Adapts today's legacy rating-conversion logic (lib/pipeline.js's
// calibratePlayers body, unmoved and unchanged) to the Translator contract.
//
// The legacy function is INJECTED via the constructor rather than required
// directly. pipeline.js already requires lib/rosetta (for Rosetta.run /
// makeSeededRng), so a direct `require('../../pipeline')` here would create
// a cycle -- and per this project's coupling rule, Rosetta subsystems
// shouldn't reach outside lib/rosetta/ at all. Injection also keeps this
// class honest about what it is: a thin adapter around code that stays in
// pipeline.js, unmoved, until a later phase replaces it for real.
const { Translator } = require('./translator');

class V1Translator extends Translator {
  constructor(legacyCalibratePlayers) {
    super();
    if (typeof legacyCalibratePlayers !== 'function') {
      throw new Error('V1Translator requires the legacy calibratePlayers function to be injected.');
    }
    this._legacyCalibratePlayers = legacyCalibratePlayers;
  }

  translate(context) {
    const { population, config, log } = context;
    return this._legacyCalibratePlayers(population, { config, log });
  }
}

module.exports = { V1Translator };
