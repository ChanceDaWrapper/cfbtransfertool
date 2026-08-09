// Headless entry point for the Coach Carousel UI (PIPELINE_APP_INTEGRATION_
// SPEC.md Part C.1, extended for the reverse direction per COACH_TRANSFER_
// AUDIT.md). Three functions, thin wrappers over the existing carousel
// modules -- no new engine logic lives here, only the plan/commit contract
// the app's IPC layer and UI need.
//
//   scanCoaches        -- read-only inventory of a CFB save's HC/OC/DC coaches.
//   scanMaddenCoaches  -- read-only inventory of a Madden save's HC/OC/DC coaches.
//   proposeMoves       -- computes a plan. DRY-RUN ONLY: never writes a byte.
//   commitMoves        -- writes the reviewed plan to a NEW output save.
//
// Both proposeMoves/commitMoves take `direction: 'cfbToMadden' | 'maddenToCfb'`
// (default 'cfbToMadden' for backward compatibility with the original
// single-direction build) and dispatch to a direction-specific implementation
// -- kept as separate functions rather than one heavily-branching function,
// since the two directions genuinely differ (different source table, different
// placement/talent/appearance modules, and maddenToCfb currently supports
// ONLY manual mode -- see its own header for why).
//
// Mirrors write-career's rule exactly: nothing here ever overwrites a source
// save in place. proposeMoves/commitMoves are deliberately separate calls so
// the UI can show a full plan (including WHY each blocked row is blocked)
// before anything is committed.
//
// Plan rows use `sourceRow` (not `cfbRow`) so the same shape works for either
// direction -- it's always "the row in whichever save the coach is coming
// FROM": a CFB Coach row for cfbToMadden, a Madden Coach row for maddenToCfb.

const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../saveIO');
const { buildCarouselModels } = require('./map');
const { planTeamPlacement } = require('./placeOnTeam');
const { planCfbTeamPlacement, countDisposableCfbSlots } = require('./placeOnCfbTeam');
const { moveCoachCfbToMaddenTeam, moveCoachMaddenToCfbTeam } = require('./index');
const { proposeCarousel, HC_OC_DC, MADDEN_FA_TEAM_INDEX } = require('./movement');
const { assertCfbTransferReady } = require('./preflight');
const { detectMaddenVersion, detectCfbVersion, describePairing } = require('./gameVersion');
const { cfbSkinTone, loadCfbTones, loadToneMap, headNumber } = require('./appearance');

// Resolved once, at the top of a run, before anything is read or written --
// so every later decision refers to one answer, and the log names the two
// builds in play. Returns the descriptors for the summary the UI shows.
function reportVersions(cfbFile, maddenFile, log) {
  const cfbVersion = detectCfbVersion(cfbFile);
  const maddenVersion = detectMaddenVersion(maddenFile);
  log(`Saves detected: ${describePairing(cfbVersion, maddenVersion)}`);
  return { cfbVersion, maddenVersion };
}

// TeamIndex -> school name, straight off the CFB Team table. Movement.js
// builds the same map internally (as part of its cohort-scoring context),
// but scanCoaches has no reason to pull in that whole context just for names.
async function cfbSchoolNames(cfbFile) {
  const teamT = biggestTableByName(cfbFile, 'Team');
  await teamT.readRecords();
  const names = new Map();
  for (const r of teamT.records) {
    if (r.isEmpty || !safe(r, 'DisplayName')) continue;
    names.set(safe(r, 'TeamIndex'), safe(r, 'DisplayName'));
  }
  return names;
}

// TeamIndex -> franchise name, off the Madden Team table -- same shape as
// cfbSchoolNames, for scanMaddenCoaches.
async function maddenTeamNames(maddenFile) {
  const teamT = biggestTableByName(maddenFile, 'Team');
  await teamT.readRecords();
  const names = new Map();
  for (const r of teamT.records) {
    if (r.isEmpty || !safe(r, 'DisplayName')) continue;
    names.set(safe(r, 'TeamIndex'), safe(r, 'DisplayName'));
  }
  return names;
}

