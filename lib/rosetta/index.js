// Rosetta -- the front door for every "replace the legacy engine" subsystem.
//
// pipeline.js's job is shrinking to: build a RosettaContext, call run(), read
// the Result. Fields the Result doesn't populate yet (translated, draftBoard,
// devTraits) stay null until their phase lands -- adding a phase means
// filling in one more Result field inside run(), never changing this
// function's signature or pipeline.js's call site.

const { createRosettaContext } = require('./context');
const identity = require('./identity');
const { makeSeededRng } = require('./rng');
const population = require('./population');

async function run(context) {
  const result = {
    population: null,
    translated: null,  // Phase 4+
    draftBoard: null,  // Phase 6+
    devTraits: null,   // Phase 7+
    meta: {},
  };

  const popResult = await population.buildExitSelection(context);
  result.population = popResult.selection;
  result.meta.regime = popResult.regime;
  result.meta.diagnostics = popResult.diagnostics;
  context.population = result.population;

  return result;
}

module.exports = {
  run,
  createRosettaContext,
  identity,
  makeSeededRng,
  population,
};
