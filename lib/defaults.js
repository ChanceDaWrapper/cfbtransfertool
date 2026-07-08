// Single source of truth for every tunable parameter in the draft-class
// generation algorithm, plus the metadata the UI needs to render controls
// (labels, descriptions, ranges). The values here are the shipped
// recommended defaults -- the same numbers the original CLI converter used.

const POSITIONS = [
  'QB', 'HB', 'FB', 'WR', 'TE',
  'LT', 'LG', 'C', 'RG', 'RT',
  'LE', 'RE', 'DT', 'LOLB', 'MLB', 'ROLB',
  'CB', 'FS', 'SS', 'K', 'P', 'LS',
];

const POSITION_LABELS = {
  QB: 'Quarterback', HB: 'Halfback', FB: 'Fullback', WR: 'Wide Receiver', TE: 'Tight End',
  LT: 'Left Tackle', LG: 'Left Guard', C: 'Center', RG: 'Right Guard', RT: 'Right Tackle',
  LE: 'Left End', RE: 'Right End', DT: 'Defensive Tackle',
  LOLB: 'Left OLB', MLB: 'Middle LB', ROLB: 'Right OLB',
  CB: 'Cornerback', FS: 'Free Safety', SS: 'Strong Safety',
  K: 'Kicker', P: 'Punter', LS: 'Long Snapper',
};

// The ratings treated as "physical" -- they get a light calibrated flat
// drop instead of quantile mapping, and support per-rating adjustments.
const PHYSICAL_RATINGS = [
  'SpeedRating', 'AccelerationRating', 'AgilityRating', 'ChangeOfDirectionRating',
  'StaminaRating', 'StrengthRating', 'JumpingRating', 'ThrowPowerRating',
  'KickPowerRating', 'InjuryRating', 'ToughnessRating', 'CarryingRating',
];

const RATING_LABELS = {
  SpeedRating: 'Speed', AccelerationRating: 'Acceleration', AgilityRating: 'Agility',
  ChangeOfDirectionRating: 'Change of Direction', StaminaRating: 'Stamina',
  StrengthRating: 'Strength', JumpingRating: 'Jumping', ThrowPowerRating: 'Throw Power',
  KickPowerRating: 'Kick Power', InjuryRating: 'Injury', ToughnessRating: 'Toughness',
  CarryingRating: 'Carrying',
};

// Default per-rating adjustment rows for the Physical Attributes page.
// extraDrop: flat points removed on top of the calibrated drop.
// jitter: overrides the global physical jitter width for this rating (null = use global).
// maxDrop: hard ceiling on the total drop for this rating (null = no cap).
function defaultRatingAdjustments() {
  const out = {};
  for (const r of PHYSICAL_RATINGS) {
    out[r] = { extraDrop: 0, jitter: null, maxDrop: null };
  }
  // The shipped "agility adjustment": a bigger, more variable, but capped cut.
  out.AgilityRating = { extraDrop: 3, jitter: 4, maxDrop: 7 };
  return out;
}

function defaultPositionExtraDrop() {
  const out = {};
  for (const p of POSITIONS) out[p] = 0;
  out.QB = -1; out.HB = 1; out.WR = 0;
  out.LE = 1; out.RE = 1; out.CB = 1;
  // FS/SS used to get -2 (a boost -- less drop than the calibrated
  // baseline) on the assumption their overall looked too low. Verified
  // against real Madden data that assumption was backwards: comparing our
  // generated safeties to Madden's OWN real rookie safeties at the same
  // final Overall, ours were running 5-12 points higher on every rating
  // (Awareness worst, +12) -- the -2 boost was actively causing that.
  // Removed rather than flipped positive since the quantile-calibration
  // reference data (data/quantile_calibration.json) checked out fine on
  // its own; 0 (no override) was the correct neutral baseline.
  return out;
}

