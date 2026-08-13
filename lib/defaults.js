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

// The only positions that ship a real cap out of the box. See positionCaps'
// own comment (in defaultProfileTuning) for why every OTHER position still
// has to appear in the config object, just with a blank ('') value.
const DEFAULT_POSITION_CAPS = { K: 3, P: 5, LS: 3 };

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
  // HB tech/mental RAISED 2026-08-11b, 0.5/0.6 -> 0.7/0.7 -- see
  // defaultPowerCurveAnchors' PART 2 comment for the full story. The 0.5/0.6
  // values were tuned when `physical` was doing heavy compression work of its
  // own; once physical went back to near-identity (to fix speed realism), HB's
  // technical/mental ratings needed to pick up more of what physical used to
  // absorb, or HB overalls reproduce the exact "too high" complaint that
  // motivated the physical retune in the first place. Still below the 1.0
  // baseline every other skill position gets -- HB keeps SOME extra leniency,
  // just not as much as before.
  set('HB', 0.7, 0.7);
  // WR LOWERED 2026-08-11e, 1.0/1.0 -> 0.85/0.85, on a report that receivers
  // were getting hit too hard: a 99-overall college WR was coming out around
  // 70. WR was the only skill position sitting at a bare 1.0 with no leniency
  // at all (QB 0.75, HB 0.7, TE 0.9, CB 0.95, safeties 0.85), which was fine
  // when the global baseline was mild but became the harshest treatment in the
  // class once that baseline was raised to 1.56 -- the two stack, so WR was
  // effectively taking the full 1.56 where every other skill position took
  // 1.1-1.5. Traced on a real player: route running fell 19 points and
  // Awareness 33.
  //
  // 0.85 lands the top receiver at 78-80 against EA's own 76-78, without
  // pushing the class past EA's 0-2 players at 80+. Dice Roll's equivalent
  // dial (GENERIC_DELTA_SCALE.WR) was moved to the same 0.85 in the same
  // change -- the engines share no config, so leaving one behind would make
  // the engine picker silently change how good receivers are.
  set('WR', 0.85, 0.85);
  // TE boost HALVED 2026-08-12b. Full history: 0.9/0.75 (pre-session), then
  // 0.55/0.55 (2026-08-11f, chasing a report that the best TE in a class was
  // capping around 62) put the class average in the high 70s -- then removing
  // the boost entirely (1.0/1.0, same day) swung the other way, averaging mid
  // 60s. Both were overcorrections in opposite directions. 0.775 is exactly
  // halfway between 0.55 and the neutral 1.0 every unlisted position gets --
  // half the leniency of the boost that was removed, not a full reintroduction
  // of it. See STALE_TE_STRENGTH below for the migration that brings an
  // already-upgraded saved config (on either 0.55/0.55 or 1.0/1.0) to this.
  set('TE', 0.775, 0.775);
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
//
// `physical` HAS A TWO-PART HISTORY, both parts on 2026-08-11, and the second
// part reverses the first's headline number while keeping its actual point.
// Read both before touching this again.
//
// PART 1 -- overalls too high. Physical shipped near-identity (99->99, 80->79),
// letting college athleticism cross over essentially untouched. For skill
// positions the overall formula leans hardest on speed/accel/agility, so a
// halfback carrying his CFB 95s straight into Madden posted an 86 no matter how
// hard the technical/mental curves compressed him. Retuned to 99->94, 80->72,
// calibrated against two real Madden 27 draft classes:
//
//                        EA's classes      before        after (part 1)
//   top overall          79-82             88            81
//   players at 80+       0-2               17            1
//
// PART 2 -- that fix broke speed realism. `physical` is ONE curve shared by
// SPD/ACC/AGI/COD *and* STR/JMP/STA/TGH/INJ/Throw/Kick power. Compressing the
// whole bucket to fix overalls meant no burner could ever exceed a ~94 speed
// ceiling either -- checked against EA's real classes BY RATING instead of by
// bucket, and confirmed the buckets should never have been uniform: EA's WR
// speed runs to 98 with 25/42 WRs at 90+, while EA's WR strength medians only
// 60. A real report ("only one WR over 90 speed") measured this exactly:
// 25/42 at 90+ down to 2/51.
//
// So `physical` reverts to a shape close to its original near-identity curve
// (steepened slightly at the low end, y2 80->82, so the 90+ speed RATIO among
// WRs -- not just the ceiling -- matches EA's real classes instead of putting
// nearly every WR over 90), and the compression PART 1 actually needed moves
// to where it belongs: StrengthRating is routed out of `physical` into
// `techhvy` for skill positions only (categoryOverrides below -- trench
// strength stays on this curve, since EA's own OL/DL strength barely
// compresses either), with HB's positionStrength dial picking up the rest QB
// didn't already handle on its own (see that comment). Verified this
// reproduces part 1's overall targets AND restores real speed simultaneously
// -- both checked on two saves, an ordinary dynasty and the unusually stacked
// one the original complaint came from:
//
//                    EA target   DRAFTSTAGE (normal)   DUKE1 (stacked, mod)
//   QB OVR top3      75-77       71,71,70              79,77,76
//   HB OVR top3      74-78       71,70,68              81,81,77
//   WR OVR top3      76-78       75,74,74               83,77,77 *
//   class top/80+    79-82/0-2   79 / 0                 83 / 7
//   WR SPD 90+ ratio  ~60%        41/61 (67%)            38/51 (75%)
//   CB SPD 90+ ratio  ~50%        25/39 (64%)            26/47 (55%)
//
//   * DUKE1's #1 WR is Jeremiah Smith, CFB 99 overall -- the CFB game's own
//     max rating, not a formula artifact. One outlier on one atypical save,
//     not chased further (see the DUKE1 note further down). Its 80+/75+
//     counts also run a bit above EA's for the same underlying reason (this
//     save's Awareness/technical inputs, not its speed).
// PART 3 (2026-08-11c) -- 96/82 -> 97/79, on a direct request to keep the
// physical hit small (a 99 landing "around 97, or lower"). This is a strictly
// better curve on every measure, not a trade:
//
//   * The TOP hit shrinks, which is what was asked: 99 -> 97 instead of 96.
//   * The old low end was actively INFLATING physicals -- 80 mapped UP to 82
//     and 85 up to 86. Nothing justified that; it was an artifact of steepening
//     the curve in PART 2 to pull the 90+ speed RATIO down, done by lifting the
//     low anchor rather than lowering the high one. 80 -> 79 now, so the whole
//     curve is a small, consistent haircut instead of a cut at the top and a
//     raise in the middle.
//   * Because the middle no longer inflates, the 90+ WR speed ratio lands on
//     EA's own ~60% (was running 67-75%), while the class's overall
//     distribution is unchanged or slightly tighter (75+ fell 37 -> 30 on the
//     reporting save; top and 80+ counts identical).
//
// Mapping, for reference:  99->97  95->93  92->90  90->88  85->84  80->79
function defaultPowerCurveAnchors() {
  return {
    physical: { x1: 99, y1: 97, x2: 80, y2: 79 }, // near-identity: speed/agility/jumping should barely move
    techmod: { x1: 99, y1: 90, x2: 80, y2: 73 },  // mild compression
    techhvy: { x1: 99, y1: 87, x2: 80, y2: 68 },  // moderate compression
    mental: { x1: 97, y1: 77, x2: 86, y2: 62 },   // hardest compression
  };
}