// A coach's tone if transferred right now: an explicit override, else what
// their own head name encodes, else null ("would be guessed" -- see
// data/cfbCoachTones.json and appearance.js's sampleFallbackTone). Shared by
// scanCoaches and proposeMoves so both agree on the same coach.
function resolveTone(headAssetName, overridesMap, explicitTone) {
  if (typeof explicitTone === 'number') return { tone: explicitTone, toneWasGuessed: false };
  if (overridesMap.has(headAssetName)) return { tone: overridesMap.get(headAssetName), toneWasGuessed: false };
  const read = cfbSkinTone(headAssetName);
  return read === null ? { tone: null, toneWasGuessed: true } : { tone: read, toneWasGuessed: false };
}

// Same idea as resolveTone, for a MADDEN source head -- reads the measured
// tone map (data/coachHeadTones.json) instead of cfbSkinTone. No override
// file exists on this side (COACH_TRANSFER_AUDIT.md's L2/L1 gaps are CFB-
// side; Madden's only unmapped heads are the ~32 licensed likenesses, which
// simply have no tone to read -- same "guessed" outcome, smaller population).
function resolveMaddenTone(headAssetName, explicitTone) {
  if (typeof explicitTone === 'number') return { tone: explicitTone, toneWasGuessed: false };
  const tone = loadToneMap().get(headNumber(headAssetName));
  return typeof tone === 'number' ? { tone, toneWasGuessed: false } : { tone: null, toneWasGuessed: true };
}

// How many CharacterVisuals rows are free in the destination Madden save --
// every transferred coach with a granted appearance consumes one, permanently
// (COACH_TRANSFER_AUDIT.md P7). Returns { free: null, ok: true } if no coach
// in the save has a CharacterVisuals reference to find the table by (an
// empty/unusual save), rather than blocking on a check that can't run. Not
// applicable to a CFB destination -- CFB coach heads carry no CharacterVisuals
// loadout at all (appearance.js's own header), so maddenToCfb has no
// equivalent consumable resource to pre-check; its capacity constraint is the
// disposable-slot pool itself, already handled by findDisposableCfbSlot.
async function checkAppearanceHeadroom(maddenFile, neededCount) {
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await coachT.readRecords();
  let visualsTableId = null;
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    let ref; try { ref = r.getReferenceDataByKey('CharacterVisuals'); } catch (e) { ref = null; }
    if (ref && ref.tableId) { visualsTableId = ref.tableId; break; }
  }
  if (!visualsTableId) return { free: null, needed: neededCount, ok: true };
  const vt = maddenFile.getTableById(visualsTableId);
  await vt.readRecords();
  const free = vt.records.filter((r) => r.isEmpty).length;
  return { free, needed: neededCount, ok: neededCount <= free };
}

// ---------------------------------------------------------------------
// scanCoaches -- every HC/OC/DC in a CFB save, with the tone each would get
// if transferred right now. CFB-only; never opens a Madden save.
// ---------------------------------------------------------------------
async function scanCoaches(cfbPath) {
  const { cfbFile } = await openCfbSave(cfbPath);
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  const schools = await cfbSchoolNames(cfbFile);
  const { overrides } = loadCfbTones();

  const coaches = [];
  const counts = { HeadCoach: 0, OffensiveCoordinator: 0, DefensiveCoordinator: 0, toneKnown: 0, toneGuessed: 0 };
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const position = safe(r, 'Position');
    if (!HC_OC_DC.includes(position)) continue;
    const level = safe(r, 'Level');
    if (!level) continue; // blank filler shell (same exclusion movement.js uses)

    const head = String(safe(r, 'GenericHeadAssetName') || '');
    const { tone, toneWasGuessed } = resolveTone(head, overrides);
    counts[position] = (counts[position] || 0) + 1;
    counts[toneWasGuessed ? 'toneGuessed' : 'toneKnown']++;

    coaches.push({
      row: r.index, name: safe(r, 'Name'), position, level,
      school: schools.get(safe(r, 'TeamIndex')) || '(unassigned)',
      head, tone, toneWasGuessed,
    });
  }
  return { coaches, counts };
}

