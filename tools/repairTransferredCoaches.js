// Repairs a CFB dynasty that CRASHES on advance after a Madden -> CFB coach
// transfer made by an older build of this app.
//
// THE DAMAGE. Those builds landed an arriving coach on a disposable
// free-agent shell and promoted them to an employed coach while leaving
// values that only make sense for someone WITHOUT a job -- above all
// CurrentContractExpectation = Count_, the enum's "no contract goal" member.
// About 75% of free agents carry it; ZERO employed coaches in a healthy
// dynasty do. Advancing past bowl week is exactly when the game asks every
// employed coach whether they met their contract goal.
//
// The same coaches were also missing the CareerStats / SeasonStats records
// every employed coach owns, which this repairs too.
//
// SAFETY:
//   - Never writes over the input; produces a NEW save.
//   - Dry-run by default. Pass --write plus an output path to write.
//   - Identifies damaged coaches by the Count_ signal alone, then excludes
//     them from the baseline before judging anything else. Verified to flag
//     0 of 414 employed coaches in a healthy, never-transferred dynasty.
//
// Usage:
//   node tools/repairTransferredCoaches.js "<dynasty save>"
//   node tools/repairTransferredCoaches.js "<dynasty save>" --write "<output>"

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const { attachCfbEmploymentRecords } = require('../lib/carousel/cfbEmploymentRecords');
const {
  findDamagedCoaches, employedPeersByPosition, buildEmploymentProfile,
  employmentProblems, applyEmploymentProfile,
} = require('../lib/carousel/cfbNormalize');
const { fixStaleContractOffers, findStaleOffers } = require('../lib/carousel/cfbContractOffers');
const { findRankProblems, repairJobSecurityRanks } = require('../lib/carousel/cfbJobSecurityRank');
const { inspectCfbSave, formatRefusal } = require('../lib/carousel/preflight');
const { saveAs } = require('../lib/carousel/write');

const args = process.argv.slice(2);
const savePath = args.find((a) => !a.startsWith('--'));
const doWrite = args.includes('--write');
const outPath = doWrite ? args[args.indexOf('--write') + 1] : null;

if (!savePath) {
  console.error('usage: node tools/repairTransferredCoaches.js "<dynasty save>" [--write "<output save>"]');
  process.exit(1);
}
if (doWrite && (!outPath || outPath.startsWith('--'))) {
  console.error('--write needs an output path, and it must not be the input save.');
  process.exit(1);
}
if (doWrite && outPath === savePath) {
  console.error('Refusing to overwrite the input save. Choose a different output path.');
  process.exit(1);
}

