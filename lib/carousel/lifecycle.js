// Coach-carousel lifecycle -- the named, ordered stages a set of coaches
// moves through:
//
//   Pool -> Selection -> Mapped -> Staged -> Written
//
// Mirrors lib/rosetta/lifecycle.js's own reasoning exactly (see its header):
// every stage is a plain JS array, tagged with `.stage` + whatever metadata
// that stage produced, never a wrapper object or class. A stage is a pure
// transform f(previousStage, context) -> nextStage and must never read a
// LATER stage or reach into a sibling module's internals.
//
// Per COACH_CAROUSEL_ROADMAP.md section 1.4:
//   pool       every non-empty Coach row in the source save, as Person+CoachFacet
//   selection  the coaches the user chose to move (UI-driven, not automatic)
//   mapped     target-game field values: copied, looked up, synthesized
//   staged     + a resolved destination (target Coach row, TeamIndex, job slot)
//   written    what changed, per record -- a dry-run report, then a commit

const STAGES = ['pool', 'selection', 'mapped', 'staged', 'written'];

function tagStage(array, stage, meta = {}) {
  if (!STAGES.includes(stage)) {
    throw new Error(`Unknown carousel stage: "${stage}" (expected one of: ${STAGES.join(', ')})`);
  }
  return Object.assign(array, { stage }, meta);
}

module.exports = { STAGES, tagStage };
