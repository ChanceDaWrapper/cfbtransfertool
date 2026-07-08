// The CFB -> Madden draft-class pipeline, refactored out of the original
// CLI tool (apply_to_career_file.js in "CFB to Madden Draft Converter") so
// it can be driven by a GUI instead of readline prompts. Same three steps:
// extract who's leaving CFB, calibrate their ratings to Madden's scale,
// then overwrite the franchise's incoming rookie class with them.
//
// Every exported function takes a `log(msg)` callback instead of writing to
// console directly, so the Electron renderer can stream progress into a UI
// log panel.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Madden 26's CharacterVisuals blob is zstd-compressed. madden-franchise
// reads it via a bundled native decoder, but WRITING it needs
// zlib.zstdCompressSync, which only exists on Node >= 22. Polyfill it with
// the same native zstd package (its Encoder) so the visuals blob -- and
// thus each player's skinTone -- can be re-saved on older Node too.
const zlib = require('zlib');
if (typeof zlib.zstdCompressSync !== 'function') {
  try {
    const { Encoder } = require('@toondepauw/node-zstd');
    const _enc = new Encoder(3);
    zlib.zstdCompressSync = (buf) => _enc.encodeSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (e) {
    // Caller's log() isn't available yet at module load time; surface this
    // the first time writeCareerFile actually runs instead.
  }
}

const FranchiseFile = require('madden-franchise');

const PROJECT = path.join(__dirname, '..');
const CFB_SCHEMA_GZ = path.join(PROJECT, 'schema', 'CFB27_schema.gz');
const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

// Default save-game folders for the two games, resolved for whatever machine
// this runs on. Windows often redirects Documents into OneDrive, so check
// both; first one that exists wins. Used only to pre-fill the native file
// dialog's starting directory.
function firstExistingDir(candidates) {
  for (const c of candidates) { try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* skip */ } }
  return null;
}
const HOME = os.homedir();
function defaultCfbSavesDir() {
  return firstExistingDir([
    path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves'),
    path.join(HOME, 'OneDrive', 'Documents', 'EA SPORTS College Football 27', 'saves'),
  ]);
}
function defaultMaddenSavesDir() {
  return firstExistingDir([
    path.join(HOME, 'Documents', 'Madden NFL 26', 'Saves'),
    path.join(HOME, 'OneDrive', 'Documents', 'Madden NFL 26', 'Saves'),
  ]);
}

// ===========================================================================
// Step 1: extract who's leaving CFB
// ===========================================================================

function decodeWeight(raw) {
  return typeof raw === 'number' ? raw + 160 : raw;
}

function extractSkinTone(genericHeadAssetName, plyrGenericHead) {
  if (typeof genericHeadAssetName === 'string') {
    const m = genericHeadAssetName.match(/_[A-Z]+_(\d)_\d+$/);
    if (m) return Number(m[1]);
  }
  if (typeof plyrGenericHead === 'string') {
    const m = plyrGenericHead.match(/^(\d)_[A-Z]+_/);
    if (m) return Number(m[1]);
  }
  return '';
}

const CFB_BIO_FIELDS = [
  'FirstName', 'LastName', 'Position', 'JerseyNum',
  'SchoolYear', 'RedshirtStatus', 'Age', 'Height', 'Weight',
  'PLYR_HOME_TOWN', 'PLYR_HOME_STATE', 'OverallRating', 'TraitDevelopment',
];

// Points per CFB27 PlayerAward.AwardType, summed across a player's whole
// college career. Tiered so a Heisman/national Player of the Year dominates,
// a single weekly conference honor barely registers -- most of the 224-ish
// leaving players will have picked up at least one minor award over 3-4
// years, so the tiering (not just "has an award or not") is what keeps this
// meaningful instead of flattening the whole class.
const AWARD_TIER_WEIGHTS = {
  HEISMAN: 8,
  BEST_PLAYER: 7, BEST_POTY: 7,
  BEST_QB: 6, BEST_RB: 6, BEST_REC: 6, BEST_TE: 6, BEST_C: 6,
  BEST_DL: 6, BEST_DE: 6, BEST_IL: 6, BEST_LB: 6, BEST_DB: 6,
  BEST_DEF_1: 6, BEST_DEF_2: 5,
  BEST_KICK: 5, BEST_PUNT: 5, BEST_SR_QB: 5,
  ALL_AM_1ST: 5,
  BEST_SR: 4, BEST_FRESHMAN_POTY: 4,
  ALL_AM_1ST_PRE: 3, MOST_VERSATILE: 3, ALL_AM_2ND: 3,
  ALL_AM_1ST_CONF: 2, ALL_AM_2ND_PRE: 2, ALL_AM_FR: 2,
  ALL_AM_1ST_PRE_CONF: 1.5,
  ALL_AM_2ND_CONF: 1, ALL_AM_2ND_PRE_CONF: 1,
  Offensive_Player_of_Week: 1, Defensive_Player_of_Week: 1,
  BEST_ACADEMIC: 1,
  ALL_AM_FR_CONF: 0.5,
  Offensive_Player_of_Week_Conf: 0.5, Defensive_Player_of_Week_Conf: 0.5,
  __default: 0.5, // any award type not listed above still counts a little
};

