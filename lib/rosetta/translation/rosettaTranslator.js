// The real translation engine. Currently a placeholder: it delegates every
// call to a fallback Translator (V1Translator today) so the strategy seam
// is provably wired end-to-end -- population in, translated population out,
// selectable via config -- before a single line of Rosetta's actual
// two-anchor translation math exists.
//
// A future phase replaces the BODY of translate() with real math (reading
// context.calibrationModel through its own FrameProvider view once Phase 5
// builds it). The contract (population-level Translator, reading only
// context.config/.log/.calibrationModel) does not change -- that's the
// point of building the abstraction now rather than when the math is ready.
const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');

class RosettaTranslator extends Translator {
  constructor(fallback) {
    super();
    if (!(fallback instanceof Translator)) {
      throw new Error('RosettaTranslator requires a fallback Translator (V1Translator today) while its own translation math is unbuilt.');
    }
    this._fallback = fallback;
  }

  translate(hydratedPopulation, context) {
    // TODO(Phase 5): replace with real Rosetta translation, reading
    // context.calibrationModel through this engine's own FrameProvider view.
    const result = this._fallback.translate(hydratedPopulation, context);
    return tagStage(result, 'translated', { strategy: 'rosetta (delegates to v1 -- no translation math built yet)' });
  }
}

module.exports = { RosettaTranslator };
