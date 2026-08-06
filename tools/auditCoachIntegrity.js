// READ-ONLY diagnostic. Audits EVERY employed coach in a CFB dynasty for the
// signatures known to cause an advance-week crash, plus a generalized scan that
// can surface a NEW corruption pattern this app has never seen before -- built
// for the reported "coach transfer in preseason crashes, and FixCoachCrash
// doesn't catch it" bug, which findDamagedCoaches' single Count_ signal may not
// cover (that signal was built and verified against BOWL-WEEK transfers; a
// preseason transfer runs through a mostly-unvalidated code path -- see the
// header note in lib/carousel/timing.js: preseason has no timing gate at all
// for OC/DC, and a HeadCoach hire forced outside the hiring window via
// config.allowOffWindowHeadCoachHire has never been checked against any of
// this).
//
// Never writes anything, never opens with autoUnempty in a way that mutates
// state, and takes no --write flag on purpose -- this is forensic, not a
// repair tool. Point tools/FixCoachCrash.js or tools/repairTransferredCoaches.js
// at a save afterward if this finds something with a known fix.
//
// Usage:
//   node tools/auditCoachIntegrity.js "<path to a CFB 27 dynasty save>"
//
// Four independent checks, run against every currently-employed coach (not a
// pre-identified suspect list -- that's the point: this works even when we
// don't yet know which coach or which field is bad):
//
//   A. Count_ contract expectation      -- the KNOWN 0.2.1/0.2.2 signal.
//   B. Employment-field profile         -- cfbNormalize's other 5 fields,
//                                          checked against every employed
//                                          coach, not just ones A already
//                                          flagged.
//   C. Stale contract offers            -- cfbContractOffers's check, against
//                                          every employed coach's OWN pending
//                                          offers, not scoped to a known list.
//   D. Cross-table reference deviation  -- generalizes the scan that actually
//                                          found the 0.2.2 root cause
//                                          (probe46-coach-backrefs.js). Instead
//                                          of comparing a hand-picked suspect
//                                          list against a hand-picked control
//                                          group, it computes what EVERY
//                                          reference field into Coach normally
//                                          looks like across the WHOLE employed
//                                          population, then flags any coach who
//                                          disagrees with that norm. This is
//                                          the one capable of catching a
//                                          corruption shape nobody has seen yet.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const {
  findDamagedCoaches, employedPeersByPosition, buildEmploymentProfile, employmentProblems,
} = require('../lib/carousel/cfbNormalize');
const { findStaleOffers } = require('../lib/carousel/cfbContractOffers');

function coachLabel(r, teamT) {
  const team = teamT.records.find((t) => !t.isEmpty && safe(t, 'TeamIndex') === safe(r, 'TeamIndex'));
  return `${safe(r, 'Name') || '(unnamed)'} (${safe(r, 'Position')}, ${team ? safe(team, 'DisplayName') : '?'}, row ${r.index})`;
}

