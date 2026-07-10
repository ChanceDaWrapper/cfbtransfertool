// Adapts the Power-Curve conversion (model spec) to the Translator contract.
// Like V1Translator, the concrete conversion function is INJECTED via the
// constructor rather than required directly: it lives in pipeline.js (where it
// can reuse the shared draft-projection / age / combine helpers), and
// lib/rosetta/ must never require pipeline.js (the no-back-edge coupling rule).
// The actual power-curve NUMERICS, by contrast, live in this directory
// (powerCurve.js / powerCurveCategories.js) as pure leaf modules that
// pipeline.js requires -- so the math is owned by Translation even though the
// orchestration that stitches it into a full draft class is not.
const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');

class PowerCurveTranslator extends Translator {
  constructor(powerCurveCalibratePlayers) {
    super();
    if (typeof powerCurveCalibratePlayers !== 'function') {
      throw new Error('PowerCurveTranslator requires the powerCurve calibratePlayers function to be injected.');
    }
    this._calibrate = powerCurveCalibratePlayers;
  }

  translate(hydratedPopulation, context) {
    const { config, log } = context;
    const result = this._calibrate(hydratedPopulation, { config, log });
    return tagStage(result, 'translated', { strategy: 'powercurve' });
  }
}

module.exports = { PowerCurveTranslator };
