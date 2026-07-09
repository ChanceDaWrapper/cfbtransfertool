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
    // Ad hoc options bag today (e.g. { juniorOvrThreshold }). Will carry the
    // full merged app config once translation/frames/draftReading/devTraits
    // need it -- deliberately not widened until a phase actually reads more
    // of it, per the "don't accumulate unused surface" rule.
    config,
    log,
    teamNames,

    // Populated by later phases -- present now so every future subsystem can
    // read/write them without changing this constructor or any call site.
    population: null,  // Phase 1 output: { selection, regime, diagnostics }
    frames: null,       // Phase 3+: calibration artifacts
    translated: null,   // Phase 4+: translated players
    draftBoard: null,   // Phase 6+
    devTraits: null,    // Phase 7+
  };
}

module.exports = { createRosettaContext };
