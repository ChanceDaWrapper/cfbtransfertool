'use strict';

// Pure, stateless math for the "Dice Roll" model -- now a LAYER over Power
// Curve rather than an engine of its own.
//
// WHAT CHANGED, AND WHY (2026-08-11g). Dice Roll used to be a complete second
// conversion: its own class-strength debuff, its own per-position dampening,
// its own flat trims, its own speed rules. That had two problems that a full
// day of tuning made undeniable.
//
//   1. EVERY calibration fix had to be made twice, in two unrelated dials, and
//      verified separately. Halfbacks, receivers, tight ends and the class-wide
//      level each needed a Power Curve change AND a Dice Roll change on the
//      same day. The two still drifted -- at one point the same nominal tight
//      end setting produced 69 on one engine and 75 on the other.
//   2. It DOUBLE-COUNTED the college-to-NFL translation. Every class-strength
//      tier was negative and the best possible outcome (strongest class + a gem
//      roll) was still -0.11. A "gem" never actually boosted anyone; it only
//      cut them less. That is not a dice roll, it is a second haircut.
//
// The model now: Power Curve produces the base -- a faithful, position-aware
// read of how the player actually plays -- and this layer SLIDES it, up or
// down, to produce steals and busts. A class no longer arrives pre-punished.
//
// DESIGN RULES, each one a deliberate decision:
//
//   * DIRECTION IS RANDOM. The slide is symmetric and zero-centred, so the
//     class average matches Power Curve. An earlier proposal pulled top-ranked
//     players down and lower-ranked players up (regression toward the mean by
//     rank), and that was rejected for a concrete reason: it applies
//     SYSTEMATICALLY, so the last pick of round 1 is pushed down while the
//     first pick of round 2 is pushed up, every single time. That manufactures
//     a crossover at every tier boundary -- an artifact, not realism. A random
//     sign cannot produce a systematic boundary effect.
//   * SMALL EVERYWHERE, RARE EXTREMES. Rolled on 2d6 rather than a flat d12
//     precisely so the tails are uncommon: a maximum swing comes up on 2 of 36
//     rolls (~6%), while half of all players land within a point of where Power
//     Curve put them.
//   * AMPLITUDE DECAYS WITH DEPTH, BUT NEVER TO ZERO. Top of the board moves
//     most; the deep class settles. The floor is deliberately high, not
//     token -- a late-round steal has to stay a real outcome, which is the same
//     principle the old rank-bias comment stated even while implementing the
//     opposite behaviour.
//   * PHYSICAL BARELY MOVES. A bust does not get slower; he fails to develop
//     technique and awareness. Speed/agility/strength are near-immune to the
//     slide, which also protects the athleticism calibration Power Curve owns.
//   * TAPERED AT BOTH ENDS. Boosts shrink approaching 99, drops shrink
//     approaching the floor. This replaces the old engine's hard cliff at
//     exactly 50 (below it a rating took 5% of the delta, at it 100% -- so a 49
//     and a 51 were treated completely differently for no reason but the
//     threshold) and removes the need to rely on clamping, which used to pile
//     ratings up against the ceiling.

// 2d6 -> slide, in RATING POINTS, before category weighting and depth decay.
//
// Symmetric about 7 and centred on zero, so across a class the slide adds
// nothing on average -- the whole point of layering rather than replacing.
// Deliberately expressed in rating points, not as a percentage of the player's
// overall: a percentage moves a 90 further than a 60 for no reason anyone can
// see on screen, and it was what made the old engine's magnitudes so hard to
// reason about.
//
// The values look small because they are amplified by Madden's own overall
// formula: it weights ~2.3 rating points of input per point of overall for a
// skill position, so a 3-point rating slide lands as roughly a 5-point overall
// swing. That is calibrated in research/probe52-diceSlide.js, not guessed.
const SLIDE_TABLE = {
  2: -3.75, 3: -2.75, 4: -2, 5: -1.25, 6: -0.5, 7: 0,
  8: 0.5, 9: 1.25, 10: 2, 11: 2.75, 12: 3.75,
};

// Two independent d6, not one d12: the bell shape is the point. A flat d12
// would make the maximum swing as likely as no swing at all (1 in 12 each),
// which reads as chaos rather than luck.
function roll2d6(rng) {
  return (1 + Math.floor(rng() * 6)) + (1 + Math.floor(rng() * 6));
}

function slideForRoll(roll) {
  const r = Math.max(2, Math.min(12, Math.round(Number(roll))));
  return SLIDE_TABLE[r];
}

// How much of the slide each rating category actually receives.
//
// Uses Power Curve's OWN four categories (powerCurveCategories.js), which is
// half the reason this layer is worth having: one categorization now drives
// both the conversion and the luck, instead of Dice Roll maintaining a
// parallel set of rating groups that had to be kept in sync by hand.
const CATEGORY_SLIDE_WEIGHT = {
  physical: 0.2,  // athleticism is close to fixed -- see the design rules above
  techmod: 1.0,
  techhvy: 1.0,
  mental: 1.15,   // the trait that most separates a bust from a hit
};

// Amplitude by draft-board depth. 1.0 for the top pick, DEPTH_FLOOR for the
// last player in the class, linear between.
//
// The floor is high on purpose. Decaying to zero would make a late-round steal
// impossible, and that is one of the outcomes this whole layer exists to
// create; decaying steeply would make the top of the board the only place
// anything happens. "Small everywhere, slightly smaller deep" is the intent.
const DEPTH_FLOOR = 0.75;

function depthScale(rankFrac) {
  const f = Number.isFinite(rankFrac) ? Math.max(0, Math.min(1, rankFrac)) : 0;
  return 1 - (1 - DEPTH_FLOOR) * f;
}

// Taper bands. A slide is at full strength through the middle of the rating
// range and fades over the last TAPER_BAND points at whichever end it is
// heading toward, so nothing is ever pushed hard against 99 or through the
// floor. TAPER_FLOOR is where downward slides have faded to nothing -- well
// below anything a real prospect carries in a rating that matters, so in
// practice this only protects the junk ratings every player has (a tackle's
// throw accuracy) from drifting into nonsense.
const TAPER_BAND = 15;
const TAPER_FLOOR = 30;

function taperFactor(value, direction) {
  const v = Number(value);
  if (direction > 0) return Math.max(0, Math.min(1, (99 - v) / TAPER_BAND));
  if (direction < 0) return Math.max(0, Math.min(1, (v - TAPER_FLOOR) / TAPER_BAND));
  return 0;
}

// The complete per-rating rule. `slide` is the player's own rolled swing
// (already depth-scaled and spread-scaled by the caller); `category` is the
// Power Curve category this rating converts through.
//
// Returns the ORIGINAL value untouched when the slide rounds to nothing, which
// matters: most players should come out of this layer exactly as Power Curve
// left them.
function applySlide(value, slide, category) {
  const v = Number(value);
  if (!Number.isFinite(v) || !Number.isFinite(slide) || slide === 0) return v;
  const weighted = slide * (CATEGORY_SLIDE_WEIGHT[category] ?? 1);
  const tapered = weighted * taperFactor(v, weighted);
  return clampRound(v + tapered);
}

function clampRound(v, lo = 1, hi = 99) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

module.exports = {
  SLIDE_TABLE,
  CATEGORY_SLIDE_WEIGHT,
  DEPTH_FLOOR,
  TAPER_BAND,
  TAPER_FLOOR,
  roll2d6,
  slideForRoll,
  depthScale,
  taperFactor,
  applySlide,
  clampRound,
};