async function extractLeavingPlayers(cfbSavePath, log = () => {}) {
  let cfbFile;
  try {
    cfbFile = await FranchiseFile.create(cfbSavePath, {
      schemaOverride: { major: 468, minor: 2, path: CFB_SCHEMA_GZ },
      gameYearOverride: 27, autoUnempty: true,
    });
  } catch (e) {
    throw new Error(
      `Could not open "${cfbSavePath}" as a CFB 27 dynasty save (${e.message}). `
      + `Make sure you picked a CFB 27 save file, not a Madden save or something else.`
    );
  }

  const lp = cfbFile.getAllTablesByName('LeavingPlayer')[0];
  if (!lp) {
    throw new Error(
      `"${cfbSavePath}" opened, but it has no LeavingPlayer table -- this isn't a CFB 27 dynasty save `
      + `(did you pick a Madden save by mistake?).`
    );
  }
  await lp.readRecords();
  const entries = lp.records.filter((r) => !r.isEmpty);
  if (!entries.length) {
    throw new Error(
      'LeavingPlayer table is empty in this save -- wrong stage? '
      + 'Use the save taken right at the players-leaving/pre-draft point.'
    );
  }

  const teamTables = cfbFile.getAllTablesByName('Team');
  const teamTable = teamTables.reduce((best, t) =>
    t.header.recordCapacity > (best ? best.header.recordCapacity : 0) ? t : best, null);
  await teamTable.readRecords();
  const teamNameByIndex = {};
  for (const r of teamTable.records) {
    if (r.isEmpty) continue;
    teamNameByIndex[r.getValueByKey('TeamIndex')] = r.getValueByKey('DisplayName');
  }

  const playerSchema = cfbFile.schemaList.getSchema('Player');
  const ratingFields = playerSchema.attributes
    .filter((a) => a.type === 'int' && /Rating$/.test(a.name))
    .map((a) => a.name);

  // Career awards (Heisman, All-American, Player of the Week, ...) feed the
  // draft-order "Awards Weight" knob later. Summed across every season the
  // table has for a player -- a 4-year decorated college career should
  // outweigh a single flashy season, same as it does for real draft boards.
  const awardScoreByPlayerKey = {};
  const awardsTable = cfbFile.getAllTablesByName('PlayerAward')[0];
  if (awardsTable) {
    await awardsTable.readRecords();
    for (const r of awardsTable.records) {
      if (r.isEmpty) continue;
      let ref, type;
      try { ref = r.getReferenceDataByKey('Player'); type = r.getValueByKey('AwardType'); } catch (e) { continue; }
      if (!ref) continue;
      const key = `${ref.tableId}:${ref.rowNumber}`;
      const points = AWARD_TIER_WEIGHTS[type] ?? AWARD_TIER_WEIGHTS.__default;
      awardScoreByPlayerKey[key] = (awardScoreByPlayerKey[key] || 0) + points;
    }
  }

  const rows = [];
  let skipped = 0;
  let duplicates = 0;
  const seenPlayers = new Set();
  for (const entry of entries) {
    let playerRef;
    try { playerRef = entry.getReferenceDataByKey('Player'); } catch (e) { skipped++; continue; }
    if (!playerRef) { skipped++; continue; }
    const playerKey = `${playerRef.tableId}:${playerRef.rowNumber}`;
    if (seenPlayers.has(playerKey)) { duplicates++; continue; }
    seenPlayers.add(playerKey);

    const pt = cfbFile.getTableById(playerRef.tableId);
    await pt.readRecords();
    const prec = pt.records[playerRef.rowNumber];
    if (!prec || prec.isEmpty) { skipped++; continue; }

    const first = safe(prec, 'FirstName'), last = safe(prec, 'LastName');
    if (!first && !last) { skipped++; continue; }

    const teamIndex = safe(prec, 'TeamIndex');
    const row = {
      FormerTeam: teamNameByIndex[teamIndex] ?? '',
      FormerTeamIndex: teamIndex,
      ProjectRound: safe(entry, 'ProjectRound'),
      LeaveType: safe(entry, 'LeaveType'),
      SkinTone: extractSkinTone(safe(prec, 'GenericHeadAssetName'), safe(prec, 'PLYR_GENERICHEAD')),
      AwardsScore: awardScoreByPlayerKey[playerKey] || 0,
    };
    for (const field of CFB_BIO_FIELDS) {
      try { row[field] = prec.getValueByKey(field); } catch (e) { row[field] = ''; }
    }
    row.Weight = decodeWeight(row.Weight);
    for (const field of ratingFields) {
      try { row[field] = prec.getValueByKey(field); } catch (e) { row[field] = ''; }
    }
    rows.push(row);
  }

  log(`LeavingPlayer entries: ${entries.length} | decoded: ${rows.length} | skipped: ${skipped} | duplicate entries removed: ${duplicates}`);
  return rows;
}

// ===========================================================================
// Step 2: calibrate ratings to Madden scale
// ===========================================================================

const { DEFAULT_CONFIG, mergeConfig } = require('./defaults');

