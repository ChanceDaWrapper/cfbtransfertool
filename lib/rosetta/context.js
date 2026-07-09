// RosettaContext -- the single object threaded through every Rosetta
// subsystem instead of an ever-growing parameter list.
//
// Fields not yet used by an implemented phase are present but null, so later
// phases (frames, translation, draft reading, dev traits) only ever ADD to
// this shape -- existing call sites never need to change signature when a
// new field starts getting populated. This is what lets pipeline.js call
// Rosetta.run(context) once and, phase by phase, read more off the Result
// without pipeline.js itself changing again.

function createRosettaContext({ cfbFile, cfbSavePath, config = {}, log = () => {}, teamNames = {} }) {
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

    // `population`: the current stage's player pool. Right after Rosetta's
    // population stage runs (Phase 1), this is the unhydrated selection
    // ({prec, leaveType, projectRound, regime} entries) -- pipeline.js
    // hydrates it into full rows (bio fields, ratings, career stats)
    // afterward, and THAT hydrated array is what a translation-stage context
    // sets as its own `population`. Same field name, stage-appropriate
    // shape -- documented here rather than split into two field names,
    // since only one is ever live in a given context at a time.
    population: null,
    frames: null,       // Phase 3+: calibration artifacts, read by translation
    translated: null,   // Phase 2+: set by a Translator's translate(context)
    draftBoard: null,   // Phase 6+
    devTraits: null,    // Phase 7+
  };
}

module.exports = { createRosettaContext };
