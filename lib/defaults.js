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
// Written for players with no background in how the algorithm works.
const DESCRIPTIONS = {
  'general.classSize': 'The maximum number of players pulled into the generated class, picking the best available prospects first. If fewer players are eligible, you simply get fewer -- this is a ceiling, not a target.',
  'general.seed': 'Leave blank for a different random class every time (recommended). Enter any word or number to make results reproducible -- same seed + same settings + same save = the exact same class every time.',
  'general.dropLeniency': 'Master strength dial for every rating reduction in the app. 1.0 = full-strength reduction. 0.25 (default) means players keep about three-quarters of their original college rating. Raise this if classes feel too strong; lower it if they feel too weak.',
  'general.defaultDrop': 'Fallback only, used when a position/rating has no real calibration data on file. You generally will not need to touch this.',
  'general.calibrationJitter': 'Adds small random variation to physical ratings (Speed, Strength, etc.) so identical college players don\'t come out as identical Madden players. Bigger number = more variety.',
  'general.quantileJitter': 'Same idea as the physical jitter, but for skill ratings (Awareness, route running, coverage, blocking, etc.) instead.',
  'bell.peakPercentile': 'Which percentile of players (0 = worst at the position, 1 = best) gets the biggest extra rating cut. 0.75 = solid-but-not-elite prospects take the hardest hit, while true elites and deep bench players are mostly untouched.',
  'bell.peakExtraDrop': 'How many extra points get subtracted right at the peak percentile chosen above, on top of everything else.',
  'bell.spreadBelow': 'How far the extra squeeze reaches into players ranked below the peak percentile. Bigger = a wider range of players below the peak get some extra cut.',
  'bell.spreadAbove': 'How far the extra squeeze reaches into players ranked above the peak percentile (closer to elite). Kept small by default so top talent stays mostly protected.',
  'positionExtraDrop': 'A "toughness dial" for this position: extra points subtracted from every single rating a player at this position has. Higher = weaker players at this position; lower/negative = they keep more of their college rating.',
  'positionCaps': 'The maximum number of players at this position allowed into the class at all, no matter how many are eligible. Blank/0 = no limit.',
  'kpAwarenessCap': 'Awareness represents football IQ built up over a career -- real rookie kickers/punters have not had time to build that up, so this caps how high their Awareness can be set regardless of CFB rating.',
  'ratingAdjustments.extraDrop': 'Extra points subtracted from just this one rating, for every player, on top of everything else.',
  'ratingAdjustments.jitter': 'Overrides the global jitter (random variance) width for this specific rating. Blank = use the global Physical Jitter value.',
  'ratingAdjustments.maxDrop': 'A hard ceiling on the total cut to this rating, no matter how much everything else adds up to. Blank = no ceiling.',
  'devTraits.xfactorMinOverall': 'The CFB overall a player must reach to automatically get the rare X-Factor trait (Madden\'s highest tier, unlocks unique abilities). Keep this high so only genuine outliers qualify.',
  'devTraits.superstarCount': 'Exactly this many players -- the best remaining by CFB overall -- get the Superstar trait (Madden\'s second-highest tier).',
  'devTraits.starPercentTarget': 'Target share of the WHOLE class that ends up with the Star trait. Players CFB already tagged "College Elite" are included automatically first, then the best remaining "College Star" players are added until this target is hit.',
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
  DEFAULT_CONFIG,
  DESCRIPTIONS,
  mergeConfig,
};
