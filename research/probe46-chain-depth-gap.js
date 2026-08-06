// READ-ONLY. probe45 showed many LOW-LEVEL CFB coaches report "no chain" from
// readOwnTalentChain -- yet hasUsableChain (the gate findDisposableCfbSlot and
// pickCfbDonorCoach both use) only checks that an ActiveTalentTree REFERENCE
// exists, never that it resolves all the way down to leaves.
//
// That gap matters now that the disposable tier accepts low-level free agents:
//   - as a DESTINATION: grantCfbTalentTree returns a `skipped` report and the
//     coach lands with no talent tree at all (the "Level 1 / DUMMY ARCHETYPE"
//     failure the whole module exists to prevent) -- silent, not an error.
//   - as a DONOR: grantCfbTalentTree THROWS ("no readable talent chain"), so a
//     low-level arrival could fail outright.
//
// Measures how many rows pass the shallow check but fail the deep one.
//
// Run: node research/probe46-chain-depth-gap.js   (CFB_SAVE=... to override)

const path = require('path');
const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const { readOwnTalentChain } = require('../lib/carousel/cfbTalentTree');

const HOME = require('os').homedir();
const CFB = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-COACHTEST');
const CEILING = 15; // disposableLevelCeiling default

const shallowOk = (r) => {
  if (!safe(r, 'Name')) return false;
  let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { return false; }
  return !!(ref && ref.tableId);
};

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  console.log(`save: ${CFB}\n`);
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const live = t.records.filter((r) => !r.isEmpty);

  // The exact pool the widened tier 2 now selects from.
  const tier2 = live.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent'
    && (safe(r, 'Level') || 0) <= CEILING
    && (safe(r, 'CareerPointsFor') || 0) === 0
    && (safe(r, 'CareerPointsAgainst') || 0) === 0
    && shallowOk(r));

  console.log('########## destinations: rows the new tier would pick ##########');
  let deepOk = 0; const bad = [];
  for (const r of tier2) {
    const chain = await readOwnTalentChain(cfbFile, r); // eslint-disable-line no-await-in-loop
    if (chain && chain.leaves.some(Boolean)) deepOk++;
    else bad.push({ name: safe(r, 'Name'), lvl: safe(r, 'Level'), pos: safe(r, 'Position'), row: r.index });
  }
  console.log(`  pass the SHALLOW check (what the code uses today): ${tier2.length}`);
  console.log(`  also pass the DEEP check (chain really resolves):   ${deepOk}`);
  console.log(`  pass shallow but FAIL deep -> coach lands talentless: ${bad.length}`);
  for (const b of bad.slice(0, 10)) console.log(`    row ${String(b.row).padStart(4)} ${String(b.name).padEnd(18)} ${String(b.pos).padEnd(22)} L${b.lvl}`);
  if (bad.length > 10) console.log(`    ... and ${bad.length - 10} more`);

  // Same gap on the DONOR side, by level band -- a bad donor throws.
  console.log('\n########## donors: chain resolves, by level band ##########');
  const bands = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 30], [31, 100]];
  for (const [lo, hi] of bands) {
    const pool = live.filter((r) => { const l = safe(r, 'Level') || 0; return l >= lo && l <= hi && shallowOk(r); });
    let ok = 0;
    for (const r of pool) {
      const chain = await readOwnTalentChain(cfbFile, r); // eslint-disable-line no-await-in-loop
      if (chain && chain.leaves.some(Boolean)) ok++;
    }
    const pct = pool.length ? Math.round((ok / pool.length) * 100) : 0;
    console.log(`  Level ${String(lo).padStart(2)}-${String(hi).padStart(3)}: ${String(ok).padStart(3)}/${String(pool.length).padStart(3)} resolve (${pct}%)`
      + (pool.length && pct < 100 ? '   <-- donors here can throw' : ''));
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
