// ArchetypePrototypeProvider -- Archetype Inference's narrow view into
// CalibrationModel. RESERVED: Phase 6 defines and consumes this; nothing
// implements or requires it yet. Defined now (rather than invented when
// Phase 6 starts) so CalibrationModel's contract can be verified complete
// today, and so Translation is never tempted to reach past FrameProvider
// for archetype data -- if it ever needs to, that's a sign the boundary is
// wrong, not a reason to add a method here for Translation's convenience.

class ArchetypePrototypeProvider {
  /** { [archetypeName]: { centroid: number[], covariance: number[][] } } over a position's key-attribute percentile subspace. */
  prototypesFor(position) {
    throw new Error('ArchetypePrototypeProvider.prototypesFor is reserved for Phase 6 -- not implemented yet.');
  }
}

module.exports = { ArchetypePrototypeProvider };
