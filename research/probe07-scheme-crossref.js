// READ-ONLY. Derives the Coach.OffensiveScheme/DefensiveScheme REFERENCE ->
// BaseScheme NAME mapping, by joining each Team's readable
// CurrentOffensiveScheme/DefaultOffensiveScheme enum value against the Coach
// row that team points at. Produces the real, named scheme lookup table for
// both games.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');

function biggest(file, name) {
  const ts = file.getAllTablesByName(name) || [];
  return ts.reduce((best, t) => (t.header.recordCapacity > (best ? best.header.recordCapacity : 0) ? t : best), null);
}
const refKey = (rec, k) => { try { const r = rec.getReferenceDataByKey(k); return r ? `${r.tableId}:${r.rowNumber}` : null; } catch (e) { return null; } };

async function run(file, label) {
  const teamT = biggest(file, 'Team');
  const coachT = biggest(file, 'Coach');
  await teamT.readRecords();
  await coachT.readRecords();
  const coachTableIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  console.log(`\n############ ${label}: Team table cap=${teamT.header.recordCapacity}, Coach table id(s)=${[...coachTableIds].join(',')}`);

  // rowNumber -> Coach record, for the coach table(s)
  const coachByRow = new Map();
  for (const r of coachT.records) if (!r.isEmpty) coachByRow.set(r.index, r);

  const off = new Map(); // schemeRef -> Map(enumName -> count)
  const def = new Map();
  let teams = 0, joined = 0;
  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    const dn = safe(tr, 'DisplayName');
    if (!dn) continue;
    teams++;
    const offName = safe(tr, 'CurrentOffensiveScheme') ?? safe(tr, 'DefaultOffensiveScheme');
    const defName = safe(tr, 'CurrentDefensiveScheme') ?? safe(tr, 'DefaultDefensiveScheme');
    for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
      let ref; try { ref = tr.getReferenceDataByKey(slot); } catch (e) { ref = null; }
      if (!ref || !coachTableIds.has(ref.tableId)) continue;
      const cr = coachByRow.get(ref.rowNumber);
      if (!cr) continue;
      joined++;
      const or = refKey(cr, 'OffensiveScheme'), dr = refKey(cr, 'DefensiveScheme');
      // only the HC's scheme should be trusted as "the team's scheme"
      if (slot !== 'HeadCoach') continue;
      if (or && offName) { if (!off.has(or)) off.set(or, {}); off.get(or)[offName] = (off.get(or)[offName] || 0) + 1; }
      if (dr && defName) { if (!def.has(dr)) def.set(dr, {}); def.get(dr)[defName] = (def.get(dr)[defName] || 0) + 1; }
    }
  }
  console.log(`  teams with DisplayName=${teams}, coach joins=${joined}`);
  const show = (m, title) => {
    console.log(`\n  === ${title} (${m.size} distinct refs) ===`);
    const rows = [...m.entries()].sort((a, b) => Number(a[0].split(':')[1]) - Number(b[0].split(':')[1]));
    for (const [k, counts] of rows) {
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const total = top.reduce((s, x) => s + x[1], 0);
      const pure = top.length === 1 ? 'PURE' : `MIXED(${top.length})`;
      console.log(`    ${k.padEnd(14)} n=${String(total).padStart(3)} ${pure.padEnd(9)} ${top.map(([n, c]) => `${n}:${c}`).join(', ')}`);
    }
    return Object.fromEntries([...m.entries()]);
  };
  return { off: show(off, `${label} OffensiveScheme ref -> BaseScheme name`), def: show(def, `${label} DefensiveScheme ref -> BaseScheme name`) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const c = await run(cfb, 'CFB27');
  const m = await run(mad, 'MADDEN26');
  fs.writeFileSync(path.join(OUT, 'scheme-crossref.json'), JSON.stringify({ cfb: c, madden: m }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
