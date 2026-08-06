'use strict';

// Pure, stateless math for the "Dice Roll" translation model -- a randomized,
// tabletop-style alternative to Power Curve. Adapted from a community-built
// spreadsheet (provided 2026-07). No I/O, no RNG state kept here: every roll
// is passed in already-drawn, same discipline as powerCurve.js.
//
// Model, in one pass:
//   1. ONE class-strength roll (D12) for the WHOLE generated class sets a
//      debuff shared by every player (a weak class is weak across the board).
//   2. ONE bust/gem roll (D12) PER PLAYER sets an individual modifier. The
//      roll itself isn't flat -- pipeline.js's rollD12RankBiased weights it
//      by the player's own draft rank, so earlier picks are more likely to
//      land on a favorable face and later picks less so (never zero either
//      way -- a late-round gem stays a real, if rarer, outcome). This module
//      only maps the resulting face to its modifier value (BUST_GEM_TABLE
//      below); it doesn't know or care where the roll came from.
//   3. delta = cfbOverall * (classDebuff + playerModifier)   -- "OVR Change"
//   4. Every rating is nudged by `delta`, at a strength that depends on which
//      of three buckets the rating falls into -- see applyDelta below.
//
// Two things intentionally NOT carried over from the source spreadsheet:
//
//   - Its own Dev Trait D10 roll. This app already assigns dev traits from a
//     signal-weighted draw (overall, production, athleticism, round, awards
//     -- see assignDevTraits in pipeline.js) that runs downstream of EVERY
//     translation engine alike. A second, unrelated flat roll here would just
//     get silently overwritten by it, so it was left out rather than built
//     and discarded.
//
//   - A few accidental inconsistencies in the source, where SPD/AGI/COD use a
//     full position-tier check (every OL/DT/edge position) but ACC's copy of
//     the same formula only checks for QB, and a couple of columns reference
//     a neighboring header cell instead of their own (harmless where a
//     position-tier branch catches the player first, but changes the
//     fallback behavior for specialists). This module applies ONE consistent
//     rule to all four speed/agility ratings -- the evident intent -- rather
//     than preserving that copy-paste drift.

// D12 roll -> { tier, debuff }.
//
// RETUNED (2026-08) -- the source spreadsheet's own rates (-0.25 / -0.225 /
// -0.20 / -0.175 / -0.15) shipped verbatim and were far too harsh once scored
// against what Madden ACTUALLY computes from the written ratings. Measured on a
// real 402-man class: median overall 59 and just THREE players at 70+, against
// Power Curve's 67 / 116 on the same save. Every tier was a penalty -- there was
// no roll that left a class intact -- and because `delta` scales with the
// player's own overall (see pipeline.js's calibratePlayersDiceRoll), the
// multiplier landed near x0.78 on everyone. A CFB 91 was needed to reach a
// Madden 70, and a Madden 80 required a CFB 103, i.e. was unreachable: the
// engine had a hard ceiling around 72.
//
// This was already known in one half of the codebase. defaults.js's UFL profile
// carries a comment recording that -0.21 vs the corrected -0.05 put the two
// engines' REAL baselines 16 points apart (53 vs 69) while reading identically
// on screen -- but that correction was applied only to the UFL profile's fixed
// `debuff`, and NFL kept rolling this table. defaults.js also explicitly
// deferred the table itself ("reworking that table is out of scope here").
// This is that rework.
//
// The new values are centered so the EXPECTED debuff under rollD12Biased's own
// 70/30 low-band bias (E = -12.8%) reproduces Power Curve's real median on the
// same save -- the "engines agree at baseline" property defaults.js says was
// always the intent. Measured after this change: median 67 vs Power Curve's 67,
// 115 players at 70+ vs 116. The tier-to-tier step is also halved (0.0125, was
// 0.025), which narrows the class-strength swing from ~10 overall points to ~5
// -- one uncontrollable die roll should colour a class, not decide it. Forcing
// a tier via cfg.diceRoll.classStrength still works and still matters.
//
// Every tier stays negative on purpose: a college rating should not survive the
// jump to the NFL untouched. The best possible combination (veryStrong + gem 12)
// is -0.04, still a cut.
const CLASS_STRENGTH_TABLE = [
  { max: 1, tier: 'veryWeak', debuff: -0.15 },
  { max: 3, tier: 'weak', debuff: -0.1375 },
  { max: 7, tier: 'normal', debuff: -0.125 },
  { max: 10, tier: 'strong', debuff: -0.1125 },
  { max: 12, tier: 'veryStrong', debuff: -0.10 },
];
const CLASS_STRENGTH_DEBUFF = Object.fromEntries(CLASS_STRENGTH_TABLE.map((t) => [t.tier, t.debuff]));
const CLASS_STRENGTH_TIERS = CLASS_STRENGTH_TABLE.map((t) => t.tier);

