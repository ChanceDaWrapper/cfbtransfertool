// Season Exit Population -- who permanently left college football, and why.
//
// Replaces the legacy extractLeavingPlayers population logic, which had two
// confirmed bugs: it admitted Transfer_* entries into the generated draft
// class (transfers are still in college), and its `LeaveType !== 'Invalid'`
// filter compared against the wrong string (the real enum value is
// 'Invalid_' with a trailing underscore) and so never actually filtered
// anything.
//
// Everything below is built from direct verification against a real CFB 27
// dynasty save at the Players-Leaving stage, not from the architecture-phase
// assumptions (two of which turned out to be wrong -- see the Regime C
// comment at the bottom of this file). Two regimes are implemented:
//
//   Regime A -- LeavingPlayer has usable EarlyNFL_* entries (the official
//               declared-draft-class stage).
//   Regime B -- LeavingPlayer has none yet (earlier dynasty stage) --
//               predict underclassman declarations from rosters instead.
//
// In BOTH regimes, graduating seniors come from the SAME source: a scan of
// currently-rostered Player rows with SchoolYear==='Senior'. Verified that
// LeavingPlayer's 'Graduation' LeaveType is never actually populated (0 of
// 270 entries on a real Players-Leaving-stage save), while 2,489 Senior-year
// players were still findable on FBS rosters at that exact save -- so the
// roster scan is the correct, and only verified, way to find them.

const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

// The real, observed LeaveType values for NFL early entrants. Verified
// against a real save (270/270 entries were one of these seven). Everything
// else the enum defines -- 'Graduation' (never observed populated),
// 'Transfer_*' (8 real reasons), 'Invalid_', and the enum's own internal
// bound-marker sentinels ('First_EarlyNFL_', 'Last_EarlyNFL_', etc.) -- is
// excluded by simply not being in this allowlist. An allowlist here is
// deliberately safer than a Transfer_*/Invalid_ blocklist: it can't silently
// admit a future enum member we haven't seen yet.
const EARLY_NFL_LEAVE_TYPES = new Set([
  'EarlyNFL_1', 'EarlyNFL_2', 'EarlyNFL_3', 'EarlyNFL_4',
  'EarlyNFL_5', 'EarlyNFL_6', 'EarlyNFL_7',
]);

function isFbsTeam(teamNames, teamIndex) {
  const name = teamNames[teamIndex];
  return !!name && !String(name).startsWith('FCS ');
}

async function readLeavingPlayerEntries(cfbFile) {
  const lp = cfbFile.getAllTablesByName('LeavingPlayer')[0];
  if (!lp) return { all: [], earlyNfl: [] };
  await lp.readRecords();
  const all = lp.records.filter((r) => !r.isEmpty);
  const earlyNfl = [];
  for (const entry of all) {
    let leaveType, ref;
    try { leaveType = entry.getValueByKey('LeaveType'); ref = entry.getReferenceDataByKey('Player'); }
    catch (e) { continue; }
    if (!ref || !EARLY_NFL_LEAVE_TYPES.has(leaveType)) continue;
    earlyNfl.push({ entry, ref, leaveType });
  }
  return { all, earlyNfl };
}

function scanRosteredSeniors(playerTable, teamNames) {
  const out = [];
  for (const prec of playerTable.records) {
    if (prec.isEmpty) continue;
    const yr = safe(prec, 'SchoolYear');
    if (yr !== 'Senior') continue;
    const teamIndex = safe(prec, 'TeamIndex');
    if (!isFbsTeam(teamNames, teamIndex)) continue;
    out.push(prec);
  }
  return out;
}

