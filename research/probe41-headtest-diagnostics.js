// READ-ONLY health check on CAREER-HEADTEST, the long-lived Madden test save
// used across probe27/33/36 for the original CFB->Madden coach-placement
// verification. This is a STATIC save from earlier work -- it predates the
// L5/L9/loadout fixes built later in this project, so it's a useful fossil
// record of what those bugs actually looked like in a real save, not
// something that self-heals when the code changes.
//
// Checks the three coaches actually placed by our engine (per probe27's own
// diagnosis): S. Archer -> Jets, D. Aranda -> Bears, M. Anthony -> Giants.
// For each: team-pointer correctness, talent tree completeness, appearance/
// visuals presence, contract sanity, and GamedayLoadout staleness.

const { openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-HEADTEST';
const PLACEMENTS = [
  { team: 'Jets', position: 'HeadCoach', expectName: 'S. Archer' },
  { team: 'Bears', position: 'HeadCoach', expectName: 'D. Aranda' },
  { team: 'Giants', position: 'HeadCoach', expectName: 'M. Anthony' },
];

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

let failures = 0;
const check = (label, cond) => { console.log(`    ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

(async () => {
  const { maddenFile } = await openMaddenSave(SAVE);
  const teamT = biggestTableByName(maddenFile, 'Team');
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await teamT.readRecords();
  await coachT.readRecords();
  const coachIds = new Set((maddenFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));

  for (const p of PLACEMENTS) {
    console.log(`\n=== ${p.team} ${p.position} (expected: ${p.expectName}) ===`);
    const teamRecord = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === p.team);
    if (!teamRecord) { check(`${p.team} team row exists`, false); continue; }

    const ref = refOf(teamRecord, p.position);
    const coach = ref && coachIds.has(ref.tableId) ? coachT.records[ref.rowNumber] : null;

    check('team pointer resolves into the Coach table', !!coach);
    if (!coach) continue;

    check(`pointer resolves to the expected coach (${p.expectName}, not a stale incumbent)`, safe(coach, 'Name') === p.expectName);
    check('coach.Position matches the slot', safe(coach, 'Position') === p.position);
    check("coach.TeamIndex matches the team's own TeamIndex", safe(coach, 'TeamIndex') === safe(teamRecord, 'TeamIndex'));

    // Talent tree -- all three categories, non-null, with real content.
    for (const cat of ['GamedayTalents', 'PlaysheetTalents', 'WearAndTearTalents']) {
      const catRef = refOf(coach, cat);
      let populated = false;
      if (catRef) {
        const arrTable = maddenFile.getTableById(catRef.tableId);
        if (arrTable) {
          await arrTable.readRecords();
          const arrRec = arrTable.records[catRef.rowNumber];
          populated = !!(arrRec && !arrRec.isEmpty && (arrRec.arraySize || 0) > 0);
        }
      }
      check(`${cat} tree present and non-empty`, populated);
    }
    check('Level is a real, non-zero value (not a blank shell)', typeof safe(coach, 'Level') === 'number' && safe(coach, 'Level') > 0);
    check('Archetype is set (not a DUMMY/blank default)', !!safe(coach, 'Archetype') && safe(coach, 'Archetype') !== 'Invalid_');

    // Appearance -- CharacterVisuals present (absence renders as a silhouette).
    const cvRef = refOf(coach, 'CharacterVisuals');
    check('CharacterVisuals reference present (would not render as a silhouette)', !!cvRef);
    check('GenericHeadAssetName is set', !!safe(coach, 'GenericHeadAssetName'));

    // Contract sanity -- the exact class of internal-contradiction bug this
    // project has hit before (a Signed coach with $0 salary).
    const status = safe(coach, 'ContractStatus');
    const salary = safe(coach, 'ContractSalary');
    check(`ContractStatus is Signed (got "${status}")`, status === 'Signed');
    check(`ContractSalary is non-zero for a Signed coach (got ${salary})`, !(status === 'Signed' && (!salary || salary <= 0)));

    // GamedayLoadout staleness -- the L5/L9 class of bug, fixed in code but
    // this save predates the fix, so THIS coach's team-level loadout slots
    // may still hold a leftover Talent reference from whoever they displaced.
    const loadoutRef = refOf(teamRecord, 'GamedayLoadout');
    if (loadoutRef) {
      const loadoutTable = maddenFile.getTableById(loadoutRef.tableId);
      await loadoutTable.readRecords();
      const loadoutRec = loadoutTable.records[loadoutRef.rowNumber];
      const staleSlots = [];
      if (loadoutRec && !loadoutRec.isEmpty) {
        const n = loadoutRec.arraySize || 0;
        for (let i = 0; i < n; i++) {
          let slotRef; try { slotRef = loadoutRec.getReferenceDataByKey(`TalentLoadoutSlot${i}`); } catch (e) { slotRef = null; }
          if (!slotRef) continue;
          const slotTable = maddenFile.getTableById(slotRef.tableId);
          await slotTable.readRecords();
          const slotRec = slotTable.records[slotRef.rowNumber];
          if (!slotRec || slotRec.isEmpty) continue;
          const talentRef = refOf(slotRec, 'Talent');
          if (talentRef) staleSlots.push(i);
        }
      }
      console.log(`    INFO  GamedayLoadout: ${staleSlots.length ? `slot(s) ${staleSlots.join(',')} hold a Talent reference (pre-dates the L5/L9 fix -- this save was never re-committed with the fixed code)` : 'all slots clear'}`);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (this is a READ-ONLY report against an existing save -- nothing was written)`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
