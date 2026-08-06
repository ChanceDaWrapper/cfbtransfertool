// The Mapped stage (lifecycle.js) for CFB -> Madden -- COACH_CAROUSEL_ROADMAP.md
// Phase 2. Ties every map/ module together into one function that turns a
// LIVE CFB Coach record into a plain { MaddenFieldName: value } bag, ready
// to be assigned onto a destination record by lib/carousel/write.js.
//
// Takes the LIVE cfbCoachRecord (not the Phase-0 CoachFacet snapshot):
// reference-typed fields (schemes) need their raw bitstring value, which
// coachFacet.js deliberately does NOT keep (it stores the resolved
// {tableId,rowNumber} instead, useful for identification/analysis but not
// for cross-save copying). Person fields ARE safe to read straight off the
// live record too, since they're simple scalars/enums.
//
// Two fields are intentionally left UNSET here rather than guessed:
//   - GenericHeadAssetName / Portrait / CharacterVisuals / FaceShape /
//     Portrait_Force_Silhouette / Portrait_Swappable_Library_Path (appearance,
//     section 3.5): no coach appearance catalog exists yet (the sibling of
//     lib/appearanceCatalog.js, for coaches, is future work). Leaving these
//     unset means Mode A injection (section 3.7) keeps the destination
//     free-agent shell's OWN existing, valid Madden face -- not the CFB
//     coach's likeness, but a real rendered face, never a broken reference.
//   - TeamPhilosophy / DefaultTeamPhilosophy / OffensivePlaybook /
//     DefensivePlaybook: these only mean something once a team is assigned.
//     Mode A coaches have no team (free agent), so these stay unset; Mode B
//     (direct placement) should resolve them from the destination team's own
//     defaults once that placement path is built.
//
// Every field this function DOES set is looked up in coachFieldMap.js by
// name (via assertPlannedAction) so a change to the field table and a change
// to this function can never silently drift apart.

const { safe, biggestTableByName } = require('../../saveIO');
const { getFieldMap } = require('./coachFieldMap');
const { crossEnum } = require('./enumBridge');
const { buildLevelModel, mapLevel, synthesizeExperiencePoints, pctOf, valueAt } = require('./levelScale');
const { deriveSide, mapArchetypeCfbToMadden, mapArchetypeMaddenToCfb, archetypeRng } = require('./archetypeMap');
const { buildSchemeIndex, crossSchemeName, lookupSchemeValue, resolveSchemeNameForCoach } = require('./schemeLookup');
const {
  neutralIfZero, synthesizeTeamBuildingAndTrading, synthesizeCoachBackstoryForMadden,
  synthesizeCoachBackstoryForCfb, synthesizeLegacyScore, synthesizeCfbProgramFields,
  synthesizeSpecialtyType,
} = require('./synthesis');

const HC_OC_DC = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];

// The lowest Level a coach arriving in CFB is given. Measured, not guessed
// (research/probe45): the sample dynasty carries NO coach below Level 10 with
// a talent tree, so anything under 10 has no comparable donor to copy from.
const CFB_MIN_COACH_LEVEL = 10;

// Reads a field's live max bound from the destination schema -- used for
// YearsCoaching's clamp (CFB's range allows up to 127; Madden's is [0..63]
// in the sample save, but read live rather than hardcode 63, same "derive,
// don't hardcode" posture as everything else in map/).
function fieldMax(file, table, field) {
  const attr = file.schemaList.getSchema(table).attributes.find((a) => a.name === field);
  if (!attr) throw new Error(`fieldMax: no "${field}" on ${table} in this save.`);
  return Number(attr.maxValue);
}

