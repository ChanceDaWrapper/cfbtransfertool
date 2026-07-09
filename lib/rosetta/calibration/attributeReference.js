// AttributeReference -- a single, self-contained bundle of everything
// Translation needs to know about one (position, attribute) pair: its
// college/rookie reference distributions, its physical measurement-scale
// map (when applicable), and its taxonomy (class + absoluteness weight).
//
// This is the ENTIRE surface FrameProvider exposes -- one method,
// attribute(position, attribute), returning one of these -- rather than
// several independent artifact lookups. The point: Translation stays
// independent of how many calibration artifacts eventually exist for a
// given attribute. Adding a new kind of per-attribute data later (a
// confidence interval, a sample-size/reliability flag, whatever a future
// phase needs) means adding a field here and to whatever builds the
// bundle -- never adding a new FrameProvider method or changing every
// place Translation already consumes a reference.
//
// Plain, frozen data, no behavior -- consistent with this codebase's
// convention for value objects (population rows, RosettaContext) over
// classes with methods.

function createAttributeReference({
  position, attribute,
  collegeDistribution, rookieDistribution,
  // null when the concept doesn't apply -- mental/technical attributes
  // have no measurement basis, so forcing a physical scale onto them would
  // be inventing data rather than reporting "not applicable."
  physicalScale = null,
  taxonomy,
}) {
  return Object.freeze({
    position,
    attribute,
    collegeDistribution,
    rookieDistribution,
    physicalScale: physicalScale ? Object.freeze({ ...physicalScale }) : null,
    taxonomy: Object.freeze({ ...taxonomy }),
  });
}

module.exports = { createAttributeReference };
