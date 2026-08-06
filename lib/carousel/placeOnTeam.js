// Mode B -- direct placement into a NAMED team/job (COACH_CAROUSEL_ROADMAP.md
// section 3.7's non-default mode). Mode A (place.js) puts a coach into the
// free-agent pool and leaves it to the destination game's own hiring system
// to pick them up; Mode B is for acting on a specific proposal from
// movement.js RIGHT NOW -- "put Freeman on the Giants" -- which means:
//
//   1. Displacing the incumbent into free agency (same-save, in place -- they
//      keep their own row/identity/career/appearance; only the fields that
//      describe their employment change).
//   2. Writing the new coach's mapped fields into a destination row.
//   3. Writing BOTH pointers that describe the new job: Coach.TeamIndex on
//      the new coach's row, AND the reciprocal Team.<slot> reference back at
//      them (Q8's locked decision -- always write both, no exceptions).
//
// Only same-kind hires are supported (a CFB HeadCoach becomes an NFL
// HeadCoach, never an OC) -- map/index.js's mapCoachCfbToMadden derives
// Level's cohort, Archetype, CareerAssistant, and IsMaxLevel all from the
// coach's OWN position, so `position` is read off the mapped result rather
// than accepted as a separate parameter that could disagree with it.
//
// HEAD COACH HIRES ARE TIMING-GATED (a locked product decision): a HeadCoach
// only goes in if the save is currently in Madden's own coach hiring/
// demand-release window (see timing.js) -- the real-world "right after Super
// Bowl week" carousel timing. OC/DC hires are NOT gated by this rule.

const { safe, biggestTableByName } = require('../saveIO');
const { findDisposableSlot } = require('./place');
const { mapCoachCfbToMadden } = require('./map');
const { enforceCoachHiringWindow } = require('./timing');
const { validateCoachFields, formatProblems } = require('./validate');

// A Signed coach with ContractSalary 0 is internally contradictory and a
// suspect in the rejected-save incident. Derives a salary from the live
// destination save's own coaches at a comparable Level, so the number sits
// inside the league's real distribution rather than being invented.
async function synthesizeContractSalary(maddenFile, position, level) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();
  const peers = [];
  for (const r of t.records) {
    if (r.isEmpty) continue;
    if (safe(r, 'Position') !== position) continue;
    if (safe(r, 'ContractStatus') !== 'Signed') continue;
    const salary = safe(r, 'ContractSalary');
    const lvl = safe(r, 'Level');
    if (typeof salary === 'number' && salary > 0 && typeof lvl === 'number') peers.push({ salary, lvl });
  }
  if (!peers.length) return 0;
  // Nearest-level peers, median of them -- robust to a single outlier salary.
  peers.sort((a, b) => Math.abs(a.lvl - level) - Math.abs(b.lvl - level));
  const near = peers.slice(0, Math.max(3, Math.ceil(peers.length * 0.2)));
  const salaries = near.map((p) => p.salary).sort((a, b) => a - b);
  return salaries[Math.floor(salaries.length / 2)];
}

// Resolves the destination Team row from an index, a name, or both. When BOTH
// are given they must point at the SAME team -- the previous version matched on
// either one independently and returned whichever came first in table order, so
// a caller passing teamIndex 25 + "Jets" (25 is actually the Commanders) got the
// Commanders silently, and the Jets kept their incumbent. A disagreement is now
// a loud error, never a coin flip on row order.
async function findMaddenTeam(maddenFile, { teamIndex, teamName } = {}) {
  const t = biggestTableByName(maddenFile, 'Team');
  await t.readRecords();
  const hasIndex = typeof teamIndex === 'number';
  const hasName = !!teamName;
  if (!hasIndex && !hasName) {
    throw new Error('findMaddenTeam: needs a teamIndex or teamName to resolve a destination team.');
  }

  let byIndex = null;
  let byName = null;
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const name = safe(r, 'DisplayName');
    if (!name) continue; // pseudo-teams (AFC/NFC/Free Agents) are never a real job
    if (hasIndex && safe(r, 'TeamIndex') === teamIndex) byIndex = r;
    if (hasName && String(name).toLowerCase() === String(teamName).toLowerCase()) byName = r;
  }

  if (hasIndex && !byIndex) throw new Error(`findMaddenTeam: no team with TeamIndex ${teamIndex}.`);
  if (hasName && !byName) throw new Error(`findMaddenTeam: no team named ${JSON.stringify(teamName)}.`);

  // Both supplied -- they must agree, or the caller has a bug we must not paper over.
  if (byIndex && byName && byIndex.index !== byName.index) {
    throw new Error(`findMaddenTeam: teamIndex ${teamIndex} is `
      + `${JSON.stringify(safe(byIndex, 'DisplayName'))}, but teamName is ${JSON.stringify(teamName)} `
      + `(TeamIndex ${safe(byName, 'TeamIndex')}). Pass consistent values, or just one.`);
  }
  return byIndex || byName;
}

