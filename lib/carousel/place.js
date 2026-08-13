// The Staged stage (lifecycle.js) -- picks a destination row for a coach
// arriving via Mode A (free-agent injection, COACH_CAROUSEL_ROADMAP.md
// section 3.7, the default placement mode). Mode B (direct placement into a
// named team/job, with the reciprocal Team.<slot> write) is future work --
// this file only implements the timing-tolerant default.
//
// Preference order, most to least ideal:
//   1. An existing FreeAgent Coach row at the SAME mapped position -- keeps
//      whatever valid head/portrait/CharacterVisuals loadout that row
//      already has (map/index.js deliberately leaves appearance fields
//      unset so this carries through -- see its header).
//   2. Any existing FreeAgent Coach row, regardless of position.
//   3. A genuinely empty Coach row -- autoUnempty:true (already passed by
//      lib/saveIO.js's openMaddenSave) means assigning any field un-empties
//      it automatically; no separate "activate this row" call is needed.

const { safe, biggestTableByName } = require('../saveIO');

// excludeRowIndex: skip this specific row. Mode B (placeOnTeam.js) passes the
// incumbent's own row here as a defensive guard -- normally the search runs
// BEFORE the incumbent is displaced into free agency, so their row doesn't
// look free yet anyway, but a caller that reorders the steps must not have
// the new hire land back in the very row the incumbent was just moved out of.
async function findFreeAgentSlot(maddenFile, position, { excludeRowIndex = null } = {}) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();

  for (const r of t.records) {
    if (r.isEmpty || r.index === excludeRowIndex) continue;
    if (safe(r, 'ContractStatus') === 'FreeAgent' && safe(r, 'Position') === position) return r;
  }
  for (const r of t.records) {
    if (r.isEmpty || r.index === excludeRowIndex) continue;
    if (safe(r, 'ContractStatus') === 'FreeAgent') return r;
  }
  for (const r of t.records) {
    if (r.index === excludeRowIndex) continue;
    if (r.isEmpty) return r;
  }
  throw new Error(`findFreeAgentSlot: no free-agent or empty Coach row available in this Madden save `
    + `for position "${position}" (table capacity ${t.header.recordCapacity}).`);
}

// Picks a DISPOSABLE destination row -- one whose occupant can be overwritten
// without destroying a real coach or creating internal contradictions.
//
// This replaced findFreeAgentSlot for Mode B after a real incident: that
// function grabbed the first same-position free agent, which was H. Flohr --
// an established Level-3 coach with a 13-38 career record, a populated
// talent tree, and IndexInUnlockList=1. Writing a Level-48 DevelopmentWizard
// over him left the new coach holding a Level-3 OffensiveGuru talent tree
// (talent references are deliberately NOT written -- see map/index.js), and
// Madden refused to load the resulting save.
//
// Preference order, per the product rule ("take the oldest FA coach if
// they're 75+, or the youngest level-0 nobody"):
//   1. A free agent aged >= retirementAge (default 75) -- oldest first. A
//      coach at retirement age vacating the file is realistic attrition.
//   2. A "nobody": free agent, Level 0, AND no career record at all --
//      youngest first. The career-record test is what keeps licensed
//      legends safe: J. Madden sits at Level 0 as a free agent but carries a
//      real 103-32 record, so he is correctly never selected.
//   3. A genuinely empty row (isEmpty) -- 343 of them in the sample save.
//
// Deliberately NEVER falls back to "any free agent". Running out of
// disposable rows throws instead, because silently clobbering an
// established coach is exactly the failure this function exists to prevent.
// `excludeRows` (a Set or array of row indices) is what makes MULTI-COACH
// planning honest. Each plan runs against the same unmodified save, so
// without it every coach in a batch is handed the SAME best disposable row.
// That had two consequences, both real:
//   - a plan's reported destRow was wrong for every coach after the first
//     (the commit path re-plans against the chained save, so the WRITES were
//     always correct -- it was the preview that lied);
//   - a batch could not detect running out of landing slots at plan time, so
//     an oversized batch would fail PARTWAY THROUGH the commit, after some
//     coaches had already been written to the output save.
// Callers planning a batch pass the rows they've already claimed.
async function findDisposableSlot(maddenFile, position, { retirementAge = 75, excludeRowIndex = null, excludeRows = null } = {}) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();

  const excluded = new Set(excludeRows || []);
  if (excludeRowIndex !== null && excludeRowIndex !== undefined) excluded.add(excludeRowIndex);
  const usable = (r) => !excluded.has(r.index);

  const live = t.records.filter((r) => !r.isEmpty && usable(r));
  const freeAgents = live.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent');

  const byAge = (a, b) => (safe(a, 'Age') || 0) - (safe(b, 'Age') || 0);

  // 1. Retirement-age free agents, oldest first.
  const retiring = freeAgents
    .filter((r) => (safe(r, 'Age') || 0) >= retirementAge)
    .sort((a, b) => byAge(b, a));
  if (retiring.length) return { record: retiring[0], reason: `free agent at retirement age (${safe(retiring[0], 'Age')})` };

  // 2. Level-0 nobodies with no career record, youngest first.
  const nobodies = freeAgents
    .filter((r) => (safe(r, 'Level') || 0) === 0
      && (safe(r, 'CareerWins') || 0) === 0
      && (safe(r, 'CareerLosses') || 0) === 0)
    .sort(byAge);
  if (nobodies.length) {
    const pick = nobodies[0];
    const name = safe(pick, 'Name');
    return { record: pick, reason: `level-0 free agent with no career record${name ? ` (${name})` : ' (unnamed shell)'}` };
  }

  // 3. A genuinely empty row.
  const empty = t.records.find((r) => r.isEmpty && usable(r));
  if (empty) return { record: empty, reason: 'empty Coach row' };

  throw new Error('findDisposableSlot: no disposable Coach row available (no retirement-age free agent, '
    + 'no level-0 nobody, no empty row). Refusing to overwrite an established coach.');
}

// A plausible salary for an arriving coach, synthesized from the destination
// save's OWN signed coaches at the same position: take the peers nearest this
// coach's level, then the MEDIAN of that group -- robust to one absurd outlier
// contract in a way a mean is not. 0 when the save has no signed peer at all
// to learn from, which callers treat as "leave the field alone".
//
// Deliberately game-agnostic and shared. This lived twice, once in
// placeOnTeam.js and once in placeOnCfbTeam.js, byte-identical apart from the
// function name, the parameter name, and one comment. Nothing in it is
// Madden- or CFB-specific: both games' Coach tables carry Position,
// ContractStatus, ContractSalary and Level with the same meanings, and the
// caller has already resolved `position` into the destination game's own
// vocabulary before calling. Two copies of one rule is two places for a future
// tweak to land in only one of.
async function synthesizeContractSalary(file, position, level) {
  const t = biggestTableByName(file, 'Coach');
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
  peers.sort((a, b) => Math.abs(a.lvl - level) - Math.abs(b.lvl - level));
  const near = peers.slice(0, Math.max(3, Math.ceil(peers.length * 0.2)));
  const salaries = near.map((p) => p.salary).sort((a, b) => a - b);
  return salaries[Math.floor(salaries.length / 2)];
}

module.exports = { findFreeAgentSlot, findDisposableSlot, synthesizeContractSalary };
