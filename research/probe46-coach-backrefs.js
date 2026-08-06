// READ-ONLY. Two field-level theories have now failed to stop the crash, so
// this stops looking at the coach RECORD and looks at everything that POINTS
// AT it.
//
// The transferred coaches occupy rows that used to be free-agent shells. If
// some other structure still lists those rows as available coaches -- a
// carousel candidate pool, a staff list, a hiring queue -- then the save has
// a coach who is simultaneously employed and in the "unemployed" list. The
// game processes exactly that kind of list when it runs the coaching carousel
// at the end of a season, which is where this save dies.
//
// Scans EVERY table in the save for references into the Coach table, then
// compares what points at our six against what points at genuine coaches.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = process.argv[2] || 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-AZSTATEOFFICIAL-REPAIRED';
const TRANSFERRED = [118, 446, 450, 461, 471, 490];

(async () => {
  const { cfbFile } = await openCfbSave(SAVE);
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  console.log(`Coach table id(s): ${[...coachTableIds].join(', ')}`);

  const transferred = new Set(TRANSFERRED);
  // A control group of genuine employed coaches to compare against.
  const genuine = coachT.records
    .filter((r) => !r.isEmpty && !transferred.has(r.index)
      && safe(r, 'TeamIndex') !== 255 && safe(r, 'Level') > 0)
    .slice(0, 40)
    .map((r) => r.index);
  const genuineSet = new Set(genuine);

  // Walk every table, every record, every reference-typed field.
  const tables = cfbFile.tables || [];
  console.log(`Scanning ${tables.length} tables for references into Coach...\n`);

  const results = []; // { table, field, hitsTransferred, hitsGenuine }
  for (const t of tables) {
    if (coachTableIds.has(t.header.tableId)) continue; // the Coach table itself
    let recs;
    try { await t.readRecords(); recs = t.records; } catch (e) { continue; }
    if (!recs || !recs.length) continue;
    const attrs = t.schema ? t.schema.attributes : [];
    if (!attrs.length) continue;

    const perField = new Map();
    for (const rec of recs) {
      if (rec.isEmpty) continue;
      for (const a of attrs) {
        let ref;
        try { ref = rec.getReferenceDataByKey(a.name); } catch (e) { continue; }
        if (!ref || !coachTableIds.has(ref.tableId)) continue;
        if (!perField.has(a.name)) perField.set(a.name, { t: [], g: 0 });
        const slot = perField.get(a.name);
        if (transferred.has(ref.rowNumber)) slot.t.push({ row: rec.index, coachRow: ref.rowNumber });
        else if (genuineSet.has(ref.rowNumber)) slot.g++;
      }
    }
    for (const [field, slot] of perField) {
      if (!slot.t.length && !slot.g) continue;
      results.push({ table: t.name, tableId: t.header.tableId, field, hitsTransferred: slot.t, hitsGenuine: slot.g });
    }
  }

  console.log('Tables/fields that reference Coach rows:');
  console.log('(comparing our 6 transferred coaches vs a 40-coach genuine control)\n');
  for (const r of results) {
    const flag = (r.hitsTransferred.length === 0 && r.hitsGenuine > 0)
      ? '   <<<< genuine coaches are referenced here, ours are NOT'
      : (r.hitsTransferred.length > 0 && r.hitsGenuine === 0)
        ? '   <<<< ONLY ours are referenced here'
        : '';
    console.log(`  ${String(r.table).padEnd(28)} .${String(r.field).padEnd(26)} `
      + `ours=${String(r.hitsTransferred.length).padStart(3)}  control=${String(r.hitsGenuine).padStart(3)}${flag}`);
  }
  if (!results.length) console.log('  (none found)');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
