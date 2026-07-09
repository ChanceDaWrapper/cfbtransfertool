// Calibration front door -- CalibrationModel's contract, every narrow
// provider view onto it, and the builder that produces a real, frozen
// model (Phase 5). InMemoryCalibrationModel + CalibrationModelFrameProvider
// are the first concrete, non-fixture implementations of CalibrationModel/
// FrameProvider -- StubFrameProvider remains for standalone testing.

const { CalibrationModel } = require('./calibrationModel');
const { InMemoryCalibrationModel } = require('./inMemoryCalibrationModel');
const { createAttributeReference } = require('./attributeReference');
const { FrameProvider } = require('./providers/frameProvider');
const { StubFrameProvider } = require('./providers/stubFrameProvider');
const { CalibrationModelFrameProvider } = require('./providers/calibrationModelFrameProvider');
const { ArchetypePrototypeProvider } = require('./providers/archetypePrototypeProvider');
const { OverallEstimatorProvider } = require('./providers/overallEstimatorProvider');
const { buildCalibrationModel } = require('./build/buildCalibrationModel');

module.exports = {
  CalibrationModel,
  InMemoryCalibrationModel,
  createAttributeReference,
  FrameProvider,
  StubFrameProvider,
  CalibrationModelFrameProvider,
  ArchetypePrototypeProvider,
  OverallEstimatorProvider,
  buildCalibrationModel,
};
