// Two-Anchor Translation -- the real engine, replacing the identity-
// passthrough skeleton. Constructed with an injected FrameProvider and a
// rating-field list (see below for why the list is injected); translate()
// runs the full model:
//
//   u        = tieAwarePercentile(value, ref.collegeDistribution)   [F^C -- tie-corrected mid-distribution CDF]
//   relative = quantileInterpolate(u, ref.rookieDistribution)       [Q^N -- piecewise-linear quantile]
//   absolute = scaleInterpolate(value, ref.physicalScale)           [only when a physical scale exists]
//   alpha    = ref.physicalScale ? ref.taxonomy.alpha : 0
//   y        = round(clamp(alpha*absolute + (1-alpha)*relative, 0, 99))
//
// All four math primitives (percentile, quantile interpolation, scale
// interpolation, degenerate check) live in ./twoAnchorMath.js -- pure,
// stateless, independently hand-verified against the math spec BEFORE
// being wired in here. This file owns orchestration (which attribute to
// translate, how to blend, how to fall back) -- not the numerics
// themselves.
//
// NOT wired into the live translation.strategy dispatch --
// lib/rosetta/translation/index.js's createTranslator('rosetta', ...)
// still returns a RosettaTranslator that delegates to V1Translator.
// Flipping that is a separate, later decision; this phase is "does the
// real math exist, work correctly, and compare sensibly against V1" --
// answered by construction + the scorecard's calibrationBuilder-adjacent
// category, not by silently changing what 'rosetta' means live. Legacy
// behavior (and the 'rosetta' strategy's current v1-equivalent behavior)
// stays byte-identical throughout this phase.
//
// ratingFields is INJECTED (constructor parameter), not required from
// pipeline.js -- same reason as every other injection in this migration
// (lib/rosetta must never require pipeline.js; see V1Translator's header
// comment). It should be pipeline.js's RATING_NAMES: the canonical "ratings
// that exist on both CFB and Madden" list CalibrationModel was itself built
// from (Phase 5) -- NOT the raw CFB-schema-derived field list, which
// includes CFB-only fields (e.g. ThrowAccuracyRating) with no Madden-side
// counterpart and no CalibrationModel coverage.

const { Translator } = require('./translator');
const { tagStage } = require('../lifecycle');
const { FrameProvider } = require('../calibration/providers/frameProvider');
const { tieAwarePercentile, quantileInterpolate, scaleInterpolate, isDegenerate } = require('./twoAnchorMath');

class TwoAnchorTranslator extends Translator {
  constructor(frameProvider, ratingFields) {
    super();
    if (!(frameProvider instanceof FrameProvider)) {
      throw new Error('TwoAnchorTranslator requires a FrameProvider.');
    }
    if (!Array.isArray(ratingFields) || ratingFields.length === 0) {
      throw new Error('TwoAnchorTranslator requires a non-empty ratingFields list (pass pipeline.js\'s RATING_NAMES).');
    }
    this._frames = frameProvider;
    this._ratingFields = ratingFields;
    // Diagnostics, not control flow -- collected per translate() call so a
    // caller can inspect what fell back and why, without either crashing
    // the run or silently hiding it. Reset at the start of each translate().
    this._warnings = [];
  }

  translate(hydratedPopulation, context) {
    this._warnings = [];
    const result = hydratedPopulation.map((player) => this._translatePlayer(player));
    const tagged = tagStage(result, 'translated', { strategy: 'rosetta-two-anchor', warnings: this._warnings.length });
    return tagged;
  }

  // Returns the warnings collected during the most recent translate() call
  // (missing-data / degenerate-source fallbacks) -- for inspection/logging,
  // not consumed by any other Rosetta subsystem.
  getWarnings() {
    return this._warnings;
  }

  _translatePlayer(player) {
    const row = {
      FirstName: player.FirstName,
      LastName: player.LastName,
      CFB_Position: player.Position,
      FormerTeam: player.FormerTeam || '',
      CFB_Overall: Number(player.OverallRating),
    };
    for (const attribute of this._ratingFields) {
      const rawValue = player[attribute];
      if (rawValue === null || rawValue === undefined || rawValue === '') continue;
      row[`Madden_${attribute}`] = this._translateAttribute(player.Position, attribute, rawValue);
    }
    return row;
  }

  _translateAttribute(position, attribute, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return rawValue;

    let ref;
    try {
      ref = this._frames.attribute(position, attribute);
    } catch (e) {
      // MISSING DATA (documented, not silent): CalibrationModel has no
      // reference for this (position, attribute) pair -- e.g. a position
      // with zero broad-tier coverage on this save (LS, confirmed in the
      // Phase 5 data-quality audit). Rather than crash the whole
      // translation run over one uncovered pair, fall back to the raw
      // value, clamped to Madden's valid range -- the safest, most honest
      // thing to do when no reference distribution exists to translate
      // against at all.
      this._warnings.push({ type: 'missing-data', position, attribute, reason: e.message });
      return this._clampRound(value);
    }

    // DEGENERATE SOURCE (math spec Sec 1.3, case 1): fewer than 2 distinct
    // values in the college reference carries no percentile information --
    // forcing a lookup against a constant sample would manufacture a fake
    // percentile (always exactly 0 or 1) rather than report "no signal
    // here." Pass through instead.
    if (isDegenerate(ref.collegeDistribution)) {
      this._warnings.push({ type: 'degenerate-source', position, attribute });
      return this._clampRound(value);
    }

    const u = tieAwarePercentile(value, ref.collegeDistribution);
    const relative = isDegenerate(ref.rookieDistribution)
      ? ref.rookieDistribution[0]
      : quantileInterpolate(u, ref.rookieDistribution);

    // No physical scale exists for this attribute class in the current
    // CalibrationModel (mental/technical attributes -- Phase 5's
    // physicalScaleBuilder only populates physical/health classes). alpha
    // is forced to 0 here rather than silently substituting `relative` in
    // place of an `absolute` that doesn't exist -- this branch is what
    // documents WHY the blend collapses to pure relative-anchor
    // translation for those attributes today, rather than leaving it as an
    // unexplained coincidence. The taxonomy's non-zero mental/technical
    // alpha defaults become "the weight IF a physical scale existed" --
    // moot until Phase 5's calibration is extended with real paired data.
    let alpha = 0;
    let absolute = relative;
    if (ref.physicalScale) {
      absolute = scaleInterpolate(value, ref.physicalScale);
      alpha = ref.taxonomy.alpha;
    }

    const blended = alpha * absolute + (1 - alpha) * relative;
    return this._clampRound(blended);
  }

  _clampRound(v) {
    return Math.max(0, Math.min(99, Math.round(v)));
  }
}

module.exports = { TwoAnchorTranslator };
