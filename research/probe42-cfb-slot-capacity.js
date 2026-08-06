// READ-ONLY. Measures the fix for CFB landing-slot exhaustion -- the failure
// behind "findDisposableCfbSlot: no disposable Coach row available".
//
// Background: placing a coach onto a CFB school reuses an existing Coach row,
// and that row must own an ActiveTalentTree chain (CFB never allocated one, so
// grantCfbTalentTree could only COPY values into a pre-existing chain). probe39
// found 0 of 135 empty rows are pre-wired, so the usable pool was only
// "free agents that happen to have chains" -- and a save can run that dry,
// after which EVERY move fails.
//
// The fix lets grantCfbTalentTree ALLOCATE a chain (allocateCfbTalentChain),
// mirroring talentTree.js's proven Madden-side allocator. This probe answers
// the two questions that decide whether that actually helps THIS save:
//
//   1. How many landing slots did we have before vs. after?
//   2. Is there room to allocate? Each coach needs 13 rows:
//        1 ActiveTalentTree + 1 TalentSubTreeStatus[] + 11 TalentSubTreeStatus
//      so the binding limit is whichever of those three tables runs out first.
//
// Writes nothing. Run: node research/probe42-cfb-slot-capacity.js
// Override the save path with CFB_SAVE=... if yours differs.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const { countDisposableCfbSlots } = require('../lib/carousel/placeOnCfbTeam');
const { readOwnTalentChain, pickCfbDonorCoach, SUBTREE_SLOTS } = require('../lib/carousel/cfbTalentTree');

const CFB = process.env.CFB_SAVE
  || 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  console.log(`save: ${CFB}\n`);

  // ===== 1. Landing slots, before vs after =====
  console.log('########## landing slots ##########');
  const strict = await countDisposableCfbSlots(cfbFile, { allowChainAllocation: false });
  const withAlloc = await countDisposableCfbSlots(cfbFile);
  console.log(`  usable rows that ALREADY own a chain (old behavior): ${strict}`);
  console.log(`  usable rows WITH chain allocation (new behavior):    ${withAlloc}`);
  console.log(`  => gain: +${withAlloc - strict} landing slots`);
  console.log(`  => full 3-person staffs supported: ${Math.floor(strict / 3)} -> ${Math.floor(withAlloc / 3)}`);

  // ===== 2. Allocation headroom =====
  // Table ids come from a REAL donor's chain rather than constants, the same
  // way allocateCfbTalentChain learns them.
  console.log('\n########## allocation headroom ##########');
  let donor = null;
  for (const position of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
    try { donor = await pickCfbDonorCoach(cfbFile, { position, targetLevel: 30 }); break; } catch (e) { /* try next */ }
  }
  if (!donor) { console.log('  no donor coach with a talent tree in this save -- cannot measure.'); return; }

  const chain = await readOwnTalentChain(cfbFile, donor.record);
  if (!chain) { console.log(`  donor ${donor.name} has no readable chain -- cannot measure.`); return; }

  const leavesUsed = chain.leaves.filter(Boolean).length;
  console.log(`  donor: ${donor.name} (L${donor.level}), ${leavesUsed}/${SUBTREE_SLOTS} subtree slots populated`);

  const perCoach = [
    { table: chain.attTable, need: 1, what: 'ActiveTalentTree' },
    { table: chain.subTable, need: 1, what: 'TalentSubTreeStatus[]' },
    { table: chain.leafTable, need: leavesUsed, what: 'TalentSubTreeStatus' },
  ];

  let limiting = null;
  for (const { table, need, what } of perCoach) {
    await table.readRecords();
    const free = table.records.filter((r) => r.isEmpty).length;
    const fits = need ? Math.floor(free / need) : Infinity;
    console.log(`  ${what.padEnd(22)} (table ${String(table.header.tableId).padStart(5)}): `
      + `capacity=${String(table.header.recordCapacity).padStart(6)} free=${String(free).padStart(6)} `
      + `need=${String(need).padStart(2)}/coach => fits ${fits}`);
    if (!limiting || fits < limiting.fits) limiting = { what, fits, free, need };
  }
  console.log(`  => limited by ${limiting.what}: ~${limiting.fits} coaches allocatable`);

  // ===== 3. The real answer =====
  console.log('\n########## bottom line ##########');
  const effective = Math.min(withAlloc, strict + limiting.fits);
  console.log(`  coaches placeable into this save: ${strict} (before) -> ${effective} (after)`);
  if (effective === strict) {
    console.log('  NOTE: no gain -- allocation headroom is the binding constraint here, not slot count.');
  } else if (limiting.fits < withAlloc - strict) {
    console.log(`  NOTE: ${withAlloc - strict} empty Coach rows exist but only ${limiting.fits} chains can be built,`);
    console.log(`        so ${limiting.what} headroom is the real ceiling.`);
  }

  // Sanity: confirm the empty rows really are chainless (the premise).
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  let empties = 0, emptiesWithChain = 0;
  for (const r of coachT.records) {
    if (!r.isEmpty) continue;
    empties++;
    let ref; try { ref = r.getReferenceDataByKey('ActiveTalentTree'); } catch (e) { ref = null; }
    if (ref && ref.tableId) emptiesWithChain++;
  }
  console.log(`\n  (premise check: ${empties} empty Coach rows, ${emptiesWithChain} of them pre-wired with a chain)`);
  console.log(`  (free agents: ${coachT.records.filter((r) => !r.isEmpty && safe(r, 'ContractStatus') === 'FreeAgent').length})`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