// Q2 (open question, see COACH_CAROUSEL_ROADMAP.md): Madden's schema default
// AND observed p50 for every COACH_* position grade is 50 -- NOT 0, which is
// where CFB leaves every one of these fields. R4 in the roadmap's risk
// register explicitly calls zero the riskier default (out of Madden's own
// distribution) and recommends 50-flat pending an in-game check (V1). Ships
// as 50 here; flip this constant if V1 shows the sim prefers zero.
const COACH_GRADE_DEFAULT = 50;
const COACH_GRADE_FIELDS = ['COACH_RATING', 'COACH_QB', 'COACH_RB', 'COACH_WR', 'COACH_OL',
  'COACH_DL', 'COACH_LB', 'COACH_DB', 'COACH_K', 'COACH_P', 'COACH_OFFENSE', 'COACH_DEFENSE'];

const ZERO_FIELDS_SHARED = [
  'SeasonsWithTeam', 'COACH_LASTCONTRACTTEAM', 'COACH_CONSECTEAMCONTRACTS',
  'COACH_PERFORMANCELEVEL', 'COACH_RETIREYRSLEFT',
  'RegularWinStreak', 'SeasWinStreak', 'WinSeasStreak', 'ConfPlayoffWinStreak',
  'DivPlayoffWinStreak', 'WCPlayoffWinStreak', 'SuperbowlWinStreak',
  'SeasPointsFor', 'SeasPointsAgainst', 'SeasTies', 'SeasLongWinStreak',
  'SeasBigWinMargin', 'SeasBigLossMargin', 'OWNER_COMMENTID', 'OWNER_COMMENTTYPE',
];
// IndexInUnlockList and CurrentPurchasedTalentCosts were REMOVED from this
// list after a real incident. They are coach-ability/talent bookkeeping that
// must stay consistent with the PlaysheetTalents/GamedayTalents/
// WearAndTearTalents references -- which this mapper deliberately never
// writes. Zeroing the bookkeeping while leaving the talent references
// untouched desynchronizes the two, and the resulting save was rejected by
// Madden as damaged. Leave all five alone as a set: whatever the
// destination row already has is internally consistent by definition.
const ZERO_FIELDS_MADDEN_ONLY = [
  'CareerSuperbowlWins', 'CareerSuperbowlLosses', 'CareerProBowlPlayers',
  'SeasWins', 'SeasLosses',
];
const COPY_FIELDS_SHARED = [
  'FirstName', 'LastName', 'Name', 'Age', 'Height', 'Weight', 'CharacterBodyType',
  'Personality', 'COACH_WASPLAYER', 'COACH_SPECIALTY', 'COACH_ADAPTIVE_AI',
  'COACH_DEMEANOR', 'COACH_STANCE', 'COACH_OFFTENDENCYRUNPASS', 'COACH_OFFTENDENCYAGGRESSCONSERV',
  'COACH_DEFTENDENCYAGGRESSCONSERV', 'TraitExpertScout',
  'CareerPointsFor', 'CareerPointsAgainst', 'CareerWinSeasons', 'CareerPlayoffsMade',
  'CareerLongWinStreak', 'CareerBigWinMargin', 'CareerBigLossMargin', 'AwardPoints', 'YearlyAwardCount',
  'CareerTies', // COPY per the roadmap, not ZERO -- CFB happens to be all-zero anyway (no ties in modern CFB), but the declared action is COPY
];