// Seedable mulberry32 PRNG -- same seed always produces the same sequence
// (reproducible classes), blank seed falls back to Math.random (genuinely
// fresh every call, which is what makes regenerating produce variation).
function makeSeededRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  let a = 0;
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bellCurveExtraDrop(percentile, cfg) {
  const spread = percentile >= cfg.bell.peakPercentile ? cfg.bell.spreadAbove : cfg.bell.spreadBelow;
  const distance = percentile - cfg.bell.peakPercentile;
  return cfg.general.dropLeniency * cfg.bell.peakExtraDrop * Math.exp(-(distance ** 2) / (2 * spread ** 2));
}

const PHYSICAL_RATINGS = new Set([
  'SpeedRating', 'AccelerationRating', 'AgilityRating', 'ChangeOfDirectionRating',
  'StaminaRating', 'StrengthRating', 'JumpingRating', 'ThrowPowerRating',
  'KickPowerRating',
  'InjuryRating', 'ToughnessRating', 'CarryingRating',
]);

const AGI_COD_DELTA_OPTIONS = [-3, -2, -1, 0, 1, 2, 3, 4, 5];
const AGI_COD_DELTA_WEIGHTS = [2, 4, 6, 10, 14, 14, 12, 10, 8];

const AGE_OFFSETS = [-1, 0, 1, 2];
const AGE_WEIGHTS = [5, 55, 35, 5];

const SCHOOL_YEAR_BASE_AGE = { Freshman: 19, Sophomore: 20, Junior: 21, Senior: 22 };

const RATING_NAMES = [
  'AccelerationRating', 'AgilityRating', 'AwarenessRating',
  'BCVisionRating', 'BlockSheddingRating', 'BreakSackRating',
  'BreakTackleRating', 'CarryingRating', 'CatchingRating',
  'CatchInTrafficRating', 'ChangeOfDirectionRating',
  'FinesseMovesRating', 'HitPowerRating', 'ImpactBlockingRating',
  'InjuryRating', 'JukeMoveRating', 'JumpingRating',
  'KickAccuracyRating', 'KickPowerRating', 'KickReturnRating',
  'LeadBlockRating', 'LongSnapRating',
  'ManCoverageRating', 'PassBlockFinesseRating',
  'PassBlockPowerRating', 'PassBlockRating', 'PersonalityRating',
  'PlayActionRating', 'PlayRecognitionRating', 'PowerMovesRating',
  'PressRating', 'PursuitRating', 'ReleaseRating',
  'DeepRouteRunningRating', 'MediumRouteRunningRating',
  'ShortRouteRunningRating', 'RunBlockFinesseRating',
  'RunBlockPowerRating', 'RunBlockRating',
  'SpectacularCatchRating', 'SpeedRating', 'SpinMoveRating',
  'StaminaRating', 'StiffArmRating', 'StrengthRating',
  'TackleRating', 'ThrowAccuracyDeepRating', 'ThrowAccuracyMidRating',
  'ThrowAccuracyShortRating',
  'ThrowOnTheRunRating', 'ThrowPowerRating',
  'ThrowUnderPressureRating', 'ToughnessRating',
  'TruckingRating', 'ZoneCoverageRating',
];

function weightedChoice(rng, options, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
}
function uniform(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

function computeAge(row, rng) {
  let base = SCHOOL_YEAR_BASE_AGE[row.SchoolYear] ?? 22;
  if (row.RedshirtStatus === 'Previous') base += 1;
  const offset = weightedChoice(rng, AGE_OFFSETS, AGE_WEIGHTS);
  return Math.max(19, Math.min(26, base + offset));
}

function loadCalibration() {
  const flatDrops = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'position_calibration.json'), 'utf-8'));
  const quantiles = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'quantile_calibration.json'), 'utf-8'));
  return { flatDrops, quantiles };
}

// Per-position formula (intercept + weighted sum of specific ratings) that
// estimates what Madden's own Overall Rating would be for a set of ratings.
// Fit directly from data/real_draft_classes.json -- 1,768 real Madden
// players decoded from actual draft-class files, each with both its full
// rating set and its real in-game OverallRating -- via ridge regression
// restricted to the ratings that plausibly matter for each position (see
// tools/fit_overall_formula.js in the CLI project for how this was built).
// R^2 per position is 0.87-0.996 for 21 of 22 positions; LS is a known weak
// fit (0.09) because LongSnapRating is a flat constant in the source data,
// leaving Strength/Awareness alone unable to explain much of LS's already
// narrow real range (65-75) -- treat LS's estimate as rougher than the rest.
let OVERALL_FORMULA = null;
function loadOverallFormula() {
  if (!OVERALL_FORMULA) {
    OVERALL_FORMULA = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'overall_formula.json'), 'utf-8'));
  }
  return OVERALL_FORMULA;
}

function estimateMaddenOverall(position, ratings) {
  const formula = loadOverallFormula()[position];
  if (!formula) return null;
  let ovr = formula.intercept;
  for (const [rating, coef] of Object.entries(formula.coefficients)) {
    ovr += (Number(ratings[rating]) || 0) * coef;
  }
  return Math.max(40, Math.min(99, Math.round(ovr)));
}

function cfbPercentile(cfbValue, cfbSorted) {
  const n = cfbSorted.length;
  if (n <= 1) return 0.5;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cfbSorted[mid] < cfbValue) lo = mid + 1; else hi = mid;
  }
  const idx = Math.max(0, Math.min(n - 1, lo));
  return idx / (n - 1);
}

