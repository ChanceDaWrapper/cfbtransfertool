// READ-ONLY follow-up to probe35. Two things it surfaced need nailing down
// before any full-staff design can rest on them:
//
//   1. CFB's SpecialTeamsCoach resolved to Coach row 375 -- a BLANK name with
//      Position=NumCollegeCoaches, and the save has exactly ONE coach at that
//      position while all 143 teams report the slot "filled". Strong smell of
//      a single shared placeholder rather than 143 real special-teams coaches.
//      If so, SpecialTeamsCoach is not a real staff job and must not be a
//      transfer target.
//   2. Madden's Team schema HAS HeadTrainer and SpecialTeamsCoach fields, but
//      neither resolved to the Coach table on the sampled team. Are they null
//      league-wide, or populated on SOME teams (which would make them real
//      slots we're currently ignoring)?
//
// Also: probe35 found NO field in either game linking a coordinator to their
// head coach. Confirm TeamIndex really is the only association, by checking
// whether a team's three coaches agree on TeamIndex and nothing else ties them.

const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  const { maddenFile } = await openMaddenSave(MADDEN);

  // =============== 1. CFB SpecialTeamsCoach ===============
  console.log('########## CFB: is SpecialTeamsCoach a real slot? ##########');
  {
    const teamT = biggestTableByName(cfbFile, 'Team');
    const coachT = biggestTableByName(cfbFile, 'Coach');
    await teamT.readRecords();
    await coachT.readRecords();
    const coachIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));

    const targets = new Map(); // "tableId:row" -> count
    let teams = 0;
    for (const tr of teamT.records) {
      if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
      teams++;
      const ref = refOf(tr, 'SpecialTeamsCoach');
      const key = ref ? `${ref.tableId}:${ref.rowNumber}` : '(null)';
      targets.set(key, (targets.get(key) || 0) + 1);
    }
    console.log(`  ${teams} schools; SpecialTeamsCoach points at ${targets.size} DISTINCT target(s):`);
    for (const [key, n] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      const [tid, row] = key.split(':').map(Number);
      let desc = '(null)';
      if (coachIds.has(tid)) {
        const rec = coachT.records[row];
        desc = rec && !rec.isEmpty
          ? `Name=${JSON.stringify(safe(rec, 'Name'))} Position=${safe(rec, 'Position')} TeamIndex=${safe(rec, 'TeamIndex')} Level=${safe(rec, 'Level')}`
          : '(empty coach row)';
      }
      console.log(`    ${key.padEnd(12)} used by ${String(n).padStart(3)} school(s)  ${desc}`);
    }
    console.log(`  => ${targets.size === 1 ? 'SHARED PLACEHOLDER -- not a real per-school job.' : 'genuinely per-school; treat as a real slot.'}`);

    // For contrast: how many distinct targets do the three REAL slots have?
    for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
      const seen = new Set();
      for (const tr of teamT.records) {
        if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
        const ref = refOf(tr, slot);
        if (ref) seen.add(`${ref.tableId}:${ref.rowNumber}`);
      }
      console.log(`    (contrast) ${slot.padEnd(22)} ${seen.size} distinct targets across ${teams} schools`);
    }
  }

  // =============== 2. Madden HeadTrainer / SpecialTeamsCoach ===============
  console.log('\n########## MADDEN: are HeadTrainer / SpecialTeamsCoach ever populated? ##########');
  {
    const teamT = biggestTableByName(maddenFile, 'Team');
    const coachT = biggestTableByName(maddenFile, 'Coach');
    await teamT.readRecords();
    await coachT.readRecords();
    const coachIds = new Set((maddenFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));

    for (const slot of ['HeadTrainer', 'SpecialTeamsCoach', 'HeadCoach']) {
      let nonNull = 0, intoCoachTable = 0, teams = 0, distinct = new Set();
      let example = null;
      for (const tr of teamT.records) {
        if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
        teams++;
        const ref = refOf(tr, slot);
        if (!ref) continue;
        nonNull++;
        distinct.add(`${ref.tableId}:${ref.rowNumber}`);
        if (coachIds.has(ref.tableId)) {
          intoCoachTable++;
          if (!example) {
            const rec = coachT.records[ref.rowNumber];
            example = rec && !rec.isEmpty ? `${safe(rec, 'Name')} (Position=${safe(rec, 'Position')})` : '(empty row)';
          }
        }
      }
      console.log(`  ${slot.padEnd(20)} non-null on ${String(nonNull).padStart(3)}/${teams} teams, `
        + `${intoCoachTable} into the Coach table, ${distinct.size} distinct target(s)`
        + (example ? `  e.g. ${example}` : ''));
    }
  }

  // =============== 3. Staff association: TeamIndex only? ===============
  console.log('\n########## Is TeamIndex the ONLY thing tying a staff together? ##########');
  for (const [label, file] of [['MADDEN', maddenFile], ['CFB', cfbFile]]) {
    const teamT = biggestTableByName(file, 'Team');
    const coachT = biggestTableByName(file, 'Coach');
    await teamT.readRecords();
    await coachT.readRecords();
    const coachIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));

    // Pick one fully-staffed team and dump the three coaches' shared/differing fields.
    let chosen = null;
    for (const tr of teamT.records) {
      if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
      const staff = {};
      let ok = true;
      for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
        const ref = refOf(tr, slot);
        const rec = ref && coachIds.has(ref.tableId) ? coachT.records[ref.rowNumber] : null;
        if (!rec || rec.isEmpty) { ok = false; break; }
        staff[slot] = rec;
      }
      if (ok) { chosen = { team: tr, staff }; break; }
    }
    if (!chosen) { console.log(`  ${label}: no fully-staffed team found`); continue; }

    console.log(`\n  ${label} -- ${safe(chosen.team, 'DisplayName')} (TeamIndex ${safe(chosen.team, 'TeamIndex')})`);
    const fields = ['TeamIndex', 'PrevTeamIndex', 'ContractStatus', 'ContractLength', 'ContractYearsRemaining', 'Level', 'YearsCoaching', 'OffensiveScheme', 'DefensiveScheme'];
    console.log(`    ${'field'.padEnd(24)} ${'HC'.padEnd(18)} ${'OC'.padEnd(18)} DC`);
    for (const f of fields) {
      const v = (slot) => {
        const raw = safe(chosen.staff[slot], f);
        return String(raw === undefined ? '-' : raw).slice(0, 17);
      };
      console.log(`    ${f.padEnd(24)} ${v('HeadCoach').padEnd(18)} ${v('OffensiveCoordinator').padEnd(18)} ${v('DefensiveCoordinator')}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