// Sanity guard: the field-action assumptions this function hardcodes must
// match coachFieldMap.js's declared action, or the two have drifted --
// throws loudly at call time rather than silently mis-mapping. Not an
// exhaustive per-field dispatcher (that's a bigger refactor for a later
// phase); this just catches the "someone changed coachFieldMap.js's action
// for a field this function assumes is COPY/ZERO and forgot to update this
// function" class of bug.
function assertPlannedAction(field, expected) {
  const entry = getFieldMap(field);
  if (!entry) throw new Error(`mapCoachCfbToMadden: "${field}" isn't in coachFieldMap.js at all.`);
  if (entry.cfbToMadden !== expected) {
    throw new Error(`mapCoachCfbToMadden: coachFieldMap.js says ${field}.cfbToMadden = `
      + `"${entry.cfbToMadden}", but this function was written assuming "${expected}" -- `
      + 'the two have drifted; update whichever one is stale.');
  }
}
for (const f of COPY_FIELDS_SHARED) assertPlannedAction(f, 'COPY');
for (const f of ZERO_FIELDS_SHARED) assertPlannedAction(f, 'ZERO');
for (const f of ZERO_FIELDS_MADDEN_ONLY) assertPlannedAction(f, 'ZERO');
assertPlannedAction('YearsCoaching', 'COPY'); // handled specially below (clamped, not a bare copy) but still declared COPY in the field map
for (const f of ['Position', 'ContractStatus']) assertPlannedAction(f, 'NAME');
assertPlannedAction('Level', 'LOOKUP');
for (const f of ['ExperiencePoints', 'LegacyScore', 'Archetype', 'CoachBackstory', 'OriginalPosition', 'CareerAssistant', 'IsMaxLevel']) assertPlannedAction(f, 'SYNTH');
for (const f of ['OffensiveScheme', 'DefensiveScheme']) assertPlannedAction(f, 'LOOKUP');
// CareerWins/Losses/PlayoffWins/PlayoffLosses are declared SYNTH (Q3, open --
// see FINDINGS.md) but ship as a hardcoded 0 below pending that work; this
// assertion documents the gap rather than silently matching a wrong action.
for (const f of ['CareerWins', 'CareerLosses', 'CareerPlayoffWins', 'CareerPlayoffLosses']) assertPlannedAction(f, 'SYNTH');

// One-time setup shared across every coach moved in a single carousel run --
// building the level model and both schemes indexes reads each Coach/Team
// table once; doing it per-coach would be wasteful for a multi-coach batch.
//
// direction picks which save is the Level model's SOURCE vs DEST -- levelScale.js's
// buildLevelModel is already fully symmetric (it just reads two live distributions
// and winsorizes the destination one), so this is the only thing that needs to
// flip for mapCoachMaddenToCfb. Defaults to 'cfbToMadden' so every existing
// caller of mapCoachCfbToMadden is unaffected.
async function buildCarouselModels({ cfbFile, maddenFile, winsor, direction = 'cfbToMadden' }) {
  const [levelModel, cfbSchemeIndex, maddenSchemeIndex] = await Promise.all([
    direction === 'maddenToCfb'
      ? buildLevelModel({ sourceFile: maddenFile, destFile: cfbFile, winsor })
      : buildLevelModel({ sourceFile: cfbFile, destFile: maddenFile, winsor }),
    buildSchemeIndex(cfbFile),
    buildSchemeIndex(maddenFile),
  ]);
  return { levelModel, cfbSchemeIndex, maddenSchemeIndex, direction };
}