function quantileMap(percentile, realSorted) {
  const m = realSorted.length;
  const realIdx = percentile * (m - 1);
  const lo = Math.floor(realIdx);
  const hi = Math.min(lo + 1, m - 1);
  const frac = realIdx - lo;
  return realSorted[lo] * (1 - frac) + realSorted[hi] * frac;
}

function makeRatingAdjuster(position, flatDrops, quantiles, rng, cfg) {
  const posDrops = flatDrops[position] || {};
  const posQuantiles = quantiles[position] || {};
  const extraDrop = Number(cfg.positionExtraDrop[position]) || 0;
  const leniency = cfg.general.dropLeniency;

  return function adjust(ratingName, cfbValue) {
    if (PHYSICAL_RATINGS.has(ratingName)) {
      const adj = cfg.ratingAdjustments[ratingName] || {};
      const baseDrop = (posDrops[ratingName] ?? cfg.general.defaultDrop) * leniency;
      const ratingExtra = Number(adj.extraDrop) || 0;
      const jitterWidth = adj.jitter !== null && adj.jitter !== undefined && adj.jitter !== ''
        ? Number(adj.jitter) : cfg.general.calibrationJitter;
      let drop = baseDrop + extraDrop + ratingExtra + uniform(rng, -jitterWidth, jitterWidth);
      if (adj.maxDrop !== null && adj.maxDrop !== undefined && adj.maxDrop !== '') {
        drop = Math.min(drop, Number(adj.maxDrop));
      }
      drop = Math.max(0, drop);
      return Math.max(0, Math.min(99, Math.round(cfbValue - drop)));
    }

    const mapping = posQuantiles[ratingName];
    let mapped, percentile;
    if (!mapping) {
      mapped = cfbValue;
      percentile = 0.5;
    } else {
      const [cfbSorted, realSorted] = mapping;
      percentile = cfbPercentile(cfbValue, cfbSorted);
      mapped = quantileMap(percentile, realSorted);
    }
    mapped -= bellCurveExtraDrop(percentile, cfg);
    mapped -= extraDrop;
    mapped += uniform(rng, -cfg.general.quantileJitter, cfg.general.quantileJitter);
    if ((position === 'K' || position === 'P') && ratingName === 'AwarenessRating') {
      mapped = Math.min(mapped, cfg.kpAwarenessCap);
    }
    return Math.max(0, Math.min(99, Math.round(mapped)));
  };
}

// Measurables that plausibly make a position's "athletic freak" -- checked
// against a player's own position group, not the whole class, since a 235lb
// frame means something completely different for a QB than a DT. Height and
// Weight are on every row already (CFB_BIO_FIELDS); the rest are ratings.
const MEASURABLE_TRAITS = {
  QB: ['SpeedRating', 'ThrowPowerRating', 'Height', 'Weight'],
  HB: ['SpeedRating', 'AccelerationRating', 'Height', 'Weight'],
  FB: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  WR: ['SpeedRating', 'JumpingRating', 'Height', 'Weight'],
  TE: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  LT: ['StrengthRating', 'Height', 'Weight'], RT: ['StrengthRating', 'Height', 'Weight'],
  LG: ['StrengthRating', 'Height', 'Weight'], RG: ['StrengthRating', 'Height', 'Weight'],
  C: ['StrengthRating', 'Height', 'Weight'],
  LE: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'], RE: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  DT: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  LOLB: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  ROLB: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  MLB: ['SpeedRating', 'StrengthRating', 'Height', 'Weight'],
  CB: ['SpeedRating', 'JumpingRating', 'Height', 'Weight'],
  FS: ['SpeedRating', 'JumpingRating', 'Height', 'Weight'], SS: ['SpeedRating', 'JumpingRating', 'Height', 'Weight'],
  K: ['KickPowerRating'], P: ['KickPowerRating'],
  LS: ['StrengthRating'],
};

// Z-score of each player's measurables against everyone else AT THEIR
// POSITION in this same pool -- averaged across that position's traits and
// clamped so one freakish 99-speed outlier can't single-handedly dominate.
// Generic over field naming so it works both on raw CFB rows (Position,
// plain rating names, used for draft-order slotting) and final calibrated
// rows (CFB_Position, Madden_-prefixed rating names, used for dev-trait
// assignment) via the two accessor functions.
function computeAthleticismZScores(rows, getPosition, getTraitValue) {
  const byPosition = {};
  for (const r of rows) (byPosition[getPosition(r)] ??= []).push(r);

  const zByRow = new Map();
  for (const [pos, group] of Object.entries(byPosition)) {
    const traits = MEASURABLE_TRAITS[pos];
    if (!traits || group.length < 2) { for (const r of group) zByRow.set(r, 0); continue; }

    const stats = traits.map((t) => {
      const vals = group.map((r) => Number(getTraitValue(r, t)) || 0);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return { trait: t, mean, stdev: Math.sqrt(variance) || 1 };
    });

    for (const r of group) {
      const zs = stats.map((s) => (Number(getTraitValue(r, s.trait)) - s.mean) / s.stdev);
      const avgZ = zs.reduce((a, b) => a + b, 0) / zs.length;
      zByRow.set(r, Math.max(-2.5, Math.min(2.5, avgZ)));
    }
  }
  return zByRow;
}