async function main() {
  const savePath = process.argv[2];
  if (!savePath) {
    console.log('Usage: node tools/auditCoachIntegrity.js "<path to a CFB 27 dynasty save>"');
    process.exitCode = 1;
    return;
  }

  console.log(`Opening ${savePath} ...`);
  const { cfbFile } = await openCfbSave(savePath);
  const coachT = biggestTableByName(cfbFile, 'Coach');
  const teamT = biggestTableByName(cfbFile, 'Team');
  await coachT.readRecords();
  await teamT.readRecords();

  const employed = coachT.records.filter((r) => !r.isEmpty
    && safe(r, 'TeamIndex') !== undefined && safe(r, 'TeamIndex') !== 255 && safe(r, 'Level') > 0);
  console.log(`Employed coaches: ${employed.length}\n`);

  const findings = new Map(); // row -> [ { check, detail } ]
  const flag = (r, check, detail) => {
    if (!findings.has(r.index)) findings.set(r.index, []);
    findings.get(r.index).push({ check, detail });
  };

  // --- A. Count_ contract expectation (the known 0.2.1/0.2.2 signal) --------
  const damagedA = findDamagedCoaches(coachT.records);
  for (const r of damagedA) flag(r, 'A', 'CurrentContractExpectation is Count_ (the free-agent "no goal" sentinel)');
  console.log(`[A] Count_ contract expectation: ${damagedA.length} coach(es)`);

  // --- B. Employment-field profile, checked against EVERY employed coach ---
  // Baseline excludes anyone already flagged by A, per cfbNormalize's own rule
  // against self-pollution -- otherwise damaged coaches could make their own
  // values look normal to each other.
  const damagedRowsA = new Set(damagedA.map((d) => d.index));
  const byPos = employedPeersByPosition(coachT.records, { excludeRows: [...damagedRowsA] });
  const profiles = new Map();
  for (const [pos, peers] of byPos) profiles.set(pos, buildEmploymentProfile(peers));
  let countB = 0;
  for (const r of employed) {
    const profile = profiles.get(safe(r, 'Position'));
    const problems = employmentProblems(r, profile);
    if (problems.length) {
      countB++;
      for (const p of problems) flag(r, 'B', `${p.field} = ${JSON.stringify(p.value)} (no other employed ${safe(r, 'Position')} holds this)`);
    }
  }
  console.log(`[B] Other employment-field mismatches: ${countB} coach(es)`);

  // --- C. Stale contract offers, checked for EVERY employed coach ----------
  const { stale: staleAll } = await findStaleOffers(cfbFile, { coachRows: employed.map((r) => r.index) });
  for (const s of staleAll) flag(s.coach, 'C', 'has a pending contract offer with no source school (StaffPersonTeam unset) -- the free-agent shape');
  console.log(`[C] Stale contract offers (no source school): ${staleAll.length} coach(es)`);

  // --- D. Cross-table reference deviation -----------------------------------
  console.log('[D] Scanning every table for references into Coach (this is the slow one)...');
  const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  const employedSet = new Set(employed.map((r) => r.index));

  // Tallied per (field, POSITION) -- not per field across the whole employed
  // population. A first version compared against the whole population and it
  // silently threw away the most useful signal: Team.HeadCoach/Offensive
  // Coordinator/DefensiveCoordinator each cap at ~33% of ALL employed coaches
  // no matter how healthy the save is, simply because a head coach, an OC and
  // a DC are three disjoint groups -- so "not referenced by Team.HeadCoach"
  // never crossed a 90% threshold even for a coordinator who obviously
  // shouldn't be. Scoping to same-position peers is exactly the profile
  // cfbNormalize.js already builds for the employment-field checks (B above);
  // this generalizes the same idea to cross-table references, and specifically
  // targets a plausible transfer bug this tool didn't otherwise cover: a coach
  // placed into a job whose Team record was never updated to point back.
  const positionOf = new Map(employed.map((r) => [r.index, safe(r, 'Position')]));
  const fieldStats = new Map(); // "field::position" -> { hit: Set(coachRow), pop: number }
  const tables = cfbFile.tables || [];
  for (const t of tables) {
    if (coachTableIds.has(t.header.tableId)) continue;
    let recs;
    try { await t.readRecords(); recs = t.records; } catch (e) { continue; }
    if (!recs || !recs.length) continue;
    const attrs = t.schema ? t.schema.attributes : [];
    if (!attrs.length) continue;

    for (const rec of recs) {
      if (rec.isEmpty) continue;
      for (const a of attrs) {
        let ref;
        try { ref = rec.getReferenceDataByKey(a.name); } catch (e) { continue; }
        if (!ref || !coachTableIds.has(ref.tableId)) continue;
        if (!employedSet.has(ref.rowNumber)) continue; // only care about employed coaches
        const pos = positionOf.get(ref.rowNumber);
        const key = `${t.name}.${a.name}::${pos}`;
        if (!fieldStats.has(key)) fieldStats.set(key, new Set());
        fieldStats.get(key).add(ref.rowNumber);
      }
    }
  }

  // Population size for each (field, position) key is the number of employed
  // coaches AT THAT POSITION, not the whole league.
  const posCounts = new Map();
  for (const r of employed) { const p = safe(r, 'Position'); posCounts.set(p, (posCounts.get(p) || 0) + 1); }

  // Only one direction is safe to flag: a field that ALMOST EVERY employed
  // coach AT THE SAME POSITION is referenced by, and this one specific coach
  // is not. The opposite direction -- almost no one has it -- was tried and
  // removed after testing on a real healthy save: it produced 20 false
  // positives (CoachAward.Coach, Franchise.LeagueOwner, TeamHistoricSeriesYear
  // .UserRef...), every one a legitimately rare-but-real signal (award
  // winners, the human-controlled team, historic records), which is exactly
  // the "uncommon in one save != a corruption marker" trap cfbNormalize.js's
  // header describes at length. The high-consensus-missing direction, scoped
  // per position, produced zero false positives on the same save -- and it is
  // the actual shape of the bug found before (StaffPersonContractOffer
  // .StaffPersonTeam: ~97% of employed coaches had it, the damaged ones didn't).
  // A minimum population guards against a 1- or 2-coach position (K, P, LS-
  // equivalent staff roles, if any) making "100% consensus" meaningless.
  const CONSENSUS_THRESHOLD = 0.9;
  const MIN_POPULATION = 5;
  let flaggedKeys = 0;
  for (const [key, hitSet] of fieldStats) {
    const [field, pos] = key.split('::');
    const pop = posCounts.get(pos) || 0;
    if (pop < MIN_POPULATION) continue;
    const hitFrac = hitSet.size / pop;
    if (hitFrac < CONSENSUS_THRESHOLD) continue;
    flaggedKeys++;
    for (const r of employed) {
      if (safe(r, 'Position') !== pos) continue;
      if (!hitSet.has(r.index)) flag(r, 'D', `NOT referenced by ${field}, though ${(hitFrac * 100).toFixed(0)}% of employed ${pos}s are`);
    }
  }
  console.log(`    ${fieldStats.size} (field, position) combination(s) found; ${flaggedKeys} had >=${CONSENSUS_THRESHOLD * 100}% consensus among >=${MIN_POPULATION} peers.`);
  console.log('    (full breakdown, for transparency -- this is what was actually scanned:)');
  const breakdown = [...fieldStats.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [key, hitSet] of breakdown) {
    const [field, pos] = key.split('::');
    const pop = posCounts.get(pos) || 0;
    console.log(`      ${field.padEnd(38)} [${pos}]  ${hitSet.size}/${pop} (${pop ? (hitSet.size / pop * 100).toFixed(1) : '?'}%)`);
  }
  console.log('');

  // --- Report ---------------------------------------------------------------
  if (!findings.size) {
    console.log('No anomalies found by any of the four checks. If this save still crashes on advance,');
    console.log('the cause is a pattern none of the known signals catch -- send this save so a fifth');
    console.log('check can be built from it, the same way check D itself was built from a prior crash.');
    return;
  }

  const sorted = [...findings.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`=== ${sorted.length} coach(es) flagged ===\n`);
  for (const [row, items] of sorted) {
    const r = coachT.records[row];
    console.log(coachLabel(r, teamT));
    const byCheck = new Map();
    for (const it of items) { if (!byCheck.has(it.check)) byCheck.set(it.check, []); byCheck.get(it.check).push(it.detail); }
    for (const [check, details] of byCheck) {
      console.log(`  [${check}] ${details.length === 1 ? details[0] : `${details.length} field(s):`}`);
      if (details.length > 1) for (const d of details) console.log(`        - ${d}`);
    }
    console.log('');
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