// ---------------------------------------------------------------------
// scanMaddenCoaches -- every HC/OC/DC in a Madden save, with the tone each
// would get if transferred to CFB right now (read from the measured
// coachHeadTones.json map, not a CFB name). Madden-only; never opens a CFB
// save. Feeds the Coach Carousel's Manual-mode coach picker when the
// direction is Madden -> CFB, the same role scanCoaches plays for the
// forward direction.
// ---------------------------------------------------------------------
async function scanMaddenCoaches(maddenPath) {
  const { maddenFile } = await openMaddenSave(maddenPath);
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await coachT.readRecords();
  const teams = await maddenTeamNames(maddenFile);

  const coaches = [];
  const counts = { HeadCoach: 0, OffensiveCoordinator: 0, DefensiveCoordinator: 0, toneKnown: 0, toneGuessed: 0 };
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const position = safe(r, 'Position');
    if (!HC_OC_DC.includes(position)) continue;
    const level = safe(r, 'Level');
    if (!level) continue;

    const head = String(safe(r, 'GenericHeadAssetName') || '');
    const { tone, toneWasGuessed } = resolveMaddenTone(head);
    counts[position] = (counts[position] || 0) + 1;
    counts[toneWasGuessed ? 'toneGuessed' : 'toneKnown']++;

    coaches.push({
      row: r.index, name: safe(r, 'Name'), position, level,
      school: teams.get(safe(r, 'TeamIndex')) || '(free agent)',
      head, tone, toneWasGuessed,
    });
  }
  return { coaches, counts };
}

// ---------------------------------------------------------------------
// proposeMoves -- computes a plan. Dispatches on config.direction.
// ---------------------------------------------------------------------
async function proposeMoves({ direction = 'cfbToMadden', cfbPath, maddenPath, config = {}, log = () => {} }) {
  if (direction === 'maddenToCfb') return proposeMovesMaddenToCfb({ cfbPath, maddenPath, config, log });
  return proposeMovesCfbToMadden({ cfbPath, maddenPath, config, log });
}

