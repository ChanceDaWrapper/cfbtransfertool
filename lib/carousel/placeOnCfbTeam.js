// Mode B for the REVERSE direction -- placing a Madden coach directly onto a
// NAMED CFB school's job, mirroring placeOnTeam.js's own structure exactly
// (findMaddenTeam -> findCfbTeam, findIncumbent -> findCfbIncumbent,
// displaceIncumbent -> displaceCfbIncumbent, findDisposableSlot ->
// findDisposableCfbSlot, planTeamPlacement -> planCfbTeamPlacement).
//
// Kept as a SEPARATE file rather than generalizing placeOnTeam.js's own
// (tested, production) functions, for two reasons:
//   1. displaceIncumbent hardcodes Madden's free-agent sentinel (TeamIndex
//      32); CFB's is 255 -- a real behavioral difference, not just naming.
//   2. Zero risk to the existing, tested Madden-side functions and their
//      spec file (carouselPlaceOnTeam.spec.js references them by these exact
//      names).
//
// CFB's own ContractStatus enum has a 'FreeAgent' member (verified), and
// CFB's Team table carries the same HeadCoach/OffensiveCoordinator/
// DefensiveCoordinator slot fields as Madden's, so the underlying shape is
// identical -- only the sentinel values differ.

const { safe, biggestTableByName } = require('../saveIO');
const { mapCoachMaddenToCfb } = require('./map');
const { enforceCoachHiringWindow } = require('./timing');
const { validateCoachFields, formatProblems } = require('./validate');
const { synthesizeContractSalary } = require('./place');

const CFB_UNASSIGNED_TEAM_INDEX = 255; // verified: every CFB free-agent/filler coach sits here, range [0..255]

// Resolves a destination CFB Team record from an index, a name, or both --
// same disagreement guard as findMaddenTeam (the Jets/Commanders incident):
// if both are given they must resolve to the SAME team, or this throws
// rather than silently picking whichever matched first in table order.
async function findCfbTeam(cfbFile, { teamIndex, teamName } = {}) {
  const t = biggestTableByName(cfbFile, 'Team');
  await t.readRecords();
  const hasIndex = typeof teamIndex === 'number';
  const hasName = !!teamName;
  if (!hasIndex && !hasName) {
    throw new Error('findCfbTeam: needs a teamIndex or teamName to resolve a destination school.');
  }

  let byIndex = null;
  let byName = null;
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const name = safe(r, 'DisplayName');
    if (!name) continue;
    if (hasIndex && safe(r, 'TeamIndex') === teamIndex) byIndex = r;
    if (hasName && String(name).toLowerCase() === String(teamName).toLowerCase()) byName = r;
  }

  if (hasIndex && !byIndex) throw new Error(`findCfbTeam: no school with TeamIndex ${teamIndex}.`);
  if (hasName && !byName) throw new Error(`findCfbTeam: no school named ${JSON.stringify(teamName)}.`);
  if (byIndex && byName && byIndex.index !== byName.index) {
    throw new Error(`findCfbTeam: teamIndex ${teamIndex} is `
      + `${JSON.stringify(safe(byIndex, 'DisplayName'))}, but teamName is ${JSON.stringify(teamName)} `
      + `(TeamIndex ${safe(byName, 'TeamIndex')}). Pass consistent values, or just one.`);
  }
  return byIndex || byName;
}

// Resolves the coach a CFB team's slot reference points at -- null for a
// vacant slot or a dangling/foreign-table reference.
async function findCfbIncumbent(cfbFile, teamRecord, position) {
  const coachTable = biggestTableByName(cfbFile, 'Coach');
  await coachTable.readRecords();
  const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  let ref; try { ref = teamRecord.getReferenceDataByKey(position); } catch (e) { ref = null; }
  if (!ref || !coachTableIds.has(ref.tableId)) return null;
  return coachTable.records[ref.rowNumber] || null;
}

