// Rosetta -- the front door for every "replace the legacy engine" subsystem.
//
// Each population-lifecycle stage (see lifecycle.js) is invoked separately
// by pipeline.js at the point in the app's actual lifecycle it belongs to
// -- population at extraction time, translation at calibration time (which
// happens repeatedly, on every Regenerate, against an already-extracted
// pool). There is deliberately no single run-everything entry point: that
// would force population to re-run every time translation does, which is
// both wasteful and wrong. buildSelection() is the population-stage door;
// translation.createTranslator(...).translate(...) is the translation-stage
// door. A future phase adds its own door the same way (e.g.
// Rosetta.readDraftBoard(...)) rather than growing one function's surface.

const { createRosettaContext } = require('./context');
const identity = require('./identity');
const { makeSeededRng } = require('./rng');
const { STAGES, tagStage } = require('./lifecycle');
const attributeTaxonomy = require('./attributeTaxonomy');
const population = require('./population');
const translation = require('./translation');
const calibration = require('./calibration');

// Builds the Season Exit Population Selection (see population.js). Returns
// the tagged Selection array directly -- see lifecycle.js -- not wrapped in
// a result/meta object; the array's own .regime/.diagnostics ARE the
// result.
async function buildSelection(context) {
  return population.buildExitSelection(context);
}

module.exports = {
  buildSelection,
  createRosettaContext,
  identity,
  makeSeededRng,
  STAGES,
  tagStage,
  attributeTaxonomy,
  population,
  translation,
  calibration,
};