const rawAthleticismAccessors = [(r) => r.Position, (r, t) => r[t]];
const calibratedAthleticismAccessors = [
  (r) => r.CFB_Position,
  (r, t) => (t === 'Height' || t === 'Weight' ? r[t] : r[`Madden_${t}`]),
];

function selectDeparted(rows, count, positionCaps, cfg) {
  const dv = cfg.draftValue || {};
  const posValue = cfg.positionValue || {};
  const athleticZ = computeAthleticismZScores(rows, ...rawAthleticismAccessors);

  const draftScore = (r) => {
    const round = Math.max(1, Math.min(8, Number(r.ProjectRound) || 8));
    const roundBonus = (8 - round) * (dv.roundWeight ?? 1);
    const posBonus = (posValue[r.Position] || 0) * (dv.positionValueWeight ?? 1);
    const awardsBonus = (Number(r.AwardsScore) || 0) * (dv.awardsWeight ?? 0.5);
    const athleticBonus = (athleticZ.get(r) || 0) * (dv.athleticismWeight ?? 2);
    return Number(r.OverallRating) + roundBonus + posBonus + awardsBonus + athleticBonus;
  };

  const sorted = rows.slice().sort((a, b) => draftScore(b) - draftScore(a));

  const selected = [];
  const posCounts = {};
  for (const r of sorted) {
    const pos = r.Position;
    const cap = Number(positionCaps[pos]);
    if (cap > 0) {
      if ((posCounts[pos] || 0) >= cap) continue;
      posCounts[pos] = (posCounts[pos] || 0) + 1;
    }
    selected.push(r);
    if (selected.length >= count) break;
  }
  if (!selected.length) {
    throw new Error('No players to select from -- the CFB extraction returned nothing.');
  }
  return selected;
}

function calibratePlayers(departedRows, { config, log = () => {} } = {}) {
  const cfg = mergeConfig(config);
  const rng = makeSeededRng(cfg.general.seed);

  const players = selectDeparted(departedRows, cfg.general.classSize, cfg.positionCaps, cfg);
  log(`  loaded top ${players.length} by draft score (overall + round + awards + athleticism + position value)`);

  const { flatDrops, quantiles } = loadCalibration();
  log(`  loaded flat-drop calibration for ${Object.keys(flatDrops).length} positions, `
    + `quantile calibration for ${Object.keys(quantiles).length} positions`);

  const preview = [];
  for (const player of players) {
    const age = computeAge(player, rng);
    const height = Math.max(65, Math.min(82, Number(player.Height)));
    const realWeight = Math.max(160, Math.min(415, Number(player.Weight)));
    const jersey = Math.max(0, Math.min(99, Number(player.JerseyNum) || 0));
    const cfbOvr = Number(player.OverallRating);

    const adjust = makeRatingAdjuster(player.Position, flatDrops, quantiles, rng, cfg);
    const writtenRatings = {};
    let agilityFinal = null;
    for (const name of RATING_NAMES) {
      const cfbVal = player[name];
      if (cfbVal === null || cfbVal === undefined || cfbVal === '') continue;
      let val;
      if (name === 'ChangeOfDirectionRating' && agilityFinal !== null) {
        const delta = weightedChoice(rng, AGI_COD_DELTA_OPTIONS, AGI_COD_DELTA_WEIGHTS);
        val = Math.max(0, Math.min(99, agilityFinal - delta));
      } else {
        val = adjust(name, Number(cfbVal));
        if (name === 'AgilityRating') agilityFinal = val;
      }
      writtenRatings[name] = val;
    }

    const row = {
      FirstName: player.FirstName, LastName: player.LastName,
      CFB_Position: player.Position, FormerTeam: player.FormerTeam || '',
      CFB_Overall: cfbOvr, ProjectRound: player.ProjectRound || '',
      Age: age, Height: height, Weight: realWeight, Jersey: jersey,
      SkinTone: player.SkinTone || '',
      TraitDevelopment: player.TraitDevelopment || '',
      AwardsScore: Number(player.AwardsScore) || 0,
    };
    for (const [k, v] of Object.entries(writtenRatings)) row[`Madden_${k}`] = v;
    row.EstMaddenOverall = estimateMaddenOverall(player.Position, writtenRatings);
    preview.push(row);
  }

  return preview;
}

// ===========================================================================
// Step 3: write into the Madden career file
// ===========================================================================

const POSITION_ARCHETYPE = {
  QB: 'QB_Scrambler', HB: 'HB_ElusiveBack', FB: 'FB_Utility', WR: 'WR_Playmaker', TE: 'TE_VerticalThreat',
  LT: 'OT_Agile', LG: 'G_Power', C: 'C_Agile', RG: 'G_Power', RT: 'OT_Power',
  LE: 'DE_SmallerSpeedRusher', RE: 'DE_SmallerSpeedRusher', DT: 'DT_NoseTackle',
  LOLB: 'OLB_RunStopper', MLB: 'MLB_RunStopper', ROLB: 'OLB_RunStopper',
  CB: 'CB_Zone', FS: 'S_Zone', SS: 'S_Zone', K: 'KP_Power', P: 'KP_Power', LS: 'LS_Accurate',
};

