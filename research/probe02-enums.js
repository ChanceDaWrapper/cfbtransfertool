// READ-ONLY. Side-by-side member dump of every enum reachable from the Coach
// table in both games. Answers the "value-name stability vs index" question.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden } = require('./_saves');

const OUT = path.join(__dirname, 'out');

function enumsOf(file, table) {
  const schema = file.schemaList.getSchema(table);
  const map = {};
  for (const a of schema.attributes) {
    if (!a.enum) continue;
    map[a.name] = {
      enumName: a.enum.name,
      members: a.enum.members.map((m) => ({ i: m.index, name: m.name, value: m.value })),
    };
  }
  return map;
}

function line(m) { return `${m.i}=${m.name}(${m.value})`; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const c = enumsOf(cfb, 'Coach');
  const m = enumsOf(mad, 'Coach');
  fs.writeFileSync(path.join(OUT, 'coach-enums.json'), JSON.stringify({ cfb: c, madden: m }, null, 2));

  const all = [...new Set([...Object.keys(c), ...Object.keys(m)])].sort();
  for (const f of all) {
    const cv = c[f], mv = m[f];
    console.log(`\n##### ${f}   cfbEnum=${cv ? cv.enumName : '-'}  madEnum=${mv ? mv.enumName : '-'}`);
    console.log('  CFB: ' + (cv ? cv.members.map(line).join(' | ') : '(absent)'));
    console.log('  MAD: ' + (mv ? mv.members.map(line).join(' | ') : '(absent)'));
    if (cv && mv) {
      const cn = new Set(cv.members.map((x) => x.name));
      const mn = new Set(mv.members.map((x) => x.name));
      const onlyC = [...cn].filter((x) => !mn.has(x));
      const onlyM = [...mn].filter((x) => !cn.has(x));
      // index drift for names present in both
      const drift = cv.members.filter((x) => mn.has(x.name))
        .map((x) => ({ name: x.name, ci: x.value, mi: mv.members.find((y) => y.name === x.name).value }))
        .filter((x) => x.ci !== x.mi);
      if (onlyC.length) console.log('   only-CFB: ' + onlyC.join(','));
      if (onlyM.length) console.log('   only-MAD: ' + onlyM.join(','));
      if (drift.length) console.log('   *** VALUE DRIFT (same name, different numeric value): '
        + drift.map((d) => `${d.name} cfb=${d.ci} mad=${d.mi}`).join(', '));
      if (!onlyC.length && !onlyM.length && !drift.length) console.log('   -> IDENTICAL');
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
