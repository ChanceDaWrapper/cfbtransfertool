// Regression test for lib/carousel/cfbTalentTree.js -- the CFB-side talent
// engine for the reverse (Madden -> CFB) direction. Structurally simpler
// than the Madden side (a single ActiveTalentTree chain per coach, always
// pre-allocated -- see this module's own header), but had ZERO fixture
// coverage before this file; every claim about it had only been verified
// once, live, against a real save (research/probe35-39).
//
// Fixture-based, no save file needed. Same fixture-kit conventions as
// test/talentTree.spec.js (records ARE their own fields; getValueByKey/
// getReferenceDataByKey read `this` directly so a write made by the code
// under test is immediately visible to a later read in the same test).
//
// Run with: node test/cfbTalentTree.spec.js (or npm test).

const assert = require('assert');
const {
  readOwnTalentChain, pickCfbDonorCoach, grantCfbTalentTree, SUBTREE_SLOTS,
} = require('../lib/carousel/cfbTalentTree');

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
// Fixture kit -- see test/talentTree.spec.js's header for why records read
// their own live properties rather than a frozen snapshot.
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
// An empty row that behaves like a REAL one when claimed: writing any field
// populates it and flips isEmpty to false, exactly as madden-franchise does
// when talentTree.js's allocator claims a row (that path is verified in-game
// on the Madden side). Used wherever a test exercises allocation, so the
// fixture can't pass by being more forgiving than the real library.
function makeClaimableEmptyRecord(index) {
  const rec = makeRecord(index, {});
  rec.isEmpty = true;
  return new Proxy(rec, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop !== 'isEmpty') target.isEmpty = false;
      return true;
    },
  });
}
// Padding rows are CLAIMABLE, matching a real save where any empty row can be
// claimed and written. Using inert rows here would let an allocation test pass
// against a fixture more forgiving than the real library.
function dense(records, minCapacity = 0) {
  const maxIndex = Math.max(minCapacity - 1, records.reduce((m, r) => Math.max(m, r.index), -1));
  const arr = new Array(maxIndex + 1);
  for (let i = 0; i < arr.length; i++) arr[i] = makeClaimableEmptyRecord(i);
  for (const r of records) arr[r.index] = r;
  return arr;
}
function makeTable(tableId, name, records) {
  const records_ = dense(records);
  return { name, header: { tableId, recordCapacity: records_.length }, records: records_, readRecords: async () => {} };
}
function makeFile(tables) {
  const list = Object.values(tables);
  return {
    getTableById: (id) => tables[id] || null,
    getAllTablesByName: (name) => list.filter((t) => t.name === name),
  };
}
const REF = (tableId, rowNumber) => ({ tableId, rowNumber });

// Table ids used across this file -- arbitrary, only need to be internally
// consistent (unlike production code, this test never touches a real save's
// actual table ids).
const T = { COACH: 4160, ATT: 6001, SUBLIST: 6002, LEAF: 6003 };

// Builds a full, valid chain: Coach -> ActiveTalentTree -> SubTreeStatusList
// -> N TalentSubTreeStatus leaves (one per slot, `slotFields[i]` populates
// leaf i, or leave that slot's ref out entirely if `slotFields[i]` is
// undefined -- simulates a real gap).
function buildChain(coachIndex, attIndex, subListIndex, leafBaseIndex, slotFields) {
  const leafRecords = [];
  const subListFields = { arraySize: SUBTREE_SLOTS };
  for (let i = 0; i < SUBTREE_SLOTS; i++) {
    if (!slotFields[i]) continue; // simulate a missing slot
    const leafIndex = leafBaseIndex + i;
    leafRecords.push(makeRecord(leafIndex, slotFields[i]));
    subListFields[`TalentSubTreeStatus${i}`] = REF(T.LEAF, leafIndex);
  }
  const subListRecord = makeRecord(subListIndex, subListFields);
  const attRecord = makeRecord(attIndex, { TalentSubTreeStatusList: REF(T.SUBLIST, subListIndex) });
  const coachRecord = makeRecord(coachIndex, { ActiveTalentTree: REF(T.ATT, attIndex) });
  return { coachRecord, attRecord, subListRecord, leafRecords };
}

