// Regression test for lib/carousel/talentTree.js -- the Madden-side talent
// tree engine. Per this file's own header: "the thing that actually makes a
// transferred coach render correctly in Madden." Had ZERO fixture coverage
// before this file -- every claim about it (including the donor-selection
// bug fixed 2026-07-26, COACH_TRANSFER_AUDIT.md §11) had only ever been
// verified once, live, against a real save (research/probe13/14/41/42).
//
// Fixture-based, no save file needed -- mirrors carouselPlaceOnTeam.spec.js's
// and carouselPlaceOnCfbTeam.spec.js's own conventions, extended for the
// deeper multi-table clone chain this module walks (Coach.<category>Talents
// -> Talent[] -> Talent -> Tiers -> TalentTier).
//
// Run with: node test/talentTree.spec.js (or npm test).

const assert = require('assert');
const {
  hasPopulatedTalentCategory, pickDonorCoach, cloneTalentRow, cloneTalentCategory,
  unlockIndexForLevel, grantTalentTree,
} = require('../lib/carousel/talentTree');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
async function throws(label, fn, pattern) {
  let threw = false, message = '';
  try { await fn(); } catch (e) { threw = true; message = e.message; }
  assert.ok(threw, `${label}: expected a throw, got none`);
  if (pattern) assert.ok(pattern.test(message), `${label}: message ${JSON.stringify(message)} does not match ${pattern}`);
  passed++;
}

// ---------------------------------------------------------------------
// Fixture kit. A fake record is a plain object whose fields ARE its own
// properties -- getValueByKey/getReferenceDataByKey read `this[key]`
// directly, so a later direct assignment (`rec.Foo = v`, exactly how the
// real code under test writes) is immediately visible to both accessors.
// This differs from carouselPlaceOnTeam.spec.js's fixture (which freezes
// reads to the ORIGINAL fields object) because THIS module's functions
// both read and write records in the same pass (clone, then verify the
// clone) -- a frozen-read fixture would make a written value invisible.
// ---------------------------------------------------------------------
function makeRecord(index, fields = {}) {
  const rec = { index, isEmpty: false };
  Object.assign(rec, fields);
  rec.getValueByKey = function getValueByKey(key) {
    return Object.prototype.hasOwnProperty.call(this, key) ? this[key] : undefined;
  };
  rec.getReferenceDataByKey = function getReferenceDataByKey(key) {
    const v = this[key];
    return (v && typeof v === 'object' && ('tableId' in v || 'rowNumber' in v)) ? v : null;
  };
  return rec;
}
function makeEmptyRecord(index) {
  return { index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null };
}
function dense(records, minCapacity = 0) {
  const maxIndex = Math.max(minCapacity - 1, records.reduce((m, r) => Math.max(m, r.index), -1));
  const arr = new Array(maxIndex + 1);
  for (let i = 0; i < arr.length; i++) arr[i] = makeEmptyRecord(i);
  for (const r of records) arr[r.index] = r;
  return arr;
}
// attributeNames: every field name cloneTalentRow's scalar-copy loop should
// consider for this table's row shape -- mirrors a real schema's attribute
// list (present even for a donor that happens to leave one unset).
function makeTable(tableId, name, records, attributeNames = [], minCapacity = 0) {
  const records_ = dense(records, minCapacity);
  return {
    name,
    header: { tableId, recordCapacity: records_.length },
    records: records_,
    readRecords: async () => {},
    getBinaryReferenceToRecord: (index) => ({ tableId, rowNumber: index }),
    schema: { attributes: attributeNames.map((n) => ({ name: n })) },
  };
}
function makeFile(tables) {
  const list = Object.values(tables);
  return {
    getTableById: (id) => tables[id] || null,
    // biggestTableByName (used by pickDonorCoach/unlockIndexForLevel to find
    // the Coach table) needs this -- picks the largest-capacity table with
    // a matching `.name`, same as the real saveIO.js helper.
    getAllTablesByName: (name) => list.filter((t) => t.name === name),
  };
}

const REF = (tableId, rowNumber) => ({ tableId, rowNumber });

