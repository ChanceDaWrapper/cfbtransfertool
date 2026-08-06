// READ-ONLY. Why do 45 free agents yield ZERO landing slots in
// DYNASTY-COACHTEST? Breaks the free-agent pool down by which specific test
// each one fails, to see whether a SAFE fix exists (widening the disposable
// tiers among real, already-allocated rows) instead of allocating new rows --
// which probe43 proved is unsafe as implemented (empty rows are a linked
// free-list; claiming one without re-linking leaves it flagged empty and
// corrupts the first field).
//
// Run: node research/probe44-cfb-fa-breakdown.js
//      CFB_SAVE=... to point at a different dynasty.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const path = require('path');
const HOME = require('os').homedir();

const CFB = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-COACHTEST');
const RETIREMENT_AGE = 75;

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  console.log(`save: ${CFB}\n`);

  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();

  const hasChain = (r) => {
    let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { return false; }
    return !!(ref && ref.tableId);
  };

  const live = t.records.filter((r) => !r.isEmpty);
  const fas = live.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent');
  console.log(`non-empty Coach rows: ${live.length}`);
  console.log(`free agents:          ${fas.length}\n`);

  let noName = 0, noChain = 0, qualifiesToday = 0;
  const nearMiss = [];
  for (const r of fas) {
    const name = safe(r, 'Name');
    const chain = hasChain(r);
    if (!name) { noName++; continue; }
    if (!chain) { noChain++; continue; }

    const age = safe(r, 'Age') || 0;
    const lvl = safe(r, 'Level') || 0;
    const pf = safe(r, 'CareerPointsFor') || 0;
    const pa = safe(r, 'CareerPointsAgainst') || 0;

    if (age >= RETIREMENT_AGE || (lvl === 0 && pf === 0 && pa === 0)) { qualifiesToday++; continue; }
    // Usable row (real, named, has a chain) that the STRICT tiers reject.
    nearMiss.push({ name, age, lvl, pf, pa, pos: safe(r, 'Position') });
  }

  console.log('########## why each free agent is rejected ##########');
  console.log(`  qualifies today (a real landing slot): ${qualifiesToday}`);
  console.log(`  rejected -- blank Name:                ${noName}`);
  console.log(`  rejected -- no talent chain:           ${noChain}`);
  console.log(`  rejected -- has a real career/level:   ${nearMiss.length}  <-- the safely-widenable pool`);

  if (nearMiss.length) {
    nearMiss.sort((a, b) => a.lvl - b.lvl || a.pf - b.pf);
    console.log('\n  the rejected-but-usable rows, weakest first:');
    for (const c of nearMiss.slice(0, 25)) {
      console.log(`    ${String(c.name).padEnd(18)} ${String(c.pos).padEnd(22)} `
        + `age=${String(c.age).padStart(2)} lvl=${String(c.lvl).padStart(2)} pointsFor=${String(c.pf).padStart(5)} pointsAgainst=${String(c.pa).padStart(5)}`);
    }
    if (nearMiss.length > 25) console.log(`    ... and ${nearMiss.length - 25} more`);

    const byLevel = {};
    for (const c of nearMiss) { const b = c.lvl === 0 ? '0' : c.lvl <= 5 ? '1-5' : c.lvl <= 15 ? '6-15' : c.lvl <= 30 ? '16-30' : '31+'; byLevel[b] = (byLevel[b] || 0) + 1; }
    console.log('\n  distribution by Level:', JSON.stringify(byLevel));
    console.log('  => a tier that accepts free agents at/below some Level would unlock these,');
    console.log('     using rows that are ALREADY properly allocated -- no free-list surgery.');
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
