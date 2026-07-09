// The Translator contract every rating-conversion engine implements.
//
// Population-level, not per-player: translate(context) takes a whole
// RosettaContext (whose `population` field already holds every departed
// player) and returns the whole translated array in one call. Rosetta's
// translation math is fundamentally population-relative -- percentile
// mapping against a reference distribution, cohort-normalized athleticism/
// production scores, frame statistics computed once per class -- and a
// per-player method signature would have forced a second, hidden pathway
// for that cohort-level context to reach the implementation. Population-in,
// population-out keeps it all flowing through one object.
//
// Coupling rule: an implementation may read context.population / .config /
// .log / .frames, and may return a value the caller assigns to
// context.translated. It must never import a sibling Rosetta subsystem
// (population.js, a future devTraits.js/draftReading.js) directly, and it
// must never require anything from outside lib/rosetta/ (dependencies like
// the legacy calibratePlayers function are injected via constructor, not
// required -- see V1Translator). If an implementation ever needs to know
// about a sibling stage, that need belongs on RosettaContext as a new
// field, not as a new import.

class Translator {
  translate(context) {
    throw new Error('Translator.translate(context) must be implemented by a subclass.');
  }
}

module.exports = { Translator };
