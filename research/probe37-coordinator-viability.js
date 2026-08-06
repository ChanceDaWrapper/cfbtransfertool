// READ-ONLY (except a throwaway save it writes then deletes).
//
// probe36 surfaced that a team's HC/OC/DC all carry the SAME
// OffensiveScheme and DefensiveScheme reference. If that holds league-wide,
// it's the central design constraint for coordinator transfers: dropping a
// coordinator onto a team with THEIR old scheme would leave the staff
// disagreeing with itself. Questions:
//
//   1. Do schemes actually VARY between teams (i.e. is the shared value
//      meaningful), or does every team carry the same one (in which case
//      "shared" is trivially true and carries no constraint)?
//   2. Does the staff-shares-a-scheme rule hold across ALL teams, or was the
//      one team probe36 sampled a coincidence?
//   3. What does Madden's HeadTrainer actually point at, since it resolves to
//      32 distinct non-Coach rows?
//   4. THE PRACTICAL ONE: does a coordinator move commit cleanly end-to-end
//      today, both directions? (L4 claims "only head coaches transfer", but
//      every layer's position handling looks generic.)

const fs = require('fs');
const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');
const { scanCoaches, scanMaddenCoaches, proposeMoves, commitMoves } = require('../lib/carousel/run');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT_MAD = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-COORDTEST';
const OUT_CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-COORDTEST';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };
const refKey = (rec, key) => { const r = refOf(rec, key); return r ? `${r.tableId}:${r.rowNumber}` : null; };

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  const { maddenFile } = await openMaddenSave(MADDEN);

  // ===== 1 & 2. Scheme sharing across the whole league =====
  for (const [label, file] of [['MADDEN', maddenFile], ['CFB', cfbFile]]) {
    console.log(`\n########## ${label}: does a staff share a scheme, and do schemes vary? ##########`);
    const teamT = biggestTableByName(file, 'Team');
    const coachT = biggestTableByName(file, 'Coach');
    await teamT.readRecords();
    await coachT.readRecords();
    const coachIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));

    let staffed = 0, offAgree = 0, defAgree = 0;
    const distinctOff = new Set(), distinctDef = new Set();
    const disagreements = [];
    for (const tr of teamT.records) {
      if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
      const staff = [];
      for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
        const ref = refOf(tr, slot);
        const rec = ref && coachIds.has(ref.tableId) ? coachT.records[ref.rowNumber] : null;
        if (rec && !rec.isEmpty) staff.push({ slot, rec });
      }
      if (staff.length < 2) continue;
      staffed++;
      const offs = staff.map((s) => refKey(s.rec, 'OffensiveScheme'));
      const defs = staff.map((s) => refKey(s.rec, 'DefensiveScheme'));
      offs.forEach((o) => o && distinctOff.add(o));
      defs.forEach((d) => d && distinctDef.add(d));
      const oAgree = new Set(offs).size === 1;
      const dAgree = new Set(defs).size === 1;
      if (oAgree) offAgree++;
      if (dAgree) defAgree++;
      if ((!oAgree || !dAgree) && disagreements.length < 4) {
        disagreements.push(`${safe(tr, 'DisplayName')}: off=[${offs.join(' ')}] def=[${defs.join(' ')}]`);
      }
    }
    console.log(`  teams with 2+ staff: ${staffed}`);
    console.log(`  staff AGREE on OffensiveScheme: ${offAgree}/${staffed}`);
    console.log(`  staff AGREE on DefensiveScheme: ${defAgree}/${staffed}`);
    console.log(`  distinct OffensiveScheme values league-wide: ${distinctOff.size}`);
    console.log(`  distinct DefensiveScheme values league-wide: ${distinctDef.size}`);
    if (disagreements.length) {
      console.log('  examples of DISAGREEMENT:');
      for (const d of disagreements) console.log(`    ${d}`);
    }
    const meaningful = distinctOff.size > 1 || distinctDef.size > 1;
    console.log(`  => scheme varies between teams: ${meaningful ? 'YES (so sharing is a real constraint)' : 'NO (sharing is trivial)'}`);
  }

  // ===== 3. Madden HeadTrainer target =====
  console.log('\n########## MADDEN: what is HeadTrainer? ##########');
  {
    const teamT = biggestTableByName(maddenFile, 'Team');
    await teamT.readRecords();
    const tr = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === '49ers');
    const ref = refOf(tr, 'HeadTrainer');
    console.log(`  49ers.HeadTrainer -> ${ref ? `${ref.tableId}:${ref.rowNumber}` : '(null)'}`);
    if (ref) {
      const t = maddenFile.getTableById(ref.tableId);
      if (t) {
        await t.readRecords();
        console.log(`  table "${t.name}" capacity=${t.header.recordCapacity}`);
        const rec = t.records[ref.rowNumber];
        if (rec && !rec.isEmpty && t.schema) {
          for (const a of t.schema.attributes.slice(0, 12)) console.log(`    ${a.name} = ${safe(rec, a.name)}`);
        }
      } else { console.log('  (table not present in save -- a static asset reference)'); }
    }
  }

  // ===== 4. Does a coordinator move actually commit? =====
  console.log('\n########## CFB -> Madden: commit a COORDINATOR ##########');
  {
    const scan = await scanCoaches(CFB);
    const oc = scan.coaches.find((c) => c.position === 'OffensiveCoordinator');
    console.log(`  moving ${oc.name} (${oc.position}, CFB row ${oc.row})`);
    // Target a Madden team whose OC slot is currently filled, to exercise displacement.
    const proposed = await proposeMoves({
      cfbPath: CFB, maddenPath: MADDEN,
      config: { mode: 'manual', moves: [{ sourceRow: oc.row, teamName: '49ers' }], coachSkinTone: 5 },
      log: () => {},
    });
    check('OC plan row produced', proposed.plan.length === 1);
    const row = proposed.plan[0];
    check('OC plan is NOT blocked (no timing gate for coordinators)', !row.blocked);
    console.log(`    -> ${row.toTeam} ${row.position}, displaces ${row.displaces ? row.displaces.name : '(vacant)'}`);

    try { fs.rmSync(OUT_MAD, { recursive: true, force: true }); } catch (e) { /* fine */ }
    const committed = await commitMoves({
      plan: proposed.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: OUT_MAD,
      config: { coachSkinTone: 5 }, log: () => {},
    });
    check('committed the coordinator', committed.written === 1);
    const res = committed.results[0];
    check('position stayed OffensiveCoordinator', res.position === 'OffensiveCoordinator');
    check('got an appearance', !!res.appearanceReport);
    check('no loadout clearing on a coordinator (HC-only)', !res.clearedLoadouts || res.clearedLoadouts.length === 0);

    // Verify in the written save: team pointer + scheme coherence with the staff.
    const { maddenFile: out } = await openMaddenSave(OUT_MAD);
    const teamT = biggestTableByName(out, 'Team');
    const coachT = biggestTableByName(out, 'Coach');
    await teamT.readRecords(); await coachT.readRecords();
    const niners = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === '49ers');
    const ocRef = refOf(niners, 'OffensiveCoordinator');
    check('49ers.OffensiveCoordinator points at the new row', ocRef && ocRef.rowNumber === res.destRow);
    const newOc = coachT.records[res.destRow];
    const hcRef = refOf(niners, 'HeadCoach');
    const hc = hcRef ? coachT.records[hcRef.rowNumber] : null;
    if (hc) {
      const same = refKey(newOc, 'OffensiveScheme') === refKey(hc, 'OffensiveScheme');
      console.log(`    staff scheme coherence: new OC off-scheme ${refKey(newOc, 'OffensiveScheme')} vs HC ${refKey(hc, 'OffensiveScheme')} -> ${same ? 'AGREE' : 'DISAGREE'}`);
    }
    fs.rmSync(OUT_MAD, { recursive: true, force: true });
  }

  console.log('\n########## Madden -> CFB: commit a COORDINATOR ##########');
  {
    const scan = await scanMaddenCoaches(MADDEN);
    const dc = scan.coaches.find((c) => c.position === 'DefensiveCoordinator');
    console.log(`  moving ${dc.name} (${dc.position}, Madden row ${dc.row})`);
    const proposed = await proposeMoves({
      direction: 'maddenToCfb', cfbPath: CFB, maddenPath: MADDEN,
      config: { mode: 'manual', moves: [{ sourceRow: dc.row, teamName: 'Alabama' }], coachSkinTone: 4 },
      log: () => {},
    });
    check('DC plan row produced', proposed.plan.length === 1);
    const row = proposed.plan[0];
    check('DC plan is NOT blocked', !row.blocked);
    console.log(`    -> ${row.toTeam} ${row.position}, displaces ${row.displaces ? row.displaces.name : '(vacant)'}`);

    try { fs.rmSync(OUT_CFB, { recursive: true, force: true }); } catch (e) { /* fine */ }
    const committed = await commitMoves({
      direction: 'maddenToCfb', plan: proposed.plan, cfbPath: CFB, maddenPath: MADDEN,
      outputPath: OUT_CFB, config: { coachSkinTone: 4 }, log: () => {},
    });
    check('committed the coordinator', committed.written === 1);
    const res = committed.results[0];
    check('position stayed DefensiveCoordinator', res.position === 'DefensiveCoordinator');

    const { cfbFile: out } = await openCfbSave(OUT_CFB);
    const teamT = biggestTableByName(out, 'Team');
    const coachT = biggestTableByName(out, 'Coach');
    await teamT.readRecords(); await coachT.readRecords();
    const bama = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === 'Alabama');
    const dcRef = refOf(bama, 'DefensiveCoordinator');
    check('Alabama.DefensiveCoordinator points at the new row', dcRef && dcRef.rowNumber === res.destRow);
    const newDc = coachT.records[res.destRow];
    const hcRef = refOf(bama, 'HeadCoach');
    const hc = hcRef ? coachT.records[hcRef.rowNumber] : null;
    if (hc) {
      const same = refKey(newDc, 'DefensiveScheme') === refKey(hc, 'DefensiveScheme');
      console.log(`    staff scheme coherence: new DC def-scheme ${refKey(newDc, 'DefensiveScheme')} vs HC ${refKey(hc, 'DefensiveScheme')} -> ${same ? 'AGREE' : 'DISAGREE'}`);
    }
    fs.rmSync(OUT_CFB, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
