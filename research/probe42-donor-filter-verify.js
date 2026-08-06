// Verifies the pickDonorCoach fix (COACH_TRANSFER_AUDIT.md / probe41 finding):
// a donor must now have a populated PlaysheetTalents tree, not just
// GamedayTalents, so a transfer never silently inherits an incomplete tree
// the way S. Archer's did in the old CAREER-HEADTEST save.
//
// 1. Confirms the 7 real coaches identified by probe41 as Gameday-but-not-
//    Playsheet (H. Flohr, D. Douglas, J. Hiller, B. Perkins, K. Leisman,
//    M. Charron, P. Troyer) are now REJECTED by pickDonorCoach for their own
//    position, even when they'd otherwise be the closest-level match.
// 2. Runs a REAL transfer at a target level chosen to be closest to one of
//    the excluded donors, and confirms the ACTUAL donor picked has a real
//    Playsheet tree, and the resulting cloned tree has real content in both
//    Gameday and Playsheet categories.
//
// WRITES a throwaway save, cleaned up at the end.

const fs = require('fs');
const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');
const { pickDonorCoach, hasPopulatedTalentCategory } = require('../lib/carousel/talentTree');
const { scanCoaches } = require('../lib/carousel/run');
const { moveCoachCfbToMaddenTeam } = require('../lib/carousel/index');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-DONORFILTERTEST';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

const GAP_COACHES = ['H. Flohr', 'D. Douglas', 'J. Hiller', 'B. Perkins', 'K. Leisman', 'M. Charron', 'P. Troyer'];

(async () => {
  const { maddenFile } = await openMaddenSave(MADDEN);
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await coachT.readRecords();

  console.log('=== 1. The 7 identified gap coaches are excluded from pickDonorCoach ===');
  const gapRecords = [];
  for (const r of coachT.records) {
    if (r.isEmpty || !GAP_COACHES.includes(safe(r, 'Name'))) continue;
    gapRecords.push(r);
    const hasGD = await hasPopulatedTalentCategory(maddenFile, r, 'GamedayTalents');
    const hasPS = await hasPopulatedTalentCategory(maddenFile, r, 'PlaysheetTalents');
    check(`${safe(r, 'Name')} (${safe(r, 'Position')}, L${safe(r, 'Level')}): Gameday=yes, Playsheet=no (confirms the gap still exists in this save)`,
      hasGD === true && hasPS === false);
  }
  check('found all 7 gap coaches in the save', gapRecords.length === 7);

  // For each gap coach, target their exact level -- if the OLD filter were
  // still active, this coach would be the perfect (distance-0) match and
  // would certainly be picked. Confirm the NEW filter skips them.
  for (const gap of gapRecords) {
    const donor = await pickDonorCoach(maddenFile, {
      position: safe(gap, 'Position'), archetype: safe(gap, 'Archetype'), targetLevel: safe(gap, 'Level'),
    });
    check(`targeting ${safe(gap, 'Name')}'s exact level (${safe(gap, 'Level')}) picks a DIFFERENT donor, not them`,
      donor.record.index !== gap.index);
    const donorHasPS = await hasPopulatedTalentCategory(maddenFile, donor.record, 'PlaysheetTalents');
    check(`  the donor actually picked (${donor.name}) has a real Playsheet tree`, donorHasPS === true);
  }

  console.log('\n=== 2. Real transfer at a gap-adjacent level produces a COMPLETE tree ===');
  // Uses moveCoachCfbToMaddenTeam directly (not run.js's commitMoves, whose
  // trimmed result shape doesn't forward talentReport) so this can inspect
  // exactly which donor got picked and what actually cloned.
  const scan = await scanCoaches(CFB);
  const oc = scan.coaches.find((c) => c.position === 'OffensiveCoordinator');
  const { cfbFile } = await openCfbSave(CFB);

  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* fine */ }
  const res = await moveCoachCfbToMaddenTeam({
    cfbFile, maddenFile, cfbCoachRowIndex: oc.row, teamName: 'Falcons',
    outputPath: OUT, config: { coachSkinTone: 5 }, log: () => {},
  });
  console.log(`  talent tree donor: ${res.talentReport.donor.name} (L${res.talentReport.donor.level})`);
  check('donor is NOT one of the 7 known-gap coaches', !GAP_COACHES.includes(res.talentReport.donor.name));
  const cats = res.talentReport.categories;
  const gdCat = cats.find((c) => c.category === 'GamedayTalents');
  const psCat = cats.find((c) => c.category === 'PlaysheetTalents');
  check('GamedayTalents actually cloned something', gdCat && gdCat.cloned > 0);
  check('PlaysheetTalents actually cloned something (the exact category that used to silently end up empty)', psCat && psCat.cloned > 0);

  const { maddenFile: out } = await openMaddenSave(OUT);
  const outCoachT = biggestTableByName(out, 'Coach');
  await outCoachT.readRecords();
  const newCoach = outCoachT.records[res.destRow];
  const psRef = refOf(newCoach, 'PlaysheetTalents');
  check('re-opened save: new coach has a real PlaysheetTalents reference', !!psRef);

  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
