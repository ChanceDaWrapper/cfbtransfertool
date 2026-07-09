// Population lifecycle -- the named, ordered stages a departed-player
// population moves through:
//
//   Selection -> HydratedPopulation -> TranslatedPopulation
//             -> DraftPopulation -> ExportPopulation
//
// Draft and Export don't exist as real stages yet (later phases). Their
// names are reserved here now so the chain never needs redesigning as
// they're added -- only extending.
//
// Every stage is a plain JS array, not a wrapper object or class: existing
// consumers throughout this app (pipeline.js, main.js, renderer.js, CSV/
// JSON export) already treat extracted/calibrated data as a plain list --
// .length, .filter, .map -- and wrapping it would break every one of them
// for no architectural benefit. Instead, each stage TAGS its array with a
// `.stage` name plus whatever metadata that stage produces (declaration
// regime, which translator ran, etc.), continuing the pattern already
// established for `.source`/`.regime`/`.populationMode`.
//
// Shared, dependency-free leaf utility (like rng.js and identity/) -- every
// stage's owning module requires this directly; none of them require each
// other through it. A stage is a pure transform, f(previousStage, context)
// -> nextStage, and must never read a LATER stage or reach into a sibling
// module's internals to build its own -- this file is what lets that hold
// without every stage needing to agree on a shared object to reach into.

const STAGES = ['selection', 'hydrated', 'translated', 'draft', 'export'];

function tagStage(array, stage, meta = {}) {
  if (!STAGES.includes(stage)) {
    throw new Error(`Unknown population stage: "${stage}" (expected one of: ${STAGES.join(', ')})`);
  }
  return Object.assign(array, { stage }, meta);
}

module.exports = { STAGES, tagStage };