// cfbCoachRecord: a LIVE FranchiseFileRecord from the CFB Coach table.
// models: from buildCarouselModels (built once per run, passed in).
// config.seed: the carousel's global RNG seed (blank -> fresh Math.random
//   roll every call, same convention as rosetta/rng).
async function mapCoachCfbToMadden({ cfbCoachRecord, maddenFile, models, config = {} }) {
  const cfbPosition = safe(cfbCoachRecord, 'Position');
  if (!HC_OC_DC.includes(cfbPosition)) {
    throw new Error(`mapCoachCfbToMadden: cannot move a "${cfbPosition}" coach -- `
      + `only ${HC_OC_DC.join('/')} are supported (CFB's NumCollegeCoaches sentinel `
      + 'and any Scout/Trainer/etc. row must be filtered out before calling this).');
  }

  const out = {};

  // --- Person core (shared, verified byte-for-byte compatible -- Phase 0) ---
  for (const f of COPY_FIELDS_SHARED) out[f] = safe(cfbCoachRecord, f);

  // --- Job assignment: Mode A (free-agent injection, section 3.7 default) ---
  out.Position = crossEnum({ destFile: maddenFile, destField: 'Position', sourceValue: cfbPosition });
  out.TeamIndex = 32; // Madden's free-agent-pool sentinel (verified: TeamIndex range [0..32])
  out.PrevTeamIndex = 32;
  for (const f of ZERO_FIELDS_SHARED) out[f] = 0;
  // COACH_FIREREPORTED / COACH_RESIGNREPORTED are deliberately NOT written.
  // Verified: they read `true` for EVERY coach in both games -- they are
  // schema defaults the games never toggle. Writing `false` produced the
  // only two false values in the entire file, which is exactly the kind of
  // out-of-distribution value that made a save unloadable. Leave them.
  out.COACH_LASTTEAMFIRED = 1023; // Madden's own "none" sentinel for this field (verified against the live schema's [0..1023] range)
  out.COACH_LASTTEAMRESIGNED = 1023;

  // --- Contract: a fresh free agent has no active contract ---
  out.ContractStatus = crossEnum({ destFile: maddenFile, destField: 'ContractStatus', sourceValue: 'FreeAgent' });
  out.ContractLength = 0;
  out.ContractYearsRemaining = 0;
  out.ContractSalary = 0; // SYNTH-from-peers (section 3.4) only applies once a real contract exists (Mode B); a free agent has none

  // --- Quality: Level, XP, LegacyScore -- all keyed off the SAME percentile ---
  const cfbLevel = safe(cfbCoachRecord, 'Level');
  const levelPercentile = pctOf(models.levelModel.byPosition[cfbPosition].source, cfbLevel);
  out.Level = mapLevel(models.levelModel, cfbPosition, cfbLevel);
  out.ExperiencePoints = await synthesizeExperiencePoints({ destGame: 'madden', destFile: maddenFile, destLevel: out.Level });
  out.LegacyScore = await synthesizeLegacyScore({ destFile: maddenFile, position: out.Position, levelPercentile });

  // --- Archetype / specialty / backstory (section 3.2/3.4) ---
  const coachSpecialty = safe(cfbCoachRecord, 'COACH_SPECIALTY');
  const specialtyType = safe(cfbCoachRecord, 'SpecialtyType');
  const side = deriveSide({ specialtyType, coachSpecialty });
  const dominantArchetype = safe(cfbCoachRecord, 'DominantArchetype');
  const rng = archetypeRng(config.seed, cfbCoachRecord.index);
  out.Archetype = mapArchetypeCfbToMadden({ dominantArchetype, side, rng });
  out.CoachBackstory = synthesizeCoachBackstoryForMadden(out.Archetype);
  out.OriginalPosition = out.Position; // matches Position for all 127 coaches in the sample save
  out.CareerAssistant = out.Position !== 'HeadCoach';
  out.IsMaxLevel = out.Level >= 50;

  // COACH_* position grades -- Q2, open question; ships 50-flat (see const doc above)
  for (const f of COACH_GRADE_FIELDS) out[f] = COACH_GRADE_DEFAULT;

  // YearsCoaching: COPY, but clamped to Madden's live max -- CFB's schema
  // allows up to 127 (observed max 43 today); Madden's range is narrower.
  out.YearsCoaching = Math.min(fieldMax(maddenFile, 'Coach', 'YearsCoaching'), safe(cfbCoachRecord, 'YearsCoaching') || 0);

  // --- Tendencies ---
  out.COACH_DEFTENDENCYRUNPASS = neutralIfZero(safe(cfbCoachRecord, 'COACH_DEFTENDENCYRUNPASS'));
  out.COACH_RBTENDENCY = neutralIfZero(safe(cfbCoachRecord, 'COACH_RBTENDENCY'));
  Object.assign(out, synthesizeTeamBuildingAndTrading());

  // --- Schemes (section 3.3) -- resolved via the live CFB scheme index, then
  // cross-named and re-resolved via the live Madden scheme index. Left unset
  // (not guessed) if this coach's own team wasn't walkable by buildSchemeIndex
  // (no DisplayName, no HeadCoach reference), their scheme name has no
  // maddenToCfb/cfbToMadden crossing entry, or no Madden save currently runs
  // the crossed-to scheme. crossSchemeName is INSIDE the try too (not just
  // lookupSchemeValue) -- it throws for a source name schemeLookup.js's own
  // dictionary doesn't cover (verified live: Madden's "Spread" defensive
  // scheme has no maddenToCfb entry), and that must be exactly as recoverable
  // as "no destination team runs this scheme", not a harder failure. ---
  for (const [side2, cfbField, maddenField] of [['offensive', 'OffensiveScheme', 'OffensiveScheme'], ['defensive', 'DefensiveScheme', 'DefensiveScheme']]) {
    const rawCfb = safe(cfbCoachRecord, cfbField);
    const cfbName = resolveSchemeNameForCoach(models.cfbSchemeIndex, side2, rawCfb);
    if (!cfbName) continue; // unresolvable -- leave unset rather than guess
    try {
      const crossed = crossSchemeName(cfbName, side2, 'cfbToMadden');
      out[maddenField] = lookupSchemeValue(models.maddenSchemeIndex, side2, crossed.name);
    } catch (e) {
      // No crossing entry for this scheme name, or no Madden team currently
      // runs the crossed-to scheme in this save -- leave unset (destination
      // keeps whatever it already had) rather than throw and abort the whole
      // coach's move over one cosmetic field.
    }
  }

  // --- Career win/loss record (Q3) -----------------------------------------
  // CFB stores no CareerWins/CareerLosses on the Coach row at all, so these
  // have to be derived. They previously shipped as a hardcoded 0, which was
  // WRONG in a way that mattered: the mapper simultaneously copies
  // CareerWinSeasons, CareerPlayoffsMade and CareerPointsFor/Against, so a
  // transferred coach came out with a 0-0 record alongside 14 winning
  // seasons and 4,053 points scored. That contradiction (and the 0/0 win
  // percentage it implies) is a prime suspect for the save Madden rejected
  // as damaged.
  //
  // Derived instead via Pythagorean expectation from the points the coach
  // actually scored and allowed -- the standard estimator, and the only
  // signal CFB gives us. Games are estimated from career length at a
  // 12-game college season. The result is internally consistent with every
  // other career field written above, which is the property that matters.
  const pf = safe(cfbCoachRecord, 'CareerPointsFor') || 0;
  const pa = safe(cfbCoachRecord, 'CareerPointsAgainst') || 0;
  const seasons = Math.max(0, safe(cfbCoachRecord, 'YearsCoaching') || 0);
  const estimatedGames = Math.round(seasons * 12);
  if (pf + pa > 0 && estimatedGames > 0) {
    const winPct = (pf * pf) / ((pf * pf) + (pa * pa));
    const wins = Math.round(estimatedGames * winPct);
    out.CareerWins = Math.min(fieldMax(maddenFile, 'Coach', 'CareerWins'), wins);
    out.CareerLosses = Math.min(fieldMax(maddenFile, 'Coach', 'CareerLosses'), estimatedGames - wins);
  } else {
    // No points history to work from -- a genuinely recordless coach. Zero
    // is correct here, and coherent, because the copied career block is
    // also zero in this case.
    out.CareerWins = 0;
    out.CareerLosses = 0;
  }
  // Playoff W/L: CFB's CareerPlayoffsMade counts appearances, not results,
  // so there is no honest way to split it into wins and losses. Left at zero
  // deliberately -- appearances-with-no-results is a coherent state (a coach
  // who made the playoffs and lost the opener every time), unlike a 0-0
  // overall record next to a full career.
  out.CareerPlayoffWins = 0;
  out.CareerPlayoffLosses = 0;
  for (const f of ZERO_FIELDS_MADDEN_ONLY) out[f] = 0;

  return out;
}

