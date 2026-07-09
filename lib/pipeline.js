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

const FranchiseFile = require('madden-franchise');

const PROJECT = path.join(__dirname, '..');
// Full CFB 27 schema (Core+Football+Franchise, major 809). Unlocks the Team
// table's real fields plus SeasonStats/CareerStats -- needed for career
// production weighting and reliable school names. Replaces the old
// Franchise-only 468/2 schema. (Full-schema extraction approach adapted from
// seanpdwyer7/cfb2madden.)
const CFB_SCHEMA_GZ = path.join(PROJECT, 'data', 'schemas', 'CFB27_809_0.gz');
const CFB_SCHEMA_MAJOR = 809;
const CFB_SCHEMA_MINOR = 0;
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

// Primary read: CFB27 encodes skin tone (1-8) directly in the head-asset
// naming. Generic heads: "Generic_1450_P_T0071_H_7_1" -- the digit right
// before the trailing index is the skin tone. Unique heads (recruited/
// scanned players -- most of a roster) don't encode it in
// GenericHeadAssetName, but PLYR_GENERICHEAD still carries it as a leading
// digit ("7_BHM_MG_022") even for those, so this covers both cases.
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

// Fallback for the rare player where neither head-asset field yields a skin
// tone: check their own CharacterVisuals blob for an explicit skinTone
// value. CFB27's CharacterVisuals sub-table wasn't reliably decodable as
// JSON through this schema in testing (came back as a raw bit view for
// every player checked), so this is defensive -- safe to attempt, but not
// something to depend on; the two head-asset fields above cover every
// player actually seen in real saves.
async function extractSkinToneFromVisuals(cfbFile, prec) {
  try {
    const ref = prec.getReferenceDataByKey('CharacterVisuals');
    if (!ref) return '';
    const vt = cfbFile.getTableById(ref.tableId);
    await vt.readRecords();
    const vrec = vt.records[ref.rowNumber];
    if (!vrec || vrec.isEmpty) return '';
    const raw = safe(vrec, 'RawData');
    if (typeof raw !== 'string') return '';
    const obj = JSON.parse(raw);
    const val = obj.skinTone ?? obj.SkinTone;
    return typeof val === 'number' ? val : '';
  } catch (e) {
    return '';
  }
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

// TeamIndex -> school display name. During the offseason the game parks
// departed players on an "FCS ..." placeholder team, so keep both the
// current name and let callers fall back to a player's PrevTeamIndex when
// their current team is that placeholder.
async function buildTeamNames(cfbFile) {
  const teamTables = cfbFile.getAllTablesByName('Team');
  const teamTable = teamTables.reduce((best, t) =>
    t.header.recordCapacity > (best ? best.header.recordCapacity : 0) ? t : best, null);
  const byIndex = {};
  if (!teamTable) return byIndex;
  await teamTable.readRecords();
  for (const r of teamTable.records) {
    if (r.isEmpty) continue;
    try { byIndex[r.getValueByKey('TeamIndex')] = r.getValueByKey('DisplayName'); } catch (e) { /* skip */ }
  }
  return byIndex;
}
function resolveSchool(teamNames, teamIndex, prevTeamIndex) {
  const cur = teamNames[teamIndex];
  if (cur && !String(cur).startsWith('FCS ')) return cur;
  const prev = teamNames[prevTeamIndex];
  if (prev && !String(prev).startsWith('FCS ')) return prev;
  return cur ?? '';
}

// tableId:rowNumber -> summed tiered award score (see AWARD_TIER_WEIGHTS).
async function buildAwardScores(cfbFile) {
  const scores = {};
  const awardsTable = cfbFile.getAllTablesByName('PlayerAward')[0];
  if (!awardsTable) return scores;
  await awardsTable.readRecords();
  for (const r of awardsTable.records) {
    if (r.isEmpty) continue;
    let ref, type;
    try { ref = r.getReferenceDataByKey('Player'); type = r.getValueByKey('AwardType'); } catch (e) { continue; }
    if (!ref) continue;
    const key = `${ref.tableId}:${ref.rowNumber}`;
    scores[key] = (scores[key] || 0) + (AWARD_TIER_WEIGHTS[type] ?? AWARD_TIER_WEIGHTS.__default);
  }
  return scores;
}

// Sum ONE player's SeasonStats[] slots (one slot per season/stat-category)
// into career totals. Lazy + cached: only called for the players actually
// in the class, not the full ~16k-row Player table. Field/table names
// verified against the full 809 schema (adapted from seanpdwyer7/cfb2madden,
// whose full-dynasty run confirmed them). Returns null when the player has
// no stats (e.g. a fresh save before any season is played).
async function aggregatePlayerStats(cfbFile, prec, tableCache) {
  let ssRef;
  try { ssRef = prec.getReferenceDataByKey('SeasonStats'); } catch (e) { return null; }
  if (!ssRef || (ssRef.tableId === 0 && ssRef.rowNumber === 0)) return null;
  const getT = async (id) => {
    if (!tableCache.has(id)) { const t = cfbFile.getTableById(id); if (t) { try { await t.readRecords(); } catch (e) { /* skip */ } } tableCache.set(id, t); }
    return tableCache.get(id);
  };
  const arr = await getT(ssRef.tableId);
  const arrRow = arr && arr.records[ssRef.rowNumber];
  if (!arrRow || arrRow.isEmpty) return null;
  const agg = { passYds: 0, passTds: 0, rushYds: 0, rushTds: 0, recYds: 0, recTds: 0, recCatches: 0, tackles: 0, sacks: 0, ints: 0, games: 0, gamesStarted: 0 };
  const n = arrRow.arraySize ?? 0;
  for (let i = 0; i < n; i++) {
    let slot;
    try { slot = arrRow.getReferenceDataByKey(arrRow.fieldsArray[i]?.key); } catch (e) { continue; }
    if (!slot || (slot.tableId === 0 && slot.rowNumber === 0)) continue;
    const st = await getT(slot.tableId);
    const s = st && st.records[slot.rowNumber];
    if (!s || s.isEmpty) continue;
    const g = (k) => { try { return s.getValueByKey(k) ?? 0; } catch (e) { return 0; } };
    if (st.name.includes('Offensive')) {
      agg.passYds += g('PASSYARDS'); agg.passTds += g('PASSTDS');
      agg.rushYds += g('RUSHYARDS'); agg.rushTds += g('RUSHTDS');
      agg.recYds += g('RECEIVEYARDS'); agg.recTds += g('RECEIVETDS'); agg.recCatches += g('RECEIVECATCHES');
    } else if (st.name.includes('Defensive')) {
      agg.tackles += g('DEFTACKLES') + g('ASSDEFTACKLES');
      agg.sacks += g('DLINESACKS') + g('DLINEHALFSACK') / 2;
      agg.ints += g('DSECINTS');
    }
    agg.games += g('GAMESPLAYED');
    agg.gamesStarted += g('GAMESSTARTED');
  }
  return agg;
}

async function extractLeavingPlayers(cfbSavePath, log = () => {}, opts = {}) {
  const juniorOvrThreshold = opts.juniorOvrThreshold ?? 85;
  const forceSource = opts.forceSource ?? null; // 'leaving' | 'synthesized' | null(auto) -- legacy mode only
  // 'legacy' (default): the original source-detection + selection logic below,
  // unchanged. 'exit': delegate population construction to Rosetta (see
  // lib/rosetta/population.js) -- fixes the Transfer_*-inclusion bug and the
  // dead 'Invalid' filter, and unifies senior detection across dynasty stages.
  const populationMode = opts.populationMode ?? 'legacy';

  let cfbFile;
  try {
    cfbFile = await FranchiseFile.create(cfbSavePath, {
      schemaOverride: { major: CFB_SCHEMA_MAJOR, minor: CFB_SCHEMA_MINOR, gameYear: 27, path: CFB_SCHEMA_GZ },
      gameYearOverride: 27, autoUnempty: true,
    });
  } catch (e) {
    throw new Error(
      `Could not open "${cfbSavePath}" as a CFB 27 dynasty save (${e.message}). `
      + `Make sure you picked a CFB 27 save file, not a Madden save or something else.`
    );
  }

  const playerTable = cfbFile.getTableByName('Player');
  if (!playerTable) {
    throw new Error(
      `"${cfbSavePath}" opened, but it has no Player table -- this isn't a CFB 27 dynasty save `
      + `(did you pick a Madden save by mistake?).`
    );
  }

  const playerSchema = cfbFile.schemaList.getSchema('Player');
  const ratingFields = playerSchema.attributes
    .filter((a) => a.type === 'int' && /Rating$/.test(a.name))
    .map((a) => a.name);

  const teamNames = await buildTeamNames(cfbFile);
  const awardScores = await buildAwardScores(cfbFile);

  const statCache = new Map();
  let selection, source;
  let skipped = 0, duplicates = 0;

  if (populationMode === 'exit') {
    const context = Rosetta.createRosettaContext({
      cfbFile, cfbSavePath, teamNames, log,
      config: { juniorOvrThreshold },
    });
    const result = await Rosetta.run(context);
    selection = result.population;
    // Reuses the existing 'leaving'/'synthesized' source labels so
    // main.js/renderer.js (which read rows.source today) keep working
    // unchanged -- Regime A is the official-declarations case, Regime B is
    // the predicted-underclassmen fallback, same distinction the labels
    // already made.
    source = result.meta.regime === 'A' ? 'leaving' : 'synthesized';
  } else {
    // Decide the source: the game's official LeavingPlayer list when it's
    // populated (the players-leaving / offseason-week-1 stage), otherwise a
    // synthesized pool so earlier-stage dynasties still work. `forceSource`
    // lets the UI override the auto-detection.
    //
    // NOTE: this branch is the pre-Rosetta legacy implementation, kept
    // unchanged and available via populationMode='legacy' (the default)
    // until the 'exit' population mode above is validated. It is known to
    // include Transfer_* entries (its 'Invalid' check compares against the
    // wrong string -- see lib/rosetta/population.js's header comment for the
    // verified enum) and to skip graduating seniors when LeavingPlayer is
    // populated. Do not fix those bugs here; fix them in Rosetta and migrate
    // by flipping the default, per this project's incremental-migration rules.
    const lp = cfbFile.getAllTablesByName('LeavingPlayer')[0];
    let leavingEntries = [];
    if (lp) {
      await lp.readRecords();
      leavingEntries = lp.records.filter((r) => {
        if (r.isEmpty) return false;
        try { return !!r.getReferenceDataByKey('Player') && r.getValueByKey('LeaveType') !== 'Invalid'; }
        catch (e) { return false; }
      });
    }
    const useLeaving = forceSource === 'leaving'
      || (forceSource !== 'synthesized' && leavingEntries.length > 0);
    source = useLeaving ? 'leaving' : 'synthesized';

    await playerTable.readRecords();

    // Build the selection list of { prec, projectRound, leaveType }, deduped
    // by player row (the game can list the same player in LeavingPlayer twice).
    selection = [];
    const seenRows = new Set();

    if (source === 'leaving') {
      for (const entry of leavingEntries) {
        let ref;
        try { ref = entry.getReferenceDataByKey('Player'); } catch (e) { skipped++; continue; }
        if (!ref) { skipped++; continue; }
        if (seenRows.has(ref.rowNumber)) { duplicates++; continue; }
        seenRows.add(ref.rowNumber);
        const prec = playerTable.records[ref.rowNumber];
        if (!prec || prec.isEmpty) { skipped++; continue; }
        selection.push({
          prec,
          projectRound: safe(entry, 'ProjectRound'),
          leaveType: safe(entry, 'LeaveType'),
        });
      }
    } else {
      for (const prec of playerTable.records) {
        if (prec.isEmpty) continue;
        const teamIndex = safe(prec, 'TeamIndex');
        if (!(teamIndex in teamNames)) continue; // FBS rosters only
        const yr = safe(prec, 'SchoolYear');
        const ovr = Number(safe(prec, 'OverallRating')) || 0;
        const dev = safe(prec, 'TraitDevelopment');
        const isSenior = yr === 'Senior';
        const isDraftJunior = yr === 'Junior' && (
          ovr >= juniorOvrThreshold
          || dev === 'College_Elite'
          || (dev === 'College_Star' && ovr >= juniorOvrThreshold - 3)
        );
        if (!isSenior && !isDraftJunior) continue;
        if (seenRows.has(prec.index)) continue;
        seenRows.add(prec.index);
        selection.push({ prec, projectRound: null, leaveType: isSenior ? 'Graduating' : 'Declared' });
      }
    }
  }

  const rows = [];
  for (const { prec, projectRound, leaveType } of selection) {
    const first = safe(prec, 'FirstName'), last = safe(prec, 'LastName');
    if (!first && !last) { skipped++; continue; }

    let skinTone = extractSkinTone(safe(prec, 'GenericHeadAssetName'), safe(prec, 'PLYR_GENERICHEAD'));
    if (skinTone === '') skinTone = await extractSkinToneFromVisuals(cfbFile, prec);

    const teamIndex = safe(prec, 'TeamIndex');
    const school = resolveSchool(teamNames, teamIndex, safe(prec, 'PrevTeamIndex'));
    const playerKey = `${prec.tableId ?? playerTable.header.tableId}:${prec.index}`;
    const row = {
      FormerTeam: school,
      FormerTeamIndex: teamIndex,
      ProjectRound: projectRound,
      LeaveType: leaveType,
      SkinTone: skinTone,
      AwardsScore: awardScores[`${playerTable.header.tableId}:${prec.index}`] || 0,
      CareerStats: await aggregatePlayerStats(cfbFile, prec, statCache),
    };
    for (const field of CFB_BIO_FIELDS) {
      try { row[field] = prec.getValueByKey(field); } catch (e) { row[field] = ''; }
    }
    row.Weight = decodeWeight(row.Weight);
    for (const field of ratingFields) {
      try { row[field] = prec.getValueByKey(field); } catch (e) { row[field] = ''; }
    }
    // Canonical Rosetta identity (see lib/rosetta/identity) -- carried on
    // every row regardless of populationMode so downstream phases can key on
    // it once they're ready to, without another pass over the save.
    row.rowIndex = prec.index;
    rows.push(row);
  }

  if (!rows.length) {
    throw new Error(
      source === 'leaving'
        ? 'The LeavingPlayer list is present but produced no usable players.'
        : 'No draft-worthy players found in this dynasty (no seniors or qualifying juniors on FBS rosters).'
    );
  }

  // Metadata rides along on the array so existing callers (which use it as a
  // plain list) keep working unchanged.
  rows.source = source;
  const withStats = rows.filter((r) => r.CareerStats && r.CareerStats.games > 0).length;
  log(`Source: ${source === 'leaving' ? "game's declared class" : 'synthesized (seniors + draft-worthy juniors)'} `
    + `| players: ${rows.length} | with career stats: ${withStats} | skipped: ${skipped} | dupes removed: ${duplicates}`);
  return rows;
}

// ===========================================================================
// Step 2: calibrate ratings to Madden scale
// ===========================================================================

const { DEFAULT_CONFIG, mergeConfig } = require('./defaults');
// Rosetta -- the new, isolated subsystem tree this project is migrating
// into (see lib/rosetta/index.js). No circular dependency: nothing under
// lib/rosetta/ requires pipeline.js.
const Rosetta = require('./rosetta');
// Moved into lib/rosetta/rng.js so Rosetta subsystems and pipeline.js share
// one implementation instead of two drifting copies. Same function, same
// behavior -- see that file for the (unchanged) body.
const { makeSeededRng } = Rosetta;

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

// Unclamped regression output -- the anchor blend below needs the raw value
// (not yet rounded/capped) so it can pull outliers back before the final
// 40-99 clamp is applied once, at the end.
function estimateMaddenOverallRaw(position, ratings) {
  const formula = loadOverallFormula()[position];
  if (!formula) return null;
  let ovr = formula.intercept;
  for (const [rating, coef] of Object.entries(formula.coefficients)) {
    ovr += (Number(ratings[rating]) || 0) * coef;
  }
  return ovr;
}

// ===========================================================================
// Overall Anchor
// ===========================================================================
// The per-rating regression above answers "given this player's specific
// technical ratings, what would Madden's formula say?" -- and it's accurate
// against real Madden ground truth. But a real declared class is narrow (most
// years, CFB Overall for draft-eligible players clusters around 85-92), and
// within that narrow a band, tiny/idiosyncratic differences between two
// similarly-rated prospects' specific sub-ratings can swing the regression
// output by 10+ points -- CFB Overall and Madden Overall are two different
// games' independent rating systems, and per-rating quantile mapping has no
// mechanism to keep a player's OVERALL in a believable place relative to
// their own CFB Overall value.
//
// The anchor curve below is a VALUE-based (not percentile-within-this-class)
// map from CFB Overall to a typical rookie Madden Overall -- it doesn't care
// how many other players are in the pool, so it behaves identically for a
// 17-player declared class or a 2,000-player synthesized one. The raw
// regression estimate still supplies all the real player-to-player variety
// (that's what keeps this from just "targeting" a single number per Overall
// value) -- applyOverallAnchor() blends toward the anchor and then hard-caps
// how far the final number can drift from it.
const OVERALL_ANCHOR_CURVE = [
  [40, 20], [50, 27], [60, 34], [65, 38], [70, 43], [75, 48],
  [78, 52], [80, 55], [82, 58], [84, 61], [85, 63], [86, 64],
  [87, 66], [88, 68], [89, 70], [90, 73], [91, 75], [92, 77],
  [93, 79], [94, 81], [95, 83], [96, 85], [97, 87], [98, 89], [99, 91],
];

function overallAnchorFor(cfbOverall) {
  const curve = OVERALL_ANCHOR_CURVE;
  const v = Math.max(curve[0][0], Math.min(curve[curve.length - 1][0], Number(cfbOverall) || 0));
  for (let i = 0; i < curve.length - 1; i++) {
    const [x0, y0] = curve[i], [x1, y1] = curve[i + 1];
    if (v >= x0 && v <= x1) {
      const frac = x1 === x0 ? 0 : (v - x0) / (x1 - x0);
      return y0 + frac * (y1 - y0);
    }
  }
  return curve[curve.length - 1][1];
}

// spreadFactor: how much of the raw estimate's own deviation from the anchor
// survives the blend (0 = anchor only/rigid, 1 = raw estimate only/today's
// unbounded behavior). maxSpread: hard cap on top of that, in points.
function applyOverallAnchor(rawEst, cfbOverall, cfg) {
  if (rawEst === null || rawEst === undefined) return null;
  const oa = cfg.overallAnchor || {};
  if (oa.enabled === false) return Math.max(40, Math.min(99, Math.round(rawEst)));
  const anchor = overallAnchorFor(cfbOverall);
  const spreadFactor = oa.spreadFactor ?? 0.5;
  const maxSpread = oa.maxSpread ?? 5;
  let blended = anchor + spreadFactor * (rawEst - anchor);
  blended = Math.max(anchor - maxSpread, Math.min(anchor + maxSpread, blended));
  return Math.max(40, Math.min(99, Math.round(blended)));
}

function estimateMaddenOverall(position, ratings) {
  const raw = estimateMaddenOverallRaw(position, ratings);
  if (raw === null) return null;
  return Math.max(40, Math.min(99, Math.round(raw)));
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

// (The old per-position measurables z-score has been retired: the projection
// step now computes a position-normalized athleticism percentile (_athScore)
// once, and both draft order and dev-trait weighting read that single signal
// -- one athletic module feeding order + dev + display, instead of two.)

// ===========================================================================
// Draft projection (adapted from seanpdwyer7/cfb2madden)
// ===========================================================================
// Answers "where should this player be drafted?" -- SELECTION + ORDER only.
// It never reads or writes a player's ratings, and runs on its own RNG so
// board variance can't perturb rating jitter. Its output (rank/round/pick)
// drives slot assignment; the rating conversion is entirely separate.

const POS_GROUP = {
  QB: 'QB', HB: 'RB', FB: 'RB', WR: 'REC', TE: 'REC',
  LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL',
  LE: 'DL', RE: 'DL', DT: 'DL', LOLB: 'LB', MLB: 'LB', ROLB: 'LB',
  CB: 'DB', FS: 'DB', SS: 'DB', K: 'ST', P: 'ST', LS: 'ST',
};

// Raw career-production value per position group (per-game + volume), from
// the aggregated CareerStats. Higher = more proven college producer.
function rawProduction(r) {
  const c = r.CareerStats;
  if (!c || !c.games) return 0;
  const perG = (v) => v / Math.max(1, c.games);
  switch (POS_GROUP[r.Position]) {
    case 'QB': return perG(c.passYds) / 3 + c.passTds * 1.5 + perG(c.rushYds) / 6;
    case 'RB': return perG(c.rushYds) + c.rushTds * 2 + perG(c.recYds) / 2;
    case 'REC': return perG(c.recYds) + c.recTds * 2 + perG(c.recCatches) * 3;
    case 'DL': return c.sacks * 8 + perG(c.tackles) * 6;
    case 'LB': return perG(c.tackles) * 10 + c.sacks * 4 + c.ints * 6;
    case 'DB': return c.ints * 12 + perG(c.tackles) * 8;
    case 'OL': case 'ST': return c.gamesStarted * 2 + c.games; // experience proxy
    default: return 0;
  }
}

// Raw athleticism from CFB measurable ratings, position-group weighted.
function rawAthleticism(r) {
  const g = (f) => Number(r[f]) || 50;
  switch (POS_GROUP[r.Position]) {
    case 'QB': return g('ThrowPowerRating') * 0.4 + g('SpeedRating') * 0.3 + g('AccelerationRating') * 0.15 + g('AgilityRating') * 0.15;
    case 'RB': return g('SpeedRating') * 0.35 + g('AccelerationRating') * 0.25 + g('AgilityRating') * 0.2 + g('JumpingRating') * 0.1 + g('StrengthRating') * 0.1;
    case 'REC': return g('SpeedRating') * 0.35 + g('JumpingRating') * 0.25 + g('AccelerationRating') * 0.2 + g('AgilityRating') * 0.2;
    case 'OL': return g('StrengthRating') * 0.5 + g('AgilityRating') * 0.3 + g('AccelerationRating') * 0.2;
    case 'DL': return g('StrengthRating') * 0.35 + g('SpeedRating') * 0.25 + g('AccelerationRating') * 0.25 + g('AgilityRating') * 0.15;
    case 'LB': return g('SpeedRating') * 0.3 + g('AccelerationRating') * 0.25 + g('AgilityRating') * 0.25 + g('StrengthRating') * 0.2;
    case 'DB': return g('SpeedRating') * 0.4 + g('AccelerationRating') * 0.2 + g('AgilityRating') * 0.2 + g('JumpingRating') * 0.2;
    case 'ST': return g('KickPowerRating') * 0.7 + g('SpeedRating') * 0.3;
    default: return 50;
  }
}

// Percentile-rank production & athleticism within each position group, then
// classify a floor/ceiling profile. High Floor = proven producer; High
// Ceiling = raw athletic freak; Complete = both; Balanced = neither extreme.
// prodScore is null when the whole class has no career data (fresh save).
function computeProfiles(rows) {
  const groups = new Map();
  for (const r of rows) {
    const gkey = POS_GROUP[r.Position] ?? 'X';
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(r);
  }
  for (const list of groups.values()) {
    const prodVals = list.map(rawProduction).sort((a, b) => a - b);
    const athVals = list.map(rawAthleticism).sort((a, b) => a - b);
    const anyProduction = prodVals.some((v) => v > 0);
    const pct = (sorted, v) => Math.round((sorted.findIndex((x) => x >= v) / Math.max(1, sorted.length - 1)) * 99);
    for (const r of list) {
      r._prodScore = anyProduction ? pct(prodVals, rawProduction(r)) : null;
      r._athScore = pct(athVals, rawAthleticism(r));
      if (r._prodScore != null && r._prodScore >= 70 && r._athScore >= 70) r._profile = 'Complete';
      else if (r._prodScore != null && r._prodScore - r._athScore >= 25) r._profile = 'High Floor';
      else if (r._athScore - (r._prodScore ?? r._athScore) >= 25 || (r._prodScore == null && r._athScore >= 85)) r._profile = 'High Ceiling';
      else r._profile = 'Balanced';
    }
  }
}

// Selects the class and assigns each kept player a board rank/round/pick.
// Stamps _rank/_round/_pick/_profile/_prodScore/_athScore/_generational/
// _draftScore onto the rows (read later by calibrate + write). rng is a
// projection-only PRNG (never the rating-jitter one).
function projectDraftClass(rows, cfg, rng) {
  const dv = cfg.draftValue || {};
  const posValue = cfg.positionValue || {};
  const positionCaps = cfg.positionCaps || {};
  const count = cfg.general.classSize;

  computeProfiles(rows);

  // At most one generational prospect: a 97+ overall elite who is also an
  // elite producer or freak athlete. Locks the top of the board.
  if (dv.generationalEnabled !== false) {
    const cands = rows.filter((r) =>
      Number(r.OverallRating) >= 97
      && (r.TraitDevelopment === 'College_Elite' || r.TraitDevelopment === 'College_Star')
      && ((r._prodScore ?? 0) >= 80 || r._athScore >= 92));
    if (cands.length) {
      cands.sort((a, b) => (Number(b.OverallRating) - Number(a.OverallRating))
        || (((b._prodScore ?? 0) + b._athScore) - ((a._prodScore ?? 0) + a._athScore)));
      cands[0]._generational = true;
      cands[0]._profile = 'Generational';
    }
  }

  const DRAFT_AWARDS_BONUS_CAP = 4; // a decorated career is worth at most a few draft spots, not a landslide
  const scoreOf = (r) => {
    const posBonus = (posValue[r.Position] || 0) * (dv.positionValueWeight ?? 1);
    const awardsBonus = Math.min(DRAFT_AWARDS_BONUS_CAP, (Number(r.AwardsScore) || 0) * (dv.awardsWeight ?? 0.5));
    const prodBonus = ((r._prodScore ?? 50) / 99) * (dv.productionWeight ?? 3);
    const athBonus = (r._athScore / 99) * (dv.athleticismWeight ?? 2.5);
    const round = Number(r.ProjectRound);
    const roundBonus = (round >= 1 && round <= 7) ? (8 - round) * (dv.roundWeight ?? 1) : 0;
    const variance = (rng() * 2 - 1) * (dv.boardVariance ?? 1.5);
    let s = Number(r.OverallRating) + posBonus + awardsBonus + prodBonus + athBonus + roundBonus + variance;
    if (r._generational) s += 12; // locks #1 overall
    return s;
  };
  for (const r of rows) r._draftScore = scoreOf(r);

  // Positional market saturation: a position premium is a DEMAND signal, and
  // demand dries up. The top few at a premium position get the full reach,
  // the next couple half, the rest none (with a deep-market slide for QBs).
  const PREMIUM_DEMAND = { QB: [3, 2] };
  const byPos = new Map();
  for (const r of rows) { if (!byPos.has(r.Position)) byPos.set(r.Position, []); byPos.get(r.Position).push(r); }
  for (const [pos, list] of byPos) {
    const prem = (posValue[pos] || 0) * (dv.positionValueWeight ?? 1);
    if (prem <= 0) continue;
    const [full, half] = PREMIUM_DEMAND[pos] ?? [4, 2];
    list.sort((a, b) => b._draftScore - a._draftScore);
    list.forEach((r, i) => {
      const mult = i < full ? 1 : i < full + half ? 0.5 : 0;
      r._draftScore -= prem * (1 - mult);
      if (pos === 'QB' && i >= full + half) r._draftScore -= Math.min(4, (i - full - half + 1) * 1.2);
    });
  }

  // Hard round-one positional caps (real-draft maxima): excess players at a
  // capped position slide to just below the round 1/2 turn rather than
  // stacking round one.
  const R1_CAP = { QB: 6, HB: 3, FB: 0, TE: 3, K: 0, P: 0, LS: 0 };
  let demotions = 0;
  for (let pass = 0; pass < 8; pass++) {
    rows.sort((a, b) => b._draftScore - a._draftScore);
    const counts = {};
    let changed = false;
    for (let i = 0; i < Math.min(32, rows.length); i++) {
      const pos = rows[i].Position;
      counts[pos] = (counts[pos] ?? 0) + 1;
      const cap = R1_CAP[pos];
      if (cap != null && counts[pos] > cap) {
        const cutoff = rows[32]?._draftScore ?? rows[rows.length - 1]._draftScore;
        rows[i]._draftScore = cutoff - 0.01 * ++demotions;
        changed = true;
      }
    }
    if (!changed) break;
  }

  rows.sort((a, b) => b._draftScore - a._draftScore);

  // Trim to class size honoring per-position caps.
  const selected = [];
  const posCounts = {};
  for (const r of rows) {
    const cap = Number(positionCaps[r.Position]);
    if (cap > 0) {
      if ((posCounts[r.Position] || 0) >= cap) continue;
      posCounts[r.Position] = (posCounts[r.Position] || 0) + 1;
    }
    selected.push(r);
    if (selected.length >= count) break;
  }
  if (!selected.length) throw new Error('No players to select from -- the CFB extraction returned nothing.');

  // Assign board rank -> round/pick. 7 rounds x 32 picks; the rest are the
  // priority-UDFA tail (round null). Generational converts above the curve.
  selected.forEach((r, i) => {
    r._rank = i + 1;
    r._round = r._rank <= 224 ? Math.ceil(r._rank / 32) : null;
    r._pick = r._rank <= 224 ? ((r._rank - 1) % 32) + 1 : null;
  });
  return selected;
}

// Stable per-player seed so a player's converted ratings depend only on the
// player + the global seed -- never on where they land on the draft board.
// This is what keeps rating conversion independent of draft projection
// (Phase 4). Blank global seed -> Math.random (fresh, non-reproducible).
function playerRatingSeed(globalSeed, player) {
  if (globalSeed === '' || globalSeed === undefined || globalSeed === null) return '';
  return `${globalSeed}:${player.FirstName}|${player.LastName}|${player.Position}|${player.OverallRating}`;
}

// Combine / pro-day numbers derived from the CONVERTED ratings (so they stay
// consistent with what the player actually is in Madden), shown on Madden's
// scouting screens. Formulas adapted from seanpdwyer7/cfb2madden -- 40 from
// speed, bench from strength, vertical/broad from jumping, cone/shuttle from
// agility. Distances/times are stored x100 (Madden's convention). Uses the
// per-player rating rng, so combine is decoupled from draft order too.
function combineNumbers(ratings, rng) {
  const spd = Number(ratings.SpeedRating) || 70;
  const str = Number(ratings.StrengthRating) || 70;
  const agi = Number(ratings.AgilityRating) || 70;
  const jmp = Number(ratings.JumpingRating) || 70;
  const j = (n) => n + (rng() * 2 - 1) * n * 0.02; // +/-2% natural scatter
  return {
    CombineFortyYardDash: Math.round(j(545 - spd * 1.25)),   // 99 spd -> ~4.21
    CombineBenchPress: Math.max(5, Math.round(j(str / 3.2))),
    CombineVerticalJump: Math.round(j(20 + jmp * 0.2) * 10) / 10,
    CombineBroadJump: Math.round(j(95 + jmp * 0.35)),
    CombineThreeConeDrill: Math.round(j(830 - agi * 1.4)),
    CombineTwentyYardShuttle: Math.round(j(500 - agi * 0.85)),
  };
}

function calibratePlayers(departedRows, { config, log = () => {} } = {}) {
  const cfg = mergeConfig(config);
  // Projection gets its OWN rng (salted) so board variance can never perturb
  // the rating streams -- ratings stay a pure function of player + seed.
  const projectRng = makeSeededRng(cfg.general.seed === '' ? '' : `${cfg.general.seed}:proj`);

  const players = projectDraftClass(departedRows, cfg, projectRng);
  const withStats = players.filter((p) => p.CareerStats && p.CareerStats.games > 0).length;
  log(`  projected + selected top ${players.length} by draft board `
    + `(overall + production + athleticism + awards + position value + round); career stats on ${withStats}`);

  const { flatDrops, quantiles } = loadCalibration();
  log(`  loaded flat-drop calibration for ${Object.keys(flatDrops).length} positions, `
    + `quantile calibration for ${Object.keys(quantiles).length} positions`);

  const preview = [];
  for (const player of players) {
    const rng = makeSeededRng(playerRatingSeed(cfg.general.seed, player));
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
      CFB_Overall: cfbOvr,
      // Projected round now comes from the draft board (player._round), not
      // raw EA ProjectRound -- UDFA tail is null -> ''.
      ProjectRound: player._round ?? '',
      DraftRank: player._rank ?? '',
      DraftPick: player._pick ?? '',
      Profile: player._profile ?? '',
      ProdScore: player._prodScore ?? '',
      AthScore: player._athScore ?? '',
      Generational: !!player._generational,
      Age: age, Height: height, Weight: realWeight, Jersey: jersey,
      SkinTone: player.SkinTone || '',
      TraitDevelopment: player.TraitDevelopment || '',
      AwardsScore: Number(player.AwardsScore) || 0,
      // Carried for downstream dev-trait weighting (P3) -- object, excluded from CSV.
      CareerStats: player.CareerStats || null,
    };
    for (const [k, v] of Object.entries(writtenRatings)) row[`Madden_${k}`] = v;
    row.EstMaddenOverall = applyOverallAnchor(
      estimateMaddenOverallRaw(player.Position, writtenRatings), cfbOvr, cfg
    );
    row.Combine = combineNumbers(writtenRatings, rng);
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

// Dev-trait draw weight. Blends everything both halves of the pipeline know
// about a prospect (Phase 5): converted Madden overall (dominant), projected
// draft round, career production, athletic upside, awards, age, and CFB dev
// tier. The convert side sets the overall/ratings; the projection side sets
// round/production percentile/athletic percentile -- so this is where the two
// independent systems finally meet. Every non-overall factor is a bounded
// multiplier so overall stays the primary driver; the actual assignment is
// still a weighted random draw (below), so it varies each regenerate.
function devTraitWeight(p) {
  const ovr = Number(p.EstMaddenOverall) || Number(p.CFB_Overall) || 50;
  // Exponential in overall so the top of the class dominates the odds without
  // being a guarantee -- each extra point ~+25% odds; a 1-2 point gap between
  // neighbors is a close roll, not a foregone one.
  let w = Math.exp((ovr - 60) * 0.22);

  // Projected draft round: earlier picks develop more often (R1 much more
  // than R7); the UDFA tail gets no boost.
  const round = Number(p.ProjectRound);
  if (round >= 1 && round <= 7) w *= 1 + (8 - round) * 0.12;

  // Career production percentile (floor) and athletic percentile (ceiling) --
  // proven producers and freak athletes both carry extra boom potential.
  const prod = Number(p.ProdScore);
  if (Number.isFinite(prod)) w *= 1 + Math.max(-0.15, Math.min(0.2, (prod - 50) / 250));
  const ath = Number(p.AthScore);
  if (Number.isFinite(ath)) w *= 1 + Math.max(-0.15, Math.min(0.25, (ath - 50) / 200));

  // Age: younger prospects have more projected upside.
  const age = Number(p.Age);
  if (Number.isFinite(age)) w *= 1 + Math.max(-0.15, Math.min(0.15, (22 - age) * 0.05));

  // Career awards.
  const awards = Number(p.AwardsScore) || 0;
  w *= 1 + Math.min(0.3, awards * 0.015);

  // CFB dev tier: big but not absolute (still capped by the target counts).
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
  const weight = devTraitWeight;

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

// CFB display names that don't normalize onto the Madden college table.
const SCHOOL_ALIASES = {
  'fla atlantic': 'fau', 'app state': 'appalachian state', 'ndsu': 'north dakota state',
  'umass': 'massachusetts', 'southern miss': 'southern mississippi', 'uconn': 'connecticut',
  'ul monroe': 'louisiana monroe', 'miami fl': 'miami', 'miami oh': 'miami ohio',
};
function normalizeSchool(name) {
  const n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '')
    .replace(/\bst(\s|$)/g, 'state$1').replace(/\s+/g, ' ').trim();
  return SCHOOL_ALIASES[n] ?? n;
}
// Robust college matcher over college_lookup.json: exact display-name match
// first (fast path, preserves the hand-tuned keys), then a normalized exact
// match, then a normalized containment match either direction. Returns the
// binary asset id or null.
function buildCollegeMatcher() {
  const raw = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'college_lookup.json'), 'utf-8'));
  raw['NC State'] = raw['N.C. State'];
  const normMap = new Map();
  for (const [name, bin] of Object.entries(raw)) {
    const nk = normalizeSchool(name);
    if (nk && !normMap.has(nk)) normMap.set(nk, bin);
  }
  return (school) => {
    if (school in raw) return raw[school];
    const n = normalizeSchool(school);
    if (!n) return null;
    if (normMap.has(n)) return normMap.get(n);
    for (const [key, bin] of normMap) if (key.includes(n) || n.includes(key)) return bin;
    return null;
  };
}
// Last name (lowercased) -> announcer commentary id, so the play-by-play says
// the player's name instead of a generic placeholder.
function loadCommentaryLookup() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data', 'commentary_lookup.json'), 'utf-8'));
    const m = new Map();
    for (const [k, v] of Object.entries(raw)) { const id = parseInt(v, 10); if (id) m.set(k.toLowerCase(), id); }
    return m;
  } catch (e) { return new Map(); }
}