// Fires the incumbent into CFB's free-agent pool, in place. Mirrors
// displaceIncumbent exactly except the sentinel (255, not 32) and field
// names present on CFB's Coach schema (no COACH_LASTTEAMFIRED there --
// that's Madden-only; CFB has no equivalent field to record it in).
function displaceCfbIncumbent(incumbentRecord, firedBySchoolIndex) {
  if (!incumbentRecord) return null;
  const before = { row: incumbentRecord.index, name: safe(incumbentRecord, 'Name'), position: safe(incumbentRecord, 'Position') };
  incumbentRecord.ContractStatus = 'FreeAgent';
  incumbentRecord.TeamIndex = CFB_UNASSIGNED_TEAM_INDEX;
  incumbentRecord.PrevTeamIndex = firedBySchoolIndex;
  incumbentRecord.ContractLength = 0;
  incumbentRecord.ContractYearsRemaining = 0;
  return before;
}

// Shared scan behind both findDisposableCfbSlot (picks one) and
// countDisposableCfbSlots (reports how many exist, for a pre-flight check --
// see run.js). Same preference order and reasoning as place.js's
// findDisposableSlot (the H. Flohr incident): never overwrite an established
// coach.
//   1. A free agent at retirement age, oldest first.
//   2. A "nobody": a free agent with no career signal at all (CFB has no
//      CareerWins/CareerLosses field -- CareerPointsFor/Against is the
//      closest signal, both zero for a genuine shell), under a Level ceiling.
//   3. A genuinely empty row.
// `excludeRows` mirrors findDisposableSlot's own option -- see its header for
// why multi-coach planning needs it (honest destRow previews, and detecting
// an oversized batch at PLAN time instead of failing partway through a
// commit that has already written earlier coaches).
async function disposableCfbSlotCandidates(cfbFile, { retirementAge = 75, disposableLevelCeiling = 15, excludeRowIndex = null, excludeRows = null } = {}) {
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();

  const excluded = new Set(excludeRows || []);
  if (excludeRowIndex !== null && excludeRowIndex !== undefined) excluded.add(excludeRowIndex);
  const usable = (r) => !excluded.has(r.index);

  const live = t.records.filter((r) => !r.isEmpty && usable(r));
  const freeAgents = live.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent');

  const byAge = (a, b) => (safe(a, 'Age') || 0) - (safe(b, 'Age') || 0);

  // Some free-agent rows read isEmpty:false but are, in every practical
  // sense, blank: no Name AND a zeroed ActiveTalentTree reference
  // ({tableId:0, rowNumber:0} -- not a real table). Verified live: of 68
  // "level-0 nobody" candidates in the sample save, 64 have a real, usable
  // talent chain and 4 don't -- and the 4 broken ones are exactly the 4 with
  // a blank Name. grantCfbTalentTree needs the destination's OWN chain to
  // already exist (see its header -- CFB never allocates one, unlike
  // Madden's talent tree), so a row without one must never be selected here.
  const hasUsableChain = (r) => {
    if (!safe(r, 'Name')) return false;
    let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { return false; }
    return !!(ref && ref.tableId);
  };

  const retiringAll = freeAgents.filter((r) => (safe(r, 'Age') || 0) >= retirementAge);
  const retiring = retiringAll.filter(hasUsableChain).sort((a, b) => byAge(b, a));

  // Tier 2 -- a "nobody": a free agent with NO career record. The real signal
  // is the zeroed career, not the Level. Requiring Level === 0 exactly was too
  // literal: measured live (research/probe44), CFB seeds its unemployed filler
  // coordinators at Level 10-12 with a completely blank career, so a save could
  // hold 41 perfectly disposable coaches and still report ZERO landing slots --
  // which is what made NFL -> CFB moves fail outright on two of three test
  // dynasties. `disposableLevelCeiling` keeps this from ever reaching an
  // established coach (in the same save, real coaches sat at Level 31+, well
  // clear of the 15 default).
  const nobodiesAll = freeAgents.filter((r) => (safe(r, 'Level') || 0) <= disposableLevelCeiling
    && (safe(r, 'CareerPointsFor') || 0) === 0
    && (safe(r, 'CareerPointsAgainst') || 0) === 0);
  // Weakest first, so the least valuable row goes before the more developed one.
  const nobodies = nobodiesAll.filter(hasUsableChain)
    .sort((a, b) => (safe(a, 'Level') || 0) - (safe(b, 'Level') || 0) || byAge(b, a));

  // A genuinely empty row (isEmpty:true) has never been populated, so it has
  // no ActiveTalentTree reference of its own -- confirmed live: 0 of the 135
  // empty rows in the sample save are pre-wired with a chain. Selecting one
  // here used to look like a working fallback (a real Coach row) but was
  // actually a silent dead end: grantCfbTalentTree can't write into a chain
  // that doesn't exist, so the coach would land with the exact "Level 1 / no
  // abilities" failure this whole talent system exists to prevent (see
  // talentTree.js's header). hasUsableChain is required here too, so this
  // tier is honest about being unusable rather than degrading silently.
  const emptyAll = t.records.filter((r) => r.isEmpty && usable(r));
  const empty = emptyAll.filter(hasUsableChain);

  return {
    retiring, retiringTotal: retiringAll.length,
    nobodies, nobodiesTotal: nobodiesAll.length,
    empty, emptyTotal: emptyAll.length,
  };
}

