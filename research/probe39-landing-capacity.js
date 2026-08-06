// READ-ONLY. How many coaches can actually LAND in each save? This is the
// binding constraint on a full-staff move (3 coaches at once) and on any
// multi-team sweep -- more binding than talent-row headroom (probe38: ~185
// on the Madden side, none on the CFB side).
//
// Both directions land a coach by claiming a "disposable" Coach row, and the
// two games have different pools:
//   Madden (place.js findDisposableSlot)      -- retirement-age FA, then
//                                                level-0 nobody, then empty row
//   CFB    (placeOnCfbTeam.js)                -- same tiers, but a row must
//                                                also carry a usable
//                                                ActiveTalentTree chain, and
//                                                probe38 found ZERO empty
//                                                rows are pre-wired -- so
//                                                CFB's tier-3 "empty row"
//                                                fallback yields a row that
//                                                CANNOT receive a talent grant.
//
// So: count each tier, per position, in both saves, and report how many full
// 3-person staffs that supports.

const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const RETIREMENT_AGE = 75;

const hasUsableCfbChain = (r) => {
  if (!safe(r, 'Name')) return false;
  let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { return false; }
  return !!(ref && ref.tableId);
};

(async () => {
  const { maddenFile } = await openMaddenSave(MADDEN);
  const { cfbFile } = await openCfbSave(CFB);

  for (const [label, file, isCfb] of [['MADDEN', maddenFile, false], ['CFB', cfbFile, true]]) {
    console.log(`\n########## ${label}: disposable landing slots ##########`);
    const t = biggestTableByName(file, 'Coach');
    await t.readRecords();

    const live = t.records.filter((r) => !r.isEmpty);
    const faStatus = isCfb ? 'FreeAgent' : 'FreeAgent';
    const freeAgents = live.filter((r) => safe(r, 'ContractStatus') === faStatus);
    const emptyRows = t.records.filter((r) => r.isEmpty);

    console.log(`  Coach table: capacity=${t.header.recordCapacity} non-empty=${live.length} empty=${emptyRows.length}`);
    console.log(`  free agents: ${freeAgents.length}`);

    const chainOk = (r) => (isCfb ? hasUsableCfbChain(r) : true);

    const retiring = freeAgents.filter((r) => (safe(r, 'Age') || 0) >= RETIREMENT_AGE && chainOk(r));
    const nobodies = freeAgents.filter((r) => (safe(r, 'Level') || 0) === 0
      && (safe(r, 'CareerPointsFor') || 0) === 0
      && (safe(r, 'CareerPointsAgainst') || 0) === 0
      && chainOk(r));

    console.log(`  tier 1 -- retirement-age FA (>=${RETIREMENT_AGE}):  ${retiring.length}`);
    console.log(`  tier 2 -- level-0 nobody FA:                ${nobodies.length}`);
    console.log(`  tier 3 -- empty rows:                       ${emptyRows.length}`
      + (isCfb ? '  <-- UNUSABLE on CFB (no pre-wired talent chain; grantCfbTalentTree needs one)' : ''));

    const usable = isCfb
      ? retiring.length + nobodies.length
      : retiring.length + nobodies.length + emptyRows.length;
    console.log(`  => usable landing slots: ${usable}`);
    console.log(`     full 3-person staffs that fit: ${Math.floor(usable / 3)}`);

    // Position breakdown -- findDisposableSlot does NOT filter the pool by
    // position (any disposable row can receive any position), so this is
    // informational, but a position-aware future version would care.
    const byPos = new Map();
    for (const r of [...retiring, ...nobodies]) {
      const p = safe(r, 'Position');
      byPos.set(p, (byPos.get(p) || 0) + 1);
    }
    console.log(`     (their current Position values: ${[...byPos.entries()].map(([p, n]) => `${p}=${n}`).join(' ') || 'none'})`);
  }

  // How many teams could actually SOURCE a full staff? (all 3 slots filled)
  console.log('\n########## Source side: teams with a complete HC+OC+DC staff ##########');
  for (const [label, file] of [['CFB', cfbFile], ['MADDEN', maddenFile]]) {
    const teamT = biggestTableByName(file, 'Team');
    const coachT = biggestTableByName(file, 'Coach');
    await teamT.readRecords(); await coachT.readRecords();
    const coachIds = new Set((file.getAllTablesByName('Coach') || []).map((x) => x.header.tableId));
    let complete = 0, teams = 0;
    for (const tr of teamT.records) {
      if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
      teams++;
      let n = 0;
      for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
        let ref; try { ref = tr.getReferenceDataByKey(slot); } catch (e) { ref = null; }
        const rec = ref && coachIds.has(ref.tableId) ? coachT.records[ref.rowNumber] : null;
        if (rec && !rec.isEmpty) n++;
      }
      if (n === 3) complete++;
    }
    console.log(`  ${label}: ${complete}/${teams} teams have a complete 3-person staff`);
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