// ---------------------------------------------------------------------
// hasPopulatedTalentCategory -- a reference existing is not enough; it must
// resolve to a real, non-empty, arraySize>0 row. This is the exact
// distinction the L10/§11 fix depends on.
// ---------------------------------------------------------------------
async function testHasPopulatedTalentCategory() {
  const populatedRow = makeRecord(5, { arraySize: 3 });
  const emptyArraySizeRow = makeRecord(6, { arraySize: 0 });
  const arrTable = makeTable(5603, 'Talent[]', [populatedRow, emptyArraySizeRow]);
  const file = makeFile({ 5603: arrTable });

  check('no reference at all -> false',
    await hasPopulatedTalentCategory(file, makeRecord(0, {}), 'GamedayTalents'), false);

  check('reference points at a table not present in the file -> false',
    await hasPopulatedTalentCategory(file, makeRecord(0, { GamedayTalents: REF(9999, 0) }), 'GamedayTalents'), false);

  check('reference resolves to a genuinely empty row -> false',
    await hasPopulatedTalentCategory(file, makeRecord(0, { GamedayTalents: REF(5603, 99) }), 'GamedayTalents'), false);

  check('reference resolves to a non-empty row with arraySize 0 -> false (exists but nothing to clone)',
    await hasPopulatedTalentCategory(file, makeRecord(0, { GamedayTalents: REF(5603, 6) }), 'GamedayTalents'), false);

  check('reference resolves to a real, populated row -> true',
    await hasPopulatedTalentCategory(file, makeRecord(0, { GamedayTalents: REF(5603, 5) }), 'GamedayTalents'), true);
}

// ---------------------------------------------------------------------
// pickDonorCoach -- archetype/level preference, position filter, blank-shell
// exclusion, excludeRows, and (the actual fix) requiring BOTH GamedayTalents
// and PlaysheetTalents to be genuinely populated, never just referenced.
// ---------------------------------------------------------------------
async function testPickDonorCoach() {
  const goodGD = makeRecord(100, { arraySize: 10 });
  const goodPS = makeRecord(101, { arraySize: 5 });
  const emptyPS = makeRecord(102, { arraySize: 0 }); // exists, but nothing to clone
  const arrTable = makeTable(5603, 'Talent[]', [goodGD, goodPS, emptyPS]);

  const donorGood = makeRecord(1, {
    Position: 'HeadCoach', Level: 40, Archetype: 'DevelopmentWizard', Name: 'Good Donor',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 101),
  });
  // Closer to a target level of 42 than donorGood, but Playsheet is empty --
  // must be excluded. This is the exact scenario that used to silently
  // produce an incomplete tree (COACH_TRANSFER_AUDIT.md §11).
  const donorNoPlaysheet = makeRecord(2, {
    Position: 'HeadCoach', Level: 41, Archetype: 'DevelopmentWizard', Name: 'No Playsheet',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 102),
  });
  // Even closer to the target level, but no Gameday reference at all.
  const donorNoGameday = makeRecord(3, {
    Position: 'HeadCoach', Level: 43, Archetype: 'DevelopmentWizard', Name: 'No Gameday',
    PlaysheetTalents: REF(5603, 101),
  });
  const donorWrongArchetype = makeRecord(4, {
    Position: 'HeadCoach', Level: 42, Archetype: 'OffensiveGuru', Name: 'Wrong Archetype',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 101),
  });
  const donorWrongPosition = makeRecord(5, {
    Position: 'OffensiveCoordinator', Level: 42, Archetype: 'DevelopmentWizard', Name: 'Wrong Position',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 101),
  });
  const donorBlankShell = makeRecord(6, {
    Position: 'HeadCoach', Level: 0, Archetype: 'DevelopmentWizard', Name: 'Blank Shell',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 101),
  });

  const coachTable = makeTable(4160, 'Coach', [
    donorGood, donorNoPlaysheet, donorNoGameday, donorWrongArchetype, donorWrongPosition, donorBlankShell,
  ]);
  const file = makeFile({ 4160: coachTable, 5603: arrTable });

  const pick1 = await pickDonorCoach(file, { position: 'HeadCoach', archetype: 'DevelopmentWizard', targetLevel: 42 });
  check('picks the exact-archetype match with a genuinely complete tree, skipping closer-level but incomplete donors',
    pick1.record.index, donorGood.index);
  check('reports an exact archetype match', pick1.exactArchetype, true);

  const pick2 = await pickDonorCoach(file, { position: 'OffensiveCoordinator', archetype: 'DevelopmentWizard', targetLevel: 42 });
  check('position filter -- only the OC candidate is eligible regardless of archetype/level', pick2.record.index, donorWrongPosition.index);

  const pick3 = await pickDonorCoach(file, { position: 'HeadCoach', archetype: 'NoSuchArchetype', targetLevel: 42 });
  check('falls back to any archetype when no exact match exists -- closest LEVEL among complete-tree candidates wins '
    + '(donorWrongArchetype is an exact level match; donorGood is off by 2)', pick3.record.index, donorWrongArchetype.index);
  check('fallback reports exactArchetype: false', pick3.exactArchetype, false);

  const pick4 = await pickDonorCoach(file, { position: 'HeadCoach', archetype: 'DevelopmentWizard', targetLevel: 42, excludeRows: [donorGood.index] });
  check('excludeRows removes an otherwise-winning candidate, falling back to the nearest complete-tree survivor',
    pick4.record.index, donorWrongArchetype.index);

  await throws('no eligible candidate at all -> throws naming the position',
    () => pickDonorCoach(file, { position: 'Trainer', archetype: 'X', targetLevel: 10 }),
    /no donor coach with a talent tree found for position Trainer/);
}

