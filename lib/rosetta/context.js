// RosettaContext -- services and environment ONLY. It does not carry
// population data of any kind.
//
// Phase 1/2 originally let a context hold the in-flight population
// (context.population, .translated, .draftBoard, .devTraits) alongside its
// services. That was reconsidered in Phase 3: population data is
// TRANSFORMING state that moves through an explicit pipeline (see
// lifecycle.js's Selection -> Hydrated -> Translated -> Draft -> Export
// chain) and belongs in function arguments/return values, not sitting on a
// shared object multiple stages could reach into. Context is now only the
// stable, read-only environment every stage needs alongside its actual
// input: config, logging, lookups, and (once Phase 5 builds it) the
// calibration model. This is what makes "communication flows through
// RosettaContext, not direct subsystem dependencies" and "avoid sideways
// dependencies between siblings" simultaneously true -- services flow
// through context, data flows as an explicit chain.

function createRosettaContext({
  cfbFile, cfbSavePath, config = {}, log = () => {}, teamNames = {}, calibrationModel = null,
} = {}) {
  return {
    cfbFile,
    cfbSavePath,
    // Shape depends on which stage built this context: an ad hoc options bag
    // (e.g. { juniorOvrThreshold }) for a population-stage context built at
    // extraction time; the full merged app config for a translation-stage
    // context built at calibration time (see pipeline.js's calibratePlayers).
    // Population and translation run at genuinely different points in the
    // app's lifecycle (extract once, calibrate/regenerate many times against
    // the cached result), so they're built as separate RosettaContext
    // instances rather than one shared one threaded across both.
    config,
    log,
    teamNames,

    // Phase 5+: the CalibrationModel -- college/rookie reference
    // distributions, physical scale maps, archetype prototypes, overall-
    // estimator coefficients. Deliberately PASSIVE: a read-only data
    // provider, never a service. It answers "what is the calibrated
    // artifact for (position, attribute)?" and performs no calculation
    // itself -- percentile mapping, PCHIP interpolation, Mahalanobis
    // clustering, and every other algorithm live in the consumer that
    // needs them (Translation, Archetype Inference, Overall), each through
    // its own narrow interface (FrameProvider, ArchetypePrototypeProvider,
    // OverallEstimatorProvider) viewing a slice of this same model. Treat
    // it like a read-only database, not a service.
    calibrationModel,
  };
}

module.exports = { createRosettaContext };
