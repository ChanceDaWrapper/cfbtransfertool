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
  out.QB = 0.5; out.HB = 1; out.WR = -1;
  out.LE = 1; out.RE = 1; out.CB = 1;
  out.FS = -2; out.SS = -2;
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
  devTraits: {
    xfactorMinOverall: 96,   // CFB overall needed to become an X-Factor
    superstarCount: 4,       // total Superstars per class
    starPercentTarget: 35,   // % of the class that ends up Star (includes College_Elite autos)
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
  'devTraits.xfactorMinOverall': 'College overall needed to become an X-Factor. Lower = more X-Factors in the class.',
  'devTraits.superstarCount': 'Exact number of Superstar dev traits handed out per class.',
  'devTraits.starPercentTarget': 'Target share of the class that ends up with the Star trait.',
};

// Every rating a generated player carries (see RATING_NAMES in pipeline.js),
// labeled for the Draft Class page's "Additional Column" picker. Speed,
// Strength, Agility, and Awareness are left out -- they're already fixed
// columns in the results table, so offering them again would just be a
// duplicate.
const ADDITIONAL_COLUMNS = [
  ['AccelerationRating', 'Acceleration'], ['BCVisionRating', 'BC Vision'],
  ['BlockSheddingRating', 'Block Shedding'], ['BreakSackRating', 'Break Sack'],
  ['BreakTackleRating', 'Break Tackle'], ['CarryingRating', 'Carrying'],
  ['CatchingRating', 'Catching'], ['CatchInTrafficRating', 'Catch in Traffic'],
  ['ChangeOfDirectionRating', 'Change of Direction'], ['FinesseMovesRating', 'Finesse Moves'],
  ['HitPowerRating', 'Hit Power'], ['ImpactBlockingRating', 'Impact Blocking'],
  ['InjuryRating', 'Injury'], ['JukeMoveRating', 'Juke Move'], ['JumpingRating', 'Jumping'],
  ['KickAccuracyRating', 'Kick Accuracy'], ['KickPowerRating', 'Kick Power'],
  ['KickReturnRating', 'Kick Return'], ['LeadBlockRating', 'Lead Block'],
  ['LongSnapRating', 'Long Snap'], ['ManCoverageRating', 'Man Coverage'],
  ['PassBlockFinesseRating', 'Pass Block Finesse'], ['PassBlockPowerRating', 'Pass Block Power'],
  ['PassBlockRating', 'Pass Block'], ['PersonalityRating', 'Personality'],
  ['PlayActionRating', 'Play Action'], ['PlayRecognitionRating', 'Play Recognition'],
  ['PowerMovesRating', 'Power Moves'], ['PressRating', 'Press'], ['PursuitRating', 'Pursuit'],
  ['ReleaseRating', 'Release'], ['DeepRouteRunningRating', 'Deep Route Running'],
  ['MediumRouteRunningRating', 'Medium Route Running'], ['ShortRouteRunningRating', 'Short Route Running'],
  ['RunBlockFinesseRating', 'Run Block Finesse'], ['RunBlockPowerRating', 'Run Block Power'],
  ['RunBlockRating', 'Run Block'], ['SpectacularCatchRating', 'Spectacular Catch'],
  ['SpinMoveRating', 'Spin Move'], ['StaminaRating', 'Stamina'], ['StiffArmRating', 'Stiff Arm'],
  ['TackleRating', 'Tackle'], ['ThrowAccuracyDeepRating', 'Throw Accuracy (Deep)'],
  ['ThrowAccuracyMidRating', 'Throw Accuracy (Mid)'], ['ThrowAccuracyRating', 'Throw Accuracy'],
  ['ThrowAccuracyShortRating', 'Throw Accuracy (Short)'], ['ThrowOnTheRunRating', 'Throw on the Run'],
  ['ThrowPowerRating', 'Throw Power'], ['ThrowUnderPressureRating', 'Throw Under Pressure'],
  ['ToughnessRating', 'Toughness'], ['TruckingRating', 'Trucking'], ['ZoneCoverageRating', 'Zone Coverage'],
].map(([key, label]) => ({ key: 'Madden_' + key, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

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
  ADDITIONAL_COLUMNS,
  DEFAULT_CONFIG,
  DESCRIPTIONS,
  mergeConfig,
};