// ---------------------------------------------------------------------
// cloneTalentRow -- scalars + static-asset refs copy as-is; Tiers deep-
// clones into NEW rows (no shared mutable state with the donor); an
// unrecognized in-save reference throws loudly rather than silently
// sharing state; a missing/empty donor row returns null.
// ---------------------------------------------------------------------
async function testCloneTalentRow() {
  const STATIC_ASSET_REF = `1${'0'.repeat(31)}`; // starts with '1' -- shared, not in-save
  const donorTier0 = makeRecord(50, { TierValue: 1 });
  const donorTier1 = makeRecord(51, { TierValue: 2 });
  const tierTable = makeTable(4097, 'TalentTier', [donorTier0, donorTier1], ['TierValue']);

  const donorTierArr = makeRecord(20, { arraySize: 2, TalentTier0: REF(4097, 50), TalentTier1: REF(4097, 51) });
  const tierArrTable = makeTable(5605, 'TalentTier[]', [donorTierArr]);

  const donorTalent = makeRecord(10, {
    CoachPointsSpent: 3, Status: 'Owned', TalentInfo: STATIC_ASSET_REF, Tiers: REF(5605, 20),
  });
  const talentTable = makeTable(4112, 'Talent', [donorTalent], ['CoachPointsSpent', 'Status', 'TalentInfo', 'Tiers']);

  function freshAlloc() {
    const { createRowAllocator } = require('../lib/carousel/talentTree');
    const file = makeFile({ 4112: talentTable, 5605: tierArrTable, 4097: tierTable });
    return { alloc: createRowAllocator(file), file };
  }

  {
    const { alloc } = freshAlloc();
    const clone = await cloneTalentRow(alloc, 4112, donorTalent.index);
    check('clone lands on a DIFFERENT row than the donor', clone.index !== donorTalent.index, true);
    check('scalar fields copy across', [clone.CoachPointsSpent, clone.Status], [3, 'Owned']);
    check('a static-asset reference (bit 1) copies as the identical string', clone.TalentInfo, STATIC_ASSET_REF);

    const cloneTiersRef = clone.Tiers;
    check('Tiers points at a NEW array row, not the donor\'s', cloneTiersRef.rowNumber !== donorTierArr.index, true);
    const newTierArr = tierArrTable.records[cloneTiersRef.rowNumber];
    check('cloned Tiers array has the same arraySize as the donor', newTierArr.arraySize, 2);

    const newTier0Ref = newTierArr.TalentTier0;
    const newTier1Ref = newTierArr.TalentTier1;
    check('cloned tier rows are DIFFERENT physical rows from the donor\'s (no shared mutable state)',
      [newTier0Ref.rowNumber !== donorTier0.index, newTier1Ref.rowNumber !== donorTier1.index], [true, true]);
    check('cloned tier content matches the donor\'s',
      [tierTable.records[newTier0Ref.rowNumber].TierValue, tierTable.records[newTier1Ref.rowNumber].TierValue], [1, 2]);
  }

  await throws('an unrecognized in-save reference (not Tiers, not static-asset, not all-zero) throws rather than sharing state',
    async () => {
      const badDonor = makeRecord(11, { SomeOtherRef: `0${'1'.repeat(31)}` }); // starts with 0, not all-zero
      const badTable = makeTable(4113, 'Talent', [badDonor], ['SomeOtherRef']);
      const { alloc } = (() => {
        const { createRowAllocator } = require('../lib/carousel/talentTree');
        const file = makeFile({ 4113: badTable });
        return { alloc: createRowAllocator(file) };
      })();
      await cloneTalentRow(alloc, 4113, badDonor.index);
    },
    /is an in-save reference.*would be shared with the donor/);

  {
    const { alloc } = freshAlloc();
    check('a missing/empty donor row returns null', await cloneTalentRow(alloc, 4112, 999), null);
  }
}