// Real Madden classes don't hand Superstar/X-Factor strictly to the top N
// players by overall -- a similarly-graded prospect can get it instead, or
// skip it, and that varies if you were to generate the "same" class twice.
// So this is a WEIGHTED RANDOM draw (without replacement) per tier, not a
// sorted cut: overall is still the dominant factor (weight grows steeply
// with it), athleticism and career awards nudge it further, and CFB's own
// TraitDevelopment tier gives a big-but-not-absolute boost (a College_Elite
// prospect is very likely to land Star, but if the Star quota is smaller
// than the number of College_Elite players in the class, some of them lose
// the roll and end up Normal instead -- there's no guarantee overriding the
// target counts). Target *counts* stay anchored to the percentage configs
// exactly like before; only *which* players fill them is randomized.
const CFB_TIER_WEIGHT_BOOST = {
  College_Elite: 40,
  College_Star: 6,
  College_Impact: 2,
};

function devTraitWeight(p, athleticZ) {
  const ovr = Number(p.EstMaddenOverall) || Number(p.CFB_Overall) || 50;
  // Exponential growth so the top of the class dominates the odds without
  // making it a guarantee -- each extra point of overall multiplies a
  // player's odds by about 25%, so a big gap is a strong favorite but a
  // 1-2 point gap between neighbors is a close roll, not a foregone one.
  let w = Math.exp((ovr - 60) * 0.22);
  const z = athleticZ.get(p) || 0; // -2.5..2.5, clamps its own influence
  w *= 1 + Math.max(-0.3, Math.min(0.3, z * 0.15));
  const awards = Number(p.AwardsScore) || 0;
  w *= 1 + Math.min(0.3, awards * 0.015);
  w *= CFB_TIER_WEIGHT_BOOST[p.TraitDevelopment] || 1;
  return Math.max(1e-9, w);
}