async function findDisposableCfbSlot(cfbFile, position, opts = {}) {
  const c = await disposableCfbSlotCandidates(cfbFile, opts);
  if (c.retiring.length) return { record: c.retiring[0], reason: `free agent at retirement age (${safe(c.retiring[0], 'Age')})` };
  if (c.nobodies.length) {
    const pick = c.nobodies[0];
    return { record: pick, reason: `free agent with no career record (${safe(pick, 'Name')}, Level ${safe(pick, 'Level')})` };
  }
  if (c.empty.length) return { record: c.empty[0], reason: 'empty Coach row' };

  throw new Error('findDisposableCfbSlot: no disposable Coach row available in this CFB save '
    + `(0 usable of ${c.retiringTotal} retirement-age free agent(s), 0 usable of ${c.nobodiesTotal} `
    + `career-less free agent(s), 0 usable of ${c.emptyTotal} empty row(s) -- each was already claimed `
    + 'earlier in this batch, lacks a talent-tree reference, or the Coach table is genuinely full). '
    + 'Refusing to place a coach onto a row that would leave them with no talent tree. Try a smaller '
    + 'batch, or advance a season or two in CFB so retirements and firings replenish the pool.');
}

// Pre-flight count for the UI/summary (run.js) -- how many CFB coach rows are
// SAFELY reusable right now, without picking or claiming any of them. Lets
// the app show "N usable CFB slots" before a batch runs headfirst into
// findDisposableCfbSlot's throw for every single move.
async function countDisposableCfbSlots(cfbFile, opts = {}) {
  const c = await disposableCfbSlotCandidates(cfbFile, opts);
  return c.retiring.length + c.nobodies.length + c.empty.length;
}

// A Signed coach with ContractSalary 0 is internally contradictory -- the
// exact class of bug that produced the original Madden corruption incident.
// CFB's Coach schema DOES have a ContractSalary field (int, [0..16383],
// verified) -- it is not Madden-only, so this cannot be skipped on this side.
//
// The synthesis itself lives in place.js and is shared with the Madden path.
// It used to be duplicated here, byte-identical apart from the name -- see
// that function's comment.

// PrimaryPipeline -- the recruiting territory a coach personally works.
// (Q6 in the roadmap, left unwritten until now; confirmed in-game that an
// arriving coach was showing the destination row's unset default, "Alabama",
// while a real coach beside him showed "Southern California".)
//
// Verified live: pipeline is a property of the COACH, not the school -- a
// single school's three coaches routinely hold three different ones
// (Alabama: MetroAtlanta / SouthernCalifornia / Missouri). So there is no
// "this school's pipeline" to look up. What IS available and defensible is
// the territory the job's PREVIOUS occupant worked: a program keeps
// recruiting where it recruits, and inheriting it is both realistic and
// entirely live-derived -- no hardcoded geography table, matching how every
// other value in this engine is sourced.
//
// Order: the displaced incumbent's own pipeline, else any other coach on the
// same staff, else leave unset (never invent one).
async function derivePipeline(cfbFile, teamRecord, incumbent) {
  const fromIncumbent = incumbent ? safe(incumbent, 'PrimaryPipeline') : null;
  if (fromIncumbent && fromIncumbent !== 'Invalid_') return { value: fromIncumbent, source: 'the outgoing coach' };

  const coachTable = biggestTableByName(cfbFile, 'Coach');
  await coachTable.readRecords();
  const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
    let ref; try { ref = teamRecord.getReferenceDataByKey(slot); } catch (e) { ref = null; }
    if (!ref || !coachTableIds.has(ref.tableId)) continue;
    const peer = coachTable.records[ref.rowNumber];
    if (!peer || peer.isEmpty) continue;
    const p = safe(peer, 'PrimaryPipeline');
    if (p && p !== 'Invalid_') return { value: p, source: `a staff peer (${safe(peer, 'Name')})` };
  }
  return { value: null, source: null };
}