async function writeCareerFile(inputPath, outputPath, players, log = () => {}) {
  const matchCollege = buildCollegeMatcher();
  const commentary = loadCommentaryLookup();

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

  // Madden encodes a player's skin tone directly in which head asset is
  // equipped ("gen_<skinDigit>_<family>_<variant>") -- confirmed against
  // real rookie data. There is no separate "skinTone" property anywhere in
  // CharacterVisuals.RawData to patch in isolation (checked: real
  // CharacterVisuals JSON only holds equipment/loadout data, nothing about
  // appearance). So changing skin tone necessarily means changing the head
  // asset -- the best we can do to keep everything else about the face the
  // same is prefer a head from the SAME family (same base head/hairstyle,
  // just the skin-tone digit swapped) when one exists in this save's own
  // pool of real assets, only falling back to a different family if no
  // same-family match at the target skin tone is available.
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

  // Slot order follows the projected draft board (DraftRank) computed in the
  // projection step -- the unified ordering. Fall back to projected round +
  // CFB overall only if a player somehow lacks a rank (e.g. a CSV-loaded pool
  // that never went through projection).
  const UNDRAFTED_ROUND = 8;
  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : UNDRAFTED_ROUND; };
  const rankOf = (p) => (Number(p.DraftRank) > 0 ? Number(p.DraftRank) : Infinity);
  const playersSorted = players.slice().sort((a, b) =>
    (rankOf(a) - rankOf(b)) ||
    (roundOf(a.ProjectRound) - roundOf(b.ProjectRound)) ||
    (Number(b.CFB_Overall) - Number(a.CFB_Overall)));

  const allSlots = prospects.slice().sort((a, b) => (a.draftRound - b.draftRound) || (a.draftPick - b.draftPick));
  let slotCursor = 0;
  function takeSlot() {
    if (slotCursor >= allSlots.length) return null;
    return allSlots[slotCursor++];
  }

  const ratingCols = Object.keys(players[0]).filter((c) => c.startsWith('Madden_'));

  function setSkinTone(slot, skin) {
    if (!skin) return false;
    const n = Math.max(1, Math.min(8, Number(skin)));
    const chosen = pickValidHead(n, safe(slot, 'GenericHeadAssetName'));
    if (!chosen) return false;
    try {
      slot.GenericHeadAssetName = chosen;
      slot.PLYR_GENERICHEAD = chosen.slice(4);
      return true;
    } catch (e) {
      return false;
    }
  }

  let written = 0, missingCollege = 0, dropped = 0, skinSet = 0, posSet = 0, archSet = 0, devSet = 0, scoutSet = 0, combineSet = 0, commentSet = 0;
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

    const collegeVal = matchCollege(p.FormerTeam);
    if (collegeVal) { try { slot.College = collegeVal; } catch (e) { /* keep */ } }
    else if (p.FormerTeam) missingCollege++;

    // Commentary: announcer says the player's name instead of a placeholder.
    const commentId = commentary.get(String(p.LastName || '').toLowerCase());
    if (commentId) { try { slot.PLYR_COMMENT = commentId; commentSet++; } catch (e) { /* optional */ } }

    if (setSkinTone(slot, p.SkinTone)) skinSet++;

    // Ratings + Original* mirrors (Madden stores an "as-drafted" copy of every
    // rating; writing both keeps the scouting/progression baseline correct).
    for (const col of ratingCols) {
      const fieldName = col.slice('Madden_'.length);
      const v = Number(p[col]);
      try { slot[fieldName] = v; } catch (e) { /* field not writable, skip */ }
      try { slot['Original' + fieldName] = v; } catch (e) { /* no mirror field, skip */ }
    }
    // Displayed overall from our estimate (Madden recomputes on import, but
    // this makes the pre-recompute value sensible) + its Original mirror.
    if (Number.isFinite(Number(p.EstMaddenOverall))) {
      const ovr = Number(p.EstMaddenOverall);
      try { slot.OverallRating = ovr; } catch (e) { /* skip */ }
      try { slot.OriginalOverallRating = ovr; } catch (e) { /* skip */ }
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
        // Combine + matching pro-day numbers on the scouting screens.
        if (p.Combine) {
          for (const [k, v] of Object.entries(p.Combine)) { try { dp[k] = v; } catch (e) { /* skip */ } }
          const pd = {
            ProDayFortyYardDash: p.Combine.CombineFortyYardDash,
            ProDayBenchPress: p.Combine.CombineBenchPress,
            ProDayVerticalJump: p.Combine.CombineVerticalJump,
            ProDayBroadJump: p.Combine.CombineBroadJump,
            ProDayThreeConeDrill: p.Combine.CombineThreeConeDrill,
            ProDayTwentyYardShuttle: p.Combine.CombineTwentyYardShuttle,
          };
          for (const [k, v] of Object.entries(pd)) { try { dp[k] = v; } catch (e) { /* skip */ } }
          combineSet++;
        }
        // Make the prospect scoutable through every stage.
        try { dp.IsVisible = true; } catch (e) { /* skip */ }
        for (const flag of ['CanScoutRegularSeason', 'CanScoutSeniorBowl', 'CanScoutCombine', 'CanScoutProDays', 'CanScoutIndividualWorkouts']) {
          try { dp[flag] = true; } catch (e) { /* skip */ }
        }
        scoutSet++;
      } catch (e) { /* leave scouting data as-is */ }
    }

    written++;
  }

  log(`Players written into rookie slots: ${written}`);
  log(`DraftPlayer scouting records synced: ${scoutSet} | with combine numbers: ${combineSet}`);
  log(`Positions rewritten: ${posSet} | archetypes set: ${archSet} | dev traits set: ${devSet} | commentary names: ${commentSet}`);
  log(`Missing college lookups: ${missingCollege}`);
  log(`Skin tones set: ${skinSet}`);
  log(`CFB players with no slot available (dropped): ${dropped}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await file.save(outputPath);
  log(`Saved franchise file to: ${outputPath}`);

  return { written, missingCollege, dropped, skinSet, posSet, archSet, devSet, scoutSet, combineSet, commentSet };
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

  // Same draft-board order the write step uses to fill slots (DraftRank).
  const UNDRAFTED_ROUND = 8;
  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : UNDRAFTED_ROUND; };
  const rankOf = (p) => (Number(p.DraftRank) > 0 ? Number(p.DraftRank) : Infinity);
  players.sort((a, b) =>
    (rankOf(a) - rankOf(b)) ||
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
  // CSV is flat -- skip object-valued fields like CareerStats (derived data,
  // recomputed from the save on extraction, not part of a reloadable CSV).
  const isFlat = (v) => v === null || v === undefined || typeof v !== 'object';
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k) && isFlat(row[k])) cols.push(k);
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
