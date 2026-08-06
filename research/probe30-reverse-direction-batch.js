// Batch verification for the Madden->CFB reverse direction (COACH_TRANSFER_
// AUDIT.md / PIPELINE_APP_INTEGRATION_SPEC.md). Places several real Madden
// coaches -- HC/OC/DC, spanning levels -- onto real CFB schools, one save,
// chained (each placement builds on the previous output), verifying each
// write and cleaning up at the end. WRITES to a throwaway save only.

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { openCfb, openMadden, safe } = require('../research/_saves');
const { biggestTableByName } = require('../lib/saveIO');
const { moveCoachMaddenToCfbTeam } = require('../lib/carousel/index');

const CFB_PATH = require('../research/_saves').CFB_PATH;
const OUT = CFB_PATH + '-BATCHTEST';
const MAD_PATH = require('../research/_saves').MAD_PATH;

const CASES = [
  { position: 'HeadCoach', teamName: 'Georgia' },
  { position: 'HeadCoach', teamName: 'Michigan' },
  { position: 'OffensiveCoordinator', teamName: 'Texas' },
  { position: 'DefensiveCoordinator', teamName: 'LSU' },
  { position: 'OffensiveCoordinator', teamName: 'Clemson' },
];

let failures = 0;
function check(label, cond) { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; }

(async () => {
  const madden = await openMadden();
  const mt = biggestTableByName(madden, 'Coach');
  await mt.readRecords();

  const picked = [];
  for (const c of CASES) {
    const candidate = mt.records.find((r) => !r.isEmpty && safe(r, 'Position') === c.position
      && safe(r, 'Level') > 0 && safe(r, 'Name') && !picked.some((p) => p.row === r.index));
    if (!candidate) { console.log(`  no Madden ${c.position} candidate found, skipping`); continue; }
    picked.push({ ...c, row: candidate.index, name: safe(candidate, 'Name'), level: safe(candidate, 'Level') });
  }

  console.log(`=== placing ${picked.length} coaches ===`);
  let cfbPath = CFB_PATH;
  const results = [];
  for (const c of picked) {
    const cfbFile = (await FranchiseFile.create(cfbPath, {
      schemaOverride: { major: 809, minor: 0, gameYear: 27, path: path.join(__dirname, '..', 'data', 'schemas', 'CFB27_809_0.gz') },
      gameYearOverride: 27,
    }));
    await new Promise((res, rej) => { if (cfbFile.isLoaded) res(); else { cfbFile.on('ready', res); cfbFile.on('error', rej); } });
    const maddenFile2 = await openMadden();

    console.log(`\n${c.name} (${c.position}, L${c.level}) -> ${c.teamName}`);
    let res;
    try {
      res = await moveCoachMaddenToCfbTeam({
        cfbFile, maddenFile: maddenFile2, maddenCoachRowIndex: c.row,
        teamName: c.teamName, outputPath: OUT,
        config: { allowOffWindowHeadCoachHire: true },
        log: (m) => console.log(`    ${m}`),
      });
      check(`${c.name} placed without throwing`, true);
      check(`${c.name} talent tree not skipped/self-donated`, !res.talentReport.skipped && res.talentReport.donor.name !== c.name);
      check(`${c.name} appearance granted`, !!res.appearanceReport && !!res.appearanceReport.head);
      results.push({ ...c, destRow: res.destRow, teamIndex: res.teamIndex });
    } catch (e) {
      check(`${c.name} placed without throwing`, false);
      console.log('    ERROR:', e.message);
    }
    cfbPath = OUT; // chain
  }

  console.log('\n=== verifying final output save ===');
  const finalCfb = await FranchiseFile.create(OUT, {
    schemaOverride: { major: 809, minor: 0, gameYear: 27, path: path.join(__dirname, '..', 'data', 'schemas', 'CFB27_809_0.gz') },
    gameYearOverride: 27,
  });
  await new Promise((res, rej) => { if (finalCfb.isLoaded) res(); else { finalCfb.on('ready', res); finalCfb.on('error', rej); } });
  const ct = biggestTableByName(finalCfb, 'Coach');
  await ct.readRecords();
  const teamT = biggestTableByName(finalCfb, 'Team');
  await teamT.readRecords();

  for (const r of results) {
    const rec = ct.records[r.destRow];
    const nameOk = safe(rec, 'Name') === r.name;
    const posOk = safe(rec, 'Position') === r.position;
    check(`${r.name}: destination row has correct Name+Position after full chain`, nameOk && posOk);

    const team = teamT.records.find((t) => !t.isEmpty && safe(t, 'TeamIndex') === r.teamIndex);
    const ref = team.getReferenceDataByKey(r.position);
    check(`${r.name}: ${r.teamName}'s ${r.position} slot points at row ${r.destRow}`, ref && ref.rowNumber === r.destRow);
  }

  // Uniqueness: no two placed coaches should have collided onto the same destRow
  const destRows = results.map((r) => r.destRow);
  check('every placed coach landed on a distinct destination row', new Set(destRows).size === destRows.length);

  try { fs.rmSync(OUT); console.log('\ncleaned up BATCHTEST save.'); } catch (e) { /* best effort */ }

  console.log(`\n${'='.repeat(60)}`);
  console.log(failures === 0 ? `ALL CHECKS PASSED (${results.length} coaches placed)` : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });
