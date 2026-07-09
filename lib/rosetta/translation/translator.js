// The Translator contract every rating-conversion engine implements.
//
// Population-level, not per-player: translate(hydratedPopulation, context)
// takes the whole HydratedPopulation (see ../lifecycle.js) and returns the
// whole TranslatedPopulation in one call. Rosetta's translation math is
// fundamentally population-relative -- percentile mapping against a
// reference distribution, cohort-normalized athleticism/production scores,
// frame statistics computed once per class -- and a per-player method
// signature would have forced a second, hidden pathway for that
// cohort-level context to reach the implementation. Population-in,
// population-out keeps it all flowing through one explicit argument.
//
// The population is an explicit argument, not read off context, because
// RosettaContext is services/environment only (see ../context.js) --
// population data is transforming state that flows through the pipeline
// as arguments and return values, never sits on a shared object.
//
// Coupling rule: an implementation may read context.config / .log /
// .calibrationModel, and must tag its return value via ../lifecycle's
// tagStage(result, 'translated', {...}) before returning it. It must never
// import a sibling Rosetta subsystem (population.js, a future
// devTraits.js/draftReading.js) directly, and it must never require
// anything from outside lib/rosetta/ (dependencies like the legacy
// calibratePlayers function are injected via constructor, not required --
// see V1Translator). If an implementation ever needs to know about a
// sibling stage, that need belongs on RosettaContext as a new field, not
// as a new import.

class Translator {
  translate(hydratedPopulation, context) {
    throw new Error('Translator.translate(hydratedPopulation, context) must be implemented by a subclass.');
  }
}

module.exports = { Translator };