// Same draft-worthiness threshold the legacy synthesized branch used --
// proven-reasonable over this whole session's testing, not something Phase 1
// is trying to improve on.
function scanPredictiveJuniors(playerTable, teamNames, juniorOvrThreshold) {
  const out = [];
  for (const prec of playerTable.records) {
    if (prec.isEmpty) continue;
    const yr = safe(prec, 'SchoolYear');
    if (yr !== 'Junior') continue;
    const teamIndex = safe(prec, 'TeamIndex');
    if (!isFbsTeam(teamNames, teamIndex)) continue;
    const ovr = Number(safe(prec, 'OverallRating')) || 0;
    const dev = safe(prec, 'TraitDevelopment');
    const qualifies = ovr >= juniorOvrThreshold
      || dev === 'College_Elite'
      || (dev === 'College_Star' && ovr >= juniorOvrThreshold - 3);
    if (!qualifies) continue;
    out.push(prec);
  }
  return out;
}

// Engineering instrumentation, not a production feature. Logged whenever a
// dynasty is loaded through the exit-population path so real saves at
// different dynasty stages can be compared -- this is the intended way a
// season-scoping signal for Regime C eventually gets discovered (see the
// bottom of this file): watching how these counts (especially the
// TeamIndex==255 population) move across stages is the plan.
async function computeDiagnostics(cfbFile, playerTable, teamNames, { lpAll, earlyNfl, selection }) {
  let totalPlayerRows = 0, activeRostered = 0, seniors = 0, atTeamIndex255 = 0;
  for (const prec of playerTable.records) {
    if (prec.isEmpty) continue;
    totalPlayerRows++;
    const teamIndex = safe(prec, 'TeamIndex');
    if (teamIndex in teamNames) activeRostered++;
    if (teamIndex === 255) atTeamIndex255++;
    if (safe(prec, 'SchoolYear') === 'Senior') seniors++;
  }

  let transferCount = 0, invalidCount = 0;
  for (const entry of lpAll) {
    const leaveType = safe(entry, 'LeaveType');
    if (typeof leaveType === 'string' && leaveType.startsWith('Transfer_')) transferCount++;
    else if (leaveType === 'Invalid_') invalidCount++;
  }

  let recruitCount = 0;
  const recruitTable = cfbFile.getAllTablesByName('Recruit')[0];
  if (recruitTable) {
    await recruitTable.readRecords();
    recruitCount = recruitTable.records.filter((r) => !r.isEmpty).length;
  }

  return {
    totalPlayerRows, activeRostered, atTeamIndex255, seniors,
    leavingPlayerCount: lpAll.length,
    earlyNflCount: earlyNfl.length,
    transferCount, invalidCount, recruitCount,
    exitPopulationSize: selection.length,
  };
}

function formatDiagnostics(d) {
  return '[Rosetta diagnostics] '
    + `Player rows: ${d.totalPlayerRows} | active rostered: ${d.activeRostered} | at TeamIndex==255: ${d.atTeamIndex255} | `
    + `seniors: ${d.seniors} | LeavingPlayer: ${d.leavingPlayerCount} `
    + `(EarlyNFL: ${d.earlyNflCount}, Transfer: ${d.transferCount}, Invalid: ${d.invalidCount}) | `
    + `Recruit: ${d.recruitCount} | Exit Population: ${d.exitPopulationSize}`;
}

