// READ-ONLY. Is there an AUTHORITATIVE XP -> Level table in the save, and
// can the game be made to auto-level a coach we hand a pile of XP to?
//
// Motivation: a transferred coach currently renders as "Level 1 / DUMMY
// ARCHETYPE" no matter what Coach.Level says, and cloning a full talent tree
// changed nothing. CoachProgressionEval exposes StaffLevelTuning,
// AutoProgressCoach, and HeadCoachTraitProgressionList:CoachPackageXP[] --
// which suggests Level is DERIVED from ExperiencePoints against a tuning
// table, not stored authoritatively on the Coach row. If so:
//   (a) the XP thresholds are readable instead of fitted (probe09 fitted a
//       quadratic at R^2=0.9972 -- this would replace the estimate with the
//       real curve), and
//   (b) handing a coach the right XP may let the game level them itself,
//       including building whatever unlock state the UI needs.
const fs = require('fs');
const path = require('path');
const { openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const refOf = (r, k) => { try { const x = r.getReferenceDataByKey(k); return x && (x.tableId || x.rowNumber) ? x : null; } catch (e) { return null; } };

async function dumpSchema(file, name) {
  const s = file.schemaList.getSchema(name);
  console.log(`\n##### ${name}: ${s ? s.attributes.map((a) => a.name + ':' + a.type).join(', ') : '(no schema)'}`);
  return s;
}

async function dumpRows(file, tableName, limit = 60) {
  const t = file.getTableByName(tableName);
  if (!t) { console.log(`  (table ${tableName} not present)`); return null; }
  await t.readRecords();
  const s = file.schemaList.getSchema(tableName);
  const filled = t.records.filter((r) => !r.isEmpty);
  console.log(`  ${tableName}: capacity=${t.header.recordCapacity} filled=${filled.length}`);
  for (const r of filled.slice(0, limit)) {
    const o = { row: r.index };
    if (s) for (const a of s.attributes) { const v = safe(r, a.name); if (v !== undefined) o[a.name] = v; }
    console.log('    ' + JSON.stringify(o));
  }
  return { table: t, filled };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mad = await openMadden();

  // ---- The tuning table the progression evaluator points at ----
  await dumpSchema(mad, 'StaffLevelTuning');
  await dumpRows(mad, 'StaffLevelTuning');

  await dumpSchema(mad, 'CoachPackageXP');
  await dumpRows(mad, 'CoachPackageXP', 20);

  await dumpSchema(mad, 'ProgressionXPSlider');
  await dumpRows(mad, 'ProgressionXPSlider', 20);

  // ---- Follow CoachProgressionEval's own references ----
  const evalT = mad.getTableByName('CoachProgressionEval');
  if (evalT) {
    await evalT.readRecords();
    const r = evalT.records.find((x) => !x.isEmpty);
    if (r) {
      console.log('\n##### CoachProgressionEval live references');
      for (const f of ['StaffLevelTuning', 'HeadCoachTraitProgressionList', 'LeagueSettingRef', 'SeasonInfoRef']) {
        const ref = refOf(r, f);
        if (!ref) { console.log(`  ${f}: (null)`); continue; }
        let t; try { t = mad.getTableById(ref.tableId); } catch (e) { t = null; }
        console.log(`  ${f} -> ${t ? `"${t.name}" (in-save id ${ref.tableId})` : `STATIC ASSET table ${ref.tableId} (not in save)`} row ${ref.rowNumber}`);
        if (t) {
          await t.readRecords();
          const rec = t.records[ref.rowNumber];
          const s = mad.schemaList.getSchema(t.name);
          if (rec && s) {
            const o = {};
            for (const a of s.attributes) { const v = safe(rec, a.name); if (v !== undefined) o[a.name] = v; }
            console.log('     ' + JSON.stringify(o).slice(0, 600));
            if (rec.arraySize) console.log('     arraySize=' + rec.arraySize);
          }
        }
      }
    }
  }

  // ---- Ground truth: the live (Level, XP) pairs, to compare against any
  //      tuning table we find ----
  console.log('\n##### Live (Level, ExperiencePoints) pairs for HeadCoaches -- sorted');
  const coachT = (mad.getAllTablesByName('Coach') || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
  await coachT.readRecords();
  const pairs = [];
  for (const r of coachT.records) {
    if (r.isEmpty || safe(r, 'Position') !== 'HeadCoach') continue;
    const lvl = safe(r, 'Level'); const xp = safe(r, 'ExperiencePoints');
    if (typeof lvl === 'number' && typeof xp === 'number' && lvl > 0) pairs.push({ lvl, xp, name: safe(r, 'Name') });
  }
  pairs.sort((a, b) => a.lvl - b.lvl);
  let prev = null;
  for (const p of pairs) {
    const delta = prev === null ? '' : ` (+${p.xp - prev})`;
    console.log(`   L${String(p.lvl).padStart(2)}  XP=${String(p.xp).padStart(7)}${delta.padStart(10)}  ${p.name}`);
    prev = p.xp;
  }
  fs.writeFileSync(path.join(OUT, 'level-tuning.json'), JSON.stringify({ pairs }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