function classStrengthForRoll(roll) {
  const r = Math.max(1, Math.min(12, Math.round(Number(roll))));
  return CLASS_STRENGTH_TABLE.find((t) => r <= t.max).tier;
}

// D12 roll -> per-player modifier (source sheet's own "Tiers" table). The
// CALLER decides which raw value comes up -- the source biases 70% of rolls
// into 1-5 and 30% into 6-12 (see rollD12Biased in pipeline.js, which is
// where the RNG itself lives); this table only maps a value to its percent.
const BUST_GEM_TABLE = {
  1: -0.10, 2: -0.09, 3: -0.07,
  4: -0.04, 5: -0.03, 6: 0, 7: 0.01, 8: 0.02, 9: 0.03,
  10: 0.04, 11: 0.05, 12: 0.06,
};
function bustGemModifierForRoll(roll) {
  const r = Math.max(1, Math.min(12, Math.round(Number(roll))));
  return BUST_GEM_TABLE[r];
}

// SPD/ACC/AGI/COD use a FLAT, roll-independent cut for these two position
// tiers instead of `delta` -- a heavy lineman doesn't get faster because the
// dice were kind, and a burner WR doesn't get slower because the class rolled
// weak. Specialists (K/P/LS) aren't in either tier and fall through to the
// general treatment in applyDelta.
const TRENCH_TIER = new Set(['QB', 'DT', 'LE', 'RE', 'RT', 'LG', 'C', 'RG', 'LT']);
const SKILL_TIER = new Set(['HB', 'FB', 'WR', 'TE', 'CB', 'SS', 'FS', 'LOLB', 'MLB', 'ROLB']);

// Returns the flat-cut value, or null if `position` isn't in either tier
// (the caller then falls back to the general delta-based rule).
function positionTierCut(position, value) {
  const v = Number(value);
  if (TRENCH_TIER.has(position)) {
    if (v > 89) return v - 5;
    if (v > 79) return v - 8;
    if (v > 69) return v - 9;
    return v;
  }
  if (SKILL_TIER.has(position)) {
    if (v > 89) return v - 2;
    if (v > 79) return v - 3;
    if (v > 69) return v - 4;
    return v;
  }
  return null;
}

// Ratings that always take the "physical" (quarter-strength) treatment
// regardless of position -- the source sheet's physical-category list, minus
// SPD/ACC/AGI/COD (which get the position-tiered flat cut above instead).
//
// ThrowPowerRating added 2026-08 -- it was falling through to the GENERAL rule
// below (full delta, same as a mental/technical rating) purely because it
// wasn't in either special-cased set, not by any deliberate choice. Arm
// strength is a physical trait, and the app already treats it as one
// everywhere else that classifies ratings (PHYSICAL_RATINGS in defaults.js,
// powerCurveCategories.js's ThrowPowerRating: 'physical') -- Dice Roll was the
// one place it wasn't. Concretely, at full delta a 90 arm could come out as low
// as 68.8 on a bad class roll (a normal roll alone took it to 79.4); at
// quarter-strength the same rolls give 84.7 and 87.3 -- present but no longer a
// double-digit swing on a trait a coordinator draft-plans around.
const ALWAYS_PHYSICAL = new Set(['StrengthRating', 'StaminaRating', 'JumpingRating', 'ToughnessRating', 'InjuryRating', 'ThrowPowerRating']);
const TIERED_RATINGS = new Set(['SpeedRating', 'AccelerationRating', 'AgilityRating', 'ChangeOfDirectionRating']);

