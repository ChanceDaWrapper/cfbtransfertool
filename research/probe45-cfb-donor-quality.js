// READ-ONLY. Two questions about "just copy a similar coach's tree":
//
//   Q1. For a chainless row, could we point it at an EXISTING coach's chain
//       instead of building one? (i.e. share the reference rather than
//       allocate.) Does the game itself ever do that?
//
//   Q2. When we DO copy, is the donor actually similar? pickCfbDonorCoach
//       takes the nearest Level -- but if the save has no low-level coaches,
//       a Level 5 arrival would inherit a Level 40 donor's fully-bought tree.
//       Measure how far off the nearest donor is across the level range.
//
// Run: node research/probe45-cfb-donor-quality.js   (CFB_SAVE=... to override)

const path = require('path');
const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const { readOwnTalentChain, SUBTREE_SLOTS } = require('../lib/carousel/cfbTalentTree');

const HOME = require('os').homedir();
const CFB = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-COACHTEST');

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  console.log(`save: ${CFB}\n`);
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const live = t.records.filter((r) => !r.isEmpty && safe(r, 'Name'));

  // ===== Q1: does the game ever SHARE a talent chain between two coaches? =====
  console.log('########## Q1: does CFB ever share a chain between coaches? ##########');
  const byRef = new Map(); // "tableId:rowNumber" -> [coach names]
  let noRef = 0;
  for (const r of live) {
    let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { ref = null; }
    if (!ref || !ref.tableId) { noRef++; continue; }
    const key = `${ref.tableId}:${ref.rowNumber}`;
    if (!byRef.has(key)) byRef.set(key, []);
    byRef.get(key).push(safe(r, 'Name'));
  }
  const shared = [...byRef.entries()].filter(([, names]) => names.length > 1);
  console.log(`  coaches with a chain: ${live.length - noRef}`);
  console.log(`  distinct chain rows:  ${byRef.size}`);
  console.log(`  rows shared by 2+ coaches: ${shared.length}`);
  for (const [key, names] of shared.slice(0, 5)) console.log(`    ${key} <- ${names.join(', ')}`);
  console.log(shared.length === 0
    ? '  => the game gives EVERY coach a private chain. Sharing one would be out-of-distribution.'
    : '  => sharing occurs, but only incidentally -- not the norm.');

  // ===== Q2: how good is the nearest-level donor, per position? =====
  console.log('\n########## Q2: donor quality by level ##########');
  const ownedCount = async (rec) => {
    const chain = await readOwnTalentChain(cfbFile, rec);
    if (!chain) return null;
    let owned = 0, spent = 0;
    for (const leaf of chain.leaves) {
      if (!leaf) continue;
      spent += safe(leaf, 'CoachPointsSpent') || 0;
      for (let j = 0; j < 33; j++) if (safe(leaf, `TalentStatus${j}`) === 'Owned') owned++;
    }
    return { owned, spent };
  };

  for (const position of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
    // Mirror pickCfbDonorCoach's OWN filter -- it requires an ActiveTalentTree
    // reference. Omitting that (an earlier version of this probe did) makes
    // chainless rows look like candidate donors and reports a false "no chain".
    const hasRef = (r) => { try { const x = r.getReferenceDataByKey('ActiveTalentTree'); return !!(x && x.tableId); } catch (e) { return false; } };
    const pool = live.filter((r) => safe(r, 'Position') === position && (safe(r, 'Level') || 0) > 0 && hasRef(r))
      .map((r) => ({ rec: r, lvl: safe(r, 'Level'), name: safe(r, 'Name') }))
      .sort((a, b) => a.lvl - b.lvl);
    if (!pool.length) { console.log(`  ${position}: no leveled coaches`); continue; }
    const levels = pool.map((p) => p.lvl);
    console.log(`\n  ${position}: ${pool.length} donors, Level ${levels[0]}..${levels[levels.length - 1]}`);

    // For a range of arrival levels, how far is the nearest available donor?
    for (const target of [1, 5, 10, 20, 30, 40, 60]) {
      const nearest = pool.reduce((best, p) => (Math.abs(p.lvl - target) < Math.abs(best.lvl - target) ? p : best), pool[0]);
      const gap = Math.abs(nearest.lvl - target);
      const stats = await ownedCount(nearest.rec);
      console.log(`    arrival L${String(target).padStart(2)} -> donor ${String(nearest.name).padEnd(16)} L${String(nearest.lvl).padStart(2)} `
        + `(gap ${String(gap).padStart(2)})  ${stats ? `${stats.owned} talents owned, ${stats.spent} pts` : 'no chain'}`
        + (gap > 8 ? '   <-- POOR MATCH' : ''));
    }
  }

  // How full is a chain at the low end vs the high end?
  console.log('\n########## how much does the tree actually vary with level? ##########');
  const sample = live.filter((r) => (safe(r, 'Level') || 0) > 0)
    .sort((a, b) => (safe(a, 'Level') || 0) - (safe(b, 'Level') || 0));
  for (const rec of [sample[0], sample[Math.floor(sample.length / 2)], sample[sample.length - 1]].filter(Boolean)) {
    const stats = await ownedCount(rec);
    console.log(`  ${String(safe(rec, 'Name')).padEnd(18)} L${String(safe(rec, 'Level')).padStart(2)} `
      + `-> ${stats ? `${stats.owned}/${SUBTREE_SLOTS * 33} talents owned, ${stats.spent} pts spent` : 'no chain'}`);
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
