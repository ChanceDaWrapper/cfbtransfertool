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

// Per-position curve-strength dials for the Power-Curve engine (model spec
// Sec 6, retuned against real in-game Madden overalls -- see
// POWERCURVE_ROADMAP.md's "Decisions" section). `tech` scales compression on
// technical ratings (route running, coverage, blocking, pass rush, catching,
// throw accuracy, elusiveness); `mental` scales it on Awareness / Play
// Recognition. Physical ratings (including Throw/Kick Power) are fixed at
// strength 1.0 by the model, but we expose a per-position `physical` dial too
// (default 1.0) so a user who wants to, say, keep a position's athleticism a
// hair higher can.
// Lower strength = LESS compression (higher rating); higher = MORE.
//
// The original model spec's design invariant was tech < mental for every
// position (technical always drops less than mental). These shipped values
// deliberately break that for a few positions (WR: tech == mental; TE, LS:
// tech > mental) -- they're carried over verbatim from live tuning against
// real generated-then-recomputed Madden overalls (RBs were coming in way too
// low under the original spec-tuned defaults; WR needed harder overall
// compression than the spec's tech/mental split allowed while still keeping
// its skill-vs-mental shape close). Not a bug -- just no longer spec-pure.
function defaultPositionStrength() {
  const out = {};
  for (const p of POSITIONS) out[p] = { physical: 1.0, tech: 1.0, mental: 1.0 };
  const set = (pos, tech, mental) => { out[pos].tech = tech; out[pos].mental = mental; };
  set('QB', 0.75, 1);
  set('HB', 0.5, 0.6);
  set('WR', 1.0, 1.0);
  set('TE', 0.9, 0.75);
  for (const p of ['LT', 'LG', 'C', 'RG', 'RT']) set(p, 1.0, 1.0);
  set('LE', 0.9, 0.9); set('RE', 0.9, 0.9); set('DT', 0.9, 1.0);
  set('LOLB', 0.8, 1.0); set('MLB', 0.8, 1.0); set('ROLB', 0.8, 1.0);
  set('CB', 0.95, 1.0);
  set('FS', 0.85, 1.0); set('SS', 0.85, 1.0);
  set('K', 1.0, 1.25); set('P', 1.0, 1.25);
  set('LS', 1.2, 1.25);
  // FB: no tuned value -> neutral 1.0/1.0 (default above).
  return out;
}

// Power-curve category anchor points. Each category's curve y = a*x^p is
// fully determined by two (x -> y) anchors; the engine derives (a, p) from
// these at load time, so moving an anchor re-tunes the whole curve. These are
// the shipped values -- four categories (the original model spec's fifth,
// ARMLEG, was folded into PHYSICAL; see powerCurveCategories.js).
function defaultPowerCurveAnchors() {
  return {
    physical: { x1: 99, y1: 99, x2: 80, y2: 79 }, // near-identity
    techmod: { x1: 99, y1: 90, x2: 80, y2: 73 },  // mild compression
    techhvy: { x1: 99, y1: 87, x2: 80, y2: 68 },  // moderate compression
    mental: { x1: 97, y1: 77, x2: 86, y2: 62 },   // hardest compression
  };
}

// UI-facing metadata for the four categories (label + which ratings fall in
// each by default). Drives the Power-Curve settings page.
const POWER_CURVE_CATEGORY_META = {
  physical: { label: 'Physical', blurb: 'Speed, Acceleration, Agility, Strength, Jumping, Throw/Kick Power — barely changes (elite athletes stay elite).' },
  techmod: { label: 'Technical (Light)', blurb: 'Catching, Carrying, Trucking — mild compression.' },
  techhvy: { label: 'Technical (Heavy)', blurb: 'Route running, Release, BC Vision, coverage, blocking, pass rush, throw accuracy — moderate compression.' },
  mental: { label: 'Mental', blurb: 'Awareness, Play Recognition — compresses the most (rookies rarely process at NFL speed).' },
};

