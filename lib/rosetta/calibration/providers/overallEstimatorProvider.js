// OverallEstimatorProvider -- Overall's narrow view into CalibrationModel.
// RESERVED: Phase 7 defines and consumes this; nothing implements or
// requires it yet. Defined now for the same reason as
// ArchetypePrototypeProvider -- completes CalibrationModel's contract
// today, and keeps Translation from ever depending on Overall's estimator
// coefficients (Overall must never be an input to anything upstream).

class OverallEstimatorProvider {
  /** Monotone per-archetype coefficients for the display-only Overall read-out. */
  coefficientsFor(archetype) {
    throw new Error('OverallEstimatorProvider.coefficientsFor is reserved for Phase 7 -- not implemented yet.');
  }
}

module.exports = { OverallEstimatorProvider };