// Skill positions whose StrengthRating routes to `techhvy` instead of
// `physical` -- see defaultPowerCurveAnchors' PART 2 comment for why. Trench
// positions (OL/DL/LB) are deliberately absent: their college strength is
// close to their real ceiling already, and EA's own classes show it barely
// compresses for those positions either.
const SKILL_STRENGTH_OVERRIDE_POSITIONS = ['WR', 'CB', 'HB', 'FS', 'SS'];
function defaultSkillStrengthOverrides() {
  const out = {};
  for (const pos of SKILL_STRENGTH_OVERRIDE_POSITIONS) out[pos] = { StrengthRating: 'techhvy' };
  return out;
}

// DUKE1 note (referenced above and in positionStrength's HB comment): a
// real-roster mod save used as one of the two calibration dynasties. Its
// college INPUT speed is ordinary (HB SPD averages 90.8 vs an organic save's
// 89.9 -- nearly identical), but its Awareness input averages 89 against an
// organic save's 75, a 14-point gap, plus modestly elevated HB technical
// ratings across the board. That is a property of this specific save's data
// (a mod that boosts real players' polish, not their raw athleticism), not
// something the conversion formula should chase further -- an organic dynasty
// (DRAFTSTAGE above) lands inside EA's target range with no residual gap at
// all under these same settings.

// UI-facing metadata for the four categories (label + which ratings fall in
// each by default). Drives the Power-Curve settings page.
const POWER_CURVE_CATEGORY_META = {
  physical: { label: 'Physical', blurb: 'Speed, Acceleration, Agility, Strength, Jumping, Throw/Kick Power — barely changes (elite athletes stay elite).' },
  techmod: { label: 'Technical (Light)', blurb: 'Catching, Carrying, Trucking — mild compression.' },
  techhvy: { label: 'Technical (Heavy)', blurb: 'Route running, Release, BC Vision, coverage, blocking, pass rush, throw accuracy — moderate compression.' },
  mental: { label: 'Mental', blurb: 'Awareness, Play Recognition — compresses the most (rookies rarely process at NFL speed).' },
};

// The full set of per-league tuning keys -- everything that now lives inside
// EACH profile (`profiles.nfl` / `profiles.ufl`), independently. See
// LEAGUE_PROFILES_ROADMAP.md. Session-level keys (population, league,
// translation, general, draftBoard) stay shared and are listed separately as
// SESSION_KEYS below.
const TUNING_KEYS = [
  'diceRoll', 'powerCurve', 'overallBoost', 'positionStrength', 'legacy',
  'bell', 'positionExtraDrop', 'positionCaps', 'kpAwarenessCap',
  'ratingAdjustments', 'positionValue', 'draftValue', 'devTraits',
  'overallAnchor', 'realism',
];
// `customPlayers` is a SESSION key, not a tuning key, and the distinction is
// load-bearing: it is class CONTENT (who is in the pool), not a dial that
// shapes conversion. Putting it in a per-league profile would mean a player
// added while NFL was selected vanished on switching to UFL, and would let a
// shared per-league weights file carry someone else's invented players into
// your dynasty. As a session key it persists once, applies to whichever league
// is generated, and travels only with a whole-app preset.
//
// mergeInto replaces arrays wholesale rather than merging them index-wise
// (see its Array.isArray branch), so a saved list of two never leaves a
// third default entry stranded behind it. That is the behavior this needs.
// Named config migrations. Declared here (above DEFAULT_CONFIG) because the
// default config lists them as already-applied -- a fresh install is current
// by definition and must never re-run one. See applyMigrations for why these
// are markers rather than value comparisons.
const PHYSICAL_ANCHOR_MIGRATION = 'physicalAnchor-2026-08';
// Covers the second same-day retune: physical reverted toward near-identity
// (fixing speed realism) plus HB's positionStrength compensating for it. See
// defaultPowerCurveAnchors' PART 2 comment.
const SPEED_REALISM_MIGRATION = 'speedRealism-2026-08-11b';
// Third and final same-day physical retune: the hit at the top of the curve
// was reduced (99 -> 97 rather than 96) and the low end stopped inflating
// (80 -> 79 rather than being raised to 82). See defaultPowerCurveAnchors'
// PART 3 comment.
const SMALL_PHYSICAL_HIT_MIGRATION = 'smallPhysicalHit-2026-08-11c';
// Receiver and tight-end position weights, both retuned after real in-game
// reports (a 99-overall college WR landing near 70; the best TE near 62).
// Needs its own marker for the usual reason: positionStrength is a TUNING key,
// so a saved config's copy beats the new default. This one was caught the hard
// way -- the WR fix shipped, the reporter re-ran it, and their saved 1.0/1.0
// silently won, so the change reached nobody who had ever opened the app.
const SKILL_WEIGHTS_MIGRATION = 'skillPositionWeights-2026-08-11f';
// The Dice Roll rewrite (2026-08-11g). `spread` survived the rewrite by name
// but not by MEANING: it used to scale a percentage-of-overall modifier and now
// scales a slide measured in rating points. A saved 0.3 -- the old shipped
// default, so almost every existing config has it -- would shrink the new slide
// to roughly a fifth of intended, making Dice Roll nearly indistinguishable
// from plain Power Curve. There is no honest conversion between the two scales,
// so any value that is still the OLD default is reset to the new one.
const SLIDE_SCALE_MIGRATION = 'diceSlideScale-2026-08-11g';
// TE's positionStrength boost (0.55/0.55) was removed entirely the very next
// day on a report that tight ends were now coming out too high -- see
// defaultPositionStrength's TE comment. Needs its own marker because
// SKILL_WEIGHTS_MIGRATION already fired for anyone who ran 0.3.1, so a
// value-only check under that marker would never run again for them.
const TE_BOOST_REMOVAL_MIGRATION = 'teBoostRemoval-2026-08-12';
// Removing the boost entirely was itself an overcorrection (high 70s average
// -> mid 60s) -- TE now gets HALF the old boost (0.775, halfway between 0.55
// and neutral 1.0) instead of none. Its own marker for the same reason as
// above: TE_BOOST_REMOVAL_MIGRATION already fired for anyone who ran the
// build that shipped 1.0/1.0, so a value check under that marker would never
// run again for them.
const TE_HALF_BOOST_MIGRATION = 'teHalfBoost-2026-08-12b';
const ALL_MIGRATIONS = [
  PHYSICAL_ANCHOR_MIGRATION, SPEED_REALISM_MIGRATION, SMALL_PHYSICAL_HIT_MIGRATION,
  SKILL_WEIGHTS_MIGRATION, SLIDE_SCALE_MIGRATION, TE_BOOST_REMOVAL_MIGRATION,
  TE_HALF_BOOST_MIGRATION,
];

