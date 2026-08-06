// A permanent placeholder, not a staging point for unfinished work: it
// delegates every call to a fallback Translator (V1Translator today) so the
// strategy seam stays provably wired end-to-end -- population in, translated
// population out, selectable via config. The percentile-based engine this
// was originally scaffolded for (internally "Two-Anchor") was abandoned
// before any of its translation math was built; that engine, and the
// calibration-model machinery it would have read through its own
// FrameProvider view, have been removed. Neither 'rosetta' nor 'v1' is
// reachable from the UI today (see defaults.js's translation.strategy
// comment) -- this class exists for tooling/comparison, not as a work site.
const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');

class RosettaTranslator extends Translator {
  constructor(fallback) {
    super();
    if (!(fallback instanceof Translator)) {
      throw new Error('RosettaTranslator requires a fallback Translator (V1Translator today) -- it has no translation math of its own.');
    }
    this._fallback = fallback;
  }

  translate(hydratedPopulation, context) {
    const result = this._fallback.translate(hydratedPopulation, context);
    return tagStage(result, 'translated', { strategy: 'rosetta (delegates to v1)' });
  }
}

module.exports = { RosettaTranslator };