async function findIncumbent(maddenFile, teamRecord, position) {
  const coachTable = biggestTableByName(maddenFile, 'Coach');
  await coachTable.readRecords();
  const coachTableIds = new Set((maddenFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  let ref; try { ref = teamRecord.getReferenceDataByKey(position); } catch (e) { ref = null; }
  if (!ref || !coachTableIds.has(ref.tableId)) return null;
  return coachTable.records[ref.rowNumber] || null;
}

// Fires the incumbent into the free-agent pool, in place -- a same-save
// field change, not a cross-game map (they were already a valid Madden
// coach). Returns what they looked like before, for the caller's log/report.
function displaceIncumbent(incumbentRecord, firedByTeamIndex) {
  if (!incumbentRecord) return null;
  const before = { row: incumbentRecord.index, name: safe(incumbentRecord, 'Name'), position: safe(incumbentRecord, 'Position') };
  incumbentRecord.ContractStatus = 'FreeAgent';
  incumbentRecord.TeamIndex = 32; // Madden's free-agent-pool sentinel
  incumbentRecord.PrevTeamIndex = firedByTeamIndex;
  incumbentRecord.ContractLength = 0;
  incumbentRecord.ContractYearsRemaining = 0;
  incumbentRecord.ContractSalary = 0;
  incumbentRecord.COACH_LASTTEAMFIRED = firedByTeamIndex;
  return before;
}

// A HeadCoach's three talent categories (Gameday/Playsheet/WearAndTear --
// see talentTree.js's header) aren't just a private tree; the Team record
// carries its OWN matching set of loadout slots (Team.GamedayLoadout /
// PlaysheetLoadout / WearAndTearLoadout -> TalentLoadoutSlot[] -> a
// TalentLoadoutSlot row with an IsLocked flag and a Talent reference) that
// hold whichever ability the coach personally equipped. Every Talent row is
// private to one coach (verified: no sharing between coaches, talentTree.js
// header) -- so once the HeadCoach changes, any slot still pointing at a
// Talent row is pointing at whoever just left the job.
//
// Found via COACH_TRANSFER_AUDIT.md L5 / COACH_FIDELITY_ROADMAP.md 4.4: the
// Giants' GamedayLoadout slot4 kept referencing the displaced coach's own
// talent row after a placement. CLEARING (not repointing) is the correct
// fix -- a freshly-hired coach hasn't equipped anything yet, same as any
// real new hire in an unmodified save; repointing would mean guessing which
// of the new coach's abilities plays the same role the old one's did, for
// no benefit over just leaving the slot unequipped.
const NULL_REFERENCE = '0'.repeat(32); // tableId=0/rowNumber=0 -- verified against a real save's own unequipped slots
const TEAM_LOADOUT_FIELDS = ['GamedayLoadout', 'PlaysheetLoadout', 'WearAndTearLoadout'];

async function clearStaleTeamLoadouts(maddenFile, teamRecord) {
  const cleared = [];
  for (const field of TEAM_LOADOUT_FIELDS) {
    let arrRef; try { arrRef = teamRecord.getReferenceDataByKey(field); } catch (e) { arrRef = null; }
    if (!arrRef) continue;
    const arrTable = maddenFile.getTableById(arrRef.tableId);
    if (!arrTable) continue;
    await arrTable.readRecords();
    const arrRec = arrTable.records[arrRef.rowNumber];
    if (!arrRec || arrRec.isEmpty) continue;

    const n = arrRec.arraySize || 0;
    for (let i = 0; i < n; i++) {
      let slotRef; try { slotRef = arrRec.getReferenceDataByKey(`TalentLoadoutSlot${i}`); } catch (e) { slotRef = null; }
      if (!slotRef) continue;
      const slotTable = maddenFile.getTableById(slotRef.tableId);
      if (!slotTable) continue;
      await slotTable.readRecords();
      const slotRec = slotTable.records[slotRef.rowNumber];
      if (!slotRec || slotRec.isEmpty) continue;

      let talentRef; try { talentRef = slotRec.getReferenceDataByKey('Talent'); } catch (e) { talentRef = null; }
      if (!talentRef || (talentRef.tableId === 0 && talentRef.rowNumber === 0)) continue; // already unequipped

      slotRec.Talent = NULL_REFERENCE;
      cleared.push({ field, slot: i });
    }
  }
  return cleared;
}

// Computes everything Mode B needs but does NOT write anything -- mirrors
// map/index.js's mapCoachCfbToMadden being pure-computation-only, so a
// dry-run caller (moveCoachCfbToMaddenTeam's config.dryRun) can inspect the
// plan before committing it.
// `excludeRows` -- rows already claimed by EARLIER plans in the same batch.
// Only a batch planner (run.js's proposeMoves) passes it; a single placement
// leaves it empty. See findDisposableSlot's header for what it prevents.
async function planTeamPlacement({ cfbCoachRecord, maddenFile, models, teamIndex, teamName, contractLength = 4, excludeRows = null, config = {} }) {
  const mapped = await mapCoachCfbToMadden({ cfbCoachRecord, maddenFile, models, config });
  const position = mapped.Position;

  // The gate: EVERY position's placement only happens right after Super Bowl
  // week (Madden's own coach hiring/demand-release window, see timing.js) --
  // HeadCoach, OffensiveCoordinator and DefensiveCoordinator alike. Checked
  // here -- the one choke point both a dry run and a real write pass through
  // -- so a dry run also reports "this can't happen right now" rather than
  // only the real write discovering it. An explicit
  // config.allowOffWindowHeadCoachHire overrides it for all three positions.
  await enforceCoachHiringWindow(maddenFile, position, config);

  const teamRecord = await findMaddenTeam(maddenFile, { teamIndex, teamName });
  const resolvedTeamIndex = safe(teamRecord, 'TeamIndex');
  const teamDisplayName = safe(teamRecord, 'DisplayName');

  const incumbent = await findIncumbent(maddenFile, teamRecord, position);
  // Destination row found BEFORE the incumbent is displaced -- their row must
  // not look free yet (excludeRowIndex is a defensive second guard).
  // findDisposableSlot (not findFreeAgentSlot) so an established coach is
  // never clobbered -- see its header for the incident that motivated it.
  const dest = await findDisposableSlot(maddenFile, position, {
    excludeRowIndex: incumbent ? incumbent.index : null,
    excludeRows,
  });
  const destRecord = dest.record;

  mapped.TeamIndex = resolvedTeamIndex;
  mapped.PrevTeamIndex = 32; // arriving from outside the league -- no prior NFL team
  mapped.ContractStatus = 'Signed';
  mapped.ContractLength = contractLength;
  mapped.ContractYearsRemaining = contractLength;
  mapped.ContractSalary = await synthesizeContractSalary(maddenFile, position, mapped.Level);

  // Refuse to hand the writer anything the destination schema won't accept.
  // This is the last line of defense before bytes change -- a rejected save
  // is far more expensive to diagnose than a thrown error here.
  const validation = validateCoachFields(maddenFile, mapped);
  if (!validation.ok) {
    throw new Error(`planTeamPlacement: mapped fields failed schema validation, refusing to write:\n${formatProblems(validation.problems)}`);
  }

  return {
    position, teamRecord, teamIndex: resolvedTeamIndex, teamName: teamDisplayName,
    incumbent, destRecord, destReason: dest.reason, mappedFields: mapped,
  };
}

module.exports = { findMaddenTeam, findIncumbent, displaceIncumbent, clearStaleTeamLoadouts, planTeamPlacement };