// ---------------------------------------------------------------------
// cloneTalentCategory -- the three outcomes: donor has no ref for this
// category, donor's array row is empty, or a real N-talent clone. Confirms
// destCoach is left UNTOUCHED in the first two cases (not overwritten with
// a broken reference) and that a partial array (some Talent{i} refs null)
// counts only the successful clones.
// ---------------------------------------------------------------------
async function testCloneTalentCategory() {
  const { createRowAllocator } = require('../lib/carousel/talentTree');

  // Case 1: donor has no reference for the category at all.
  {
    const donor = makeRecord(1, {});
    const dest = makeRecord(2, { GamedayTalents: 'PRE_EXISTING_SENTINEL' });
    const file = makeFile({});
    const result = await cloneTalentCategory(createRowAllocator(file), donor, dest, 'GamedayTalents');
    check('no donor reference -> cloned:0 with the right note', result, { category: 'GamedayTalents', cloned: 0, note: 'donor has no tree for this category' });
    check('destCoach is left untouched', dest.GamedayTalents, 'PRE_EXISTING_SENTINEL');
  }

  // Case 2: donor's array row exists but is empty.
  {
    const donor = makeRecord(1, { GamedayTalents: REF(5603, 5) });
    const dest = makeRecord(2, { GamedayTalents: 'PRE_EXISTING_SENTINEL' });
    const arrTable = makeTable(5603, 'Talent[]', [makeEmptyRecord(5)]);
    const file = makeFile({ 5603: arrTable });
    const result = await cloneTalentCategory(createRowAllocator(file), donor, dest, 'GamedayTalents');
    check('empty donor array row -> cloned:0 with the right note', result, { category: 'GamedayTalents', cloned: 0, note: 'donor array row is empty' });
    check('destCoach is left untouched', dest.GamedayTalents, 'PRE_EXISTING_SENTINEL');
  }

  // Case 2b: THE MULTI-COACH CORRUPTION BUG. The donor's array row is
  // NOT empty, but its arraySize is 0 -- which is exactly how every real
  // Madden 26 coach's WearAndTearTalents looks (0 of 136 populated).
  //
  // The old code passed the isEmpty test, claimed a fresh row, wrote
  // `arraySize = 0` into a row that was already all zeros, cloned nothing,
  // and pointed the coach at it. That row still read as EMPTY, so the next
  // coach in the batch claimed it for PlaysheetTalents and wrote a real tree
  // into it -- leaving coach N's WearAndTear and coach N+1's Playsheet
  // sharing one array row. 66 rows were shared across a real 6-coach batch.
  // One coach alone never showed it, which is why it survived every
  // single-transfer test.
  //
  // The fix must claim NOTHING and leave destCoach alone.
  {
    const donor = makeRecord(1, { WearAndTearTalents: REF(5603, 5) });
    const dest = makeRecord(2, { WearAndTearTalents: 'PRE_EXISTING_SENTINEL' });
    // A live row (not isEmpty) whose arraySize is 0 -- the real shape.
    const donorArr = makeRecord(5, { arraySize: 0 });
    const arrTable = makeTable(5603, 'Talent[]', [donorArr], [], 40);
    const file = makeFile({ 5603: arrTable });
    const alloc = createRowAllocator(file);

    const result = await cloneTalentCategory(alloc, donor, dest, 'WearAndTearTalents');
    check('arraySize-0 donor category -> cloned:0', result.cloned, 0);
    check('and reports arraySize 0', result.arraySize, 0);
    check('destCoach is left untouched, NOT pointed at a claimed row',
      dest.WearAndTearTalents, 'PRE_EXISTING_SENTINEL');
    // The heart of it: nothing may be taken from the free pool, or the row
    // gets handed to the next coach while this one still references it.
    check('NO row was claimed from the array table', alloc.stats(), {});
  }

  // Case 3: a real, partial clone -- 3 slots, one of them null (a gap in
  // the donor's own array, which happens in real saves).
  {
    const talent0 = makeRecord(10, { CoachPointsSpent: 1 });
    const talent2 = makeRecord(12, { CoachPointsSpent: 2 });
    const talentTable = makeTable(4112, 'Talent', [talent0, talent2], ['CoachPointsSpent']);
    const donorArr = makeRecord(5, { arraySize: 3, Talent0: REF(4112, 10), Talent1: null, Talent2: REF(4112, 12) });
    const arrTable = makeTable(5603, 'Talent[]', [donorArr]);
    const donor = makeRecord(1, { GamedayTalents: REF(5603, 5) });
    const dest = makeRecord(2, {});
    const file = makeFile({ 5603: arrTable, 4112: talentTable });

    const result = await cloneTalentCategory(createRowAllocator(file), donor, dest, 'GamedayTalents');
    check('reports 2 cloned (the null slot is skipped, not counted)', result.cloned, 2);
    check('reports the donor array\'s own arraySize (3), not the cloned count', result.arraySize, 3);
    check('destCoach now has a NEW GamedayTalents reference, not the donor\'s', dest.GamedayTalents.rowNumber !== donorArr.index, true);
  }
}

