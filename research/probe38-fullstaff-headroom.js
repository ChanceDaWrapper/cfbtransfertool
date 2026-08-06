// READ-ONLY. probe37 proved single-coordinator moves already work both ways.
// The genuinely-unbuilt capability is moving a WHOLE STAFF as a unit. The one
// resource that could hard-block that is row headroom: every CFB->Madden
// coach needs a deep-cloned talent tree (talentTree.js clones into tables
// 5603 / 4235 / 4112 / 4110 / 4208 plus tier rows), so a 3-coach staff costs
// ~3x what a single head coach costs, and a multi-team sweep multiplies again.
//
// Questions:
//   1. How many rows does ONE cloned tree actually consume, per table?
//   2. What's the free headroom in each of those tables right now?
//   3. => How many coaches can be moved CFB->Madden before a table runs dry?
//   4. Does CFB have the same constraint? (cfbTalentTree.js copies VALUES into
//      pre-allocated rows and never allocates -- so it should be UNLIMITED.)
//   5. Does CFB have a Trainer table like Madden's, i.e. is "full staff"
//      eventually 4 people (HC/OC/DC/Trainer) or 3?

const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');
const { pickDonorCoach, createRowAllocator, cloneTalentCategory, TALENT_CATEGORIES } = require('../lib/carousel/talentTree');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';

const TALENT_TABLES = [5603, 4235, 4112, 4110, 4208, 5605, 4097];

(async () => {
  const { maddenFile } = await openMaddenSave(MADDEN);
  const { cfbFile } = await openCfbSave(CFB);

  // ===== 1/2. Headroom in every table a clone touches =====
  console.log('########## MADDEN talent-table headroom ##########');
  const headroom = new Map();
  for (const id of TALENT_TABLES) {
    let t; try { t = maddenFile.getTableById(id); } catch (e) { t = null; }
    if (!t) { console.log(`  table ${id}: NOT PRESENT`); continue; }
    await t.readRecords();
    const filled = t.records.filter((r) => !r.isEmpty).length;
    const free = t.header.recordCapacity - filled;
    headroom.set(id, { name: t.name, capacity: t.header.recordCapacity, filled, free });
    console.log(`  ${String(id).padEnd(6)} "${String(t.name).padEnd(20)}" capacity=${String(t.header.recordCapacity).padStart(6)} `
      + `filled=${String(filled).padStart(6)} FREE=${String(free).padStart(6)}`);
  }

  // ===== 1. Actual per-coach cost, measured by really running a clone =====
  // Uses the same allocator the real path uses, against an in-memory file we
  // simply never save -- so this measures the true cost, not an estimate.
  console.log('\n########## Measured cost of ONE cloned tree ##########');
  for (const position of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
    const coachT = biggestTableByName(maddenFile, 'Coach');
    await coachT.readRecords();
    // A blank-ish destination to clone INTO; we only care about allocator stats.
    const dest = coachT.records.find((r) => r.isEmpty) || coachT.records[0];
    const donor = await pickDonorCoach(maddenFile, { position, archetype: 'DevelopmentWizard', targetLevel: 40, excludeRows: [dest.index] });
    const alloc = createRowAllocator(maddenFile);
    for (const c of TALENT_CATEGORIES) await cloneTalentCategory(alloc, donor.record, dest, c);
    const stats = alloc.stats();
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    console.log(`  ${position.padEnd(24)} donor ${String(donor.name).padEnd(14)} (L${donor.level}) -> rows used: `
      + `${Object.entries(stats).map(([id, n]) => `${id}:${n}`).join(' ')}  TOTAL=${total}`);

    // 3. How many such coaches fit?
    let limiting = null;
    for (const [id, n] of Object.entries(stats)) {
      const h = headroom.get(Number(id));
      if (!h || !n) continue;
      const fits = Math.floor(h.free / n);
      if (!limiting || fits < limiting.fits) limiting = { id, fits, name: h.name, free: h.free, per: n };
    }
    if (limiting) {
      console.log(`      => limited by table ${limiting.id} ("${limiting.name}"): ${limiting.free} free / ${limiting.per} per coach `
        + `= ~${limiting.fits} more ${position}s movable into this save`);
    }
  }

  // ===== 4. CFB side: does granting a tree allocate anything? =====
  console.log('\n########## CFB: does a talent grant consume rows? ##########');
  {
    const t = biggestTableByName(cfbFile, 'TalentSubTreeStatus');
    if (t) {
      await t.readRecords();
      const filled = t.records.filter((r) => !r.isEmpty).length;
      console.log(`  TalentSubTreeStatus capacity=${t.header.recordCapacity} filled=${filled} free=${t.header.recordCapacity - filled}`);
    }
    const coachT = biggestTableByName(cfbFile, 'Coach');
    await coachT.readRecords();
    let withChain = 0, blankWithChain = 0, total = 0;
    for (const r of coachT.records) {
      total++;
      let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { ref = null; }
      const has = !!(ref && (ref.tableId || ref.rowNumber));
      if (has) withChain++;
      if (has && r.isEmpty) blankWithChain++;
    }
    console.log(`  Coach rows: ${total}; with an ActiveTalentTree reference: ${withChain}; `
      + `of those, EMPTY rows already pre-wired: ${blankWithChain}`);
    console.log(`  => CFB grants copy VALUES into pre-allocated chains -- no allocation, so no headroom ceiling.`);
  }

  // ===== 5. Trainer tables =====
  console.log('\n########## Trainer: a 4th staff member? ##########');
  for (const [label, file] of [['MADDEN', maddenFile], ['CFB', cfbFile]]) {
    const t = biggestTableByName(file, 'Trainer');
    if (!t) { console.log(`  ${label}: no Trainer table`); continue; }
    await t.readRecords();
    const filled = t.records.filter((r) => !r.isEmpty).length;
    console.log(`  ${label}: Trainer table capacity=${t.header.recordCapacity} filled=${filled}`);
    const sample = t.records.find((r) => !r.isEmpty);
    if (sample) {
      console.log(`    sample: ${safe(sample, 'FirstName')} ${safe(sample, 'LastName')} `
        + `Archetype=${safe(sample, 'Archetype')} TeamIndex=${safe(sample, 'TeamIndex')} Level=${safe(sample, 'Level')}`);
      console.log(`    fields: ${(t.schema ? t.schema.attributes.map((a) => a.name) : []).join(', ')}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
