// Adapts the Dice Roll conversion to the Translator contract. Like
// PowerCurveTranslator, the concrete conversion function is INJECTED via the
// constructor rather than required directly: it lives in pipeline.js (where
// it can reuse the shared draft-projection / age / combine helpers), and
// lib/rosetta/ must never require pipeline.js (the no-back-edge coupling
// rule). The actual Dice Roll NUMERICS live in this directory (diceRoll.js)
// as a pure leaf module that pipeline.js requires.
const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');

class DiceRollTranslator extends Translator {
  constructor(diceRollCalibratePlayers) {
    super();
    if (typeof diceRollCalibratePlayers !== 'function') {
      throw new Error('DiceRollTranslator requires the diceRoll calibratePlayers function to be injected.');
    }
    this._calibrate = diceRollCalibratePlayers;
  }

  translate(hydratedPopulation, context) {
    const { config, log } = context;
    const result = this._calibrate(hydratedPopulation, { config, log });
    return tagStage(result, 'translated', { strategy: 'diceroll' });
  }
}

module.exports = { DiceRollTranslator };
