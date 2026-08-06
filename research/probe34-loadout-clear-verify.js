// Verifies the P5 fix (COACH_TRANSFER_AUDIT.md L5): placeOnTeam.js's new
// clearStaleTeamLoadouts actually clears a stale Team.GamedayLoadout Talent
// reference when a new HeadCoach is placed.
//
// Neither real save on disk currently has a non-null Talent ref in any
// team's loadout slots (checked directly -- probe33), so this test
// SYNTHESIZES the exact failure condition the audit described (a loadout
// slot pointing at a real talent row) on a throwaway copy, then runs the
// real moveCoachCfbToMaddenTeam path through it and checks the slot comes
// out cleared. Never touches source saves; writes + deletes a throwaway.

const fs = require('fs');
const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');
const { scanCoaches, proposeMoves, commitMoves } = require('../lib/carousel/run');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const SEEDED = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-LOADOUTSEED';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-LOADOUTVERIFY';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

(async () => {
  console.log('=== Step 1: seed a fake stale Talent ref onto the Giants GamedayLoadout ===');
  try { fs.rmSync(SEEDED, { recursive: true, force: true }); } catch (e) { /* fine */ }
  const seedFile = await FranchiseFile.create(MADDEN, { autoUnempty: true });
  const teamT = biggestTableByName(seedFile, 'Team');
  await teamT.readRecords();
  const giants = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === 'Giants');

  const loadoutRef = refOf(giants, 'GamedayLoadout');
  const loadoutTable = seedFile.getTableById(loadoutRef.tableId);
  await loadoutTable.readRecords();
  const loadoutRec = loadoutTable.records[loadoutRef.rowNumber];
  const slot0Ref = loadoutRec.getReferenceDataByKey('TalentLoadoutSlot0');
  const slotTable = seedFile.getTableById(slot0Ref.tableId);
  await slotTable.readRecords();
  const slotRec = slotTable.records[slot0Ref.rowNumber];

  // Borrow a real, valid Talent row reference from some other real coach's
  // own tree (any non-empty row in table 4112 works -- we only need a
  // structurally valid, non-zero reference to prove clearing).
  const talentTable = seedFile.getTableById(4112);
  await talentTable.readRecords();
  const donorTalentRow = talentTable.records.findIndex((r) => !r.isEmpty);
  check('found a real talent row to borrow as the fake stale ref', donorTalentRow >= 0);

  slotRec.Talent = talentTable.getBinaryReferenceToRecord(donorTalentRow);
  const seededRef = refOf(slotRec, 'Talent');
  check('seed: slot0.Talent is now non-null', !!seededRef && (seededRef.tableId !== 0 || seededRef.rowNumber !== 0));
  console.log(`  seeded slot0.Talent -> ${seededRef.tableId}:${seededRef.rowNumber}`);

  await new Promise((resolve, reject) => {
    seedFile.on('saved', resolve);
    seedFile.save(SEEDED);
  });
  console.log(`  wrote seeded save to ${SEEDED}`);

  console.log('\n=== Step 2: run the real Freeman -> Giants placement against the seeded save ===');
  const scan = await scanCoaches(CFB);
  const freeman = scan.coaches.find((c) => c.head === 'Unique_C_FreemanMarcus_659');
  const proposed = await proposeMoves({
    cfbPath: CFB, maddenPath: SEEDED,
    config: { mode: 'manual', moves: [{ sourceRow: freeman.row, teamName: 'Giants' }], allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: () => {},
  });
  check('plan produced exactly one row', proposed.plan.length === 1);

  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* fine */ }
  const commitLog = [];
  const committed = await commitMoves({
    plan: proposed.plan, cfbPath: CFB, maddenPath: SEEDED, outputPath: OUT,
    config: { allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: (m) => commitLog.push(m),
  });
  check('committed one coach', committed.written === 1);
  const result = committed.results[0];
  check('result reports clearedLoadouts', Array.isArray(result.clearedLoadouts));
  check('cleared at least the seeded slot0', result.clearedLoadouts.some((c) => c.field === 'GamedayLoadout' && c.slot === 0));
  console.log(`  clearedLoadouts: ${JSON.stringify(result.clearedLoadouts)}`);
  const clearLogLine = commitLog.find((l) => /cleared \d+ stale loadout slot/.test(l));
  check('log line mentions the clear', !!clearLogLine);
  if (clearLogLine) console.log(`  log: "${clearLogLine.trim()}"`);

  console.log('\n=== Step 3: re-open the committed save and confirm the ref is actually gone ===');
  const verifyFile = await FranchiseFile.create(OUT, { autoUnempty: true });
  const teamT2 = biggestTableByName(verifyFile, 'Team');
  await teamT2.readRecords();
  const giants2 = teamT2.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === 'Giants');
  const loadoutRef2 = refOf(giants2, 'GamedayLoadout');
  const loadoutTable2 = verifyFile.getTableById(loadoutRef2.tableId);
  await loadoutTable2.readRecords();
  const loadoutRec2 = loadoutTable2.records[loadoutRef2.rowNumber];
  const slot0Ref2 = loadoutRec2.getReferenceDataByKey('TalentLoadoutSlot0');
  const slotTable2 = verifyFile.getTableById(slot0Ref2.tableId);
  await slotTable2.readRecords();
  const slotRec2 = slotTable2.records[slot0Ref2.rowNumber];
  const finalTalentRef = refOf(slotRec2, 'Talent');
  check('slot0.Talent is null after the real commit+reload round-trip', finalTalentRef === null);

  // Sanity: Freeman himself still has a real talent tree (the fix shouldn't
  // have touched HIS own GamedayTalents, only the team's loadout slots).
  const coachT2 = biggestTableByName(verifyFile, 'Coach');
  await coachT2.readRecords();
  const freemanRec2 = coachT2.records[result.destRow];
  const freemanTreeRef = refOf(freemanRec2, 'GamedayTalents');
  check("Freeman's own GamedayTalents tree is untouched (still present)", !!freemanTreeRef);

  fs.rmSync(SEEDED, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('\n(cleaned up throwaway saves)');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
