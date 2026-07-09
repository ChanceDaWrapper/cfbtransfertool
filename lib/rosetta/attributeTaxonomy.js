// Per-attribute translation class + default absoluteness weight (alpha),
// per the Two-Anchor math spec. This is TRANSLATION's own domain
// knowledge/config -- which Madden rating IS a physical measurement vs a
// competition-relative skill is a structural, hand-authored fact about
// what the rating MEANS, not something fit from data. It does NOT belong
// on CalibrationModel: alpha is a blending hyperparameter of Translation's
// own algorithm (closer to a ridge regression's lambda than to a fitted
// coefficient), never a population-derived artifact -- contrast with the
// college/rookie reference SAMPLES, which genuinely are derived from real
// data and DO belong there.
//
// alpha in [0,1]: 1 = pure absolute anchor (a physical measurement carries
// over unchanged), 0 = pure relative anchor (cohort percentile, fully
// re-expressed in the NFL frame).
//
// Lives at lib/rosetta/ root (a shared, dependency-free leaf, like rng.js,
// identity/, lifecycle.js) rather than under translation/, because a
// concrete FrameProvider bundles this taxonomy into every AttributeReference
// it returns (see calibration/attributeReference.js) -- if this stayed
// under translation/, that would make calibration/ reach INTO translation/,
// a reverse edge on top of the translation->calibration edge that already
// exists, creating a two-way dependency between the two directories.
// Promoting shared domain knowledge to root, rather than letting one
// sibling depend on another, is the same fix already used for rng.js.

const PHYSICAL = [
  'SpeedRating', 'AccelerationRating', 'AgilityRating', 'ChangeOfDirectionRating',
  'StrengthRating', 'JumpingRating', 'ThrowPowerRating', 'KickPowerRating',
];
const HEALTH = ['InjuryRating', 'StaminaRating', 'ToughnessRating'];
const MENTAL = ['AwarenessRating', 'PlayRecognitionRating', 'ThrowUnderPressureRating'];
// Everything else rated is TECHNICAL by default (route running, coverage,
// blocking, pass-rush moves, catching, tackling, throw accuracy, etc.) --
// listed as a fallback rather than enumerated, since it's the largest and
// least remarkable class.

const DEFAULT_ALPHA = { physical: 0.9, health: 0.95, mental: 0.1, technical: 0.4 };

function attributeClass(attribute) {
  if (PHYSICAL.includes(attribute)) return 'physical';
  if (HEALTH.includes(attribute)) return 'health';
  if (MENTAL.includes(attribute)) return 'mental';
  return 'technical';
}

function defaultAlpha(attribute) {
  return DEFAULT_ALPHA[attributeClass(attribute)];
}

module.exports = { attributeClass, defaultAlpha, DEFAULT_ALPHA, PHYSICAL, HEALTH, MENTAL };
