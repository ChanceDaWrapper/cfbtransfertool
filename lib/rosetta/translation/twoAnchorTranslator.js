// Two-Anchor Translation -- SKELETON ONLY.
//
// Wires the Translator contract to a FrameProvider and proves the data
// flows correctly end to end -- constructed with an injected FrameProvider,
// fetches the real AttributeReference (see ../calibration/attributeReference.js)
// for every attribute it processes, returns a properly-tagged
// TranslatedPopulation. It does NOT yet implement the real translation
// mathematics (the tie-corrected percentile CDF, PCHIP quantile
// interpolation, absolute/relative anchor blending -- see the math spec).
// That is deliberately deferred to the next phase, gated on this skeleton
// -- and the interfaces it depends on -- being validated first.
//
// NOT wired into the live translation.strategy dispatch
// (lib/rosetta/translation/index.js still only knows 'v1'/'rosetta', and
// 'rosetta' still delegates to V1Translator) -- this class is standalone
// and tested in isolation, so legacy behavior stays byte-identical while
// it's built out. A later phase swaps RosettaTranslator's fallback for
// this class once its math is real and validated.
//
// Known incompleteness, intentional for a skeleton: _translateAttribute
// returns each rating unchanged (an identity placeholder) and the overall
// row shape does not yet match V1Translator's output (no Madden_* prefix,
// no EstMaddenOverall, no Combine, no age/height/weight/jersey handling --
// all of that is real translation work for the next phase, not wiring).

const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');
const { FrameProvider } = require('../calibration/providers/frameProvider');

class TwoAnchorTranslator extends Translator {
  constructor(frameProvider) {
    super();
    if (!(frameProvider instanceof FrameProvider)) {
      throw new Error('TwoAnchorTranslator requires a FrameProvider.');
    }
    this._frames = frameProvider;
  }

  translate(hydratedPopulation, context) {
    const result = hydratedPopulation.map((player) => this._translatePlayer(player));
    return tagStage(result, 'translated', { strategy: 'rosetta-two-anchor-skeleton' });
  }

  _translatePlayer(player) {
    const translated = { ...player };
    for (const attribute of Object.keys(player)) {
      if (!/Rating$/.test(attribute)) continue;
      translated[attribute] = this._translateAttribute(player.Position, attribute, player[attribute]);
    }
    return translated;
  }

  // TODO(real math, next phase): the Two-Anchor blend, given
  // ref = frames.attribute(position, attribute) --
  //   u        = percentile(ref.collegeDistribution, value)   [tie-corrected mid-distribution CDF]
  //   relative = quantileMap(ref.rookieDistribution, u)        [PCHIP]
  //   absolute = physicalScaleLookup(ref.physicalScale, value) [when ref.physicalScale is non-null]
  //   alpha    = ref.taxonomy.alpha
  //   return round(clamp(alpha * absolute + (1 - alpha) * relative, 0, 99))
  //
  // For now: identity passthrough. The AttributeReference IS fetched (not
  // yet used) -- this deliberately exercises FrameProvider for every
  // attribute processed, so a missing fixture/artifact fails loudly here,
  // at the wiring level, rather than silently once real math lands.
  _translateAttribute(position, attribute, value) {
    if (value === null || value === undefined || value === '') return value;
    this._frames.attribute(position, attribute);
    return value;
  }
}

module.exports = { TwoAnchorTranslator };