const REQUIRED = ['CareerStats', 'SeasonStats'];
const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  console.log(`\nSave: ${savePath}`);
  console.log(doWrite ? `Mode: WRITE -> ${outPath}` : 'Mode: DRY RUN (nothing will be written)');
  console.log('='.repeat(64));

  const { cfbFile } = await openCfbSave(savePath);

  // Structural pre-flight before anything else -- same reasoning as the engine
  // and FixCoachCrash: refuse loudly rather than repair against a save whose
  // shape this doesn't recognise. Passes silently on every real save.
  const structure = inspectCfbSave(cfbFile);
  if (!structure.ok) {
    console.error(`\n${formatRefusal(structure, { what: 'this save' }).replace(/^Cannot safely transfer coaches into/, 'Cannot safely repair')}\n`);
    process.exit(1);
  }
  for (const w of structure.warnings) console.log(`  NOTE: ${w}`);

  const coachT = biggestTableByName(cfbFile, 'Coach');
  const teamT = biggestTableByName(cfbFile, 'Team');
  await coachT.readRecords();
  await teamT.readRecords();

  const employed = coachT.records.filter((r) => !r.isEmpty
    && safe(r, 'TeamIndex') !== 255 && safe(r, 'TeamIndex') !== undefined && safe(r, 'Level') > 0);

  const damaged = findDamagedCoaches(coachT.records);
  // Checked independently of `damaged`: the two faults do not travel together.
  // A save can pass the contract-expectation check completely and still be
  // broken by the ranking alone -- that is exactly what a preseason transfer
  // produced, and why bailing out on `!damaged.length` reported a plainly
  // broken dynasty as clean.
  const rankProblems = findRankProblems(coachT.records);
  console.log(`\nEmployed coaches: ${employed.length}`);
  console.log(`  carrying an unemployed coach's contract goal: ${damaged.length}`);
  console.log(`  job-security ranking: ${rankProblems.ok
    ? 'complete and unique'
    : `BROKEN -- ${rankProblems.offenders.length} bad rank(s), ${rankProblems.missing.length} rank(s) belong to nobody`}`);
  if (!rankProblems.ok) {
    console.log(`     missing ranks: ${rankProblems.missing.slice(0, 20).join(', ')}${rankProblems.missing.length > 20 ? ', ...' : ''}`);
    for (const r of rankProblems.offenders.slice(0, 10)) {
      const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
      console.log(`     ${safe(r, 'Name')} (${safe(r, 'Position')}, ${team ? safe(team, 'DisplayName') : '?'}) holds rank ${safe(r, 'CurrentJobSecurityPercentageRank')}`);
    }
  }

  if (!damaged.length && rankProblems.ok) {
    console.log('\nNothing to repair -- this save passes both checks.');
    console.log('If it still crashes on advance or will not load, the cause is something else.\n');
    return;
  }

  // Baseline EXCLUDES the damaged coaches, so their broken values cannot
  // make themselves look normal.
  const damagedRows = damaged.map((d) => d.index);
  const byPos = employedPeersByPosition(coachT.records, { excludeRows: damagedRows });
  const profiles = new Map();
  for (const [pos, peers] of byPos) profiles.set(pos, buildEmploymentProfile(peers));

  console.log('\nCoaches needing repair:');
  for (const r of damaged) {
    const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
    const missing = REQUIRED.filter((f) => !refOf(r, f));
    const probs = employmentProblems(r, profiles.get(safe(r, 'Position')));
    console.log(`\n  row ${String(r.index).padStart(4)}  ${String(safe(r, 'Name')).padEnd(16)} `
      + `${String(safe(r, 'Position')).padEnd(22)} ${team ? safe(team, 'DisplayName') : '?'}`);
    if (missing.length) console.log(`     missing records: ${missing.join(', ')}`);
    if (probs.length) console.log(`     invalid for an employed coach: ${probs.map((p) => `${p.field}=${JSON.stringify(p.value)}`).join(', ')}`);
  }

  if (!doWrite) {
    console.log('\nDry run -- nothing written. Re-run with:');
    console.log(`  node tools/repairTransferredCoaches.js "${savePath}" --write "${savePath}-REPAIRED"\n`);
    return;
  }

  console.log('\nRepairing...');
  let repaired = 0;
  for (const r of damaged) {
    const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
    try {
      // The coach already HOLDS the job here, so there is no incumbent to
      // inherit from -- philosophy falls through to a staff peer.
      const rep = await attachCfbEmploymentRecords(cfbFile, r, {
        teamRecord: team || null,
        incumbent: null,
        excludeRows: damagedRows.filter((i) => i !== r.index),
      });
      const changes = applyEmploymentProfile(r, profiles.get(safe(r, 'Position')));

      const bits = [];
      if (rep.attached.length) bits.push(rep.attached.join(', '));
      if (changes.length) bits.push(changes.map((c) => `${c.field} ${JSON.stringify(c.from)}->${JSON.stringify(c.to)}`).join(', '));
      console.log(`  ${safe(r, 'Name')}: ${bits.join(' | ') || '(nothing needed)'}`);
      repaired++;
    } catch (e) {
      console.log(`  ${safe(r, 'Name')}: FAILED -- ${e.message}`);
    }
  }

  // Pending contract offers still point at these rows from when they were
  // free-agent shells, and carry no source school -- a shape only an
  // unemployed coach ever has. See cfbContractOffers.js; this is the piece
  // the earlier repairs missed entirely, because it lives in another table.
  const offerFixes = await fixStaleContractOffers(cfbFile, { coachRows: damagedRows });
  if (offerFixes.length) {
    console.log(`\n  contract offers repaired: ${offerFixes.length}`);
    const byCoach = new Map();
    for (const f of offerFixes) byCoach.set(f.coach, (byCoach.get(f.coach) || 0) + 1);
    for (const [name, n] of byCoach) console.log(`     ${name}: ${n} pending offer(s) given their current school`);
  }

  // Runs LAST, after the employment repairs above -- findRankProblems counts who
  // is employed, so the arithmetic is only right once employment state is.
  if (!rankProblems.ok) {
    const rankFix = await repairJobSecurityRanks(cfbFile, { coachRecords: coachT.records });
    console.log(`\n  job-security ranking: ${rankFix.repaired.length} rank(s) reassigned`);
    for (const f of rankFix.repaired.slice(0, 20)) console.log(`     ${f.name}: ${f.from} -> ${f.to}`);
    if (rankFix.cleared.length) {
      console.log(`     ${rankFix.cleared.length} departed coach(es) cleared off a rank now held by someone else`);
    }
    if (rankFix.shortfall > 0) {
      console.log(`     WARNING: ${rankFix.shortfall} coach(es) still hold an invalid rank (no free rank remained)`);
    }
    repaired += rankFix.repaired.length;
  }

  if (!repaired) { console.log('\nNothing was repaired; not writing an output save.\n'); return; }

  await saveAs(cfbFile, outPath);
  console.log(`\nRepaired ${repaired} coach(es). Wrote: ${outPath}`);
  console.log('Verify with a dry run against the new file:');
  console.log(`  node tools/repairTransferredCoaches.js "${outPath}"\n`);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
