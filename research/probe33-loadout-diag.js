// READ-ONLY diagnosis for P5 (COACH_TRANSFER_AUDIT.md L5 / COACH_FIDELITY_ROADMAP.md 4.4):
// "Giants' GamedayLoadout slot4 still references the *previous* coach's
// talent row (4112:794)."
//
// Rebuilds the exact Freeman -> Giants scenario probe28 already uses (same
// CFB/Madden source saves), then inspects:
//   1. The GamedayLoadout table/row structure on the Giants Team record --
//      how many slots exist, what each one currently points at.
//   2. Whether those slots point at Daboll (the displaced incumbent), at
//      Freeman (the new coach), at something else, or at nothing.
//   3. Whether Daboll's OWN GamedayTalents tree still contains row 4112:794
//      after the move (i.e. is this "stale" in the sense of pointing at
//      still-valid-but-wrong data, or would it dangle if Daboll's tree were
//      ever freed).
//   4. Whether Freeman's newly-granted tree has any row that plays the same
//      structural role (same slot-index-equivalent) slot4 could repoint to.
//
// WRITES a throwaway save (CAREER-LOADOUTDIAG), never touches source saves.

const fs = require('fs');
const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');
const { scanCoaches, proposeMoves, commitMoves } = require('../lib/carousel/run');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-LOADOUTDIAG';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  console.log('=== Rebuilding Freeman -> Giants scenario ===');
  const scan = await scanCoaches(CFB);
  const freeman = scan.coaches.find((c) => c.head === 'Unique_C_FreemanMarcus_659');
  if (!freeman) throw new Error('Freeman not found in scan -- has the source save changed?');

  const proposed = await proposeMoves({
    cfbPath: CFB, maddenPath: MADDEN,
    config: { mode: 'manual', moves: [{ sourceRow: freeman.row, teamName: 'Giants' }], allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: () => {},
  });
  if (proposed.plan.length !== 1) throw new Error('expected exactly one plan row');

  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* fine */ }
  const committed = await commitMoves({
    plan: proposed.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: OUT,
    config: { allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: () => {},
  });
  console.log(`  written=${committed.written} outputPath=${committed.outputPath}`);
  const freemanNewRow = committed.results[0].destRow;
  const daboll = committed.results[0].displaces; // {row, name, ...} or null
  console.log(`  Freeman landed at Coach row ${freemanNewRow}`);
  console.log(`  Displaced incumbent: ${daboll ? `${daboll.name} (row ${daboll.row})` : '(none -- vacancy)'}`);

  console.log('\n=== Opening committed save for inspection ===');
  const file = await FranchiseFile.create(OUT, { autoUnempty: true });
  const teamT = biggestTableByName(file, 'Team');
  const coachT = biggestTableByName(file, 'Coach');
  await teamT.readRecords();
  await coachT.readRecords();

  const giants = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === 'Giants');
  if (!giants) throw new Error('Giants team row not found');
  console.log(`  Giants Team row ${giants.index}`);

  const freemanRec = coachT.records[freemanNewRow];
  console.log(`  Freeman (new): row ${freemanNewRow} Level=${safe(freemanRec, 'Level')} Archetype=${safe(freemanRec, 'Archetype')}`);

  let dabollRec = null;
  if (daboll) {
    dabollRec = coachT.records[daboll.row];
    console.log(`  Daboll (displaced): row ${daboll.row} TeamIndex=${safe(dabollRec, 'TeamIndex')} Level=${safe(dabollRec, 'Level')}`);
  }

  // ---- 1. GamedayLoadout structure on the Giants row ----
  console.log('\n=== Giants.GamedayLoadout ===');
  const loadoutRef = refOf(giants, 'GamedayLoadout');
  if (!loadoutRef) {
    console.log('  (null -- no GamedayLoadout reference on this Team row)');
  } else {
    const loadoutTable = file.getTableById(loadoutRef.tableId);
    await loadoutTable.readRecords();
    const loadoutRec = loadoutTable.records[loadoutRef.rowNumber];
    console.log(`  -> table "${loadoutTable.name}" (id ${loadoutRef.tableId}) row ${loadoutRef.rowNumber} isEmpty=${loadoutRec ? loadoutRec.isEmpty : '(missing row)'}`);
    if (loadoutRec && !loadoutRec.isEmpty) {
      console.log(`  schema fields: ${loadoutTable.schema ? loadoutTable.schema.attributes.map((a) => a.name).join(', ') : '(no schema)'}`);
      const n = loadoutRec.arraySize;
      console.log(`  arraySize=${n}`);
      for (let i = 0; i < 8; i++) {
        const key = `TalentLoadoutSlot${i}`;
        let ref; try { ref = loadoutRec.getReferenceDataByKey(key); } catch (e) { ref = undefined; }
        if (ref === undefined) { console.log(`  slot${i}: (field not on schema)`); continue; }
        if (!ref) { console.log(`  slot${i}: (null)`); continue; }
        console.log(`  slot${i}: -> table ${ref.tableId} row ${ref.rowNumber}`);
      }
    }
  }

  // ---- 2. Also check other loadout-ish fields for comparison ----
  console.log('\n=== Giants other loadout fields (for comparison) ===');
  for (const f of ['PlaysheetLoadout', 'WearAndTearLoadout']) {
    const ref = refOf(giants, f);
    if (!ref) { console.log(`  ${f}: (null)`); continue; }
    const t = file.getTableById(ref.tableId);
    await t.readRecords();
    const rec = t.records[ref.rowNumber];
    console.log(`  ${f}: -> table ${ref.tableId} row ${ref.rowNumber} isEmpty=${rec ? rec.isEmpty : '(missing)'} arraySize=${rec ? rec.arraySize : '-'}`);
  }

  // ---- 3. Does Freeman's own GamedayTalents tree contain equivalent rows? ----
  console.log("\n=== Freeman's GamedayTalents tree (for repoint candidates) ===");
  const gdRef = refOf(freemanRec, 'GamedayTalents');
  if (!gdRef) {
    console.log('  (null -- Freeman has no GamedayTalents array reference)');
  } else {
    const arrTable = file.getTableById(gdRef.tableId);
    await arrTable.readRecords();
    const arrRec = arrTable.records[gdRef.rowNumber];
    console.log(`  GamedayTalents array -> table ${gdRef.tableId} row ${gdRef.rowNumber} arraySize=${arrRec ? arrRec.arraySize : '-'}`);
    if (arrRec && !arrRec.isEmpty) {
      const n = arrRec.arraySize || 0;
      for (let i = 0; i < Math.min(n, 12); i++) {
        let tRef; try { tRef = arrRec.getReferenceDataByKey(`Talent${i}`); } catch (e) { tRef = null; }
        console.log(`    Talent${i}: -> ${tRef ? `${tRef.tableId}:${tRef.rowNumber}` : '(null)'}`);
      }
    }
  }

  // ---- 4. Is the stale row (from the roadmap: 4112:794) still valid, and whose is it? ----
  console.log('\n=== Whose talent row is table 4112 row 794 (the originally-reported stale ref)? ===');
  try {
    const t4112 = file.getTableById(4112);
    await t4112.readRecords();
    const rec = t4112.records[794];
    console.log(`  table 4112 row 794: isEmpty=${rec ? rec.isEmpty : '(missing)'}`);
    if (rec && !rec.isEmpty && t4112.schema) {
      for (const a of t4112.schema.attributes.slice(0, 15)) {
        console.log(`    ${a.name} = ${safe(rec, a.name)}`);
      }
    }
  } catch (e) { console.log(`  error reading table 4112: ${e.message}`); }

  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('\n(cleaned up throwaway save)');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
