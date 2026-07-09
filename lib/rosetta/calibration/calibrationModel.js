// CalibrationModel -- the passive, immutable store of every artifact
// Rosetta's consumers need that was fit/derived from real game data:
// college and NFL-rookie reference distributions, physical measurement-
// scale maps, archetype prototypes, overall-estimator coefficients.
//
// STRICT INVARIANT: performs NO calculations. Every method here is a
// lookup, never a computation. Percentile mapping, quantile interpolation,
// clustering, and estimation all belong to the CONSUMER that needs them
// (Translation, Archetype Inference, Overall) -- never here. Treat this
// like a read-only database, not a service.
//
// STRICT INVARIANT: immutable. A CalibrationModel instance is built ONCE
// (by a future calibration builder, Phase 5) and never mutated afterward.
// Concrete implementations should Object.freeze() themselves at
// construction.
//
// STRICT INVARIANT: gap-filling (sparse-position pooling, shrinkage
// blending across sample tiers, per the calibration strategy) happens
// INSIDE THE BUILDER, before a CalibrationModel is ever handed to a
// consumer. Once built, every getter below returns a complete,
// ready-to-use artifact for any valid (position, attribute) key -- never
// partial data a consumer has to patch. This is what lets every provider
// built on top of this be a computation-free pass-through.
//
// No consumer depends on CalibrationModel directly except the narrow
// provider that implements it for one purpose (FrameProvider for
// Translation, ArchetypePrototypeProvider for Archetype Inference,
// OverallEstimatorProvider for Overall). This file defines the full
// surface those providers are sliced from; a provider is a documented
// SLICE, never the whole thing (Interface Segregation).
//
// This is a CONTRACT, not an implementation. Phase 5 is where a concrete,
// self-calibrating CalibrationModel gets built against it. Nothing
// implements this yet.

class CalibrationModel {
  /** Version/build identifier (game-year + build hash) -- for drift-checking and reproducibility. */
  get version() { throw new Error('CalibrationModel.version must be implemented by a subclass.'); }

  /** Sorted college reference sample for (position, attribute). */
  getCollegeReference(position, attribute) {
    throw new Error('CalibrationModel.getCollegeReference must be implemented by a subclass.');
  }

  /** Sorted NFL-rookie reference sample for (position, attribute). */
  getRookieReference(position, attribute) {
    throw new Error('CalibrationModel.getRookieReference must be implemented by a subclass.');
  }

  /** { collegeValues: number[], maddenValues: number[] } -- parallel sorted arrays, the measurement-scale map for the absolute anchor. */
  getPhysicalScale(position, attribute) {
    throw new Error('CalibrationModel.getPhysicalScale must be implemented by a subclass.');
  }

  /** Archetype prototype centroids/covariances for a position. Reserved for Phase 6 (ArchetypePrototypeProvider). */
  getArchetypePrototypes(position) {
    throw new Error('CalibrationModel.getArchetypePrototypes must be implemented by a subclass.');
  }

  /** Monotone per-archetype Overall-estimator coefficients. Reserved for Phase 7 (OverallEstimatorProvider). */
  getOverallCoefficients(archetype) {
    throw new Error('CalibrationModel.getOverallCoefficients must be implemented by a subclass.');
  }
}

module.exports = { CalibrationModel };