// ===========================================================================
// Madden -> CFB (the reverse direction). Every helper this function calls
// (levelScale.js, archetypeMap.js's mapArchetypeMaddenToCfb, synthesis.js's
// synthesizeCoachBackstoryForCfb/synthesizeCfbProgramFields/
// synthesizeSpecialtyType, schemeLookup.js's 'maddenToCfb' direction,
// enumBridge.js's crossEnum, coachFieldMap.js's maddenToCfb column) already
// existed before this function was written -- the design work for this
// direction was done during the original field-mapping research; only the
// orchestrator was missing. See COACH_TRANSFER_AUDIT.md / PIPELINE_APP_
// INTEGRATION_SPEC.md for the write-round-trip verification that unblocked
// building this.
//
// Two real schema differences from the forward direction, not just a mirror:
//   - CFB's Coach table has NO CareerWins/CareerLosses/CareerPlayoffWins/
//     CareerPlayoffLosses fields at all (Q3's own finding, confirmed again
//     here) -- they are simply never written, not zeroed.
//   - CFB's ActiveTalentTree is NOT a "create a fresh row" situation the way
//     Madden's talent references are. Every CFB Coach row -- INCLUDING the
//     blank Level-0/TeamIndex-255 filler shells this lands on -- already owns
//     a fully private, pre-allocated ActiveTalentTree -> TalentSubTreeStatusList
//     -> 11x TalentSubTreeStatus chain (verified: zero sharing across 478
//     sampled coaches bar one incidental pair). So this field is never
//     touched here; granting a tree (cfbTalentTree.js) means writing VALUES
//     into the destination row's own already-existing chain, not allocating
//     new rows the way talentTree.js does for Madden.
//
// AlmaMater / HomeState / PrimaryPipeline are left UNSET on purpose -- the
// roadmap's own Q4/Q6 never reached a confident synthesis rule, and every
// blank landing shell already carries a plausible-looking (if arbitrary)
// value for all three. Writing a guessed replacement would be strictly worse
// than leaving what's already there, per this codebase's standing rule:
// leave unset rather than guess (see mapCoachCfbToMadden's own header for
// the same posture on GenericHeadAssetName/TeamPhilosophy).
const CFB_COPY_FIELDS = [
  'FirstName', 'LastName', 'Name', 'Age', 'Height', 'CharacterBodyType', 'Personality',
  'COACH_WASPLAYER', 'COACH_SPECIALTY', 'COACH_ADAPTIVE_AI', 'COACH_DEMEANOR', 'COACH_STANCE',
  'COACH_OFFTENDENCYRUNPASS', 'COACH_OFFTENDENCYAGGRESSCONSERV', 'COACH_DEFTENDENCYAGGRESSCONSERV',
  'COACH_DEFTENDENCYRUNPASS', 'COACH_RBTENDENCY', 'TeamBuilding', 'TradingTendency', 'TraitExpertScout',
  'CareerPointsFor', 'CareerPointsAgainst', 'CareerWinSeasons', 'CareerPlayoffsMade',
  'CareerLongWinStreak', 'CareerBigWinMargin', 'CareerBigLossMargin', 'AwardPoints', 'YearlyAwardCount',
];
for (const f of CFB_COPY_FIELDS) assertPlannedAction2(f, 'COPY');
assertPlannedAction2('YearsCoaching', 'COPY'); // clamped below, not a bare copy, but still declared COPY
for (const f of ['Position']) assertPlannedAction2(f, 'NAME');
for (const f of ['ContractStatus', 'CoachBackstory']) assertPlannedAction2(f, 'NAME');
assertPlannedAction2('Level', 'LOOKUP');
for (const f of ['PrevTeamIndex', 'PrevPosition', 'ExperiencePoints', 'SpecialtyType', 'DominantArchetype',
  'COACH_NO_HUDDLE_TEMPO', 'HatType', 'CoachPrestige', 'CoachPrestigeScore', 'CoachPoints',
  'CurrentJobSecurityStatus', 'SeasonStartJobSecurityStatus', 'CurrentJobSecurityPercentage']) {
  assertPlannedAction2(f, 'SYNTH');
}
for (const f of ['OffensiveScheme', 'DefensiveScheme']) assertPlannedAction2(f, 'LOOKUP');

