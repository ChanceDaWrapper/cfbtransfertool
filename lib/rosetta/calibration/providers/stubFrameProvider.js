// Fixture-driven FrameProvider for testing the Two-Anchor engine without a
// real CalibrationModel (which doesn't exist until Phase 5). This is what
// lets Translation's math be unit-tested against hand-verifiable synthetic
// data -- "does F^C === F^N yield identity?", "does a known shift produce
// a known compression?" -- entirely decoupled from whether real calibration
// data exists yet.
//
// Bundles each fixture entry's college/rookie/physical data together with
// taxonomy (from ../../attributeTaxonomy.js) into an AttributeReference --
// exactly the assembly work a real, CalibrationModel-backed FrameProvider
// will do in Phase 5, just fed from a fixture map instead of a repository.
//
// Frozen at construction, same immutability discipline the real thing
// will need.
const { FrameProvider } = require('./frameProvider');
const { createAttributeReference } = require('../attributeReference');
const { attributeClass, defaultAlpha } = require('../../attributeTaxonomy');

class StubFrameProvider extends FrameProvider {
  // fixtures: { [position]: { [attribute]: { college: number[], rookie: number[], physical?: {collegeValues, maddenValues} } } }
  constructor(fixtures = {}) {
    super();
    this._fixtures = fixtures;
    Object.freeze(this._fixtures);
    Object.freeze(this);
  }

  attribute(position, attribute) {
    const entry = this._fixtures[position] && this._fixtures[position][attribute];
    if (!entry) {
      throw new Error(`StubFrameProvider has no fixture for (${position}, ${attribute}) -- add one to the test's fixture map.`);
    }
    return createAttributeReference({
      position,
      attribute,
      collegeDistribution: entry.college,
      rookieDistribution: entry.rookie,
      physicalScale: entry.physical ?? null,
      taxonomy: { class: attributeClass(attribute), alpha: defaultAlpha(attribute) },
    });
  }

  // Convenience for the identity-map unit test the math spec calls for
  // (F^C === F^N, physical scale === y=x -- translation must be a no-op).
  // Builds a stub where every listed attribute shares the SAME sample.
  static identity(position, attributes, sample) {
    const entry = { college: sample, rookie: sample, physical: { collegeValues: sample, maddenValues: sample } };
    const byAttr = {};
    for (const a of attributes) byAttr[a] = entry;
    return new StubFrameProvider({ [position]: byAttr });
  }
}

module.exports = { StubFrameProvider };
