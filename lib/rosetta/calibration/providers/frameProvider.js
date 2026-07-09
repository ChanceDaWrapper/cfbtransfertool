// FrameProvider -- Translation's narrow, read-only view into
// CalibrationModel. Owned by Translation (this migration's dependency-
// inversion rule: the consumer defines the contract, calibration
// implements it afterward).
//
// Exposes exactly ONE method: attribute(position, attribute), returning a
// single AttributeReference (see ../attributeReference.js) that bundles
// everything the Two-Anchor model needs for that pair -- college/rookie
// reference distributions, physical scale, taxonomy -- rather than several
// independent lookups. This keeps Translation independent of how many
// calibration artifacts eventually exist for a given attribute: adding a
// new kind of per-attribute data later means adding a field to
// AttributeReference, never adding a new FrameProvider method or changing
// every Translation call site that already consumes a reference.
//
// Performs NO calculation, same invariant as CalibrationModel. Percentile
// computation (the tie-corrected mid-distribution CDF), quantile
// interpolation (PCHIP), and anchor blending are Translation's OWN
// algorithms, operating on the AttributeReference this interface returns.
// A convenience `collegePercentile(pos, attr, value)`-style method does
// NOT belong here -- that would smuggle Translation's algorithm into the
// data-access layer, exactly the coupling this interface exists to
// prevent.
//
// Guarantee: attribute() always returns a complete AttributeReference for
// any valid (position, attribute) pair -- gap-filling/pooling is the
// BUILDER's job (see ../calibrationModel.js), never resolved here at
// query time. A concrete implementation backed by a real CalibrationModel
// (Phase 5) can therefore be a thin, computation-free assembly of that
// model's granular getters into one bundle.

class FrameProvider {
  /** @returns {object} an AttributeReference -- see ../attributeReference.js. */
  attribute(position, attribute) {
    throw new Error('FrameProvider.attribute must be implemented by a subclass.');
  }
}

module.exports = { FrameProvider };