// Same guard as mapCoachCfbToMadden's assertPlannedAction, checking the
// OTHER column -- kept as a separate function (not a shared parameterized
// one) so a typo in one direction's guard can never silently validate the
// other direction's assumption instead.
function assertPlannedAction2(field, expected) {
  const entry = getFieldMap(field);
  if (!entry) throw new Error(`mapCoachMaddenToCfb: "${field}" isn't in coachFieldMap.js at all.`);
  if (entry.maddenToCfb !== expected) {
    throw new Error(`mapCoachMaddenToCfb: coachFieldMap.js says ${field}.maddenToCfb = `
      + `"${entry.maddenToCfb}", but this function was written assuming "${expected}" -- `
      + 'the two have drifted; update whichever one is stale.');
  }
}

// maddenCoachRecord: a LIVE FranchiseFileRecord from the Madden Coach table.
// models: from buildCarouselModels({ ..., direction: 'maddenToCfb' }).
async function mapCoachMaddenToCfb({ maddenCoachRecord, cfbFile, models, config = {} }) {
  const maddenPosition = safe(maddenCoachRecord, 'Position');
  if (!HC_OC_DC.includes(maddenPosition)) {
    throw new Error(`mapCoachMaddenToCfb: cannot move a "${maddenPosition}" coach -- `
      + `only ${HC_OC_DC.join('/')} are supported.`);
  }

  const out = {};

  // --- Person core / shared scalars ---
  for (const f of CFB_COPY_FIELDS) out[f] = safe(maddenCoachRecord, f);

  // --- Job assignment: Mode A (free-agent injection) default ---
  out.Position = crossEnum({ destFile: cfbFile, destField: 'Position', sourceValue: maddenPosition });
  out.TeamIndex = 255; // CFB's unassigned sentinel (verified: TeamIndex range [0..255], filler shells all sit here)
  out.PrevTeamIndex = 255;
  out.ContractStatus = crossEnum({ destFile: cfbFile, destField: 'ContractStatus', sourceValue: 'FreeAgent' });
  out.ContractLength = 0;
  out.ContractYearsRemaining = 0;

  // --- Quality: Level, XP -- same percentile machinery, model built with direction:'maddenToCfb' ---
  const maddenLevel = safe(maddenCoachRecord, 'Level');
  const levelPercentile = pctOf(models.levelModel.byPosition[maddenPosition].source, maddenLevel);
  // Floor at CFB's own lowest real coach. Measured live (research/probe45):
  // CFB carries no coach below Level 10 with a talent tree -- coordinator
  // pools start at 10, head coaches at 21 -- so a mapped level under 10 has no
  // comparable donor to copy a tree from and would inherit one 9-20 levels too
  // strong. Clamping keeps every arrival inside the range the game actually
  // populates, which is also where donor matching is accurate.
  out.Level = Math.max(CFB_MIN_COACH_LEVEL, mapLevel(models.levelModel, maddenPosition, maddenLevel));
  out.ExperiencePoints = await synthesizeExperiencePoints({ destGame: 'cfb', destFile: cfbFile, destLevel: out.Level });

  // --- Archetype / specialty / backstory ---
  out.SpecialtyType = synthesizeSpecialtyType(safe(maddenCoachRecord, 'COACH_SPECIALTY'));
  const levelDest = models.levelModel.byPosition[maddenPosition].dest; // already winsorized CFB distribution
  const levelP70 = valueAt(levelDest, 0.70);
  const rng = archetypeRng(config.seed, maddenCoachRecord.index);
  // `position` matters: CFB's DominantArchetype is strongly position-
  // partitioned (Schemer/Recruiter/Motivator are coordinator-only; CEO and
  // ProgramBuilder are HC-only). See archetypeMap.js's own table.
  out.DominantArchetype = mapArchetypeMaddenToCfb({
    archetype: safe(maddenCoachRecord, 'Archetype'), level: out.Level, levelP70,
    position: out.Position,
    allowVarietyRoll: !!config.allowArchetypeVariety, rng,
  });
  out.CoachBackstory = crossEnum({
    destFile: cfbFile, destField: 'CoachBackstory',
    sourceValue: synthesizeCoachBackstoryForCfb(safe(maddenCoachRecord, 'CoachBackstory'), out.Position),
    fallback: 'Motivator',
  });

  // PrevPosition: best-effort from Madden's own OriginalPosition -- left
  // unset (not the coach's actual CFB history, which doesn't exist) if it
  // doesn't resolve to a valid CFB PrevPosition member for any reason.
  try {
    out.PrevPosition = crossEnum({
      destFile: cfbFile, destField: 'PrevPosition', sourceValue: safe(maddenCoachRecord, 'OriginalPosition'),
    });
  } catch (e) { /* leave unset */ }

  // --- CFB program-state fields (prestige, job security, CoachPoints, ...) ---
  // fromNfl:true -- centres prestige on P70 of the position cohort (locked
  // decision: a proven NFL coach starts above a from-scratch college hire).
  // levelPercentile spreads it by how good this coach actually is, so a
  // batch of arrivals no longer all come out with the identical grade.
  Object.assign(out, await synthesizeCfbProgramFields({
    cfbFile, position: out.Position, fromNfl: true, levelPercentile,
  }));

  // COACH_* position grades -- CFB's own all-zero convention (Q2's finding,
  // now applied in reverse: 0 is what CFB itself already does here).
  for (const f of COACH_GRADE_FIELDS) out[f] = 0;

  // YearsCoaching: COPY, clamped to CFB's live max (its schema allows up to
  // 127; Madden's own range is narrower, so this is rarely a real clamp, but
  // read live rather than assume).
  out.YearsCoaching = Math.min(fieldMax(cfbFile, 'Coach', 'YearsCoaching'), safe(maddenCoachRecord, 'YearsCoaching') || 0);

  // --- Schemes -- resolved via the live Madden index, then cross-named and
  // re-resolved via the live CFB index. Left unset if unresolvable, same
  // "don't guess" posture as the forward direction. crossSchemeName is
  // INSIDE the try (verified live: Madden's "Spread" defensive scheme has no
  // maddenToCfb crossing entry -- that failure must be exactly as
  // recoverable as "no CFB team runs the crossed-to scheme"). ---
  for (const [side2, maddenField, cfbField] of [['offensive', 'OffensiveScheme', 'OffensiveScheme'], ['defensive', 'DefensiveScheme', 'DefensiveScheme']]) {
    const rawMadden = safe(maddenCoachRecord, maddenField);
    const maddenName = resolveSchemeNameForCoach(models.maddenSchemeIndex, side2, rawMadden);
    if (!maddenName) continue;
    try {
      const crossed = crossSchemeName(maddenName, side2, 'maddenToCfb');
      out[cfbField] = lookupSchemeValue(models.cfbSchemeIndex, side2, crossed.name);
    } catch (e) {
      // No crossing entry for this scheme name, or no CFB team currently
      // runs the crossed-to scheme -- leave unset rather than abort the
      // whole coach's move over one cosmetic field.
    }
  }

  return out;
}

module.exports = {
  buildCarouselModels, mapCoachCfbToMadden, mapCoachMaddenToCfb, HC_OC_DC,
};
