// Rating -> power-curve category assignment. Every shared CFB/Madden rating
// field maps to one of four categories, and the category decides BOTH which
// power curve applies (PHYSICAL / TECHMOD / TECHHVY / MENTAL) and whether the
// position's tech- or mental-strength knob is used:
//
//   PHYSICAL          -> strength fixed at 1.0 (near-identity)
//   TECHMOD, TECHHVY  -> position's `tech`    strength
//   MENTAL            -> position's `mental`  strength
//
// Every rating that is ever converted has an explicit entry here -- there is
// no "copy raw / leave untouched" category. The original model spec (Sec 5)
// specified a fifth ARMLEG category and a copy-raw exemption for unlisted
// ratings; both were removed per product decision: throw/kick power are an
// athletic measurable like any other physical rating (folded into PHYSICAL),
// and every field the game tracks is a real rating that should compress like
// the rest, not get a free pass (see POWERCURVE_ROADMAP.md).
//
// This is hand-authored structural domain knowledge -- which rating is a
// physical measurement vs a competition-relative skill vs pure processing --
// not something fit from data, exactly like attributeTaxonomy.js. It lives
// beside the translator that consumes it rather than at lib/rosetta/ root
// because (unlike the Two-Anchor taxonomy) nothing in calibration/ needs it;
// only the power-curve translator does.

const CATEGORY_OF = {
  // PHYSICAL -- near-identity (elite athletes stay elite)
  SpeedRating: 'physical',
  AccelerationRating: 'physical',
  AgilityRating: 'physical',
  ChangeOfDirectionRating: 'physical',
  StrengthRating: 'physical',
  JumpingRating: 'physical',
  StaminaRating: 'physical',
  ToughnessRating: 'physical',
  InjuryRating: 'physical',
  // Throw/kick power: an athletic measurable that carries over rather than a
  // competition-relative skill, so it sits with the rest of PHYSICAL.
  ThrowPowerRating: 'physical',
  KickPowerRating: 'physical',

  // TECHMOD -- moderate technical (mild compression)
  CarryingRating: 'techmod',
  CatchingRating: 'techmod',
  CatchInTrafficRating: 'techmod',
  TruckingRating: 'techmod',
  StiffArmRating: 'techmod',
  BreakTackleRating: 'techmod',
  HitPowerRating: 'techmod',
  LongSnapRating: 'techmod',
  KickReturnRating: 'techmod',
  // No dedicated category signal (flavor rating, doesn't drive any real
  // on-field behavior) -- parked in the lightest technical bucket rather than
  // left unconverted.
  PersonalityRating: 'techmod',

  // TECHHVY -- heavy technical (moderate compression). BCVisionRating lives
  // here (not TECHMOD) despite the original spec listing it as light --
  // moved per user correction: a 91+ BC Vision on a rookie reads as
  // unrealistic, and it's a meaningful chunk of Madden's real HB Overall
  // formula (~0.27 weight), so it needs the same heavier compression as
  // Release rather than Catching's light treatment.
  BCVisionRating: 'techhvy',
  SpectacularCatchRating: 'techhvy',
  ShortRouteRunningRating: 'techhvy',
  MediumRouteRunningRating: 'techhvy',
  DeepRouteRunningRating: 'techhvy',
  ReleaseRating: 'techhvy',
  JukeMoveRating: 'techhvy',
  SpinMoveRating: 'techhvy',
  ManCoverageRating: 'techhvy',
  ZoneCoverageRating: 'techhvy',
  PressRating: 'techhvy',
  BlockSheddingRating: 'techhvy',
  PowerMovesRating: 'techhvy',
  FinesseMovesRating: 'techhvy',
  PursuitRating: 'techhvy',
  TackleRating: 'techhvy',
  RunBlockRating: 'techhvy',
  RunBlockPowerRating: 'techhvy',
  RunBlockFinesseRating: 'techhvy',
  PassBlockRating: 'techhvy',
  PassBlockPowerRating: 'techhvy',
  PassBlockFinesseRating: 'techhvy',
  // ImpactBlocking is deliberately the ONE blocking rating in the light
  // bucket; every other Run/Pass/Lead block rating above and below stays
  // heavy. Those are technique -- hand placement, footwork, leverage, picking
  // up a stunt -- which is exactly what a rookie lineman has least of. Impact
  // blocking is the finishing hit once he's already engaged, and it survives
  // the jump to the NFL far better than his technique does.
  //
  // It is not free: this rating feeds the Madden overall formula for FB
  // (0.244), C (0.184), LG (0.149), RG (0.121) and TE (0.050), so lightening
  // it lifts interior linemen and fullbacks specifically. Measured on a
  // 240-player class -- the written rating gains about +7 there, which Madden
  // recomputes as roughly +1.7 overall for a fullback, +1.4 center, +1.1 left
  // guard, +0.9 right guard, +0.3 tight end. Every other position's written
  // rating also moves, but none of their overall formulas read it, so they are
  // unaffected in game.
  //
  // The app's own Est. OVR column will NOT show this: applyOverallAnchor pulls
  // that estimate back toward the player's CFB overall and absorbs it. The
  // exported ratings are what change, and Madden recomputes overall from those
  // on import.
  ImpactBlockingRating: 'techmod',
  LeadBlockRating: 'techhvy',
  ThrowAccuracyShortRating: 'techhvy',
  ThrowAccuracyMidRating: 'techhvy',
  ThrowAccuracyDeepRating: 'techhvy',
  ThrowOnTheRunRating: 'techhvy',
  ThrowUnderPressureRating: 'techhvy',
  PlayActionRating: 'techhvy',
  BreakSackRating: 'techhvy',
  KickAccuracyRating: 'techhvy',

  // MENTAL -- hardest compression (rookies rarely process at NFL speed)
  AwarenessRating: 'mental',
  PlayRecognitionRating: 'mental',
};

// Which of the four categories exist, and which position-strength knob each
// one reads. PHYSICAL reads no position knob (fixed s = 1.0).
const CATEGORY_STRENGTH_KIND = {
  physical: 'fixed',
  techmod: 'tech',
  techhvy: 'tech',
  mental: 'mental',
};

const CATEGORIES = Object.keys(CATEGORY_STRENGTH_KIND);

// Resolve a rating's category for a given position. Precedence, most specific
// first (roadmap Phase 4): a per-position override wins, then a global
// reclassification, then the structural default. `overrides` is
// { [position]: { [rating]: category } }; `ratingCategory` is the flat global
// map { [rating]: category }. Always returns a real, convertible category --
// there is no "leave untouched" outcome. The final `|| 'techmod'` is a
// defensive fallback only; every rating this is ever called with (pipeline.js
// RATING_NAMES) has an explicit CATEGORY_OF entry.
function categoryFor(position, rating, overrides = {}, ratingCategory = {}) {
  const posOv = overrides[position] && overrides[position][rating];
  if (posOv && CATEGORY_STRENGTH_KIND[posOv]) return posOv;
  const globalOv = ratingCategory[rating];
  if (globalOv && CATEGORY_STRENGTH_KIND[globalOv]) return globalOv;
  return CATEGORY_OF[rating] || 'techmod';
}

module.exports = { CATEGORY_OF, CATEGORY_STRENGTH_KIND, CATEGORIES, categoryFor };
