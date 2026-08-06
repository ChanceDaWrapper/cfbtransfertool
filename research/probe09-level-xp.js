// READ-ONLY. Q10: the Level <-> ExperiencePoints relationship in each game.
// A transferred coach needs a Level AND an XP total that agree with each other
// in the DESTINATION game's own progression curve -- copying either one alone
// leaves the coach mid-level-up or instantly over-levelled.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);

async function curve(file, label) {
  const t = biggest(file, 'Coach');
  await t.readRecords();
  const rows = t.records.filter((r) => !r.isEmpty)
    .map((r) => ({ lvl: safe(r, 'Level'), xp: safe(r, 'ExperiencePoints'), pos: String(safe(r, 'Position')) }))
    .filter((x) => typeof x.lvl === 'number' && typeof x.xp === 'number');

  // XP observed at each level
  const byLevel = new Map();
  for (const r of rows) {
    if (!byLevel.has(r.lvl)) byLevel.set(r.lvl, []);
    byLevel.get(r.lvl).push(r.xp);
  }
  const table = [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, xs]) => {
    const s = xs.slice().sort((a, b) => a - b);
    return { lvl, n: s.length, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  });

  console.log(`\n######## ${label}  n=${rows.length}, distinct levels=${table.length}`);
  console.log('  lvl   n     minXP      medXP      maxXP   | med/lvl  | gap from prev med');
  let prev = null;
  for (const e of table) {
    const gap = prev === null ? '' : String(e.med - prev);
    console.log(`  ${String(e.lvl).padStart(3)} ${String(e.n).padStart(4)}  ${String(e.min).padStart(9)}  ${String(e.med).padStart(9)}  ${String(e.max).padStart(9)}   | ${e.lvl ? (e.med / e.lvl).toFixed(0).padStart(6) : '     -'}   | ${gap.padStart(8)}`);
    prev = e.med;
  }

  // Is XP a clean monotone function of level? Check overlap between adjacent levels.
  let violations = 0;
  for (let i = 1; i < table.length; i++) if (table[i].min < table[i - 1].max) violations++;
  console.log(`  adjacent-level XP range overlaps: ${violations}/${table.length - 1}`
    + (violations === 0 ? '  -> XP THRESHOLDS ARE CLEAN (level is a pure function of XP)' : '  -> ranges overlap'));

  // Fit: is cumulative XP quadratic in level? (typical "cost to next level" = a*L+b)
  const fitPts = table.filter((e) => e.lvl > 0 && e.n >= 2);
  if (fitPts.length >= 3) {
    // least squares on med = a*L^2 + b*L
    let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
    for (const e of fitPts) {
      const L = e.lvl, L2 = L * L;
      s11 += L2 * L2; s12 += L2 * L; s22 += L * L; y1 += L2 * e.med; y2 += L * e.med;
    }
    const det = s11 * s22 - s12 * s12;
    if (det !== 0) {
      const a = (y1 * s22 - y2 * s12) / det;
      const b = (s11 * y2 - s12 * y1) / det;
      let sse = 0, sst = 0;
      const mean = fitPts.reduce((s, e) => s + e.med, 0) / fitPts.length;
      for (const e of fitPts) { const p = a * e.lvl * e.lvl + b * e.lvl; sse += (e.med - p) ** 2; sst += (e.med - mean) ** 2; }
      console.log(`  quadratic fit: XP(L) = ${a.toFixed(3)}*L^2 + ${b.toFixed(3)}*L   R^2=${(1 - sse / sst).toFixed(4)}  (n=${fitPts.length} levels)`);
    }
  }
  return { label, table, rows };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const c = await curve(cfb, 'CFB27');
  const m = await curve(mad, 'MADDEN26');
  fs.writeFileSync(path.join(OUT, 'level-xp.json'), JSON.stringify({ cfb: c.table, madden: m.table }, null, 2));

  // What XP should a coach mapped to Madden level N be given?
  console.log('\n\n######## PROPOSED: XP floor to write for a given destination level');
  const floor = (tbl) => { const f = {}; for (const e of tbl) f[e.lvl] = e.min; return f; };
  const mf = floor(m.table), cf = floor(c.table);
  console.log('  MADDEN lvl -> min observed XP at that level (the level-up threshold):');
  console.log('   ' + Object.entries(mf).map(([l, x]) => `${l}:${x}`).join(' '));
  console.log('  CFB lvl -> min observed XP at that level:');
  console.log('   ' + Object.entries(cf).map(([l, x]) => `${l}:${x}`).join(' '));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