// How much draft-order weight (NOT rating weight -- this never touches a
// player's actual ratings) each position carries on its own, independent of
// overall. Mirrors real draft behavior: a 93 OVR QB and a 93 OVR FB are not
// equally valuable prospects. QB/blindside-tackle/edge get a premium; RB/FB
// and specialists get a discount, since real teams are reluctant to
// spend high picks there even on great players.
function defaultPositionValue() {
  const out = {};
  for (const p of POSITIONS) out[p] = 0;
  out.QB = 6;
  out.LT = 3; out.RT = 2;
  out.LE = 3; out.RE = 3; out.DT = 1.5;
  out.CB = 2; out.WR = 1.5; out.TE = 0.5;
  out.LOLB = 1.5; out.ROLB = 1.5; out.MLB = 0.5;
  out.FS = 0.5; out.SS = 0.5;
  out.HB = -1; out.FB = -4;
  out.K = -6; out.P = -6; out.LS = -6;
  return out;
}

const DEFAULT_CONFIG = {
  general: {
    classSize: 500,        // max players pulled into the class
    seed: '',              // reproducibility seed; blank = random every run
    dropLeniency: 0.25,    // scales BOTH the physical flat drop and the bell-curve squeeze (1 = full strength)
    defaultDrop: 10,       // fallback flat drop when a position/rating has no calibration data
    calibrationJitter: 2,  // +/- randomness on physical-rating drops
    quantileJitter: 2,     // +/- randomness on quantile-mapped (skill) ratings
  },
  bell: {
    peakPercentile: 0.75,  // class percentile hit hardest by the extra squeeze
    peakExtraDrop: 13,     // max extra points removed right at the peak (scaled by leniency)
    spreadBelow: 0.15,     // how fast the squeeze fades below the peak
    spreadAbove: 0.12,     // how fast it fades above the peak (small = protects elites)
  },
  positionExtraDrop: defaultPositionExtraDrop(),
  positionCaps: { K: 3, P: 5, LS: 3 },   // max players of a position allowed into the class
  kpAwarenessCap: 70,                     // AwarenessRating ceiling for K/P
  ratingAdjustments: defaultRatingAdjustments(),
  // Draft ORDER only -- none of this touches a player's ratings, just where
  // they land in the class (round/pick), same as a real team's draft board.
  positionValue: defaultPositionValue(),
  draftValue: {
    // Kept intentionally smaller than CFB overall's influence so overall stays
    // the dominant factor and these nudge the order rather than dominate it
    // (CFB overall is compressed at the top of a class, so large bonuses here
    // reorder it wildly). Magnitudes mirror cfb2madden's proven values.
    positionValueWeight: 1,     // multiplier on the Position Value table above (points)
    awardsWeight: 0.5,          // multiplier on career award points; contribution capped (see DRAFT_AWARDS_BONUS_CAP)
    athleticismWeight: 2.5,     // max points from an elite athletic profile (measurables percentile)
    productionWeight: 3,        // max points from elite career production (stats percentile)
    roundWeight: 1,             // how much CFB's own projected round still matters (points per round above 8th)
    boardVariance: 1.5,         // +/- random points so the board isn't a rigid overall sort (0 = deterministic order)
    generationalEnabled: true,  // allow at most one "generational" prospect to lock the top of the board
  },
  devTraits: {
    // All three are a target share of the WHOLE generated class, same idea
    // as starPercentTarget always was. X-Factor is meant to be a needle in
    // a haystack -- 0.08% works out to about 1 in every 1,300 players, so a
    // typical ~200-500 player class usually produces zero and only
    // occasionally produces one, which is the point. Superstar at 2% is
    // roughly 1 in every 50 players (about 4-5 in a 224-player class, the
    // same real-world rate the old fixed count of 4 was targeting).
    xfactorPercentTarget: 0.08,  // ~1 in 1,300
    superstarPercentTarget: 2,   // ~1 in 50
    starPercentTarget: 35,       // % of the class that ends up Star (includes College_Elite autos)
  },
  // Keeps Est. Madden OVR from drifting too far from what a player's own CFB
  // Overall would suggest -- see the Overall Anchor comment in pipeline.js.
  // Value-based (not percentile-within-this-class), so it behaves the same
  // for a 17-player declared class or a 2,000-player synthesized one.
  overallAnchor: {
    enabled: true,
    spreadFactor: 0.5,  // 0 = rigid (anchor only), 1 = today's unbounded regression estimate
    maxSpread: 5,        // hard cap, in points, on top of the blend
  },
};