// CFB -> Madden. Two shapes:
//   config.mode === 'manual'  -- config.moves: [{ sourceRow, teamIndex?,
//     teamName? }] chosen by the caller (the UI's Manual mode).
//   otherwise ('auto')        -- movement.js's proposeCarousel picks who
//     moves and to which opening.
//
// Every candidate is run through placeOnTeam.js's planTeamPlacement, which
// computes only -- it never writes (only moveCoachCfbToMaddenTeam's real
// branch, called from commitMoves, does). Any failure it raises (the timing
// gate, schema validation, no disposable destination slot, ...) is caught
// here and turned into a blocked row instead of aborting the whole batch, so
// one bad coach never hides everyone else's valid moves.
async function proposeMovesCfbToMadden({ cfbPath, maddenPath, config = {}, log = () => {} }) {
  const { cfbFile } = await openCfbSave(cfbPath);
  const { maddenFile } = await openMaddenSave(maddenPath);
  const versions = reportVersions(cfbFile, maddenFile, log);
  // At PROPOSE time, before the movement engine reads a single coach. A CFB
  // save this tool cannot actually read produces an empty candidate list, and
  // "0 coaches proposed" looks like an empty dynasty rather than an
  // unreadable one -- the refusal names the real reason. Runs in this
  // direction too (where CFB is only the SOURCE), because an unreadable Coach
  // table breaks reading just as thoroughly as it breaks writing.
  assertCfbTransferReady(cfbFile, { what: 'this CFB dynasty', log });
  const schools = await cfbSchoolNames(cfbFile);
  const { overrides } = loadCfbTones();

  const candidates = []; // [{ sourceRow, teamIndex, teamName, why }]
  if (config.mode === 'manual' && Array.isArray(config.moves)) {
    for (const m of config.moves) {
      candidates.push({ sourceRow: m.sourceRow, teamIndex: m.teamIndex, teamName: m.teamName, why: 'manually selected' });
    }
  } else {
    const proposal = await proposeCarousel({ cfbFile, maddenFile, config });
    for (const c of proposal.cfbToNfl) {
      candidates.push({ sourceRow: c.coach.sourceRow, teamIndex: c.target.job.teamIndex, teamName: c.target.job.teamName, why: c.why });
    }
    log(`Movement engine: ${proposal.counts.cfbCandidatesConsidered} CFB candidates considered, `
      + `${proposal.counts.realNflJobs} NFL jobs scored, ${candidates.length} move(s) proposed.`);
  }

  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  const models = await buildCarouselModels({ cfbFile, maddenFile, winsor: config.winsor });

  // Rows claimed by earlier plans in THIS batch. Without this every coach is
  // handed the same best disposable row (all plans run against one unmodified
  // save), so the preview lied and an oversized batch only failed partway
  // through the commit. See findDisposableSlot's header.
  const claimedRows = new Set();

  const plan = [];
  for (const cand of candidates) {
    const cfbCoachRecord = coachT.records[cand.sourceRow];
    if (!cfbCoachRecord || cfbCoachRecord.isEmpty) {
      plan.push({
        sourceRow: cand.sourceRow, coach: '(unknown)', fromSchool: null, toTeam: cand.teamName, teamIndex: cand.teamIndex,
        position: null, level: null, tone: null, toneWasGuessed: false, displaces: null, destRow: null,
        blocked: `no coach at CFB Coach row ${cand.sourceRow}`, why: cand.why,
      });
      continue;
    }

    const coachName = safe(cfbCoachRecord, 'Name');
    const fromSchool = schools.get(safe(cfbCoachRecord, 'TeamIndex')) || '(unassigned)';
    const head = String(safe(cfbCoachRecord, 'GenericHeadAssetName') || '');
    const { tone, toneWasGuessed } = resolveTone(head, overrides, config.coachSkinTone);

    try {
      const placement = await planTeamPlacement({
        cfbCoachRecord, maddenFile, models,
        teamIndex: cand.teamIndex, teamName: cand.teamName,
        contractLength: config.contractLength, excludeRows: claimedRows, config,
      });
      claimedRows.add(placement.destRecord.index);
      plan.push({
        sourceRow: cand.sourceRow, coach: coachName, fromSchool,
        toTeam: placement.teamName, teamIndex: placement.teamIndex,
        position: placement.position, level: placement.mappedFields.Level,
        tone, toneWasGuessed,
        displaces: placement.incumbent ? { name: safe(placement.incumbent, 'Name'), row: placement.incumbent.index } : null,
        destRow: placement.destRecord.index,
        blocked: null, why: cand.why,
      });
    } catch (e) {
      plan.push({
        sourceRow: cand.sourceRow, coach: coachName, fromSchool,
        toTeam: cand.teamName, teamIndex: cand.teamIndex,
        position: safe(cfbCoachRecord, 'Position'), level: null,
        tone, toneWasGuessed, displaces: null, destRow: null,
        blocked: e.message, why: cand.why,
      });
    }
  }

  const includedCount = plan.filter((r) => !r.blocked).length;
  const headroom = await checkAppearanceHeadroom(maddenFile, config.skipAppearance ? 0 : includedCount);

  const summary = {
    total: plan.length,
    included: includedCount,
    blocked: plan.length - includedCount,
    toneGuessed: plan.filter((r) => !r.blocked && r.toneWasGuessed).length,
    cfbVersion: versions.cfbVersion,
    maddenVersion: versions.maddenVersion,
    visualsFree: headroom.free,
    visualsNeeded: headroom.needed,
    visualsOk: headroom.ok,
  };
  log(`Proposed ${summary.total} move(s): ${summary.included} ready, ${summary.blocked} blocked, `
    + `${summary.toneGuessed} tone-guessed.`
    + (headroom.ok ? '' : ` WARNING: only ${headroom.free} free CharacterVisuals rows for ${headroom.needed} needed.`));

  return { plan, summary, direction: 'cfbToMadden' };
}

