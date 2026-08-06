// READ-ONLY. Q10: produce the BALANCED Level+XP conversion table.
//
// probe09 established that the two games mean different things by
// ExperiencePoints:
//   Madden -- CUMULATIVE career XP. Level is a clean function of it
//             (quadratic R^2=0.9972, ~2040 XP per level, flat).
//   CFB    -- SPENDABLE currency, drained by the talent tree. Uncorrelated
//             with Level (R^2=0.4998; a Level 87 coach holds 112 XP).
// So XP is never copied in either direction: it is DERIVED from the mapped
// level using the destination game's own curve.
//
// This script emits the full CFB Level -> Madden (Level, XP) table for each
// position, under the blend from ROADMAP 3.1, so the mapping can be eyeballed
// before any code is written.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const POSITIONS = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];
const W = Number(process.env.W || 1.0);   // percentile weight; 1-W goes to the linear anchor
const WINSOR = Number(process.env.WINSOR || 0.95); // destination top-tail clip

async function levelsByPosition(file) {
  const t = biggest(file, 'Coach');
  await t.readRecords();
  const out = {};
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const p = String(safe(r, 'Position'));
    if (!POSITIONS.includes(p)) continue;
    const l = safe(r, 'Level');
    // Level 0 rows are unfilled shells (CFB free-agent fillers, Madden blanks),
    // not real coaches -- they would drag every percentile down.
    if (typeof l !== 'number' || l === 0) continue;
    (out[p] = out[p] || []).push(l);
  }
  for (const p of Object.keys(out)) out[p].sort((a, b) => a - b);
  return out;
}

// Clip the destination pool's top tail so a SINGLE outlier can't define the
// ceiling. Madden's OC pool has one coach at Level 49 against a p95 of 15 --
// without this, the best CFB OC maps onto that outlier and arrives at 49.
function winsorize(a, q) {
  if (!a.length || q >= 1) return a;
  const cap = a[Math.min(a.length - 1, Math.round(q * (a.length - 1)))];
  return a.map((v) => Math.min(v, cap));
}

// percentile of v within sorted array a (0..1), midpoint convention for ties
function pctOf(a, v) {
  let lo = 0, hi = 0;
  for (const x of a) { if (x < v) lo++; if (x <= v) hi++; }
  return a.length ? ((lo + hi) / 2) / a.length : 0;
}
function valueAt(a, p) {
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}

// Madden cumulative-XP curve, fitted in probe09 (R^2 = 0.9972)
const maddenXp = (L) => Math.max(0, Math.round(1.8 * L * L + 2016.385 * L));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const C = await levelsByPosition(cfb);
  const M = await levelsByPosition(mad);

  console.log(`Blend weight W=${W} (percentile) / ${(1 - W).toFixed(2)} (linear 2:1 anchor)\n`);
  const result = {};
  for (const pos of POSITIONS) {
    const src = C[pos] || [], dst = winsorize(M[pos] || [], WINSOR);
    const rawDst = M[pos] || [];
    console.log(`\n######## ${pos}   CFB n=${src.length} (${src[0]}..${src[src.length - 1]})`
      + `   MAD n=${dst.length} (${rawDst[0]}..${rawDst[rawDst.length - 1]}, winsorized to ${dst[dst.length - 1]})`);
    console.log('  cfbLvl | pct  | pctMap | linear | BLEND | mono | maddenXP  | note');
    const rows = [];
    let lastOut = 0;
    const marks = [];
    for (let l = 1; l <= 90; l++) marks.push(l);
    for (const l of marks) {
      const p = pctOf(src, l);
      const pm = valueAt(dst, p);
      const lin = Math.round(l * 50 / 100);
      let out = Math.round(W * pm + (1 - W) * lin);
      out = Math.max(1, Math.min(50, out));
      const monoFixed = out < lastOut;
      if (monoFixed) out = lastOut;      // enforce monotonicity
      lastOut = out;
      rows.push({ cfb: l, pct: +p.toFixed(3), pctMap: pm, linear: lin, madden: out, xp: maddenXp(out), monoFixed });
    }
    // print a readable subset: every level actually present in the CFB save, plus deciles
    const present = new Set(src);
    for (const r of rows) {
      if (!present.has(r.cfb) && r.cfb % 10 !== 0) continue;
      console.log(`  ${String(r.cfb).padStart(6)} | ${r.pct.toFixed(2)} | ${String(r.pctMap).padStart(6)} | ${String(r.linear).padStart(6)} | ${String(r.madden).padStart(5)} | ${r.monoFixed ? ' fix' : '    '} | ${String(r.xp).padStart(9)} | ${present.has(r.cfb) ? '' : '(no CFB coach at this level)'}`);
    }
    result[pos] = rows;
  }
  fs.writeFileSync(path.join(OUT, 'balanced-level-xp.json'), JSON.stringify({ W, maddenXpFit: 'XP(L)=1.8L^2+2016.385L', table: result }, null, 2));

  // sanity: where do the CFB percentile landmarks land?
  console.log('\n\n######## SANITY — CFB landmark coaches, where they land in Madden');
  for (const pos of POSITIONS) {
    const src = C[pos] || [], dst = winsorize(M[pos] || [], WINSOR);
    const rows = result[pos];
    const at = (q) => src[Math.round(q * (src.length - 1))];
    console.log(`\n  ${pos}:`);
    for (const [label, q] of [['p25', 0.25], ['median', 0.5], ['p75', 0.75], ['p90', 0.9], ['best', 1.0]]) {
      const cl = at(q);
      const r = rows.find((x) => x.cfb === cl);
      const destPct = pctOf(dst, r.madden);
      console.log(`    CFB ${label.padEnd(6)} (Lvl ${String(cl).padStart(2)}) -> Madden Lvl ${String(r.madden).padStart(2)}, XP ${String(r.xp).padStart(6)}  = Madden ${pos} p${Math.round(destPct * 100)}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