const DEFAULT_CONFIG = {
  // Rosetta migration feature flag (see MERGE_PLAN.md / the Rosetta roadmap;
  // FACES_AND_DRAFT_ROADMAP.md Phase 2). 'exit' (default): the Season Exit
  // Population constructor (lib/rosetta/population.js) -- sources ALL
  // graduating seniors + real EarlyNFL declarers (~2,500+ player pool vs.
  // legacy's ~224), fixes the Transfer_*-inclusion bug and the dead 'Invalid'
  // filter. 'legacy': today's original extraction logic, kept selectable as
  // a fallback. Not yet exposed in the UI; settable via an imported preset.
  population: {
    mode: 'exit', // 'legacy' | 'exit'
  },
  // Which rating-conversion engine runs. 'powercurve' (default) is the
  // Power-Curve model (model spec): closed-form per-category curves x
  // per-position strength dials, fully user-tunable, no Madden-OVR estimation
  // (Madden recomputes OVR in-game). 'v1' is the legacy quantile/flat-drop +
  // overall-anchor engine, kept for side-by-side comparison. 'rosetta' is the
  // Two-Anchor percentile engine (delegates to v1 in the live seam for now).
  translation: {
    strategy: 'powercurve', // 'powercurve' | 'v1' | 'rosetta'
  },
  // Power-Curve engine knobs (model spec). Category anchors drive the five
  // curves (a, p derived from two points each); positionStrength holds the
  // per-position tech/mental/physical compression dials. categoryOverrides
  // lets a rating be re-classed for one position (spec Sec 10). No jitter by
  // default -- the model is deterministic, so a player's identity is exact and
  // regenerating never reshuffles their ratings; raise it for scatter.
  powerCurve: {
    anchors: defaultPowerCurveAnchors(),
    // Level-1 global dial (roadmap Phase 1): multiplies every position's
    // effective tech/mental strength at once -- one knob for "make the whole
    // class stronger/weaker" on top of the per-position dials in
    // positionStrength. Shown/stored as 1.0 = the dial's own neutral position
    // (leaves per-position values unchanged AS FAR AS THE DIAL ITSELF GOES).
    // A separate fixed baseline (GLOBAL_STRENGTH_BASELINE in pipeline.js,
    // currently 1.05x) is stacked on top of whatever this dial is set to at
    // calculation time -- invisible here, so a fresh install's dial reads a
    // clean "1" while the class still comes in a touch harsher by default.
    // Deliberately does NOT touch physical/arm-leg strength (fixed at 1.0) or
    // the per-position `physical` dial -- keeping athleticism as the one
    // lever this global dial never reaches, per the "compress technical/
    // mental only" decision in POWERCURVE_ROADMAP.md.
    globalStrength: 1.0,
    clampFloor: 1,
    clampCeiling: 99,
    jitter: 0,            // +/- random scatter on converted ratings (0 = deterministic)
    // Level-4 global reclassification (roadmap Phase 4a): move a rating into a
    // different compression bucket for EVERY position. Empty = use the built-in
    // structural defaults. This is the "this specific rating translates wrong
    // everywhere" fix (e.g. BC Vision). Every rating always converts through
    // one of the four real buckets -- there is no "leave it untouched" choice.
    ratingCategory: {},    // { [Rating]: 'physical'|'techmod'|'techhvy'|'mental' }
    categoryOverrides: {}, // per-position exceptions (Phase 4c): { [position]: { [Rating]: category } }
    // Level-4b per-rating numeric tweaks: a flat point subtraction and/or a
    // hard cap on total drop, for ONE rating, on top of everything else
    // (category curve, position strength, position Extra Drop). A fresh,
    // all-zero/all-null structure -- deliberately NOT the old physical-only
    // `ratingAdjustments` (which ships a live AgilityRating cut for V1 and
    // would have silently activated under Power Curve).
    // { [Rating]: { extraDrop, maxDrop } }
    ratingTweaks: {},
  },
  positionStrength: defaultPositionStrength(),
  general: {
    classSize: 402,         // players pulled into the class -- 402 matches a real Madden draft-class file exactly (see lib/draftClassExporter.js)
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
    awardsWeight: 1,            // multiplier on career award points; contribution capped (see DRAFT_AWARDS_BONUS_CAP)
    athleticismWeight: 2.5,     // max points from an elite athletic profile (measurables percentile)
    productionWeight: 3,        // max points from elite career production (stats percentile)
    roundWeight: 2,             // how much CFB's own projected round still matters (points per round above 8th)
    boardVariance: 1.5,         // +/- random points so the board isn't a rigid overall sort (0 = deterministic order)
    generationalEnabled: true,  // allow at most one "generational" prospect to lock the top of the board
  },
  devTraits: {
    // All three are a target share of the WHOLE generated class, same idea
    // as starPercentTarget always was. X-Factor is meant to be a needle in
    // a haystack -- 0.08% works out to about 1 in every 1,300 players, so a
    // typical ~200-500 player class usually produces zero and only
    // occasionally produces one, which is the point. Superstar at 1% is
    // roughly 1 in every 100 players (about 2 in a 224-player class).
    xfactorPercentTarget: 0.08,  // ~1 in 1,300
    superstarPercentTarget: 1,   // ~1 in 100
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
  // How the SELECTED class is ordered into rounds/picks. Never changes which
  // players make the class -- only where they land. See lib/draftBoard.js.
  draftBoard: {
    // 'cfbProjected' = today's board (CFB's own projected round carries a lot
    // of weight). 'realisticDraftDay' = re-rank on talent alone, then let
    // players slide, producing late-round steals.
    organization: 'cfbProjected',
    // Slide intensity for 'realisticDraftDay' only. 0 = pure talent order.
    chaos: 50,
  },
  // Targeted post-translation realism corrections. Each can be switched off if
  // the same thing is already being handled by an external tool.
  realism: {
    // Pull down over-high Agility / Change-of-Direction for BIG WR & CB only
    // (a 6'4"/230 receiver shouldn't test 99). See applyAgilitySizePenalty in
    // pipeline.js. ON by default; turn OFF if you've run the external
    // AGI/COD tool, so the correction isn't applied twice.
    agilityCodSizePenalty: true,
  },
};

// Human-readable descriptions surfaced as tooltips / helper text in the UI.
// Written for players who know football but not statistics: short, scannable,
// and framed around the on-field/in-game result rather than the math behind it.
const DESCRIPTIONS = {
  'population.mode': 'How the tool decides which college players are leaving. The default pulls everyone graduating or declaring for the draft. (Not shown in the app -- kept for advanced preset use.)',
  'translation.strategy': 'The method that turns college ratings into Madden ratings. Power Curve is the built-in engine every other setting is tuned around -- there\'s nothing to change here.',
  'positionStrength.tech': 'How hard this position\'s TECHNICAL ratings (route running, coverage, blocking, pass rush, catching, throw accuracy) drop from college to rookie. Lower = keeps more of their college skill (stronger). Higher = bigger cut. 1.0 = the standard amount of drop.',
  'positionStrength.mental': 'How hard this position\'s MENTAL ratings (Awareness, Play Recognition) drop. This is always the biggest rookie drop. Lower = smarter rookies; higher = greener. Keep this above the Technical dial.',
  'positionStrength.physical': 'How hard this position\'s PHYSICAL ratings (including Throw/Kick Power) drop. At 1.0 these barely change from college. Lower = athleticism carries over even more intact.',
  'powerCurve.anchors': 'What percentage of a college rating carries over to Madden for this category. Lower = a harsher cut across the whole category. You set the carry-over at two reference points: an Elite college rating and a Good one.',
  'powerCurve.globalStrength': 'One dial for the whole class: adjusts every position\'s Technical and Mental compression at once. Lower = the entire class keeps more college rating (stronger class). Higher = bigger cuts everywhere. 1.0 is the recommended baseline -- a small class-wide cut is already built in at that setting. Never touches Physical ratings.',
  'powerCurve.jitter': 'Random +/- scatter added to every converted rating so players don\'t feel copy-pasted. 0 = fully deterministic (a burner stays an exact burner, and the same seed always gives the same class).',
  'powerCurve.clampFloor': 'Lowest any converted rating can go.',
  'powerCurve.clampCeiling': 'Highest any converted rating can go.',
  'powerCurve.ratingCategory': 'Which category decides how much a rating drops. Physical barely changes; Technical (Light) drops mildly; Technical (Heavy) more; Mental drops hardest. Change this if a specific rating comes out too high or too low across the board.',
  'ratingTweaks.extraDrop': 'Extra points shaved off just this one rating, for every position, on top of everything else (category curve, position strength, position Extra Drop).',
  'ratingTweaks.maxDrop': 'Hard ceiling on how much this one rating can drop below its college value, no matter what else applies. Blank = no cap.',
  'realism.agilityCodSizePenalty': 'Pulls down unrealistically high Agility & Change-of-Direction for BIG receivers and corners (a 6\'4"/230 WR/CB shouldn\'t test 99). The bigger the frame, the harder the pull, plus a random downward drag so flat 99s thin out. Change-of-Direction tracks Agility closely -- usually equal or a bit below, only rarely a hair above. Leaves smaller, shifty WR/CB mostly alone, and never touches other positions. On by default -- turn it OFF if you have already run the external Agility/COD tool, so the same correction isn\'t applied twice.',
  'draftBoard.organization': 'How the class is ordered into rounds and picks. This never changes WHICH players make the class -- only where they get drafted. "CFB Projected Rounds" leans heavily on the round CFB 27 itself projected for each player. "Realistic Draft Day" ignores CFB\'s projected round entirely, re-ranks the same players on talent alone, then lets some of them slide down the board -- so you get genuine late-round steals instead of a clean best-to-worst sort.',
  'draftBoard.chaos': 'Only used by "Realistic Draft Day". How far players can slide down the board. 0 = pure talent order, no movement. Higher = more players fall, and the ones that fall go further. Most players stay near where their talent says; a small number drop a long way (those are your steals). Sliding never drags a bad player up into round 1 -- when someone falls, everyone below them moves up a single pick.',
  'general.classSize': 'Players in the class. 402 matches a real Madden draft-class file exactly -- that\'s the game\'s own auto-generated class size (7 rounds x 32 picks + a 178-player UDFA tail). You can go higher (the extra players are generated but only the top 402 get exported) or lower: a smaller class still exports, but the leftover slots keep the bundled template\'s original, unconverted prospects. Go below 224 and even some DRAFTED rounds will include those unconverted fillers, not just the UDFA tail.',
  'general.seed': 'Leave blank for a different class every time. Enter anything here to get the exact same class again later.',
  'general.dropLeniency': 'Overall strength of the class. Lower = players keep more of their college rating (stronger class). Higher = bigger cuts across the board (weaker class).',
  'general.defaultDrop': 'Backup number used only when a rating has no real calibration data. You won\'t normally need this.',
  'general.calibrationJitter': 'Random variation on physical ratings (Speed, Strength, etc.) so players don\'t feel copy-pasted. Higher = more player-to-player variety.',
  'general.quantileJitter': 'Same as Physical Jitter, but for skill ratings (Awareness, coverage, blocking, route running, etc.).',
  'bell.peakPercentile': 'Which tier of prospects gets hit hardest by the extra cut. Higher = the pain shifts toward your better players. Lower = it hits weaker players hardest instead.',
  'bell.peakExtraDrop': 'How big that extra cut is at its worst point.',
  'bell.spreadBelow': 'How far the extra cut spreads into weaker players below that tier. Higher = more of the lower half also takes a hit.',
  'bell.spreadAbove': 'How far the extra cut spreads toward your elite players. Kept low by default so stars stay strong.',
  'positionExtraDrop': 'A flat number of points off EVERY rating for this position (Physical, Technical, and Mental alike) -- not a percentage, and not the same as the Strength dials above. Stacks on top of them. Higher = everyone here comes in weaker overall. Lower or negative = they keep more of their college rating.',
  'positionCaps': 'Max players at this position allowed in the class. Leave blank for no limit — handy for trimming excess Kickers/Punters.',
  'kpAwarenessCap': 'Awareness is the biggest driver of K/P overall. Lowering this keeps rookie kickers/punters from rating too high on day one.',
  'ratingAdjustments.extraDrop': 'Extra points shaved off just this one rating, for every player.',
  'ratingAdjustments.jitter': 'How much this specific rating varies player to player. Blank = use the global Physical Jitter.',
  'ratingAdjustments.maxDrop': 'Caps how much this rating can drop, no matter what else applies. Blank = no cap.',
  'devTraits.xfactorPercentTarget': 'Target share of the class that becomes an X-Factor — Madden\'s rarest trait. Default is about 1 in 1,300 players, so most classes have zero. Raise this and X-Factors stop being special.',
  'devTraits.superstarPercentTarget': 'Target share of the class that becomes a Superstar. Default is about 1 in 100 players (roughly 2 in a typical class).',
  'devTraits.starPercentTarget': 'Target share of the class that ends up with the Star trait.',
  'positionValue': 'Draft-order-only value for this position, on top of overall -- doesn\'t change ratings, just where they land in the class. Positive = drafted earlier than their overall alone would suggest (QB, blindside tackle, edge rusher). Negative = drafted later (RB, FB, specialists), matching how real teams actually spend picks.',
  'draftValue.positionValueWeight': 'How much the Position Value table above actually matters. 0 turns it off entirely; higher exaggerates it.',
  'draftValue.awardsWeight': 'How much career awards (Heisman, All-American, Player of the Week, etc.) push a player up the draft order.',
  'draftValue.athleticismWeight': 'How much a great athlete climbs the draft board. Compares his measurables -- speed, size, jumps -- against others at his position, so a freak rises even without huge stats. Draft order only; never changes ratings.',
  'draftValue.productionWeight': 'How much big college production climbs the draft board. Compares his stats against others at his position, so a proven producer rises even without freaky measurables. Needs a save with seasons played. Draft order only.',
  'draftValue.roundWeight': 'How much CFB\'s own projected round still factors into where a player lands, alongside overall, awards, athleticism, production, and position value.',
  'draftValue.boardVariance': 'Random points added to each player\'s draft score so the board isn\'t a rigid overall ranking -- similarly-graded prospects shuffle a little each regenerate. 0 = fully deterministic order.',
  'draftValue.generationalEnabled': 'Allow at most one "generational" prospect (97+ overall elite who is also an elite producer or freak athlete) to lock the very top of the board, like a real headline #1 pick.',
  'overallAnchor.spreadFactor': 'How much two players with the same CFB Overall can differ in their estimated Madden Overall. 0 = they all land on the same number (rigid). 1 = their ratings alone decide it, with no guardrail.',
  'overallAnchor.maxSpread': 'The most (in points) a player\'s estimated Madden Overall can drift from what his CFB Overall suggests -- stops a mediocre college player from ever estimating as high as an elite one.',
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

// Class Size's only real technical floor is one full draft round (32) --
// below that there's no meaningful "class" to speak of. The draft-class FILE
// itself no longer requires exactly 402 (draftClassExporter.js now fills as
// many of the file's 402 slots as the class provides, leaving the rest as the
// bundled template's original prospects), so this is a much lower bar than it
// used to be; see general.classSize's description for the real user-facing
// tradeoffs (224 = smallest class that still fills every drafted round).
// Applied by ConfigStore (the user-facing config boundary) rather than inside
// mergeConfig itself, since pipeline.js also calls mergeConfig internally with
// intentionally small classSize overrides for fast, focused calibration tests.
const MIN_CLASS_SIZE = 32;
function enforceMinClassSize(config) {
  if (!(Number(config.general.classSize) >= MIN_CLASS_SIZE)) config.general.classSize = MIN_CLASS_SIZE;
  return config;
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
  POWER_CURVE_CATEGORY_META,
  defaultPositionStrength,
  defaultPowerCurveAnchors,
  mergeConfig,
  MIN_CLASS_SIZE,
  enforceMinClassSize,
};
