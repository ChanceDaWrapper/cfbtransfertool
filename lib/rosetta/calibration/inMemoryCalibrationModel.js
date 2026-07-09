// InMemoryCalibrationModel -- the concrete, frozen CalibrationModel built
// by lib/rosetta/calibration/build/buildCalibrationModel.js.
//
// Holds plain nested objects ({ [position]: { [attribute]: artifact } }),
// deep-frozen at construction so the "immutable" invariant is enforced at
// runtime, not just by convention (Object.freeze alone doesn't stop a Map's
// internal state from mutating -- plain objects, frozen recursively, do
// stay genuinely immutable). Every getter is a pure lookup: no percentile
// computation, no interpolation, no clustering -- exactly the passivity
// invariant CalibrationModel's contract requires. Archetype prototypes and
// overall coefficients are reserved (Phase 6/7) -- this constructor accepts
// them but Phase 5 never populates them.

const { CalibrationModel } = require('./calibrationModel');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

class InMemoryCalibrationModel extends CalibrationModel {
  constructor({
    version,
    collegeReferences = {}, rookieReferences = {}, physicalScales = {},
    archetypePrototypes = {}, overallCoefficients = {},
  }) {
    super();
    this._version = version;
    this._collegeReferences = deepFreeze(collegeReferences);
    this._rookieReferences = deepFreeze(rookieReferences);
    this._physicalScales = deepFreeze(physicalScales);
    this._archetypePrototypes = deepFreeze(archetypePrototypes);
    this._overallCoefficients = deepFreeze(overallCoefficients);
    Object.freeze(this);
  }

  get version() { return this._version; }

  getCollegeReference(position, attribute) {
    const sample = this._collegeReferences[position]?.[attribute];
    if (!sample) throw new Error(`CalibrationModel has no college reference for (${position}, ${attribute}).`);
    return sample;
  }

  getRookieReference(position, attribute) {
    const sample = this._rookieReferences[position]?.[attribute];
    if (!sample) throw new Error(`CalibrationModel has no rookie reference for (${position}, ${attribute}).`);
    return sample;
  }

  // Physical scale legitimately doesn't apply to every attribute (mental/
  // technical attributes have no measurement basis) -- returns null rather
  // than throwing, since "not applicable" is a well-formed answer here,
  // unlike a genuine gap in the college/rookie references above.
  getPhysicalScale(position, attribute) {
    return this._physicalScales[position]?.[attribute] ?? null;
  }

  getArchetypePrototypes(position) {
    return this._archetypePrototypes[position] ?? null;
  }

  getOverallCoefficients(archetype) {
    return this._overallCoefficients[archetype] ?? null;
  }
}

module.exports = { InMemoryCalibrationModel };
