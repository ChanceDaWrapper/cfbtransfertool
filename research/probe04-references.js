// READ-ONLY. Resolves the Coach table's REFERENCE-typed fields (Scheme,
// Playbook, TeamPhilosophy, CharacterVisuals, ActiveTalentTree) to the tables
// and rows they point at, and dumps the real scheme/playbook NAMES in both
// games. This is what the scheme lookup table gets built from.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const REF_FIELDS = ['OffensiveScheme', 'DefensiveScheme', 'OffensivePlaybook', 'DefensivePlaybook',
  'TeamPhilosophy', 'DefaultTeamPhilosophy', 'CharacterVisuals', 'ActiveTalentTree',
  'SeasonStats', 'CareerStats', 'SeasonalGoal', 'HasTrait'];

async function resolve(file, label) {
  const t = file.getTableByName('Coach');
  await t.readRecords();
  const rows = t.records.filter((r) => !r.isEmpty);
  const present = new Set(file.schemaList.getSchema('Coach').attributes.map((a) => a.name));
  const result = {};

  for (const f of REF_FIELDS) {
    if (!present.has(f)) continue;
    const targets = new Map(); // tableId -> {name, rows:Map(row->count)}
    let nulls = 0;
    for (const r of rows) {
      let ref;
      try { ref = r.getReferenceDataByKey(f); } catch (e) { ref = null; }
      if (!ref || (ref.tableId === 0 && ref.rowNumber === 0)) { nulls++; continue; }
      if (!targets.has(ref.tableId)) {
        let tname = '(unknown)';
        try { const tt = file.getTableById(ref.tableId); tname = tt ? tt.name : '(no table)'; } catch (e) { tname = '(err)'; }
        targets.set(ref.tableId, { tableName: tname, rows: new Map() });
      }
      const e = targets.get(ref.tableId);
      e.rows.set(ref.rowNumber, (e.rows.get(ref.rowNumber) || 0) + 1);
    }
    result[f] = { nulls, targets: [...targets.entries()].map(([id, v]) => ({ tableId: id, tableName: v.tableName, distinctRows: v.rows.size, refCount: [...v.rows.values()].reduce((a, b) => a + b, 0) })) };
    console.log(`\n[${label}] ${f}: nulls=${nulls}`);
    for (const tg of result[f].targets) console.log(`    -> table ${tg.tableId} "${tg.tableName}" distinctRows=${tg.distinctRows} refs=${tg.refCount}`);
  }
  return { result, rows, table: t };
}

// Dump the human-readable content of a referenced table.
async function dumpTable(file, tableId, label, maxRows = 400) {
  let t;
  try { t = file.getTableById(tableId); } catch (e) { return null; }
  if (!t) return null;
  await t.readRecords();
  const schema = t.schema ? t.schema.attributes.map((a) => a.name) : [];
  const nameFields = schema.filter((n) => /name|Name|Title|Label|Asset/.test(n));
  const out = { tableId, tableName: t.name, attrs: schema, rowCount: t.records.length, rows: [] };
  for (const r of t.records.slice(0, maxRows)) {
    if (r.isEmpty) continue;
    const o = { _row: r.index };
    for (const f of schema) { const v = safe(r, f); if (v !== undefined && typeof v !== 'object') o[f] = v; }
    out.rows.push(o);
  }
  console.log(`\n### [${label}] table ${tableId} "${t.name}" rows=${t.records.length} filled=${out.rows.length}`);
  console.log(`    attrs: ${schema.join(', ')}`);
  console.log(`    nameish: ${nameFields.join(', ') || '(none)'}`);
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const c = await resolve(cfb, 'CFB');
  const m = await resolve(mad, 'MAD');

  const dumps = { cfb: {}, madden: {} };
  for (const [file, res, bag, label] of [[cfb, c.result, dumps.cfb, 'CFB'], [mad, m.result, dumps.madden, 'MAD']]) {
    for (const f of ['OffensiveScheme', 'DefensiveScheme', 'OffensivePlaybook', 'DefensivePlaybook', 'TeamPhilosophy']) {
      if (!res[f]) continue;
      for (const tg of res[f].targets) {
        if (bag[tg.tableId]) continue;
        bag[tg.tableId] = await dumpTable(file, tg.tableId, label);
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'coach-references.json'), JSON.stringify({ cfb: c.result, madden: m.result, dumps }, null, 2));

  // print the actual scheme/playbook names
  const printNames = (bag, label) => {
    for (const k of Object.keys(bag)) {
      const d = bag[k]; if (!d) continue;
      console.log(`\n===== [${label}] ${d.tableName} (id ${d.tableId}) -- ${d.rows.length} filled rows`);
      for (const r of d.rows.slice(0, 80)) {
        const label2 = r.Name ?? r.name ?? r.AssetName ?? r.SchemeName ?? JSON.stringify(r).slice(0, 120);
        console.log(`   row ${r._row}: ${label2}`);
      }
      if (d.rows.length > 80) console.log(`   ... +${d.rows.length - 80} more`);
    }
  };
  printNames(dumps.cfb, 'CFB');
  printNames(dumps.madden, 'MAD');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