const SESSION_KEYS = ['population', 'league', 'translation', 'general', 'draftBoard', 'customPlayers', 'migrations'];

// CONFIG_HARDENING_ROADMAP.md Phase 5. Stamped onto every exported preset
// file (whole-app and per-league alike) alongside the app name/version and
// export timestamp, so a file's provenance travels with it and a future
// schema change has something to check against before applying a file it
// might not understand correctly. Bump this only when a change to the
// config SHAPE (not just default VALUES) could make an older importer
// misinterpret a newer file -- main.js rejects any file whose own
// schemaVersion is greater than this build's.
const CONFIG_SCHEMA_VERSION = 1;

// The base tuning bundle both leagues start from -- today's values, before
// any per-league divergence. defaultNflProfile() uses this as-is;
// defaultUflProfile() clones it and overrides the handful of fields that
// have always been UFL-specific (see LEAGUE_PROFILES_ROADMAP.md Section 2a).
function defaultProfileTuning() {
  return {
    // Dice Roll settings (lib/rosetta/translation/diceRoll.js).
    //
    // REBUILT 2026-08-11g. Dice Roll is no longer a separate conversion engine
    // -- it now runs Power Curve for the base ratings and then applies a
    // per-player luck SLIDE on top, up or down, to produce steals and busts.
    // That means all the per-position and class-wide calibration lives in the
    // Power Curve settings for BOTH engines, and only the luck itself is
    // configured here.
    diceRoll: {
      // DEAD as of the rewrite. Both described a class-wide debuff, which no
      // longer exists: the slide is zero-centred, so a Dice Roll class averages
      // out to the same strength as a Power Curve one by construction rather
      // than by tuning. Kept as keys purely so old saved configs and exported
      // presets still load without complaint; nothing reads them.
      classStrength: '',
      debuff: -0.20,
      // How much luck. Scales the per-player slide drawn from SLIDE_TABLE
      // (2d6, symmetric, in rating points) before category weighting and the
      // depth taper. 1.0 is the shipped amount; 0 disables the layer entirely
      // and makes Dice Roll identical to Power Curve.
      //
      // Measured on a real class at 1.0: about a third of players come out
      // exactly where Power Curve put them, most of the rest move a point or
      // two of overall, and roughly 2% swing the full ~5 points. That is the
      // intended shape -- small everywhere, rare extremes.
      //
      // NOTE the scale CHANGED with the rewrite. The old 0.3 default scaled a
      // percentage-of-overall modifier and has no meaning here; a saved 0.3
      // would shrink the new slide to near-nothing, so it is migrated forward
      // rather than carried over (see SLIDE_SCALE_MIGRATION in this file).
      spread: 1.0,
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
      // per-position exceptions (Phase 4c): { [position]: { [Rating]: category } }.
      // SHIPPED NON-EMPTY 2026-08-11b -- see defaultPowerCurveAnchors' PART 2
      // comment. Routes StrengthRating out of `physical` (near-identity, so
      // speed stays real) into `techhvy` (real compression) for skill
      // positions specifically, since EA's own classes show skill-position
      // strength compressing hard while their speed barely moves -- the two
      // ratings needed genuinely different treatment, not one shared curve.
      // Trench positions are deliberately absent: their strength stays on
      // `physical`, since EA's OL/DL strength barely compresses either.
      categoryOverrides: defaultSkillStrengthOverrides(),
      // Level-4b per-rating numeric tweaks: a flat point subtraction and/or a
      // hard cap on total drop, for ONE rating, on top of everything else
      // (category curve, position strength, position Extra Drop). A fresh,
      // all-zero/all-null structure -- deliberately NOT the old physical-only
      // `ratingAdjustments` (which ships a live AgilityRating cut for V1 and
      // would have silently activated under Power Curve).
      // { [Rating]: { extraDrop, maxDrop } }
      ratingTweaks: {},
    },
    // Post-translation overall lift (UFL_ROADMAP.md Phase 4). Engine-agnostic
    // -- both Power Curve and Dice Roll read it the same way (see
    // applyOverallBoost in pipeline.js). Despite living in every profile,
    // this is the ONE deliberately league-gated mechanism: pipeline.js only
    // ever applies it when league === 'ufl', regardless of what an NFL
    // profile's own `enabled` says (UFL_ROADMAP.md Decision 3) -- so editing
    // it on the NFL profile has no effect. It's still per-profile so the
    // per-league UI (CONFIG_HARDENING_ROADMAP.md Phase 2) has one place to
    // show/edit it, not a special case.
    //
    // points: 4, even though `enabled` defaults to false -- CONFIG_HARDENING
    // finding #4: shipping points: 0 meant switching `enabled` on added
    // nothing, which reads as a broken control the moment anyone tries it.
    // The UI (renderer.js) also auto-fills this value if a user flips
    // `enabled` on while `points` is still 0 from an older saved config.
    overallBoost: { enabled: false, points: 4 },
    positionStrength: defaultPositionStrength(),
    // Legacy V1-engine-only tuning (calibratePlayersV1), carved out of the
    // old shared `general` section so it can vary per league like everything
    // else. No UI exposes these today (V1 has none -- see main.js).
    legacy: {
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
    // Seeded with EVERY position, not just the three that ship a real cap.
    // mergeInto (below) merges a saved config by iterating the DEFAULT's own
    // sub-keys -- `for (const subKey of Object.keys(target[key]))` -- so any
    // position missing from this object can never survive a save/reload round
    // trip: a user-set WR cap was silently dropped on the very next load,
    // which made the Position Caps control appear to do nothing for every
    // position except Kicker/Punter/Long Snapper. '' (blank) means no cap,
    // matching both the UI (renderer.js deletes a position's key when its
    // input is cleared) and the enforcement check itself (projectDraftClass's
    // `Number(positionCaps[r.Position]) > 0` -- Number('') is 0, so a blank
    // entry is inert, exactly like an absent one).
    positionCaps: Object.fromEntries(POSITIONS.map((p) => [p, DEFAULT_POSITION_CAPS[p] ?? ''])),
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
}

function defaultNflProfile() {
  return defaultProfileTuning();
}

// UFL_ROADMAP.md Phases 3/4/6 + LEAGUE_PROFILES_ROADMAP.md Sections 2a/Phase
// 5: the second tier's own values, independent of NFL's from here down --
// no runtime override, no inheritance. Two stages: powerCurve.globalStrength
// / diceRoll.debuff bring each engine to a real (not just displayed)
// baseline near NFL's own; overallBoost is left available for MORE lift on
// top, off by default.
//
// The values below were RETUNED in LEAGUE_PROFILES_ROADMAP.md Phase 5 after
// discovering the ones Phase 3/4 shipped were tuned against
// `EstMaddenOverall`, which does not match what Madden actually computes
// from the written ratings on import -- Dice Roll's display is pure
// arithmetic that never looks at the real sub-ratings, and Power Curve's
// anchored display undercounted the boost's real effect by ~9 points.
// Measured instead by scoring the actual written ratings through
// data/overall_formula.json (the same regression the app's own estimate is
// built from, just without the anchor's guardrail clamping it). Reference
// point throughout: NFL Power Curve's own real median (~65-66 across two
// saves) -- already healthy at its shipped default, untouched here.
function defaultUflProfile() {
  const p = defaultProfileTuning();
  // Stage 1, Power Curve. Measured: Power Curve's compression plateaus
  // around 0.5 (lower barely moves the band further -- the transform floor
  // is the player's raw college rating), so this is the practical floor,
  // not an arbitrary half-strength pick. Unchanged in Phase 5 -- its REAL
  // baseline (boost off) already reads ~68-69, close to NFL's own ~65-66.
  p.powerCurve = { ...p.powerCurve, globalStrength: 0.5 };
  // Stage 1, Dice Roll -- no longer needs its own UFL value at all. Before the
  // 2026-08-11g rewrite this carried a hand-tuned debuff whose entire job was
  // to make Dice Roll's UFL baseline agree with Power Curve's. Dice Roll now
  // RUNS Power Curve underneath, so it inherits this profile's globalStrength
  // above and the two agree by construction. The old tuning is deleted rather
  // than kept inert, because keeping it would imply it still did something.
  // Stage 2, both engines. Raises each player's ratings until the position's
  // own Madden overall formula reads `points` higher (see applyOverallBoost
  // in pipeline.js), clamped/redistributed at 99. OFF by default -- Phase
  // 5 finding: once Stage 1 above is correctly grounded in real (not
  // displayed) numbers, the UFL baseline ALONE already lands at/above NFL's
  // real median (measured +3 to +5 across two saves, boost off) -- the old
  // +4-ON-by-default was stacking real inflation on top of a baseline that
  // had already arrived, overshooting NFL's band by 7-9 points instead of
  // landing in it. Reverted to off-by-default, its ORIGINAL design
  // (UFL_ROADMAP.md Decision 5: "off by default; the honest 'this is
  // inflation' case") -- still available, still fully functional, for
  // anyone who wants UFL to run hotter than NFL on purpose. `points` itself
  // is already 4 from defaultProfileTuning() above -- no override needed
  // here, only `enabled` ever differed from the shared base, and the base
  // already defaults to false.
  // UFL-mode dev-trait rates (UFL_ROADMAP.md Phase 6): a thinner profile --
  // this is the tier that did NOT get drafted, so it should read as a league
  // of solid pros with a few standouts, not a second class full of future
  // superstars. X-Factor is 0 rather than merely small: it's Madden's
  // generational trait, and a generational player by definition doesn't fall
  // out of the NFL cut.
  p.devTraits = {
    xfactorPercentTarget: 0,      // vs 0.08 for the NFL profile
    superstarPercentTarget: 0.25, // vs 1
    starPercentTarget: 20,        // vs 35
  };
  return p;
}

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
  // Which draft this generates: the top-402 NFL class, or the next 402 for a
  // UFL mod import (see UFL_ROADMAP.md). Selecting 'ufl' selects the next
  // 402 players after the NFL cut (a disjoint tier, guaranteed by a
  // deterministic talent score -- see projectDraftClass in pipeline.js) and
  // switches which profile (see `profiles` below) supplies every tuning
  // value.
  league: 'nfl', // 'nfl' | 'ufl'
  // Which rating-conversion engine runs. 'powercurve' (default) is the
  // Power-Curve model (model spec): closed-form per-category curves x
  // per-position strength dials, fully user-tunable, no Madden-OVR estimation
  // (Madden recomputes OVR in-game). 'diceroll' RUNS that same Power Curve
  // conversion and then applies a per-player luck slide on top
  // (lib/rosetta/translation/diceRoll.js), producing steals and busts while
  // leaving the class average where Power Curve put it. It is a layer, not an
  // alternative: every Power Curve dial shapes it too. (It began as a separate
  // model adapted from a community spreadsheet; see diceRoll.js for why that
  // was replaced.) 'v1' is the
  // legacy quantile/flat-drop + overall-anchor engine, kept for side-by-side
  // comparison. 'rosetta' is currently a pure delegate to 'v1' (see
  // RosettaTranslator) -- the percentile-based engine that was going to
  // replace it (internally "Two-Anchor") was abandoned before any of its
  // translation math was built; only the strategy seam remains. Neither
  // 'v1' nor 'rosetta' is reachable from the UI (renderer.js only offers
  // 'powercurve'/'diceroll'), kept for tooling/comparison only. Shared
  // across leagues -- flipping the league toggle never switches engines
  // (UFL_ROADMAP.md Decision 4).
  translation: {
    strategy: 'powercurve', // 'powercurve' | 'diceroll' | 'v1' | 'rosetta'
  },
  general: {
    classSize: 402,  // players pulled into the class -- 402 matches a real Madden draft-class file exactly (see lib/draftClassExporter.js)
    seed: '',        // reproducibility seed; blank = random every run
  },
  // Players the user typed in by hand, appended to the extracted pool before
  // generation (see lib/customPlayers.js). Each entry is
  // { firstName, lastName, position, overall } and nothing else -- the rest of
  // the row is borrowed from the closest same-position real prospect.
  //
  // These are ordinary pool members from the moment they are added: they are
  // scored, ranked, converted and dev-traited by the same code as everyone
  // else, so one lands wherever its talent puts it rather than at a slot it
  // was told to occupy. `overall` is a COLLEGE overall and converts downward
  // like any other, which is why the UI labels it as such.
  customPlayers: [],
  // Config migrations already applied (see applyMigrations). A fresh install
  // ships current, so it lists them all and no migration ever re-runs on it.
  migrations: [...ALL_MIGRATIONS],
  // How the SELECTED class is ordered into rounds/picks. Never changes which
  // players make the class -- only where they land. See lib/draftBoard.js.
  // Shared across leagues (LEAGUE_PROFILES_ROADMAP.md Section 2).
  draftBoard: {
    // 'cfbProjected' = today's board (CFB's own projected round carries a lot
    // of weight). 'realisticDraftDay' = re-rank on talent alone, then let
    // players slide, producing late-round steals.
    organization: 'cfbProjected',
    // Slide intensity for 'realisticDraftDay' only. 0 = pure talent order.
    chaos: 50,
  },
  // Every OTHER tunable value, independently for each league -- no
  // inheritance, no runtime override (LEAGUE_PROFILES_ROADMAP.md Decision 1).
  // See TUNING_KEYS above for exactly what a profile holds, and
  // activeConfig() below for how the currently-selected one gets flattened
  // onto the rest of this shape for pipeline.js / the renderer to use.
  profiles: {
    nfl: defaultNflProfile(),
    ufl: defaultUflProfile(),
  },
};

// Human-readable descriptions surfaced as tooltips / helper text in the UI.
// Written for players who know football but not statistics: short, scannable,
// and framed around the on-field/in-game result rather than the math behind it.
const DESCRIPTIONS = {
  'population.mode': 'How the tool decides which college players are leaving. The default pulls everyone graduating or declaring for the draft. (Not shown in the app -- kept for advanced preset use.)',
  'league': 'NFL generates your main draft class, same as always. UFL generates the next tier down -- the players just below the NFL cut, guaranteed never to overlap the NFL class (the number next to UFL above shows exactly where that tier starts) -- for import into a UFL roster mod. Ratings compress more gently for this tier so they land in a competitive range instead of the raw drop-off.',
  'translation.strategy': "The method that turns college ratings into Madden ratings. Power Curve is deterministic: every setting on this page and Rating Categories tunes it, and generating twice gives the same class. Dice Roll uses those exact same settings for the base ratings, then rolls each player a little luck on top -- most barely move, a few swing several points -- so you get steals and busts instead of a predictable board. A Dice Roll class averages out the same strength as a Power Curve one; only the individual players move.",
  'diceRoll.classStrength': "No longer used. Dice Roll used to apply a class-wide strength debuff on top of its own conversion; it now builds on Power Curve and only adds per-player luck, so there is no class-wide value to set. The key is kept so older saved settings files still load.",
  'diceRoll.debuff': "No longer used. This was UFL's fixed class-wide debuff, hand-tuned so Dice Roll's UFL baseline matched Power Curve's. Dice Roll now runs Power Curve underneath, so the two agree automatically and there is nothing left to tune here. The key is kept so older saved settings files still load.",
  'diceRoll.spread': "How much luck Dice Roll adds on top of the Power Curve base. 1.0 is the shipped amount: about 4 in 10 players come out exactly where Power Curve put them, most of the rest move a point or two of overall, and a handful swing around 5 -- with the top of the draft board moving most and the deep class least, though never nothing, so a late-round steal stays possible. Speed and agility barely move at any setting; luck lands on technique and awareness. Set it to 0 and Dice Roll produces exactly the same class as Power Curve. Raise it above 1.0 for a wilder, less predictable board. NFL and UFL each keep their own copy.",
  'overallBoost.enabled': 'Turns the boost above on or off. It only ever affects UFL, even if switched on while you\'re viewing NFL settings. Off by default -- tested UFL classes already land at a competitive overall without it, so this is purely for pushing UFL higher on purpose, not something you need.',
  'overallBoost.points': 'Roughly how many Overall points the boost adds, once the toggle above is on (UFL only, no matter which league you\'re viewing). It works by raising the specific ratings that matter most to each position\'s Overall, capped at 99. Raise it to push the UFL class higher, lower it to keep it closer to the regular class.',
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
  'general.classSize': 'Players in the class. 402 matches a real Madden draft-class file exactly -- that\'s the game\'s own auto-generated class size (7 rounds x 32 picks + a 178-player UDFA tail). You can go higher (the extra players are generated but only the top 402 get exported) or lower: a smaller class still exports, but the leftover slots keep the bundled template\'s original, unconverted prospects. Go below 224 and even some DRAFTED rounds will include those unconverted fillers, not just the UDFA tail. This also decides where the UFL tier starts -- right after this many NFL players -- see the number next to UFL on the Generate Class page.',
  'general.seed': 'Leave blank for a different class every time. Enter anything here to get the exact same class again later.',
  'legacy.dropLeniency': 'V1 engine only. Overall strength of the class. Lower = players keep more of their college rating (stronger class). Higher = bigger cuts across the board (weaker class).',
  'legacy.defaultDrop': 'V1 engine only. Backup number used only when a rating has no real calibration data. You won\'t normally need this.',
  'legacy.calibrationJitter': 'V1 engine only. Random variation on physical ratings (Speed, Strength, etc.) so players don\'t feel copy-pasted. Higher = more player-to-player variety.',
  'legacy.quantileJitter': 'V1 engine only. Same as Physical Jitter, but for skill ratings (Awareness, coverage, blocking, route running, etc.).',
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
  'overallAnchor.spreadFactor': 'How much two players who share the same CFB Overall can still end up with different Est. Madden Overall. 0 = they land on the exact same number. 1 = their individual ratings decide it entirely, with nothing pulling them together.',
  'overallAnchor.maxSpread': 'The most, in points, a player\'s Est. Madden Overall can drift from what their CFB Overall alone suggests -- keeps a mediocre college player from ever estimating as high as an elite one.',
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

// Deep-merges `saved`'s matching keys onto `target`, for exactly the given
// key names -- unknown/stale saved keys never leak in, since only keys that
// already exist on `target` are ever considered. One level of the merge
// (an object-valued key gets its own sub-keys shallow-merged; anything else
// is taken from `saved` outright) -- the same rule this project's config
// merging has always used, now reusable for both the session-level keys and,
// once per league, a profile's tuning keys.
function mergeInto(target, saved, keys) {
  if (!saved || typeof saved !== 'object') return target;
  for (const key of keys) {
    const sv = saved[key];
    if (sv === undefined || sv === null) continue;
    if (target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      for (const subKey of Object.keys(target[key])) {
        if (sv[subKey] === undefined) continue;
        if (target[key][subKey] !== null && typeof target[key][subKey] === 'object' && !Array.isArray(target[key][subKey])) {
          target[key][subKey] = { ...target[key][subKey], ...sv[subKey] };
        } else {
          target[key][subKey] = sv[subKey];
        }
      }
    } else {
      target[key] = sv;
    }
  }
  return target;
}

// CONFIG_HARDENING_ROADMAP.md Phase 1. Identifies which of this app's config
// file shapes `parsed` is, so every import path validates the same way --
// the bug this exists to prevent (found in the Phase-5 audit): importing a
// single-league `{league, profile}` file through the WHOLE-APP import path
// used to reach `configStore.save(parsed)` directly, which fed a shape
// `mergeConfig` doesn't recognize into its legacy-flat fallback -- no tuning
// keys at top level, so it silently returned pure defaults, wiping every
// setting with no error.
//
// Deliberately strict: a file matching nothing recognizable is 'unknown'
// rather than being treated as an empty legacy config, because
// mergeConfig({}) returns pure defaults -- i.e. the exact silent-wipe this
// classifier exists to catch before it reaches mergeConfig at all.
function classifyConfigFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  if (parsed.profile && typeof parsed.profile === 'object' && !Array.isArray(parsed.profile)) {
    return 'leagueProfile'; // { league, profile } -- one league, from config-export-profile
  }
  if (parsed.profiles && typeof parsed.profiles === 'object'
      && (parsed.profiles.nfl || parsed.profiles.ufl)) {
    return 'canonical'; // whole app, current (post-profiles) shape
  }
  const known = [...SESSION_KEYS, ...TUNING_KEYS];
  if (known.some((k) => parsed[k] !== undefined)) return 'legacyFlat'; // pre-profiles export
  return 'unknown';
}

// CONFIG_HARDENING_ROADMAP.md Phase 5. Pure decision logic, deliberately
// separated from main.js's presetHeader()/error-throwing wrapper so it can
// be unit tested without an Electron context (see test/config.spec.js) --
// the same reasoning classifyConfigFile above is split out for. A MISSING
// schemaVersion (every file exported before this phase existed, or a
// hand-built legacy-flat file) is treated as compatible, not rejected --
// versioning starts here, it doesn't retroactively invalidate what came
// before it. Only a schemaVersion strictly GREATER than this build's is
// incompatible.
function isSchemaVersionCompatible(parsed) {
  if (!parsed || typeof parsed !== 'object') return true; // nothing to reject on
  const v = Number(parsed.schemaVersion);
  if (!Number.isFinite(v)) return true; // unversioned
  return v <= CONFIG_SCHEMA_VERSION;
}

// Splits an incoming league-profile's keys into the ones that are real
// tuning keys and the ones that aren't (hand-edited, misspelled, or written
// by a future version). foldIntoProfile would drop the strays silently
// anyway -- doing it up front means the import PREVIEW can't promise a
// change that was never going to apply, and can name what it dropped.
//
// Lives here rather than inline in main.js's config-import-profile handler
// specifically so the test suite can exercise THIS function instead of a
// copy of it: an earlier version of test/config.spec.js reimplemented this
// loop, which meant the test would still have passed if the real one broke
// -- the same "test consults a copy of its own source of truth" blind spot
// that showed up while building the Phase 4 key-coverage checks.
function splitKnownTuningKeys(rawProfile) {
  const profile = {};
  const ignoredKeys = [];
  for (const key of Object.keys(rawProfile || {})) {
    if (TUNING_KEYS.includes(key)) profile[key] = rawProfile[key];
    else ignoredKeys.push(key);
  }
  return { profile, ignoredKeys };
}

// Deep-merge stored/partial config over the defaults so old saved configs
// keep working when new options are added later. Two shapes come through
// here:
//
//   - The CURRENT (post-profiles) shape: session keys + `profiles.nfl` /
//     `profiles.ufl`. Each profile merges independently over its own
//     defaults -- no cross-profile inheritance (LEAGUE_PROFILES_ROADMAP.md
//     Decision 1).
//   - A LEGACY flat shape (no `profiles` key): every saved config from
//     before per-league profiles existed, where every tuning value except a
//     small `ufl` override block was genuinely shared between leagues. Both
//     profiles start from those same shared values, then the UFL profile's
//     historically-divergent fields (if an old `ufl` block is present) are
//     overlaid on top -- reproducing exactly what UFL mode used to compute
//     via its old runtime override, now baked into the UFL profile itself.
// The `physical` Power-Curve anchor as it shipped before 2026-08-11's FIRST
// retune, when it was near-identity and let college athleticism cross over
// untouched -- and as it shipped between that retune and the second one later
// the same day. A profile can be sitting on either value depending on exactly
// when it last ran the app, so both are checked.
const STALE_PHYSICAL_ANCHOR_V1 = { x1: 99, y1: 99, x2: 80, y2: 79 }; // pre-any-retune
const STALE_PHYSICAL_ANCHOR_V2 = { x1: 99, y1: 94, x2: 80, y2: 72 }; // first retune only
const STALE_PHYSICAL_ANCHOR_V3 = { x1: 99, y1: 96, x2: 80, y2: 82 }; // second retune only
// HB's positionStrength as it shipped before the second retune. See
// defaultPositionStrength's HB comment for why raising this was necessary
// once `physical` stopped doing the compression work these values assumed.
const STALE_HB_STRENGTH = { tech: 0.5, mental: 0.6 };

// Migrations already applied to a config. A retune is otherwise worthless to
// anyone who has run the app before: these values live under TUNING keys, so
// a saved config's copy beats the new default and every existing user
// silently keeps the old numbers -- the same shape as the positionCaps bug, a
// fix that "ships" but reaches nobody.
//
// Recorded as named markers rather than inferred by comparing values. Value
// sniffing ("if it still equals the old default, upgrade it") cannot tell
// "never touched this" from "deliberately set it to exactly that", so it would
// permanently prevent anyone from CHOOSING the old numbers -- their setting
// would be reverted on every single load. A marker runs once and then never
// second-guesses the user again.

// Only upgrades a profile still sitting on an exact pre-retune value; a
// profile the user had already tuned to something else is left alone even on
// the one run this fires.
function upgradeStalePhysicalAnchor(profile) {
  const pc = profile && profile.powerCurve;
  const a = pc && pc.anchors && pc.anchors.physical;
  if (!a) return;
  const matches = (stale) => Object.keys(stale).every((k) => Number(a[k]) === stale[k]);
  if (matches(STALE_PHYSICAL_ANCHOR_V1) || matches(STALE_PHYSICAL_ANCHOR_V2) || matches(STALE_PHYSICAL_ANCHOR_V3)) {
    pc.anchors.physical = { ...defaultPowerCurveAnchors().physical };
  }
}

// Same exact-match discipline as the anchor upgrade above.
// Every pre-retune value these two positions have ever shipped. A profile can
// be sitting on any of them depending on when it last ran, so all are checked.
const STALE_SKILL_STRENGTH = {
  WR: [{ tech: 1.0, mental: 1.0 }],
  TE: [{ tech: 0.9, mental: 0.75 }],
};
function upgradeStaleSkillStrength(profile) {
  const ps = profile && profile.positionStrength;
  if (!ps) return;
  const fresh = defaultPositionStrength();
  for (const [pos, staleList] of Object.entries(STALE_SKILL_STRENGTH)) {
    const cur = ps[pos];
    if (!cur) continue;
    const isStale = staleList.some((st) => Number(cur.tech) === st.tech && Number(cur.mental) === st.mental);
    if (isStale) { cur.tech = fresh[pos].tech; cur.mental = fresh[pos].mental; }
  }
}

// Only the exact old default is reset. Someone who deliberately set 0.5 or 2.0
// on the old scale had SOME intent about how much luck they wanted, and
// silently rewriting that is worse than leaving a number that no longer means
// what it did -- they can see and change this dial, and it is one number.
const STALE_SLIDE_SPREAD = 0.3;
function upgradeStaleSlideSpread(profile) {
  const dr = profile && profile.diceRoll;
  if (!dr) return;
  if (Number(dr.spread) === STALE_SLIDE_SPREAD) {
    dr.spread = defaultProfileTuning().diceRoll.spread;
  }
}

function upgradeStaleHbStrength(profile) {
  const hb = profile && profile.positionStrength && profile.positionStrength.HB;
  if (!hb) return;
  if (Number(hb.tech) === STALE_HB_STRENGTH.tech && Number(hb.mental) === STALE_HB_STRENGTH.mental) {
    const fresh = defaultPositionStrength().HB;
    hb.tech = fresh.tech;
    hb.mental = fresh.mental;
  }
}

// TE's positionStrength as it shipped in 0.3.1 (the 2026-08-11f boost), before
// that boost was removed entirely the next day. A profile can only be sitting
// on this one exact value, since it's the most recent TE tuning.
const STALE_TE_STRENGTH = { tech: 0.55, mental: 0.55 };
function upgradeStaleTeStrength(profile) {
  const te = profile && profile.positionStrength && profile.positionStrength.TE;
  if (!te) return;
  if (Number(te.tech) === STALE_TE_STRENGTH.tech && Number(te.mental) === STALE_TE_STRENGTH.mental) {
    const fresh = defaultPositionStrength().TE;
    te.tech = fresh.tech;
    te.mental = fresh.mental;
  }
}

// Every TE value this app has shipped since the boost was removed and then
// halved: the original boost (0.55/0.55, in case someone never reopened the
// app between that build and this one) and the just-shipped no-boost value
// (1.0/1.0, the realistic case for anyone on the previous installer).
const STALE_TE_HALF_BOOST = [{ tech: 0.55, mental: 0.55 }, { tech: 1.0, mental: 1.0 }];
function upgradeStaleTeHalfBoost(profile) {
  const te = profile && profile.positionStrength && profile.positionStrength.TE;
  if (!te) return;
  const isStale = STALE_TE_HALF_BOOST.some((st) => Number(te.tech) === st.tech && Number(te.mental) === st.mental);
  if (isStale) {
    const fresh = defaultPositionStrength().TE;
    te.tech = fresh.tech;
    te.mental = fresh.mental;
  }
}

// categoryOverrides needs no migration of its own. A saved config's
// categoryOverrides is virtually always `{}` (there has never been a UI for
// it), and mergeInto SPREADS an object-valued subkey rather than replacing it
// wholesale -- `{...newDefault, ...saved}` -- so an empty saved value never
// clobbers the new default's WR/CB/HB/FS/SS entries. This differs from the
// anchor and positionStrength cases above only because THEIR saved values are
// never empty (every save has always written them out in full), which is
// exactly what forces those two into the explicit-marker path.

// Reads the RAW saved marker list, not the merged one -- a config written
// before migrations existed has no `migrations` key at all, and merging would
// hand it the default (which lists every migration as done) and skip the very
// work it needs.
function applyMigrations(out, saved) {
  const already = Array.isArray(saved && saved.migrations) ? saved.migrations : [];
  if (!already.includes(PHYSICAL_ANCHOR_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStalePhysicalAnchor(out.profiles[lg]);
  }
  if (!already.includes(SLIDE_SCALE_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStaleSlideSpread(out.profiles[lg]);
  }
  if (!already.includes(SKILL_WEIGHTS_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStaleSkillStrength(out.profiles[lg]);
  }
  if (!already.includes(SMALL_PHYSICAL_HIT_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStalePhysicalAnchor(out.profiles[lg]);
  }
  if (!already.includes(SPEED_REALISM_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) {
      upgradeStalePhysicalAnchor(out.profiles[lg]);
      upgradeStaleHbStrength(out.profiles[lg]);
    }
  }
  if (!already.includes(TE_BOOST_REMOVAL_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStaleTeStrength(out.profiles[lg]);
  }
  if (!already.includes(TE_HALF_BOOST_MIGRATION)) {
    for (const lg of ['nfl', 'ufl']) upgradeStaleTeHalfBoost(out.profiles[lg]);
  }
  out.migrations = [...new Set([...already, ...ALL_MIGRATIONS])];
  return out;
}

function mergeConfig(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!saved || typeof saved !== 'object') return out;

  mergeInto(out, saved, SESSION_KEYS);

  if (saved.profiles && typeof saved.profiles === 'object') {
    for (const lg of ['nfl', 'ufl']) {
      mergeInto(out.profiles[lg], saved.profiles[lg], TUNING_KEYS);
    }
    return applyMigrations(out, saved);
  }

  // Legacy flat shape -- migrate. Both profiles start from the same shared
  // values a flat config always had...
  mergeInto(out.profiles.nfl, saved, TUNING_KEYS);
  mergeInto(out.profiles.ufl, saved, TUNING_KEYS);
  // ...`legacy` didn't exist as its own section -- it was carved out of the
  // old shared `general` block, so pull those four fields from there.
  mergeInto(out.profiles.nfl, { legacy: saved.general }, ['legacy']);
  mergeInto(out.profiles.ufl, { legacy: saved.general }, ['legacy']);
  // ...then the UFL profile's actual historical divergence, if present, from
  // the old `ufl` override block -- this is what makes the migration
  // reproduce a pre-existing UFL setup exactly rather than resetting it to
  // fresh UFL defaults.
  const oldUfl = saved.ufl;
  if (oldUfl && typeof oldUfl === 'object') {
    if (oldUfl.powerCurveGlobalStrength !== undefined) {
      out.profiles.ufl.powerCurve.globalStrength = oldUfl.powerCurveGlobalStrength;
    }
    if (oldUfl.diceRollDebuff !== undefined) {
      out.profiles.ufl.diceRoll.debuff = oldUfl.diceRollDebuff;
    }
    if (oldUfl.overallBoostEnabled !== undefined) {
      out.profiles.ufl.overallBoost.enabled = oldUfl.overallBoostEnabled;
    }
    if (oldUfl.overallBoostPoints !== undefined) {
      out.profiles.ufl.overallBoost.points = oldUfl.overallBoostPoints;
    }
    if (oldUfl.devTraits) {
      out.profiles.ufl.devTraits = { ...out.profiles.ufl.devTraits, ...oldUfl.devTraits };
    }
  }
  // Legacy flat configs predate every migration by definition.
  return applyMigrations(out, saved);
}

// Flattens the canonical (session + profiles) shape into the FLAT view
// pipeline.js's math and the renderer's UI expect -- session keys plus the
// selected league's tuning keys, all at the top level, exactly the shape
// this app used before per-league profiles existed. `leagueOverride` lets a
// caller flatten a SPECIFIC league regardless of what `config.league` says
// (e.g. previewing the other league without switching the live config to
// it); omit it to use `config.league` as normal.
function activeConfig(config, leagueOverride) {
  const lg = (leagueOverride || config.league) === 'ufl' ? 'ufl' : 'nfl';
  const { profiles, ...session } = config;
  const flat = { ...session, league: lg, ...(profiles ? profiles[lg] : {}) };
  // Defensive deep clone -- the spread above only copies TOP-LEVEL keys;
  // each tuning key's own value (diceRoll, powerCurve, ...) is still the
  // SAME object `config` held, not a copy. Every caller that gets `config`
  // from mergeConfig() is already safe (mergeConfig clones DEFAULT_CONFIG
  // fresh every call), but flatConfigAndDefaults() in main.js flattens the
  // raw DEFAULT_CONFIG module singleton directly for the `defaults` field --
  // without this, any future code that mutated a returned defaults object
  // in place (renderer.js's own convention today is careful never to, always
  // JSON-cloning out of META.defaults first, but that's a discipline, not a
  // guarantee) would silently corrupt the shared default for the rest of the
  // app's process lifetime. One JSON round-trip on a small config object,
  // not a hot path -- cheap insurance.
  return JSON.parse(JSON.stringify(flat));
}

// The inverse of activeConfig: folds a FLAT config (session keys + one
// league's tuning keys at the top level -- what the renderer edits and
// submits) into the correct profile of a canonical (session + profiles)
// config, leaving the OTHER profile untouched. Used when persisting renderer
// edits, so editing UFL's settings can never clobber NFL's (or vice versa).
function foldIntoProfile(canonical, flatConfig) {
  const lg = flatConfig.league === 'ufl' ? 'ufl' : 'nfl';
  const next = JSON.parse(JSON.stringify(canonical));
  mergeInto(next, flatConfig, SESSION_KEYS);
  mergeInto(next.profiles[lg], flatConfig, TUNING_KEYS);
  return next;
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
  defaultNflProfile,
  defaultUflProfile,
  TUNING_KEYS,
  SESSION_KEYS,
  // Exported so tests/fixtures can declare themselves fully migrated without
  // hardcoding a marker list that silently rots every time one is added.
  ALL_MIGRATIONS,
  mergeConfig,
  activeConfig,
  foldIntoProfile,
  classifyConfigFile,
  isSchemaVersionCompatible,
  splitKnownTuningKeys,
  CONFIG_SCHEMA_VERSION,
  MIN_CLASS_SIZE,
  enforceMinClassSize,
};