// Dampens the GENERIC (mental/technical, non-tiered, non-always-physical)
// ratings for a position, on top of whatever tiered/physical treatment
// already applies to specific ratings. Added 2026-08 for QB and HB, added
// after measuring both notably underperforming Power Curve on the SAME
// college pool -- the only fair comparison, since both engines convert
// identical players:
//
//               Power Curve   Dice Roll (undampened)
//   QB median        66              59
//   HB median        68              60
//
// Every other position this was checked against (DT: 68 vs 68) already
// matched without any dampening, so this is scoped to QB/HB specifically, not
// a blanket change.
//
// This is not a new idea -- Power Curve already dampens exactly these two
// positions, for exactly this reason. Its own `positionStrength` table
// (defaults.js's defaultPositionStrength) sets QB tech=0.75 and HB
// tech=0.5/mental=0.6, both below the 1.0 neutral baseline, with a comment
// recording that RBs specifically "were coming in way too low under the
// original spec-tuned defaults." Dice Roll shares no config with Power Curve
// by design (LEAGUE_PROFILES_ROADMAP), so this is Dice Roll's own dial rather
// than a reference to that one -- but it exists to fix the identical problem.
//
// 0.55 for both, empirically matched against the real-Madden-formula median on
// this save's pool (QB 0.55 -> median 66, exact match; HB 0.55 -> median 69,
// within 1 of Power Curve's 68 -- HB's sample is only ~17 players a class, so
// exact-integer matching isn't meaningful past that). A single shared value
// rather than two different magic numbers, since neither position's true
// "correct" dampening is knowable to more precision than this.
const GENERIC_DELTA_SCALE = { QB: 0.55, HB: 0.55 };

// The complete per-rating rule:
//   - SPD/ACC/AGI/COD on a trench or skill player: flat position-tier cut,
//     `delta` never enters into it.
//   - Anything below 50 barely moves: 5% of delta (protects an already-weak
//     rating from a bad roll compounding it further).
//   - Physical ratings (including SPD/ACC/AGI/COD for the specialists who
//     didn't match a tier above): quarter-strength delta, POSITION-NEUTRAL --
//     matches Power Curve's own rule that physical ratings are fixed at
//     strength 1.0 regardless of position, so GENERIC_DELTA_SCALE never
//     applies here.
//   - Everything else (technical/mental): full delta, except for QB/HB above.
function applyDelta(ratingName, cfbValue, position, delta) {
  const v = Number(cfbValue);
  if (TIERED_RATINGS.has(ratingName)) {
    const tiered = positionTierCut(position, v);
    if (tiered !== null) return tiered;
  }
  if (v < 50) return v + delta * 0.05;
  if (ALWAYS_PHYSICAL.has(ratingName) || TIERED_RATINGS.has(ratingName)) return v + delta * 0.25;
  return v + delta * (GENERIC_DELTA_SCALE[position] ?? 1);
}

function clampRound(v, lo = 1, hi = 99) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

module.exports = {
  CLASS_STRENGTH_DEBUFF,
  CLASS_STRENGTH_TIERS,
  BUST_GEM_TABLE,
  TRENCH_TIER,
  SKILL_TIER,
  ALWAYS_PHYSICAL,
  TIERED_RATINGS,
  GENERIC_DELTA_SCALE,
  classStrengthForRoll,
  bustGemModifierForRoll,
  positionTierCut,
  applyDelta,
  clampRound,
};