// Human-readable descriptions surfaced as tooltips / helper text in the UI.
// Written for players who know football but not statistics: short, scannable,
// and framed around the on-field/in-game result rather than the math behind it.
const DESCRIPTIONS = {
  'general.classSize': 'Max players in the class. Fewer eligible prospects in your save just means a smaller class.',
  'general.seed': 'Leave blank for a different class every time. Enter anything here to get the exact same class again later.',
  'general.dropLeniency': 'Overall strength of the class. Lower = players keep more of their college rating (stronger class). Higher = bigger cuts across the board (weaker class).',
  'general.defaultDrop': 'Backup number used only when a rating has no real calibration data. You won\'t normally need this.',
  'general.calibrationJitter': 'Random variation on physical ratings (Speed, Strength, etc.) so players don\'t feel copy-pasted. Higher = more player-to-player variety.',
  'general.quantileJitter': 'Same as Physical Jitter, but for skill ratings (Awareness, coverage, blocking, route running, etc.).',
  'bell.peakPercentile': 'Which tier of prospects gets hit hardest by the extra cut. Higher = the pain shifts toward your better players. Lower = it hits weaker players hardest instead.',
  'bell.peakExtraDrop': 'How big that extra cut is at its worst point.',
  'bell.spreadBelow': 'How far the extra cut spreads into weaker players below that tier. Higher = more of the lower half also takes a hit.',
  'bell.spreadAbove': 'How far the extra cut spreads toward your elite players. Kept low by default so stars stay strong.',
  'positionExtraDrop': 'Toughness dial for this position. Higher = everyone here comes in weaker overall. Lower or negative = they keep more of their college rating.',
  'positionCaps': 'Max players at this position allowed in the class. Leave blank for no limit — handy for trimming excess Kickers/Punters.',
  'kpAwarenessCap': 'Awareness is the biggest driver of K/P overall. Lowering this keeps rookie kickers/punters from rating too high on day one.',
  'ratingAdjustments.extraDrop': 'Extra points shaved off just this one rating, for every player.',
  'ratingAdjustments.jitter': 'How much this specific rating varies player to player. Blank = use the global Physical Jitter.',
  'ratingAdjustments.maxDrop': 'Caps how much this rating can drop, no matter what else applies. Blank = no cap.',
  'devTraits.xfactorPercentTarget': 'Target share of the class that becomes an X-Factor — Madden\'s rarest trait. Default is about 1 in 1,300 players, so most classes have zero. Raise this and X-Factors stop being special.',
  'devTraits.superstarPercentTarget': 'Target share of the class that becomes a Superstar. Default is about 1 in 50 players (roughly 4-5 in a typical class).',
  'devTraits.starPercentTarget': 'Target share of the class that ends up with the Star trait.',
  'positionValue': 'Draft-order-only value for this position, on top of overall -- doesn\'t change ratings, just where they land in the class. Positive = drafted earlier than their overall alone would suggest (QB, blindside tackle, edge rusher). Negative = drafted later (RB, FB, specialists), matching how real teams actually spend picks.',
  'draftValue.positionValueWeight': 'How much the Position Value table above actually matters. 0 turns it off entirely; higher exaggerates it.',
  'draftValue.awardsWeight': 'How much career awards (Heisman, All-American, Player of the Week, etc.) push a player up the draft order.',
  'draftValue.athleticismWeight': 'Max draft-order points from an elite athletic profile (measurables percentile vs same-position peers) -- an "athletic freak" rises even with modest production. Draft order only; never changes ratings.',
  'draftValue.productionWeight': 'Max draft-order points from elite career production (stats percentile vs same-position peers) -- a proven producer rises even with modest measurables. Needs career stats (a save with seasons played); draft order only.',
  'draftValue.roundWeight': 'How much CFB\'s own projected round still factors into where a player lands, alongside overall, awards, athleticism, production, and position value.',
  'draftValue.boardVariance': 'Random points added to each player\'s draft score so the board isn\'t a rigid overall ranking -- similarly-graded prospects shuffle a little each regenerate. 0 = fully deterministic order.',
  'draftValue.generationalEnabled': 'Allow at most one "generational" prospect (97+ overall elite who is also an elite producer or freak athlete) to lock the very top of the board, like a real headline #1 pick.',
  'overallAnchor.spreadFactor': 'How much natural player-to-player variety survives around the Overall Anchor. 0 = every player at a given CFB Overall lands on the same target number (rigid). 1 = today\'s behavior -- ratings alone decide Est. Madden OVR, unbounded.',
  'overallAnchor.maxSpread': 'Hard cap, in points, on how far Est. Madden OVR can drift from the Overall Anchor for a player\'s CFB Overall value -- keeps a mediocre CFB Overall from ever estimating as high as an elite one, even in a small class.',
};

