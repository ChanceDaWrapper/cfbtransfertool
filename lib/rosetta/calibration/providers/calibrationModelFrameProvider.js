// CalibrationModelFrameProvider -- the real FrameProvider, backed by a
// frozen CalibrationModel. A thin adapter: every call is a direct
// delegation to the model's granular getters, assembled into one
// AttributeReference. No calculation happens here -- same discipline as
// StubFrameProvider, just reading from real calibrated data instead of a
// fixture map.

const { FrameProvider } = require('./frameProvider');
const { CalibrationModel } = require('../calibrationModel');
const { createAttributeReference } = require('../attributeReference');
const { attributeClass, defaultAlpha } = require('../../attributeTaxonomy');

class CalibrationModelFrameProvider extends FrameProvider {
  constructor(calibrationModel) {
    super();
    if (!(calibrationModel instanceof CalibrationModel)) {
      throw new Error('CalibrationModelFrameProvider requires a CalibrationModel.');
    }
    this._model = calibrationModel;
    Object.freeze(this);
  }

  attribute(position, attribute) {
    return createAttributeReference({
      position,
      attribute,
      collegeDistribution: this._model.getCollegeReference(position, attribute),
      rookieDistribution: this._model.getRookieReference(position, attribute),
      physicalScale: this._model.getPhysicalScale(position, attribute),
      taxonomy: { class: attributeClass(attribute), alpha: defaultAlpha(attribute) },
    });
  }
}

module.exports = { CalibrationModelFrameProvider };
