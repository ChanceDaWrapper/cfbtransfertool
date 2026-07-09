// The real translation engine. Currently a placeholder: it delegates every
// call to a fallback Translator (V1Translator today) so the strategy seam
// is provably wired end-to-end -- population in, translated population out,
// selectable via config -- before a single line of Rosetta's actual
// two-anchor translation math exists.
//
// A future phase replaces the BODY of translate() with real math (frames,
// percentile mapping, the absolute/relative anchor blend). The contract
// (population-level Translator, reading only context.population/.config/
// .log/.frames) does not change -- that's the point of building the
// abstraction now rather than when the math is ready.
const { Translator } = require('./translator');

class RosettaTranslator extends Translator {
  constructor(fallback) {
    super();
    if (!(fallback instanceof Translator)) {
      throw new Error('RosettaTranslator requires a fallback Translator (V1Translator today) while its own translation math is unbuilt.');
    }
    this._fallback = fallback;
  }

  translate(context) {
    // TODO(Phase 4): replace with real Rosetta translation. Reads
    // context.frames once that field is populated (Phase 3).
    return this._fallback.translate(context);
  }
}

module.exports = { RosettaTranslator };