// Builds the Season Exit Population selection: a list of
// { prec, leaveType, projectRound, regime } entries, deduplicated by
// canonical row index (see rosetta/identity). Does NOT hydrate full player
// rows (bio fields, ratings, career stats, skin tone) -- that machinery
// already exists in pipeline.js's per-row hydration loop and is reused
// as-is, so this module owns only "who and why," never "what fields."
async function buildExitSelection(context) {
  const { cfbFile, teamNames, config = {}, log = () => {} } = context;
  const juniorOvrThreshold = config.juniorOvrThreshold ?? 85;

  const playerTable = cfbFile.getTableByName('Player');
  await playerTable.readRecords();

  const { all: lpAll, earlyNfl } = await readLeavingPlayerEntries(cfbFile);
  const regime = earlyNfl.length > 0 ? 'A' : 'B';

  const seenRows = new Set();
  const selection = [];

  // EarlyNFL_* entries go FIRST, seniors second. Verified against a real
  // save: 178 of 2,489 rostered seniors ALSO carry a real EarlyNFL_* entry
  // (an eligibility nuance -- e.g. a redshirt senior still using a "declare
  // early" slot) with a genuine game-assigned ProjectRound. Processing
  // seniors first would let the generic 'Graduating'/projectRound:null entry
  // win the seenRows dedup and silently discard that real ProjectRound,
  // which draft projection (projectDraftClass's roundBonus) reads. The more
  // informative source -- an explicit LeavingPlayer entry -- should always
  // win over the generic roster-scan fallback for the same player.
  if (regime === 'A') {
    for (const { ref, entry } of earlyNfl) {
      if (seenRows.has(ref.rowNumber)) continue;
      const prec = playerTable.records[ref.rowNumber];
      if (!prec || prec.isEmpty) continue;
      seenRows.add(ref.rowNumber);
      selection.push({ prec, leaveType: 'Declared', projectRound: safe(entry, 'ProjectRound'), regime });
    }
  } else {
    for (const prec of scanPredictiveJuniors(playerTable, teamNames, juniorOvrThreshold)) {
      if (seenRows.has(prec.index)) continue;
      seenRows.add(prec.index);
      selection.push({ prec, leaveType: 'Declared', projectRound: null, regime });
    }
  }

  // Seniors: identical source in both regimes (see file header). Anyone
  // already captured above (the overlap case) is skipped here, keeping
  // their richer EarlyNFL_* info intact.
  for (const prec of scanRosteredSeniors(playerTable, teamNames)) {
    if (seenRows.has(prec.index)) continue;
    seenRows.add(prec.index);
    selection.push({ prec, leaveType: 'Graduating', projectRound: null, regime });
  }

  const diagnostics = await computeDiagnostics(cfbFile, playerTable, teamNames, { lpAll, earlyNfl, selection });
  log(formatDiagnostics(diagnostics));

  return { selection, regime, diagnostics };
}

// ---------------------------------------------------------------------------
// Regime C -- Post-departure reconstruction. UNRESOLVED, NOT IMPLEMENTED.
// ---------------------------------------------------------------------------
// For a save where LeavingPlayer has no usable EarlyNFL_ entries AND the
// dynasty has already moved past this cycle's Players-Leaving stage (as
// opposed to Regime B, simply not having reached it yet), the originally
// planned signal was: scan Player rows at TeamIndex==255, cross-reference
// against Recruit (a departed player who reappears there transferred and is
// still in college -- exclude them), and treat the remainder as permanent
// departures.
//
// This is intentionally NOT implemented. Verified against a real
// Players-Leaving-stage save: 6,760 of ~11,000 Player rows already sit at
// TeamIndex==255. Player rows are never deleted, so 255 accumulates EVERY
// departure across the dynasty's entire history, not just the current
// season. Naively scanning it would return years of accumulated departures
// as if they all just left this cycle. No field has yet been found that
// scopes a departure to a specific season/year.
//
// Extension point: once a season-scoping signal is discovered, a
// buildPostDepartureSelection(context) function belongs HERE, returning the
// same { prec, leaveType, projectRound, regime: 'C' } shape the other two
// regimes use, and buildExitSelection()'s `regime` branch above gains a
// third arm. Nothing else in Rosetta needs to change to support it --
// population is the only consumer of the regime signal; frames,
// translation, draft reading, and dev traits all operate on the selection's
// row shape, not on how it was assembled.
//
// The diagnostics this module logs (computeDiagnostics/formatDiagnostics,
// especially `atTeamIndex255`) exist specifically to help find that signal:
// watching how these counts move across many saves at many dynasty stages is
// the intended discovery path.
function buildPostDepartureSelection() {
  throw new Error(
    'Regime C (post-departure reconstruction) is not implemented -- no verified '
    + 'season-scoping signal exists yet. See the comment above this function in '
    + 'lib/rosetta/population.js.'
  );
}

module.exports = {
  buildExitSelection,
  buildPostDepartureSelection,
  EARLY_NFL_LEAVE_TYPES,
  formatDiagnostics,
};
