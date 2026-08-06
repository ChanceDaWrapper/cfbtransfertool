// READ-ONLY. Why does a coach written into a blank shell render as
// "Level 1 / DUMMY ARCHETYPE / no abilities" even though Coach.Level=48 and
// Coach.Archetype=DevelopmentWizard were written and read back correctly?
//
// Hypothesis: Madden's Coach Central UI derives Level, Archetype and the
// ability bars from the TALENT TREE (PlaysheetTalents / GamedayTalents /
// WearAndTearTalents -> Talent[] rows), not from the scalar Coach fields.
// A blank shell has null talent references, so there is nothing to render.
//
// This probe maps the talent system: what those references point at, what a
// real coach's tree looks like at various levels, and what would have to be
// constructed (or cloned) to give a transferred coach a working tree.
const fs = require('fs');
const path = require('path');
const { openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const refOf = (rec, k) => { try { const r = rec.getReferenceDataByKey(k); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

async function dumpTableShape(file, name) {
  const schema = file.schemaList.getSchema(name);
  if (!schema) return console.log(`  ${name}: (no schema)`);
  console.log(`  ${name}: ${schema.attributes.map((a) => a.name + ':' + a.type).join(', ')}`);
}

async function resolveRef(file, ref, label) {
  if (!ref) return console.log(`    ${label}: (null)`);
  let t; try { t = file.getTableById(ref.tableId); } catch (e) { t = null; }
  if (!t) return console.log(`    ${label}: -> table ${ref.tableId} (NOT IN SAVE), row ${ref.rowNumber}`);
  await t.readRecords();
  const rec = t.records[ref.rowNumber];
  console.log(`    ${label}: -> "${t.name}" (id ${ref.tableId}) row ${ref.rowNumber}, isEmpty=${rec ? rec.isEmpty : 'n/a'}, arraySize=${rec ? rec.arraySize : 'n/a'}`);
  return { table: t, rec };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mad = await openMadden();

  console.log('######## Talent-related table shapes');
  for (const n of ['Talent', 'TalentTier', 'PlaysheetTalent', 'GamedayTalent', 'WearAndTearTalent',
    'SeasonTalent', 'TalentLoadoutSlot', 'CoachTalentEffects', 'TalentSubTreeStatus']) {
    await dumpTableShape(mad, n);
  }

  const coachT = biggest(mad, 'Coach');
  await coachT.readRecords();

  // Compare coaches across the level range: a high-level HC, a mid one, and
  // the blank shell the transfer landed in.
  const picks = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const lvl = safe(r, 'Level');
    const name = safe(r, 'Name');
    if (name === 'S. McVay' || name === 'D. Canales' || r.index === 109 || r.index === 21) {
      picks.push({ row: r.index, name, lvl, rec: r });
    }
  }

  for (const p of picks) {
    console.log(`\n######## Coach row ${p.row} -- ${p.name || '(blank)'} (Coach.Level=${p.lvl}, Archetype=${safe(p.rec, 'Archetype')})`);
    console.log(`    IndexInUnlockList=${safe(p.rec, 'IndexInUnlockList')} CurrentPurchasedTalentCosts=${safe(p.rec, 'CurrentPurchasedTalentCosts')} ExperiencePoints=${safe(p.rec, 'ExperiencePoints')}`);
    for (const f of ['PlaysheetTalents', 'GamedayTalents', 'WearAndTearTalents']) {
      const resolved = await resolveRef(mad, refOf(p.rec, f), f);
      // If it's an array table, walk its entries
      if (resolved && resolved.rec && !resolved.rec.isEmpty) {
        const arrTable = resolved.table;
        const arrRec = resolved.rec;
        const n = arrRec.arraySize || 0;
        const entries = [];
        for (let i = 0; i < Math.min(n, 12); i++) {
          const key = `Talent${i}`;
          let v; try { v = arrRec.getValueByKey(key); } catch (e) { v = undefined; }
          let er; try { er = arrRec.getReferenceDataByKey(key); } catch (e) { er = null; }
          entries.push(er ? `${key}->${er.tableId}:${er.rowNumber}` : `${key}=${JSON.stringify(v)}`);
        }
        if (entries.length) console.log(`      arraySize=${n} entries: ${entries.join(', ')}`);
      }
    }
  }

  // What does a real Talent row contain?
  console.log('\n######## Sample Talent rows (from a real coach\'s tree)');
  const mcvay = picks.find((p) => p.name === 'S. McVay') || picks.find((p) => p.name === 'D. Canales');
  if (mcvay) {
    const ref = refOf(mcvay.rec, 'PlaysheetTalents');
    if (ref) {
      const arrT = mad.getTableById(ref.tableId);
      await arrT.readRecords();
      const arrRec = arrT.records[ref.rowNumber];
      const first = (() => { try { return arrRec.getReferenceDataByKey('Talent0'); } catch (e) { return null; } })();
      if (first) {
        const tt = mad.getTableById(first.tableId);
        await tt.readRecords();
        const trec = tt.records[first.rowNumber];
        console.log(`  Talent table "${tt.name}" (id ${first.tableId}), row ${first.rowNumber}:`);
        const tschema = mad.schemaList.getSchema(tt.name);
        if (tschema) for (const a of tschema.attributes) console.log(`    ${a.name} (${a.type}) = ${JSON.stringify(safe(trec, a.name))}`);
      }
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