// Every rating a generated player carries (see RATING_NAMES in pipeline.js),
// labeled for the Draft Class table, grouped so related ratings sit next to
// each other instead of alphabetically -- Speed next to Acceleration next
// to Agility, all the throwing ratings together, etc. (ThrowAccuracyRating
// is deliberately excluded: it isn't a real Madden rating, just leftover
// data CFB27 happens to also expose.) Order here is display order only --
// unrelated to which ratings get highlighted (see POSITION_KEY_ATTRIBUTES).
const ALL_RATING_COLUMNS = [
  ['AwarenessRating', 'Awareness'],

  ['SpeedRating', 'Speed'], ['AccelerationRating', 'Acceleration'],
  ['AgilityRating', 'Agility'], ['ChangeOfDirectionRating', 'Change of Direction'],
  ['JumpingRating', 'Jumping'], ['StrengthRating', 'Strength'],
  ['InjuryRating', 'Injury'], ['StaminaRating', 'Stamina'], ['ToughnessRating', 'Toughness'],

  ['ThrowPowerRating', 'Throw Power'], ['ThrowAccuracyShortRating', 'Throw Accuracy (Short)'],
  ['ThrowAccuracyMidRating', 'Throw Accuracy (Mid)'], ['ThrowAccuracyDeepRating', 'Throw Accuracy (Deep)'],
  ['ThrowUnderPressureRating', 'Throw Under Pressure'], ['ThrowOnTheRunRating', 'Throw on the Run'],
  ['PlayActionRating', 'Play Action'], ['BreakSackRating', 'Break Sack'],

  ['CatchingRating', 'Catching'], ['CatchInTrafficRating', 'Catch in Traffic'],
  ['SpectacularCatchRating', 'Spectacular Catch'], ['ReleaseRating', 'Release'],

  ['ShortRouteRunningRating', 'Short Route Running'], ['MediumRouteRunningRating', 'Medium Route Running'],
  ['DeepRouteRunningRating', 'Deep Route Running'],

  ['CarryingRating', 'Carrying'], ['BCVisionRating', 'BC Vision'], ['BreakTackleRating', 'Break Tackle'],
  ['TruckingRating', 'Trucking'], ['StiffArmRating', 'Stiff Arm'], ['SpinMoveRating', 'Spin Move'],
  ['JukeMoveRating', 'Juke Move'],

  ['PassBlockRating', 'Pass Block'], ['PassBlockPowerRating', 'Pass Block Power'],
  ['PassBlockFinesseRating', 'Pass Block Finesse'], ['RunBlockRating', 'Run Block'],
  ['RunBlockPowerRating', 'Run Block Power'], ['RunBlockFinesseRating', 'Run Block Finesse'],
  ['LeadBlockRating', 'Lead Block'], ['ImpactBlockingRating', 'Impact Blocking'],

  ['PowerMovesRating', 'Power Moves'], ['FinesseMovesRating', 'Finesse Moves'], ['BlockSheddingRating', 'Block Shedding'],

  ['ManCoverageRating', 'Man Coverage'], ['ZoneCoverageRating', 'Zone Coverage'],
  ['PressRating', 'Press'], ['PlayRecognitionRating', 'Play Recognition'],

  ['PursuitRating', 'Pursuit'], ['TackleRating', 'Tackle'], ['HitPowerRating', 'Hit Power'],

  ['KickPowerRating', 'Kick Power'], ['KickAccuracyRating', 'Kick Accuracy'], ['LongSnapRating', 'Long Snap'],

  ['KickReturnRating', 'Kick Return'],
].map(([key, label]) => ({ key: 'Madden_' + key, label }));

