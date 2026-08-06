// READ-ONLY. Can we GIVE a transferred coach a working talent tree?
//
// probe13 established that Madden's Coach Central UI renders Level,
// Archetype and abilities from the talent tree, not from Coach.Level /
// Coach.Archetype -- a coach with null talent references displays as
// "Level 1 / DUMMY ARCHETYPE / no abilities" no matter what those scalar
// fields say. Each coach owns PRIVATE talent instance rows (no sharing
// between coaches), so a transferred coach needs their own tree.
//
// Three questions:
//   1. HEADROOM -- are there free rows in the talent tables to clone into?
//   2. LINKAGE  -- what else points at a coach's talents? (Team loadouts?)
//   3. SHAPE    -- how does tree size scale with Level, so a cloned tree can
//                  be sized to the mapped level rather than the donor's?
const fs = require('fs');
const path = require('path');
const { openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const refOf = (rec, k) => { try { const r = rec.getReferenceDataByKey(k); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mad = await openMadden();

  // ---- 1. HEADROOM in every table the tree lives in ----
  console.log('######## Talent table headroom');
  const talentTableIds = [5603, 4235, 4112, 4110, 4208];
  for (const id of talentTableIds) {
    let t; try { t = mad.getTableById(id); } catch (e) { t = null; }
    if (!t) { console.log(`  table ${id}: NOT PRESENT`); continue; }
    await t.readRecords();
    const filled = t.records.filter((r) => !r.isEmpty).length;
    console.log(`  ${String(id).padEnd(6)} "${String(t.name).padEnd(18)}" capacity=${String(t.header.recordCapacity).padStart(5)} filled=${String(filled).padStart(5)} FREE=${t.header.recordCapacity - filled}`);
  }

  // ---- 2. What else references a coach's talents? ----
  console.log('\n######## Team-side loadout references (do they point at coach talents?)');
  const teamT = biggest(mad, 'Team');
  await teamT.readRecords();
  const giants = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === 'Giants');
  for (const f of ['GamedayLoadout', 'PlaysheetLoadout', 'WearAndTearLoadout', 'CoachTalentEffects']) {
    const ref = refOf(giants, f);
    if (!ref) { console.log(`  Giants.${f}: (null)`); continue; }
    let t; try { t = mad.getTableById(ref.tableId); } catch (e) { t = null; }
    console.log(`  Giants.${f}: -> "${t ? t.name : '?'}" (id ${ref.tableId}) row ${ref.rowNumber}`);
    if (t) {
      await t.readRecords();
      const rec = t.records[ref.rowNumber];
      if (rec && !rec.isEmpty) {
        const n = rec.arraySize || 0;
        const slots = [];
        for (let i = 0; i < Math.min(n, 8); i++) {
          let er; try { er = rec.getReferenceDataByKey(`TalentLoadoutSlot${i}`); } catch (e) { er = null; }
          slots.push(er ? `${er.tableId}:${er.rowNumber}` : '(null)');
        }
        console.log(`     arraySize=${n} slots: ${slots.join(', ')}`);
      }
    }
  }

  // ---- 3. Tree SHAPE vs Level, across every real coach ----
  console.log('\n######## Tree size vs Coach.Level (all HeadCoaches)');
  const coachT = biggest(mad, 'Coach');
  await coachT.readRecords();
  const arrCache = new Map();
  async function arraySizeOf(rec, field) {
    const ref = refOf(rec, field);
    if (!ref) return null;
    const key = ref.tableId;
    if (!arrCache.has(key)) { const t = mad.getTableById(ref.tableId); if (t) await t.readRecords(); arrCache.set(key, t); }
    const t = arrCache.get(key);
    if (!t) return null;
    const r = t.records[ref.rowNumber];
    return r && !r.isEmpty ? (r.arraySize || 0) : null;
  }

  const rows = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    if (safe(r, 'Position') !== 'HeadCoach') continue;
    rows.push({
      row: r.index, name: safe(r, 'Name'), lvl: safe(r, 'Level'),
      unlock: safe(r, 'IndexInUnlockList'), xp: safe(r, 'ExperiencePoints'),
      arch: safe(r, 'Archetype'),
      gameday: await arraySizeOf(r, 'GamedayTalents'),
      playsheet: await arraySizeOf(r, 'PlaysheetTalents'),
      weartear: await arraySizeOf(r, 'WearAndTearTalents'),
    });
  }
  rows.sort((a, b) => (a.lvl || 0) - (b.lvl || 0));
  console.log('  lvl  unlock  gameday  playsheet  weartear  archetype            name');
  for (const r of rows) {
    console.log('  ' + String(r.lvl).padStart(3) + String(r.unlock).padStart(8) + String(r.gameday).padStart(9)
      + String(r.playsheet).padStart(11) + String(r.weartear).padStart(10) + '  ' + String(r.arch).padEnd(20) + ' ' + (r.name || '(blank)'));
  }

  // correlation summary
  const withTrees = rows.filter((r) => typeof r.gameday === 'number' && r.lvl > 0);
  if (withTrees.length) {
    const ratios = withTrees.map((r) => r.unlock / r.lvl).filter((x) => Number.isFinite(x));
    console.log(`\n  IndexInUnlockList / Level ratio: min=${Math.min(...ratios).toFixed(2)} max=${Math.max(...ratios).toFixed(2)} mean=${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)}`);
  }
  fs.writeFileSync(path.join(OUT, 'talent-shape.json'), JSON.stringify(rows, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
