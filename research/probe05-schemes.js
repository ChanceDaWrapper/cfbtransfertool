// READ-ONLY. The scheme/playbook refs point at asset tables that DON'T exist
// in the save. So: (a) list every table in each save whose name looks
// scheme/playbook/talent related, (b) cross-reference each distinct scheme
// pointer against the TEAMS whose coaches use it, so the lookup table can be
// named from team identity + in-game screens.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');

function rawRef(rec, key) {
  try {
    const ref = rec.getReferenceDataByKey(key);
    if (!ref) return null;
    return `${ref.tableId}:${ref.rowNumber}`;
  } catch (e) { return null; }
}

async function teamNames(file, teamTable) {
  const t = file.getTableByName(teamTable);
  if (!t) return {};
  await t.readRecords();
  const map = {};
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const n = [safe(r, 'DisplayName'), safe(r, 'LongName'), safe(r, 'ShortName'), safe(r, 'Name'), safe(r, 'NickName')]
      .filter((x) => typeof x === 'string' && x.trim()).join(' / ');
    const idx = safe(r, 'TeamIndex');
    if (idx !== undefined) map[idx] = n || `(row ${r.index})`;
  }
  return map;
}

async function schemeMap(file, label) {
  const t = file.getTableByName('Coach');
  await t.readRecords();
  const rows = t.records.filter((r) => !r.isEmpty);
  const tn = await teamNames(file, 'Team');
  const acc = {};
  for (const f of ['OffensiveScheme', 'DefensiveScheme', 'OffensivePlaybook', 'DefensivePlaybook']) {
    const m = new Map();
    for (const r of rows) {
      const k = rawRef(r, f);
      if (!k || k === '0:0') continue;
      if (!m.has(k)) m.set(k, { count: 0, positions: {}, teams: new Set() });
      const e = m.get(k);
      e.count++;
      const p = String(safe(r, 'Position')); e.positions[p] = (e.positions[p] || 0) + 1;
      const ti = safe(r, 'TeamIndex');
      if (ti !== undefined && tn[ti]) e.teams.add(tn[ti]);
    }
    acc[f] = [...m.entries()]
      .map(([k, v]) => ({ ref: k, count: v.count, positions: v.positions, sampleTeams: [...v.teams].slice(0, 12) }))
      .sort((a, b) => b.count - a.count);
  }
  console.log(`\n############ ${label} — team names resolved: ${Object.keys(tn).length}`);
  for (const f of Object.keys(acc)) {
    console.log(`\n=== ${f} (${acc[f].length} distinct) ===`);
    for (const e of acc[f].slice(0, 40)) {
      console.log(`  ${e.ref.padEnd(14)} n=${String(e.count).padStart(4)}  pos=${JSON.stringify(e.positions)}`);
      if (e.sampleTeams.length) console.log(`      teams: ${e.sampleTeams.join(' | ')}`);
    }
    if (acc[f].length > 40) console.log(`  ... +${acc[f].length - 40} more`);
  }
  return acc;
}

async function listTables(file, label) {
  const names = [];
  // FranchiseFile exposes .tables
  for (const t of (file.tables || [])) names.push({ id: t.header ? t.header.tableId : t.tableId, name: t.name });
  const interesting = names.filter((x) => /scheme|playbook|talent|philosoph|archetype|coach|staff|goal|expectation/i.test(x.name || ''));
  console.log(`\n[${label}] total tables=${names.length}; scheme/coach-related:`);
  for (const x of interesting) console.log(`   ${x.id}  ${x.name}`);
  return names;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const cTables = await listTables(cfb, 'CFB');
  const mTables = await listTables(mad, 'MAD');
  const c = await schemeMap(cfb, 'CFB27');
  const m = await schemeMap(mad, 'MADDEN26');
  fs.writeFileSync(path.join(OUT, 'schemes.json'), JSON.stringify({ cfb: c, madden: m, cfbTables: cTables, madTables: mTables }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
