// Calibration front door -- CalibrationModel's contract plus every narrow
// provider view onto it. No concrete CalibrationModel exists yet (Phase 5);
// StubFrameProvider is the only concrete implementation today, and it's
// fixture-driven, not backed by real calibration data.

const { CalibrationModel } = require('./calibrationModel');
const { createAttributeReference } = require('./attributeReference');
const { FrameProvider } = require('./providers/frameProvider');
const { StubFrameProvider } = require('./providers/stubFrameProvider');
const { ArchetypePrototypeProvider } = require('./providers/archetypePrototypeProvider');
const { OverallEstimatorProvider } = require('./providers/overallEstimatorProvider');

module.exports = {
  CalibrationModel,
  createAttributeReference,
  FrameProvider,
  StubFrameProvider,
  ArchetypePrototypeProvider,
  OverallEstimatorProvider,
};