// Madden -> CFB. Two shapes, same as the forward direction:
//   config.mode === 'manual'  -- config.moves: [{ sourceRow, teamIndex?,
//     teamName? }] chosen by the caller.
//   otherwise ('auto')        -- movement.js's proposeCarousel picks who
//     moves and to which school, using CFB's own CurrentJobSecurityPercentage
//     field (scoreCfbJobVulnerability) to find the jobs most likely to open.
async function proposeMovesMaddenToCfb({ cfbPath, maddenPath, config = {}, log = () => {} }) {
  const { cfbFile } = await openCfbSave(cfbPath);
  const { maddenFile } = await openMaddenSave(maddenPath);
  const versions = reportVersions(cfbFile, maddenFile, log);
  // Same check the commit path already runs (moveCoachMaddenToCfbTeam), pulled
  // forward to propose time. Without it an unreadable CFB save reaches the
  // planner and every row comes back "no disposable Coach row available",
  // which points at a full dynasty rather than an unreadable one.
  assertCfbTransferReady(cfbFile, { what: 'this CFB dynasty', log });
  const maddenT = biggestTableByName(maddenFile, 'Coach');
  await maddenT.readRecords();
  const teams = await maddenTeamNames(maddenFile);
  const models = await buildCarouselModels({ cfbFile, maddenFile, winsor: config.winsor, direction: 'maddenToCfb' });

  let moves;
  if (config.mode === 'manual' && Array.isArray(config.moves)) {
    moves = config.moves.map((m) => ({ sourceRow: m.sourceRow, teamIndex: m.teamIndex, teamName: m.teamName, why: 'manually selected' }));
  } else {
    const proposal = await proposeCarousel({ cfbFile, maddenFile, config });
    moves = proposal.nflToCfb.map((c) => ({
      sourceRow: c.coach.sourceRow, teamIndex: c.target.job.teamIndex, teamName: c.target.job.teamName, why: c.why,
    }));
    log(`Movement engine: ${proposal.counts.nflCandidatesConsidered} NFL candidates considered, `
      + `${proposal.counts.realCfbJobs} CFB jobs scored, ${moves.length} move(s) proposed.`);
  }

  // Same batch-claim bookkeeping as the forward direction -- see its own
  // comment, and findDisposableSlot's header.
  const claimedRows = new Set();

  const plan = [];
  for (const m of moves) {
    const maddenCoachRecord = maddenT.records[m.sourceRow];
    if (!maddenCoachRecord || maddenCoachRecord.isEmpty) {
      plan.push({
        sourceRow: m.sourceRow, coach: '(unknown)', fromSchool: null, toTeam: m.teamName, teamIndex: m.teamIndex,
        position: null, level: null, tone: null, toneWasGuessed: false, displaces: null, destRow: null,
        blocked: `no coach at Madden Coach row ${m.sourceRow}`, why: m.why,
      });
      continue;
    }

    const coachName = safe(maddenCoachRecord, 'Name');
    const head = String(safe(maddenCoachRecord, 'GenericHeadAssetName') || '');
    const { tone, toneWasGuessed } = resolveMaddenTone(head, config.coachSkinTone);
    // "From" for this direction is the coach's CURRENT NFL team, not a school
    // (they're leaving the NFL, not a college) -- mirrors the forward
    // direction's cfbSchoolNames lookup at line ~245, just against Madden's
    // Team table. 32 is Madden's free-agent-pool sentinel (placeOnTeam.js).
    const maddenTeamIndex = safe(maddenCoachRecord, 'TeamIndex');
    const fromTeam = maddenTeamIndex === 32 ? '(free agent)' : (teams.get(maddenTeamIndex) || '(unassigned)');

    try {
      const placement = await planCfbTeamPlacement({
        maddenCoachRecord, cfbFile, models,
        teamIndex: m.teamIndex, teamName: m.teamName,
        contractLength: config.contractLength, excludeRows: claimedRows, config,
      });
      claimedRows.add(placement.destRecord.index);
      plan.push({
        sourceRow: m.sourceRow, coach: coachName, fromSchool: fromTeam,
        toTeam: placement.teamName, teamIndex: placement.teamIndex,
        position: placement.position, level: placement.mappedFields.Level,
        tone, toneWasGuessed,
        displaces: placement.incumbent ? { name: safe(placement.incumbent, 'Name'), row: placement.incumbent.index } : null,
        destRow: placement.destRecord.index,
        blocked: null, why: m.why,
      });
    } catch (e) {
      plan.push({
        sourceRow: m.sourceRow, coach: coachName, fromSchool: fromTeam,
        toTeam: m.teamName, teamIndex: m.teamIndex,
        position: safe(maddenCoachRecord, 'Position'), level: null,
        tone, toneWasGuessed, displaces: null, destRow: null,
        blocked: e.message, why: m.why,
      });
    }
  }

  const includedCount = plan.filter((r) => !r.blocked).length;
  // Composition of the NFL coaching pool this plan drew from. Surfaced because
  // "(free agent)" on every row looks like a bug when it isn't: the movement
  // engine deliberately favours unemployed NFL coaches (see readNflCandidates),
  // and a save that has already had carousel moves committed into it carries a
  // visibly swollen free-agent pool -- one real example went 28/125 to 44/127
  // after ~16 incumbents were displaced. Reporting the numbers lets the user
  // judge whether the source save is the one they meant to use.
  let nflCoaches = 0;
  let nflFreeAgents = 0;
  for (const r of maddenT.records) {
    if (r.isEmpty || !safe(r, 'Name')) continue;
    if (!HC_OC_DC.includes(safe(r, 'Position'))) continue;
    nflCoaches++;
    if (safe(r, 'TeamIndex') === MADDEN_FA_TEAM_INDEX) nflFreeAgents++;
  }

  // CFB's equivalent of checkAppearanceHeadroom -- there's no CharacterVisuals
  // resource on this side, but there IS a consumable "disposable Coach row"
  // pool (findDisposableCfbSlot), and it's exactly what most maddenToCfb
  // batches actually run out of. Counted fresh (no exclusions), so this is
  // the save's whole starting budget for the batch, not what's left after it.
  const cfbSlotsFree = await countDisposableCfbSlots(cfbFile);
  const summary = {
    total: plan.length,
    included: includedCount,
    blocked: plan.length - includedCount,
    toneGuessed: plan.filter((r) => !r.blocked && r.toneWasGuessed).length,
    cfbVersion: versions.cfbVersion, maddenVersion: versions.maddenVersion,
    // No CharacterVisuals-style consumable resource on the CFB side -- see
    // checkAppearanceHeadroom's own header.
    visualsFree: null, visualsNeeded: 0, visualsOk: true,
    cfbSlotsFree, cfbSlotsNeeded: moves.length, cfbSlotsOk: moves.length <= cfbSlotsFree,
    nflCoaches, nflFreeAgents,
  };
  log(`Proposed ${summary.total} move(s) (Madden -> CFB): ${summary.included} ready, `
    + `${summary.blocked} blocked, ${summary.toneGuessed} tone-guessed.`
    + (summary.cfbSlotsOk ? '' : ` WARNING: only ${cfbSlotsFree} disposable CFB coach slot(s) `
      + `for ${moves.length} proposed move(s) -- try a smaller batch or advance a CFB season first.`));

  return { plan, summary, direction: 'maddenToCfb' };
}