// ---------------------------------------------------------------------
// unlockIndexForLevel -- median ratio among the nearest-level real coaches
// at this position, applied to the target level.
// ---------------------------------------------------------------------
async function testUnlockIndexForLevel() {
  const coaches = [
    makeRecord(1, { Position: 'HeadCoach', Level: 40, IndexInUnlockList: 34 }), // ratio 0.85
    makeRecord(2, { Position: 'HeadCoach', Level: 44, IndexInUnlockList: 37 }), // ratio ~0.84
    makeRecord(3, { Position: 'HeadCoach', Level: 20, IndexInUnlockList: 5 }),  // far from target, excluded by proximity
    makeRecord(4, { Position: 'OffensiveCoordinator', Level: 42, IndexInUnlockList: 999 }), // wrong position, ignored
  ];
  const file = makeFile({ 4160: makeTable(4160, 'Coach', coaches) });

  const idx = await unlockIndexForLevel(file, 'HeadCoach', 42);
  check('derives a plausible unlock index from the nearest real coaches, ignoring the wrong position', typeof idx === 'number' && idx > 0, true);

  const none = await unlockIndexForLevel(file, 'Trainer', 42);
  check('returns 0 when no coach at this position exists', none, 0);
}

// ---------------------------------------------------------------------
// grantTalentTree -- integration of the above: picks a donor, clones all
// three categories, sets IndexInUnlockList, and reports what happened.
// ---------------------------------------------------------------------
async function testGrantTalentTree() {
  const gdArr = makeRecord(100, { arraySize: 1, Talent0: REF(4112, 10) });
  const psArr = makeRecord(101, { arraySize: 1, Talent0: REF(4112, 10) });
  const arrTable = makeTable(5603, 'Talent[]', [gdArr, psArr]);
  const talent = makeRecord(10, { CoachPointsSpent: 5 });
  const talentTable = makeTable(4112, 'Talent', [talent], ['CoachPointsSpent']);

  const donor = makeRecord(1, {
    Position: 'HeadCoach', Level: 40, Archetype: 'DevelopmentWizard', Name: 'Donor',
    GamedayTalents: REF(5603, 100), PlaysheetTalents: REF(5603, 101),
  });
  const coachTable = makeTable(4160, 'Coach', [donor]);
  const file = makeFile({ 4160: coachTable, 5603: arrTable, 4112: talentTable });

  const dest = makeRecord(2, {});
  const report = await grantTalentTree(file, dest, { position: 'HeadCoach', archetype: 'DevelopmentWizard', targetLevel: 40 });

  check('reports the donor actually used', report.donor.name, 'Donor');
  check('reports all three categories, in TALENT_CATEGORIES order', report.categories.map((c) => c.category),
    ['PlaysheetTalents', 'GamedayTalents', 'WearAndTearTalents']);
  check('Gameday and Playsheet actually cloned something', [
    report.categories.find((c) => c.category === 'GamedayTalents').cloned,
    report.categories.find((c) => c.category === 'PlaysheetTalents').cloned,
  ], [1, 1]);
  check('WearAndTear correctly reports 0 cloned (donor has none) rather than fabricating one',
    report.categories.find((c) => c.category === 'WearAndTearTalents').cloned, 0);
  check('sets IndexInUnlockList on the destination', typeof dest.IndexInUnlockList, 'number');
  check('destCoach ends up with real Gameday/Playsheet references', [!!dest.GamedayTalents, !!dest.PlaysheetTalents], [true, true]);

  await throws('propagates pickDonorCoach\'s throw when no eligible donor exists',
    () => grantTalentTree(file, makeRecord(3, {}), { position: 'Trainer', archetype: 'X', targetLevel: 10 }),
    /no donor coach with a talent tree found/);
}

(async () => {
  await testHasPopulatedTalentCategory();
  await testPickDonorCoach();
  await testCloneTalentRow();
  await testCloneTalentCategory();
  await testUnlockIndexForLevel();
  await testGrantTalentTree();
  console.log(`\n  Talent tree spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