// ---------------------------------------------------------------------
// readOwnTalentChain
// ---------------------------------------------------------------------
async function testReadOwnTalentChain() {
  check('no ActiveTalentTree reference at all -> null',
    await readOwnTalentChain(makeFile({}), makeRecord(0, {})), null);

  check('ActiveTalentTree resolves to a missing/empty row -> null',
    await readOwnTalentChain(makeFile({ [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', []) }),
      makeRecord(0, { ActiveTalentTree: REF(T.ATT, 5) })), null);

  {
    const attNoList = makeRecord(1, {}); // present, but no TalentSubTreeStatusList ref
    const file = makeFile({ [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', [attNoList]) });
    check('ActiveTalentTree row exists but has no TalentSubTreeStatusList ref -> null',
      await readOwnTalentChain(file, makeRecord(0, { ActiveTalentTree: REF(T.ATT, 1) })), null);
  }

  {
    const att = makeRecord(1, { TalentSubTreeStatusList: REF(T.SUBLIST, 9) });
    const file = makeFile({
      [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', [att]),
      [T.SUBLIST]: makeTable(T.SUBLIST, 'TalentSubTreeStatusList', []), // row 9 resolves empty
    });
    check('TalentSubTreeStatusList resolves to a missing/empty row -> null',
      await readOwnTalentChain(file, makeRecord(0, { ActiveTalentTree: REF(T.ATT, 1) })), null);
  }

  // A full, valid chain, with slot 3 deliberately missing (a real gap).
  const slotFields = {};
  for (let i = 0; i < SUBTREE_SLOTS; i++) if (i !== 3) slotFields[i] = { CoachPointsSpent: i * 10 };
  const { coachRecord, attRecord, subListRecord, leafRecords } = buildChain(0, 1, 2, 100, slotFields);
  const file = makeFile({
    [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', [attRecord]),
    [T.SUBLIST]: makeTable(T.SUBLIST, 'TalentSubTreeStatusList', [subListRecord]),
    [T.LEAF]: makeTable(T.LEAF, 'TalentSubTreeStatus', leafRecords),
  });
  const chain = await readOwnTalentChain(file, coachRecord);
  check('returns exactly SUBTREE_SLOTS leaves', chain.leaves.length, SUBTREE_SLOTS);
  check('a missing slot reads as null, not a crash', chain.leaves[3], null);
  check('a present slot resolves to the real leaf record', chain.leaves[0].CoachPointsSpent, 0);
  check('leaves preserve slot order (leaf 5 has CoachPointsSpent 50)', chain.leaves[5].CoachPointsSpent, 50);
}

// ---------------------------------------------------------------------
// pickCfbDonorCoach -- position filter, blank-shell exclusion, requires an
// ActiveTalentTree reference, nearest-level (NO archetype pass -- verified
// irrelevant for CFB, per this module's own header), excludeRows.
// ---------------------------------------------------------------------
async function testPickCfbDonorCoach() {
  const donorNear = makeRecord(1, { Position: 'HeadCoach', Level: 40, Name: 'Near', ActiveTalentTree: REF(T.ATT, 1) });
  const donorFar = makeRecord(2, { Position: 'HeadCoach', Level: 10, Name: 'Far', ActiveTalentTree: REF(T.ATT, 2) });
  const donorNoChain = makeRecord(3, { Position: 'HeadCoach', Level: 41, Name: 'NoChain' }); // closer, but no ref at all
  const donorWrongPosition = makeRecord(4, { Position: 'OffensiveCoordinator', Level: 40, Name: 'WrongPos', ActiveTalentTree: REF(T.ATT, 4) });
  const donorBlankShell = makeRecord(5, { Position: 'HeadCoach', Level: 0, Name: 'Blank', ActiveTalentTree: REF(T.ATT, 5) });

  const coachTable = makeTable(T.COACH, 'Coach', [donorNear, donorFar, donorNoChain, donorWrongPosition, donorBlankShell]);
  const file = makeFile({ [T.COACH]: coachTable });

  const pick1 = await pickCfbDonorCoach(file, { position: 'HeadCoach', targetLevel: 42 });
  check('picks the nearest-level candidate with a real chain reference, skipping the closer but chainless one',
    pick1.record.index, donorNear.index);

  const pick2 = await pickCfbDonorCoach(file, { position: 'HeadCoach', targetLevel: 42, excludeRows: [donorNear.index] });
  check('excludeRows falls through to the next-nearest candidate', pick2.record.index, donorFar.index);

  await throws('no candidate at all for a position -> throws naming it',
    () => pickCfbDonorCoach(file, { position: 'Trainer', targetLevel: 10 }),
    /no donor coach with a talent tree found for position Trainer/);
}

// ---------------------------------------------------------------------
// grantCfbTalentTree -- copies CoachPointsSpent + TalentStatus fields per
// subtree, only where BOTH donor and destination have that slot; throws if
// the DONOR has no readable chain; degrades to a `skipped` no-op (not a
// throw) if the DESTINATION has none, matching findDisposableCfbSlot's own
// guarantee that this should be unreachable in practice but must not abort
// the whole coach's placement if it ever happens.
// ---------------------------------------------------------------------
async function testGrantCfbTalentTree() {
  // Donor: slots 0 and 1 populated, slot 2 missing.
  const donorSlots = { 0: { CoachPointsSpent: 100, TalentStatus0: 'Owned', TalentStatus1: 'Locked' }, 1: { CoachPointsSpent: 50, TalentStatus0: 'Purchasable' } };
  const donorChain = buildChain(1, 10, 20, 1000, donorSlots);
  // Destination: slots 0 and 2 exist (note the ASYMMETRY with the donor --
  // slot 1 is missing on the dest, slot 2 is missing on the donor. Only
  // slot 0 exists on BOTH, so only slot 0 should actually copy).
  const destSlots = { 0: { CoachPointsSpent: 0 }, 2: { CoachPointsSpent: 0 } };
  const destChain = buildChain(2, 11, 21, 2000, destSlots);

  const coachTable = makeTable(T.COACH, 'Coach', [
    makeRecord(donorChain.coachRecord.index, { ...donorChain.coachRecord, Position: 'HeadCoach', Level: 40, Name: 'Donor' }),
  ]);
  const file = makeFile({
    [T.COACH]: coachTable,
    [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', [donorChain.attRecord, destChain.attRecord]),
    [T.SUBLIST]: makeTable(T.SUBLIST, 'TalentSubTreeStatusList', [donorChain.subListRecord, destChain.subListRecord]),
    [T.LEAF]: makeTable(T.LEAF, 'TalentSubTreeStatus', [...donorChain.leafRecords, ...destChain.leafRecords]),
  });

  const report = await grantCfbTalentTree(file, destChain.coachRecord, { position: 'HeadCoach', targetLevel: 40 });
  check('reports the donor used', report.donor.name, 'Donor');
  check('only the ONE slot present on BOTH sides (slot 0) is copied', report.subtreesCopied, 1);
  check('totalSpent reflects only the copied slot (100, not 150)', report.totalSpent, 100);
  check('destination slot 0 actually received the donor\'s CoachPointsSpent', destChain.leafRecords[0].CoachPointsSpent, 100);
  check('destination slot 0 received both TalentStatus fields the donor had', [destChain.leafRecords[0].TalentStatus0, destChain.leafRecords[0].TalentStatus1], ['Owned', 'Locked']);
  check('statusesCopied counts exactly the fields the donor actually had (2), not a fixed 33', report.statusesCopied, 2);
  check('destination slot 2 (absent on the donor) is untouched', destChain.leafRecords.find((l) => l.index === 2002).CoachPointsSpent, 0);

  // pickCfbDonorCoach only checks that an ActiveTalentTree REFERENCE exists
  // (readOwnTalentChain does the deeper resolution) -- so to reach
  // grantCfbTalentTree's own "no readable chain" throw specifically, the
  // donor needs a reference that PASSES that shallow check but resolves to
  // nothing (points at a row absent from the ActiveTalentTree table).
  const chainlessDonor = makeRecord(9, { Position: 'HeadCoach', Level: 40, Name: 'Chainless', ActiveTalentTree: REF(T.ATT, 999) });
  const chainlessFile = makeFile({
    [T.COACH]: makeTable(T.COACH, 'Coach', [chainlessDonor]),
    [T.ATT]: makeTable(T.ATT, 'ActiveTalentTree', []), // row 999 resolves empty
  });
  await throws('a donor whose reference exists but resolves to no readable chain throws, naming the donor',
    () => grantCfbTalentTree(chainlessFile, destChain.coachRecord, { position: 'HeadCoach', targetLevel: 40 }),
    /donor Chainless.*has no readable talent chain/);

  // Destination has no chain of its own -- degrades to a skipped report, does
  // NOT throw (findDisposableCfbSlot prevents this reaching here at all, but
  // it must fail soft rather than abort the coach). A chain cannot simply be
  // allocated for such a row -- see cfbTalentTree.js's header (probe43).
  const blankDest = makeRecord(3, {}); // no ActiveTalentTree at all
  const report2 = await grantCfbTalentTree(file, blankDest, { position: 'HeadCoach', targetLevel: 40 });
  check('a chainless destination returns a skipped report rather than throwing', typeof report2.skipped, 'string');
  check('a skipped report still names the donor that WOULD have been used', report2.donor.name, 'Donor');
  check('a skipped report copies nothing', [report2.subtreesCopied, report2.statusesCopied, report2.totalSpent], [0, 0, 0]);
}

(async () => {
  await testReadOwnTalentChain();
  await testPickCfbDonorCoach();
  await testGrantCfbTalentTree();
  console.log(`\n  CFB talent tree spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