// ---------------------------------------------------------------------
// commitMoves -- writes the REVIEWED plan (rows with no `blocked` reason and
// `included !== false`), one coach at a time, each chained onto the output
// the coach before it just wrote. Never writes to the source path in place.
// Dispatches on config.direction (the plan itself doesn't carry direction as
// a per-row field, so the caller must pass the same direction it proposed
// with -- main.js's IPC layer tracks this alongside the cached plan).
// ---------------------------------------------------------------------
async function commitMoves({ direction = 'cfbToMadden', plan, cfbPath, maddenPath, outputPath, config = {}, log = () => {} }) {
  if (direction === 'maddenToCfb') return commitMovesMaddenToCfb({ plan, cfbPath, maddenPath, outputPath, config, log });
  return commitMovesCfbToMadden({ plan, cfbPath, maddenPath, outputPath, config, log });
}

async function commitMovesCfbToMadden({ plan, cfbPath, maddenPath, outputPath, config = {}, log = () => {} }) {
  if (!outputPath) {
    throw new Error('commitMoves: outputPath is required -- this never overwrites the source Madden save in place.');
  }
  const rows = (plan || []).filter((r) => !r.blocked && r.included !== false);
  if (!rows.length) {
    log('Nothing to write -- every row is blocked or excluded.');
    return { written: 0, outputPath: null, results: [] };
  }

  const { cfbFile } = await openCfbSave(cfbPath);
  let currentMaddenPath = maddenPath;
  const results = [];
  for (const row of rows) {
    const { maddenFile } = await openMaddenSave(currentMaddenPath);
    const res = await moveCoachCfbToMaddenTeam({
      cfbFile, maddenFile,
      cfbCoachRowIndex: row.sourceRow,
      teamIndex: row.teamIndex, teamName: row.toTeam,
      contractLength: config.contractLength,
      outputPath, config, log,
    });
    results.push({
      sourceRow: row.sourceRow, coach: row.coach, teamName: res.teamName, position: res.position,
      destRow: res.destRow, displacedIncumbent: res.displacedIncumbent,
      appearanceReport: res.appearanceReport, appearanceError: res.appearanceError,
      clearedLoadouts: res.clearedLoadouts,
    });
    currentMaddenPath = outputPath; // chain -- the next coach builds on the file we just wrote
  }
  log(`Wrote ${results.length} coach(es) to ${outputPath}.`);
  return { written: results.length, outputPath, results };
}