// Computes everything Mode B needs for the CFB direction but does NOT write
// anything -- mirrors planTeamPlacement's pure-compute contract exactly, so
// a dry-run caller can inspect the plan before committing.
// `excludeRows` -- rows already claimed by EARLIER plans in the same batch,
// same contract as planTeamPlacement's own. See findDisposableSlot's header.
async function planCfbTeamPlacement({ maddenCoachRecord, cfbFile, models, teamIndex, teamName, contractLength = 4, excludeRows = null, config = {} }) {
  const mapped = await mapCoachMaddenToCfb({ maddenCoachRecord, cfbFile, models, config });
  const position = mapped.Position;

  // Same coach hiring-window gate as the forward direction, now covering
  // every position (see timing.js) -- CFB's own SeasonInfo carries the
  // identical flag names (verified live), so timing.js works against a CFB
  // save completely unmodified.
  await enforceCoachHiringWindow(cfbFile, position, config);

  const teamRecord = await findCfbTeam(cfbFile, { teamIndex, teamName });
  const resolvedTeamIndex = safe(teamRecord, 'TeamIndex');
  const teamDisplayName = safe(teamRecord, 'DisplayName');

  const incumbent = await findCfbIncumbent(cfbFile, teamRecord, position);
  const dest = await findDisposableCfbSlot(cfbFile, position, {
    excludeRowIndex: incumbent ? incumbent.index : null,
    excludeRows,
  });
  const destRecord = dest.record;

  mapped.TeamIndex = resolvedTeamIndex;
  mapped.PrevTeamIndex = CFB_UNASSIGNED_TEAM_INDEX; // arriving from outside CFB -- no prior school
  // 'Signed' is a valid ContractStatus enum member but NOT what CFB actually
  // uses for a real, employed coach -- verified live: 0 of 493 coaches in
  // this save are ever 'Signed'; every one of the 275 real employed coaches
  // (Level>30, a real TeamIndex) reads 'First_Active'. Writing 'Signed'
  // would be the exact class of out-of-distribution value that produced the
  // original Madden corruption incident, just on the CFB side this time.
  mapped.ContractStatus = 'First_Active';
  mapped.ContractLength = contractLength;
  mapped.ContractYearsRemaining = contractLength;
  // ContractSalary is essentially unpopulated in CFB (1 of 493 coaches ever
  // nonzero) -- so unlike Madden, 0 here is the CORRECT, in-distribution
  // value, not a contradiction. synthesizeContractSalary still runs (in
  // case a save genuinely does have salary data) but naturally returns 0
  // against a save like this one, which is exactly right.
  mapped.ContractSalary = await synthesizeContractSalary(cfbFile, position, mapped.Level);

  // Recruiting territory -- needs the destination TEAM, which the field
  // mapper never sees, so it is resolved here rather than in
  // mapCoachMaddenToCfb. Left unset if nothing on the staff has one, per this
  // engine's standing rule: leave unset rather than invent.
  const pipeline = await derivePipeline(cfbFile, teamRecord, incumbent);
  if (pipeline.value) mapped.PrimaryPipeline = pipeline.value;

  const validation = validateCoachFields(cfbFile, mapped);
  if (!validation.ok) {
    throw new Error(`planCfbTeamPlacement: mapped fields failed schema validation, refusing to write:\n${formatProblems(validation.problems)}`);
  }

  return {
    position, teamRecord, teamIndex: resolvedTeamIndex, teamName: teamDisplayName,
    incumbent, destRecord, destReason: dest.reason, mappedFields: mapped,
    pipelineSource: pipeline.source,
  };
}

module.exports = {
  CFB_UNASSIGNED_TEAM_INDEX,
  findCfbTeam, findCfbIncumbent, displaceCfbIncumbent, findDisposableCfbSlot, countDisposableCfbSlots,
  planCfbTeamPlacement,
};
