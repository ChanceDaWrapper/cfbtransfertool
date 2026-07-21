// READ-ONLY. (a) CharacterVisuals blob structure in both games (Q5),
// (b) Level scale: full percentile ladder for the CFB->Madden conversion (Q1),
// (c) CoachPrestigeScore percentiles for the P70 synthesis rule,
// (d) head-asset naming taxonomy for coaches in both games.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe, stats } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);

function walk(obj, prefix, acc, depth = 0) {
  if (depth > 4 || obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { if (obj.length) walk(obj[0], `${prefix}[]`, acc, depth + 1); return; }
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    acc[p] = (acc[p] || 0) + 1;
    walk(obj[k], p, acc, depth + 1);
  }
}

async function visuals(file, label) {
  const coachT = biggest(file, 'Coach');
  await coachT.readRecords();
  const rows = coachT.records.filter((r) => !r.isEmpty);
  const keyCounts = {};
  let parsed = 0, refd = 0, failed = 0;
  const samples = [];
  const cache = new Map();
  for (const r of rows) {
    let ref; try { ref = r.getReferenceDataByKey('CharacterVisuals'); } catch (e) { ref = null; }
    if (!ref || (!ref.tableId && !ref.rowNumber)) continue;
    refd++;
    const ck = ref.tableId;
    if (!cache.has(ck)) { const vt = file.getTableById(ref.tableId); if (vt) await vt.readRecords(); cache.set(ck, vt); }
    const vt = cache.get(ck);
    if (!vt) { failed++; continue; }
    const vr = vt.records[ref.rowNumber];
    if (!vr || vr.isEmpty) { failed++; continue; }
    const raw = safe(vr, 'RawData');
    if (typeof raw !== 'string') { failed++; continue; }
    let obj; try { obj = JSON.parse(raw); } catch (e) { failed++; continue; }
    parsed++;
    walk(obj, '', keyCounts);
    if (samples.length < 2) samples.push({ row: r.index, name: safe(r, 'Name'), bytes: raw.length, obj });
  }
  console.log(`\n######## ${label} CharacterVisuals: coaches=${rows.length} withRef=${refd} parsedJSON=${parsed} failed=${failed}`);
  const top = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  distinct JSON paths: ${top.length}`);
  for (const [k, n] of top.slice(0, 45)) console.log(`    ${String(n).padStart(4)}/${parsed}  ${k}`);
  if (samples[0]) {
    console.log(`  SAMPLE (${samples[0].name}, ${samples[0].bytes} bytes):`);
    console.log('    ' + JSON.stringify(samples[0].obj).slice(0, 1600));
  }
  return { refd, parsed, failed, paths: Object.fromEntries(top), samples };
}

async function levels(file, label) {
  const coachT = biggest(file, 'Coach');
  await coachT.readRecords();
  const rows = coachT.records.filter((r) => !r.isEmpty);
  const out = {};
  const byPos = {};
  for (const r of rows) {
    const p = String(safe(r, 'Position'));
    if (!['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'].includes(p)) continue;
    (byPos[p] = byPos[p] || []).push(safe(r, 'Level'));
    (byPos.ALL = byPos.ALL || []).push(safe(r, 'Level'));
  }
  for (const p of Object.keys(byPos)) {
    const a = byPos[p].filter((n) => typeof n === 'number').sort((x, y) => x - y);
    const ladder = {};
    for (let q = 0; q <= 100; q += 5) ladder[`p${q}`] = a[Math.min(a.length - 1, Math.round((a.length - 1) * q / 100))];
    out[p] = { n: a.length, ladder };
  }
  // head-asset naming
  const heads = {};
  for (const r of rows) { const h = safe(r, 'GenericHeadAssetName'); if (h) heads[h] = (heads[h] || 0) + 1; }
  const prestige = label === 'CFB27' ? stats(rows.map((r) => safe(r, 'CoachPrestigeScore'))) : null;
  const prestigeHC = label === 'CFB27'
    ? stats(rows.filter((r) => String(safe(r, 'Position')) === 'HeadCoach').map((r) => safe(r, 'CoachPrestigeScore'))) : null;

  console.log(`\n######## ${label} LEVEL PERCENTILE LADDER`);
  for (const p of Object.keys(out)) console.log(`  ${p.padEnd(24)} n=${out[p].n}  ${Object.entries(out[p].ladder).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`\n  GenericHeadAssetName: ${Object.keys(heads).length} distinct; samples: ${Object.keys(heads).slice(0, 12).join(', ')}`);
  if (prestige) {
    console.log(`\n  CoachPrestigeScore ALL: ${JSON.stringify(prestige)}`);
    console.log(`  CoachPrestigeScore HC : ${JSON.stringify(prestigeHC)}`);
  }
  return { levels: out, heads, prestige, prestigeHC };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const cv = await visuals(cfb, 'CFB27');
  const mv = await visuals(mad, 'MADDEN26');
  const cl = await levels(cfb, 'CFB27');
  const ml = await levels(mad, 'MADDEN26');
  fs.writeFileSync(path.join(OUT, 'visuals-level.json'), JSON.stringify({ cfbVisuals: cv, madVisuals: mv, cfbLevels: cl, madLevels: ml }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