// Two-color highlight system for the Draft Class table.
//
// Physical: the same handful of measurables for every position (a workout/
// combine-style set), plus Throw Power for QBs specifically since arm
// strength is as much a physical trait as a throwing skill for evaluation
// purposes. Kept separate from POSITION_KEY_ATTRIBUTES below so the two
// highlight colors never fight over the same cell.
const PHYSICAL_HIGHLIGHT_ATTRIBUTES = [
  'SpeedRating', 'AccelerationRating', 'StrengthRating', 'AgilityRating',
  'ChangeOfDirectionRating', 'JumpingRating', 'InjuryRating', 'StaminaRating', 'ToughnessRating',
];
const PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION = {
  QB: ['ThrowPowerRating'],
};
function physicalHighlightAttributesFor(position) {
  return PHYSICAL_HIGHLIGHT_ATTRIBUTES.concat(PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION[position] || []);
}

// The ratings that matter most for each position's evaluation, beyond the
// universal physical set above -- explicit and hand-maintained rather than
// derived, so it's easy to check and adjust. Awareness is included
// everywhere since it's one of the single biggest drivers of Overall for
// nearly every position. Never repeats anything already in the Physical
// list above (a cell only gets one highlight color).
const POSITION_KEY_ATTRIBUTES = {
  QB: ['ThrowAccuracyShortRating', 'ThrowAccuracyMidRating', 'ThrowAccuracyDeepRating',
    'ThrowUnderPressureRating', 'ThrowOnTheRunRating', 'PlayActionRating', 'AwarenessRating'],
  HB: ['CarryingRating', 'BCVisionRating', 'BreakTackleRating', 'TruckingRating',
    'StiffArmRating', 'SpinMoveRating', 'JukeMoveRating', 'CatchingRating', 'AwarenessRating'],
  FB: ['CarryingRating', 'BCVisionRating', 'BreakTackleRating', 'TruckingRating',
    'LeadBlockRating', 'RunBlockRating', 'PassBlockRating', 'CatchingRating', 'AwarenessRating'],
  WR: ['CatchingRating', 'CatchInTrafficRating', 'SpectacularCatchRating', 'ShortRouteRunningRating',
    'MediumRouteRunningRating', 'DeepRouteRunningRating', 'ReleaseRating', 'AwarenessRating'],
  TE: ['CatchingRating', 'CatchInTrafficRating', 'SpectacularCatchRating', 'ShortRouteRunningRating',
    'MediumRouteRunningRating', 'DeepRouteRunningRating', 'RunBlockRating', 'PassBlockRating',
    'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  LT: ['PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating', 'RunBlockRating',
    'RunBlockPowerRating', 'RunBlockFinesseRating', 'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  RT: ['PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating', 'RunBlockRating',
    'RunBlockPowerRating', 'RunBlockFinesseRating', 'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  LG: ['PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating', 'RunBlockRating',
    'RunBlockPowerRating', 'RunBlockFinesseRating', 'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  RG: ['PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating', 'RunBlockRating',
    'RunBlockPowerRating', 'RunBlockFinesseRating', 'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  C: ['PassBlockRating', 'PassBlockPowerRating', 'PassBlockFinesseRating', 'RunBlockRating',
    'RunBlockPowerRating', 'RunBlockFinesseRating', 'LeadBlockRating', 'ImpactBlockingRating', 'AwarenessRating'],
  LE: ['BlockSheddingRating', 'PowerMovesRating', 'FinesseMovesRating', 'PursuitRating',
    'PlayRecognitionRating', 'TackleRating', 'AwarenessRating'],
  RE: ['BlockSheddingRating', 'PowerMovesRating', 'FinesseMovesRating', 'PursuitRating',
    'PlayRecognitionRating', 'TackleRating', 'AwarenessRating'],
  DT: ['BlockSheddingRating', 'PowerMovesRating', 'FinesseMovesRating', 'PursuitRating',
    'PlayRecognitionRating', 'TackleRating', 'AwarenessRating'],
  LOLB: ['BlockSheddingRating', 'PowerMovesRating', 'FinesseMovesRating', 'PursuitRating',
    'PlayRecognitionRating', 'ZoneCoverageRating', 'ManCoverageRating', 'HitPowerRating', 'TackleRating', 'AwarenessRating'],
  ROLB: ['BlockSheddingRating', 'PowerMovesRating', 'FinesseMovesRating', 'PursuitRating',
    'PlayRecognitionRating', 'ZoneCoverageRating', 'ManCoverageRating', 'HitPowerRating', 'TackleRating', 'AwarenessRating'],
  MLB: ['PlayRecognitionRating', 'ZoneCoverageRating', 'ManCoverageRating', 'PursuitRating',
    'BlockSheddingRating', 'HitPowerRating', 'TackleRating', 'AwarenessRating'],
  CB: ['ManCoverageRating', 'ZoneCoverageRating', 'PressRating', 'PlayRecognitionRating',
    'CatchingRating', 'AwarenessRating'],
  FS: ['ZoneCoverageRating', 'ManCoverageRating', 'PlayRecognitionRating', 'PursuitRating',
    'HitPowerRating', 'CatchingRating', 'AwarenessRating'],
  SS: ['ZoneCoverageRating', 'ManCoverageRating', 'PlayRecognitionRating', 'PursuitRating',
    'HitPowerRating', 'BlockSheddingRating', 'TackleRating', 'AwarenessRating'],
  K: ['KickPowerRating', 'KickAccuracyRating', 'AwarenessRating'],
  P: ['KickPowerRating', 'KickAccuracyRating', 'AwarenessRating'],
  LS: ['LongSnapRating', 'AwarenessRating'],
};

// Deep-merge stored/partial config over the defaults so old saved configs
// keep working when new options are added later.
function mergeConfig(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!saved || typeof saved !== 'object') return out;
  for (const section of Object.keys(out)) {
    const sv = saved[section];
    if (sv === undefined || sv === null) continue;
    if (typeof out[section] !== 'object') { out[section] = sv; continue; }
    for (const key of Object.keys(out[section])) {
      if (sv[key] === undefined) continue;
      if (out[section][key] !== null && typeof out[section][key] === 'object' && !Array.isArray(out[section][key])) {
        out[section][key] = { ...out[section][key], ...sv[key] };
      } else {
        out[section][key] = sv[key];
      }
    }
  }
  return out;
}

module.exports = {
  POSITIONS,
  POSITION_LABELS,
  PHYSICAL_RATINGS,
  RATING_LABELS,
  ALL_RATING_COLUMNS,
  PHYSICAL_HIGHLIGHT_ATTRIBUTES,
  PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION,
  POSITION_KEY_ATTRIBUTES,
  physicalHighlightAttributesFor,
  DEFAULT_CONFIG,
  DESCRIPTIONS,
  mergeConfig,
};