async function commitMovesMaddenToCfb({ plan, cfbPath, maddenPath, outputPath, config = {}, log = () => {} }) {
  if (!outputPath) {
    throw new Error('commitMoves: outputPath is required -- this never overwrites the source CFB save in place.');
  }
  const rows = (plan || []).filter((r) => !r.blocked && r.included !== false);
  if (!rows.length) {
    log('Nothing to write -- every row is blocked or excluded.');
    return { written: 0, outputPath: null, results: [] };
  }

  const { maddenFile } = await openMaddenSave(maddenPath); // read-only source, opened once
  let currentCfbPath = cfbPath;
  const results = [];
  for (const row of rows) {
    const { cfbFile } = await openCfbSave(currentCfbPath);
    const res = await moveCoachMaddenToCfbTeam({
      cfbFile, maddenFile,
      maddenCoachRowIndex: row.sourceRow,
      teamIndex: row.teamIndex, teamName: row.toTeam,
      contractLength: config.contractLength,
      outputPath, config, log,
    });
    results.push({
      sourceRow: row.sourceRow, coach: row.coach, teamName: res.teamName, position: res.position,
      destRow: res.destRow, displacedIncumbent: res.displacedIncumbent,
      appearanceReport: res.appearanceReport, appearanceError: res.appearanceError,
    });
    currentCfbPath = outputPath; // chain
  }
  log(`Wrote ${results.length} coach(es) to ${outputPath}.`);
  return { written: results.length, outputPath, results };
}

module.exports = {
  scanCoaches, scanMaddenCoaches, proposeMoves, commitMoves,
  // Exported for direct unit testing (test/carouselRun.spec.js) -- both are
  // pure or fixture-testable without opening a real save, unlike the
  // functions above which require openCfbSave/openMaddenSave and are instead
  // validated against real saves (research/probe28/probe30), matching how
  // planTeamPlacement's own full orchestration is validated.
  resolveTone, resolveMaddenTone, checkAppearanceHeadroom,
};
