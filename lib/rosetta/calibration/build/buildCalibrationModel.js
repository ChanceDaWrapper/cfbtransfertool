// Calibration Builder orchestrator -- runs all three artifact builders,
// validates each independently, and freezes the result into an
// InMemoryCalibrationModel. This is where real, one-time statistical work
// happens (shrinkage blending, sample collection) -- CalibrationModel
// itself, once returned, does none of it (see inMemoryCalibrationModel.js).
//
// Every dependency is INJECTED (cfbFile, maddenFile, teamNames,
// ratingFields, posGroup), not required directly -- pipeline.js already
// requires lib/rosetta (for Rosetta.buildSelection/makeSeededRng), so a
// direct require of pipeline.js here would close a real circular-require
// cycle (pipeline.js -> rosetta/index.js -> calibration/index.js ->
// this file -> pipeline.js), handing back pipeline.js's INCOMPLETE exports
// at that point in the load order. Same fix already used for V1Translator's
// legacyCalibratePlayers -- applied here, not a new pattern. The caller
// (currently only tools/harness/scorecard.js, outside lib/rosetta/ entirely
// so it can safely require pipeline.js directly) is responsible for opening
// both saves and deriving ratingFields/posGroup before calling this.
//
// Standalone and self-contained beyond that injection: not wired into the
// live app's extraction/generation flow yet -- same posture Phase 4's
// TwoAnchorTranslator took (built and validated standalone before being
// wired live).
//
// ratingFields should be pipeline.js's RATING_NAMES (the canonical "ratings
// we actually translate" list), not the raw CFB-schema-derived field list
// extraction uses elsewhere -- that broader list includes CFB-only fields
// (e.g. ThrowAccuracyRating, explicitly documented elsewhere in this app as
// "not a real Madden rating") that would never have a meaningful Madden-side
// counterpart to pair against.

const { blendTiers } = require('./shrinkage');
const { buildCollegeReferences } = require('./collegeReferenceBuilder');
const { buildRookieReferences } = require('./rookieReferenceBuilder');
const { buildPhysicalScales } = require('./physicalScaleBuilder');
const { validateReferenceArtifact, validatePhysicalScaleArtifact } = require('./validateArtifact');
const { InMemoryCalibrationModel } = require('../inMemoryCalibrationModel');

async function buildCalibrationModel({
  cfbFile, teamNames, maddenFile, exitPopulation, ratingFields, posGroup, version, log = () => {},
}) {
  if (!Array.isArray(exitPopulation) || exitPopulation.length === 0) {
    throw new Error('buildCalibrationModel requires a non-empty exitPopulation (see Rosetta\'s population stage / extractLeavingPlayers).');
  }
  if (!cfbFile || !maddenFile || !teamNames || !ratingFields || !posGroup) {
    throw new Error('buildCalibrationModel requires cfbFile, maddenFile, teamNames, ratingFields, and posGroup to be injected by the caller.');
  }

  log('Building CalibrationModel...');

  const collegeReferences = await buildCollegeReferences({
    cfbFile, teamNames, exitPopulation, ratingFields, posGroup, blendTiers, log,
  });
  const collegeValidation = validateReferenceArtifact('collegeReferences', collegeReferences);
  if (!collegeValidation.valid) {
    throw new Error(`College reference failed validation, refusing to freeze: ${collegeValidation.errors.slice(0, 5).join('; ')}`);
  }

  const rookieReferences = await buildRookieReferences({
    maddenFile, ratingFields, posGroup, blendTiers, log,
  });
  const rookieValidation = validateReferenceArtifact('rookieReferences', rookieReferences);
  if (!rookieValidation.valid) {
    throw new Error(`Rookie reference failed validation, refusing to freeze: ${rookieValidation.errors.slice(0, 5).join('; ')}`);
  }

  const physicalScales = buildPhysicalScales({ collegeReferences, rookieReferences, ratingFields, log });
  const physicalValidation = validatePhysicalScaleArtifact(physicalScales);
  if (!physicalValidation.valid) {
    throw new Error(`Physical scale failed validation, refusing to freeze: ${physicalValidation.errors.slice(0, 5).join('; ')}`);
  }

  const model = new InMemoryCalibrationModel({
    version: version ?? `cfb27-madden26-${new Date().toISOString().slice(0, 10)}`,
    collegeReferences, rookieReferences, physicalScales,
  });

  log(`CalibrationModel frozen -- version=${model.version}.`);

  return {
    model,
    validation: { college: collegeValidation, rookie: rookieValidation, physicalScale: physicalValidation },
  };
}

module.exports = { buildCalibrationModel };