// Draws exactly k items from candidates without replacement, with
// probability roughly proportional to weight -- via log-space keys
// (Efraimidis-Spirakis "A-Res": key = ln(rng()) / weight, keep the k
// largest). Never calls Math.pow, so it can't hit the float-underflow tie
// bug an earlier weighted-pull implementation in this project had at large
// weight values; log-space stays numerically stable at any magnitude.
function weightedSampleWithoutReplacement(candidates, k, weightFn, rng) {
  if (k <= 0 || !candidates.length) return [];
  const keyed = candidates.map((p) => ({ p, key: Math.log(rng()) / weightFn(p) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, k).map((x) => x.p);
}

function assignDevTraits(players, config) {
  const cfg = mergeConfig(config);
  // Its own fresh RNG (not shared with calibratePlayers' rating jitter) so
  // dev traits reroll independently every generation with a blank seed, but
  // still reproduce identically with a fixed one, same as everything else.
  const rng = makeSeededRng(cfg.general.seed);
  const athleticZ = computeAthleticismZScores(players, ...calibratedAthleticismAccessors);
  const weight = (p) => devTraitWeight(p, athleticZ);

  const traitOf = new Map();
  let remaining = players;

  const xfactorTarget = Math.round(players.length * (cfg.devTraits.xfactorPercentTarget / 100));
  for (const p of weightedSampleWithoutReplacement(remaining, xfactorTarget, weight, rng)) traitOf.set(p, 'XFactor');
  remaining = remaining.filter((p) => !traitOf.has(p));

  const superstarTarget = Math.round(players.length * (cfg.devTraits.superstarPercentTarget / 100));
  for (const p of weightedSampleWithoutReplacement(remaining, superstarTarget, weight, rng)) traitOf.set(p, 'Superstar');
  remaining = remaining.filter((p) => !traitOf.has(p));

  const starTarget = Math.round(players.length * (cfg.devTraits.starPercentTarget / 100));
  for (const p of weightedSampleWithoutReplacement(remaining, starTarget, weight, rng)) traitOf.set(p, 'Star');

  for (const p of players) {
    if (!traitOf.has(p)) traitOf.set(p, 'Normal');
  }

  return traitOf;
}

const POSITION_TO_PROSPECT_GROUP = {
  QB: 'QB', HB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
  LT: 'OT', RT: 'OT', LG: 'IOL', RG: 'IOL', C: 'IOL',
  LE: 'DE', RE: 'DE', DT: 'DT',
  LOLB: 'OLB', ROLB: 'OLB', MLB: 'MLB',
  CB: 'CB', FS: 'S', SS: 'S',
  K: 'K', P: 'P', LS: 'LS',
};

async function writeCareerFile(inputPath, outputPath, players, log = () => {}) {
  if (typeof zlib.zstdCompressSync !== 'function') {
    log('WARN: zstd write support unavailable; skin tone body-blob update will be skipped (head-code will still be set).');
  }

  const lookup = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'college_lookup.json'), 'utf-8'));
  lookup['NC State'] = lookup['N.C. State'];

  let file;
  try {
    file = await FranchiseFile.create(inputPath, { autoUnempty: true });
  } catch (e) {
    throw new Error(
      `Could not open "${inputPath}" as a Madden 26 franchise save (${e.message}). `
      + `Make sure you picked a Madden 26 career save file, not a CFB save or something else.`
    );
  }
  const t = file.getTableByName('Player');
  if (!t) {
    throw new Error(
      `"${inputPath}" opened, but it has no Player table -- this isn't a Madden 26 franchise save `
      + `(did you pick a CFB save by mistake?).`
    );
  }
  await t.readRecords();

  const validHeads = new Set();
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const h = safe(r, 'GenericHeadAssetName');
    if (typeof h === 'string' && /^gen_\d_/.test(h)) validHeads.add(h);
  }
  const headsBySkin = {};
  for (const h of validHeads) {
    const d = h[4];
    (headsBySkin[d] = headsBySkin[d] || []).push(h);
  }
  function pickValidHead(n, origHead) {
    if (typeof origHead === 'string' && /^gen_\d_/.test(origHead)) {
      const fam = origHead.slice(6);
      const sameFamily = `gen_${n}_${fam}`;
      if (validHeads.has(sameFamily)) return sameFamily;
    }
    const pool = headsBySkin[String(n)];
    if (pool && pool.length) return pool[Math.floor(Math.random() * pool.length)];
    return null;
  }

  const prospects = [];
  t.records.forEach((r, idx) => {
    if (r.isEmpty) return;
    const first = safe(r, 'FirstName'), last = safe(r, 'LastName');
    if (!first && !last) return;
    const yearsPro = safe(r, 'YearsPro');
    const injWeek = safe(r, 'LastYearSeasonEndingInjuryWeek');
    const teamIndex = safe(r, 'TeamIndex');
    const height = safe(r, 'Height');
    const speed = safe(r, 'SpeedRating');
    if (yearsPro === 0 && injWeek === 0 && teamIndex !== null && teamIndex !== undefined && height > 0 && speed > 0) {
      prospects.push({ record: r, idx, pos: safe(r, 'Position'), draftRound: safe(r, 'PLYR_DRAFTROUND'), draftPick: safe(r, 'PLYR_DRAFTPICK') });
    }
  });
  log(`Found ${prospects.length} incoming rookie-class slots to overwrite.`);

  const draftPlayerByPlayerIdx = new Map();
  const dpTable = file.getAllTablesByName('DraftPlayer')[0];
  if (dpTable) {
    await dpTable.readRecords();
    for (const dp of dpTable.records) {
      if (dp.isEmpty) continue;
      let ref;
      try { ref = dp.getReferenceDataByKey('Player'); } catch (e) { continue; }
      if (ref && ref.tableId === t.header.tableId) {
        draftPlayerByPlayerIdx.set(ref.rowNumber, dp);
      }
    }
    log(`DraftPlayer scouting records linked to Player slots: ${draftPlayerByPlayerIdx.size}`);
  } else {
    log('No DraftPlayer table found -- scouting data (rank/grade/position) will not be synced.');
  }

  const UNDRAFTED_ROUND = 8;
  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : UNDRAFTED_ROUND; };
  const playersSorted = players.slice().sort((a, b) =>
    (roundOf(a.ProjectRound) - roundOf(b.ProjectRound)) ||
    (Number(b.CFB_Overall) - Number(a.CFB_Overall)));

  const allSlots = prospects.slice().sort((a, b) => (a.draftRound - b.draftRound) || (a.draftPick - b.draftPick));
  let slotCursor = 0;
  function takeSlot() {
    if (slotCursor >= allSlots.length) return null;
    return allSlots[slotCursor++];
  }

  const ratingCols = Object.keys(players[0]).filter((c) => c.startsWith('Madden_'));
  const canWriteVisuals = typeof zlib.zstdCompressSync === 'function';

  async function setSkinTone(slot, skin) {
    if (!skin) return false;
    const n = Math.max(1, Math.min(8, Number(skin)));
    let ok = false;

    const chosen = pickValidHead(n, safe(slot, 'GenericHeadAssetName'));
    if (chosen) {
      try { slot.GenericHeadAssetName = chosen; slot.PLYR_GENERICHEAD = chosen.slice(4); ok = true; }
      catch (e) { /* skip */ }
    }

    if (canWriteVisuals) {
      try {
        const refData = slot.getReferenceDataByKey('CharacterVisuals');
        if (refData && refData.tableId) {
          const vt = file.getTableById(refData.tableId);
          if (vt) await vt.readRecords();
          const vrec = vt && vt.records[refData.rowNumber];
          const raw = vrec && !vrec.isEmpty ? safe(vrec, 'RawData') : null;
          if (typeof raw === 'string') {
            const obj = JSON.parse(raw);
            obj.skinTone = n;
            vrec.RawData = JSON.stringify(obj);
            ok = true;
          }
        }
      } catch (e) { /* leave existing visuals */ }
    }
    return ok;
  }

  let written = 0, missingCollege = 0, dropped = 0, skinSet = 0, posSet = 0, archSet = 0, devSet = 0, scoutSet = 0;
  for (const [rankIdx, p] of playersSorted.entries()) {
    const target = takeSlot();
    if (!target) { dropped++; continue; }
    const slot = target.record;

    slot.FirstName = p.FirstName;
    slot.LastName = p.LastName;
    try { slot.Position = p.CFB_Position; posSet++; } catch (e) { /* keep slot's position */ }
    const arch = POSITION_ARCHETYPE[p.CFB_Position];
    if (arch) { try { slot.PlayerType = arch; archSet++; } catch (e) { /* keep */ } }
    const dev = p.DevTrait;
    if (dev) { try { slot.TraitDevelopment = dev; devSet++; } catch (e) { /* keep */ } }
    slot.Age = Number(p.Age);
    slot.Height = Number(p.Height);
    slot.Weight = Number(p.Weight) - 160;
    slot.JerseyNum = Number(p.Jersey);

    const collegeVal = lookup[p.FormerTeam];
    if (collegeVal) {
      slot.College = collegeVal;
    } else {
      missingCollege++;
    }

    if (await setSkinTone(slot, p.SkinTone)) skinSet++;

    for (const col of ratingCols) {
      const fieldName = col.slice('Madden_'.length);
      try { slot[fieldName] = Number(p[col]); } catch (e) { /* field not writable, skip */ }
    }

    const dp = draftPlayerByPlayerIdx.get(target.idx);
    if (dp) {
      const rank = rankIdx + 1;
      try {
        const group = POSITION_TO_PROSPECT_GROUP[p.CFB_Position];
        if (group) dp.DraftPosition = group;
        dp.TrueOverallRanking = rank;
        dp.InitialDraftRank = rank;
        dp.ProductionGrade = Math.max(0, Math.min(127, Math.round((Number(p.CFB_Overall) / 99) * 127)));
        scoutSet++;
      } catch (e) { /* leave scouting data as-is */ }
    }

    written++;
  }

  log(`Players written into rookie slots: ${written}`);
  log(`DraftPlayer scouting records synced: ${scoutSet}`);
  log(`Positions rewritten: ${posSet} | archetypes set: ${archSet} | dev traits set: ${devSet}`);
  log(`Missing college lookups: ${missingCollege}`);
  log(`Skin tones set: ${skinSet}${canWriteVisuals ? '' : ' (head-code only -- zstd write unavailable)'}`);
  log(`CFB players with no slot available (dropped): ${dropped}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await file.save(outputPath);
  log(`Saved franchise file to: ${outputPath}`);

  return { written, missingCollege, dropped, skinSet, posSet, archSet, devSet, scoutSet };
}

// ===========================================================================
// Top-level entry points for the GUI
// ===========================================================================

// Calibrate + dev traits + final class ordering, all driven by the user's
// config. Returns the full preview the Results page renders: each player
// carries DevTrait and Rank (1 = first pick used when writing).
function generateClass(departedRows, config, log = () => {}) {
  const players = calibratePlayers(departedRows, { config, log });
  log(`  calibrated ${players.length} players`);

  const devTraits = assignDevTraits(players, config);
  for (const p of players) p.DevTrait = devTraits.get(p) || 'Normal';
  const traitCounts = {};
  for (const p of players) traitCounts[p.DevTrait] = (traitCounts[p.DevTrait] || 0) + 1;
  log(`  dev traits: ${Object.entries(traitCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  // Same deterministic order the write step uses to fill draft slots.
  const UNDRAFTED_ROUND = 8;
  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : UNDRAFTED_ROUND; };
  players.sort((a, b) =>
    (roundOf(a.ProjectRound) - roundOf(b.ProjectRound)) ||
    (Number(b.CFB_Overall) - Number(a.CFB_Overall)));
  players.forEach((p, i) => { p.Rank = i + 1; });

  return players;
}

async function runConversion({ cfbPath, maddenPath, outputPath, config }, log = () => {}) {
  log('=== Extracting who is leaving CFB ===');
  const departedRows = await extractLeavingPlayers(cfbPath, log);

  log('=== Generating draft class ===');
  const players = generateClass(departedRows, config, log);

  log('=== Writing CFB players into the career file ===');
  const stats = await writeCareerFile(maddenPath, outputPath, players, log);

  return { departedCount: departedRows.length, calibratedCount: players.length, ...stats };
}

// ===========================================================================
// CSV support -- lets the dashboard accept a previously exported
// departed_players.csv (or compatible roster export) instead of a save file.
// ===========================================================================

function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') { pushField(); pushRow(); }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  if (!rows.length) throw new Error('CSV file is empty.');

  const header = rows[0];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    header.forEach((h, j) => {
      const v = rows[i][j] ?? '';
      obj[h] = v !== '' && !isNaN(v) && v.trim() !== '' ? Number(v) : v;
    });
    out.push(obj);
  }
  return out;
}

function loadDepartedCsv(csvPath, log = () => {}) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  const required = ['FirstName', 'LastName', 'Position', 'OverallRating'];
  const missing = required.filter((c) => !(c in rows[0]));
  if (missing.length) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(', ')}. `
      + `Expected a departed-players export with at least FirstName, LastName, Position, OverallRating.`
    );
  }
  log(`Loaded ${rows.length} players from CSV.`);
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = {
  extractLeavingPlayers,
  calibratePlayers,
  assignDevTraits,
  generateClass,
  writeCareerFile,
  runConversion,
  loadDepartedCsv,
  toCsv,
  defaultCfbSavesDir,
  defaultMaddenSavesDir,
};
