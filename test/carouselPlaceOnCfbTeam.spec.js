// Regression test for lib/carousel/placeOnCfbTeam.js's findDisposableCfbSlot
// -- specifically the L9 fix (COACH_TRANSFER_AUDIT.md): CFB's tier-3 "empty
// row" fallback must require a usable ActiveTalentTree chain, same as tiers
// 1-2, instead of silently handing back a chainless row that
// grantCfbTalentTree can't write into (the "Level 1 / no abilities" failure
// talentTree.js's header describes). Fixture conventions mirror
// carouselPlaceOnTeam.spec.js's own fakeRecord/fakeFile helpers.
// Run with: node test/carouselPlaceOnCfbTeam.spec.js (or npm test).

const assert = require('assert');
const { findDisposableCfbSlot, countDisposableCfbSlots } = require('../lib/carousel/placeOnCfbTeam');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function fakeRecord(index, fields, refs = {}) {
  return {
    index,
    isEmpty: false,
    getValueByKey(key) { return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined; },
    getReferenceDataByKey(key) { return Object.prototype.hasOwnProperty.call(refs, key) ? refs[key] : null; },
  };
}

// A real save's genuinely-empty rows have never been populated, so they have
// NO ActiveTalentTree reference of their own -- verified live, 0/135 in the
// sample save. This fixture matches that reality exactly.
function fakeEmptyRecord(index) { return { index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null }; }

function fakeFile({ coachRecords, coachTableId = 4160, minCapacity = 3 }) {
  const dense = (recs) => {
    const maxIndex = Math.max(minCapacity - 1, recs.reduce((m, r) => Math.max(m, r.index), -1));
    const a = new Array(maxIndex + 1);
    for (let i = 0; i < a.length; i++) a[i] = fakeEmptyRecord(i);
    for (const r of recs) a[r.index] = r;
    return a;
  };
  const records = dense(coachRecords);
  // biggestTableByName picks by recordCapacity > 0 -- must reflect the dense
  // array's real size, not just the count of non-empty fixture records
  // (a table of all-empty rows, like the L9 regression case, still has real
  // capacity and must be selectable).
  const coachTable = {
    header: { recordCapacity: records.length, tableId: coachTableId },
    records,
    readRecords: async () => {},
  };
  return { getAllTablesByName: (name) => (name === 'Coach' ? [coachTable] : []) };
}

const CHAIN_REF = { ActiveTalentTree: { tableId: 7001, rowNumber: 1 } };

(async () => {
  // ---------------------------------------------------------------------
  // Preference order is unaffected by the fix -- tiers 1-2 already required
  // hasUsableChain before this change.
  // ---------------------------------------------------------------------
  const oldFA = fakeRecord(3, { Name: 'Old Timer', ContractStatus: 'FreeAgent', Age: 78, Level: 5 }, CHAIN_REF);
  const nobodyA = fakeRecord(4, { Name: 'Nobody A', ContractStatus: 'FreeAgent', Age: 35, Level: 0, CareerPointsFor: 0, CareerPointsAgainst: 0 }, CHAIN_REF);
  const file1 = fakeFile({ coachRecords: [oldFA, nobodyA] });

  const pick1 = await findDisposableCfbSlot(file1, 'HeadCoach');
  check('picks the retirement-age free agent first', pick1.record.index, 3);

  const pick2 = await findDisposableCfbSlot(file1, 'HeadCoach', { excludeRows: [3] });
  check('with the old-timer claimed, falls to the level-0 nobody', pick2.record.index, 4);

  // ---------------------------------------------------------------------
  // THE L9 GUARANTEE: a chainless empty row must NEVER be handed back --
  // grantCfbTalentTree would have no chain to write into and the coach would
  // land as the "Level 1 / no abilities" shell. probe43 confirmed a chain
  // cannot simply be allocated for one (empty rows are a linked free-list),
  // so this stays a hard refusal.
  // ---------------------------------------------------------------------
  const file2 = fakeFile({ coachRecords: [] }); // every row is a dense fakeEmptyRecord, chainless
  let threwOnChainless = false;
  try {
    await findDisposableCfbSlot(file2, 'HeadCoach');
  } catch (e) { threwOnChainless = /talent-tree reference/.test(e.message); }
  check('a save with only chainless empty rows throws instead of degrading silently', threwOnChainless, true);

  // ---------------------------------------------------------------------
  // TIER 2 WIDENING (probe44): CFB seeds unemployed filler coordinators at
  // Level 10-12 with a completely blank career, not Level 0. Requiring
  // Level === 0 exactly rejected 41 perfectly disposable rows in a real save
  // and left it with ZERO landing slots. The real signal is the zeroed
  // career; Level is only a ceiling guarding established coaches.
  // ---------------------------------------------------------------------
  const filler = fakeRecord(8, { Name: 'Filler DC', ContractStatus: 'FreeAgent', Age: 38, Level: 11, CareerPointsFor: 0, CareerPointsAgainst: 0 }, CHAIN_REF);
  const established = fakeRecord(9, { Name: 'Real Coach', ContractStatus: 'FreeAgent', Age: 50, Level: 40, CareerPointsFor: 0, CareerPointsAgainst: 0 }, CHAIN_REF);
  const fileFiller = fakeFile({ coachRecords: [filler, established] });
  const pickFiller = await findDisposableCfbSlot(fileFiller, 'HeadCoach');
  check('a career-less Level-11 free agent is now a usable slot', pickFiller.record.index, 8);
  check('and an established Level-40 free agent is still never selected',
    await countDisposableCfbSlots(fileFiller), 1);

  // A free agent WITH a career record stays protected regardless of level.
  const hasCareer = fakeRecord(10, { Name: 'Has Career', ContractStatus: 'FreeAgent', Age: 44, Level: 9, CareerPointsFor: 320, CareerPointsAgainst: 280 }, CHAIN_REF);
  check('a low-level free agent WITH a career record is not disposable',
    await countDisposableCfbSlots(fakeFile({ coachRecords: [hasCareer] })), 0);

  // ---------------------------------------------------------------------
  // A chainless FREE AGENT (blank name, zeroed ActiveTalentTree -- the "4 of
  // 68 broken nobodies" the original header describes) must be skipped in
  // favor of a real nobody with a chain, not selected itself.
  // ---------------------------------------------------------------------
  const brokenNobody = fakeRecord(5, { Name: '', ContractStatus: 'FreeAgent', Age: 40, Level: 0, CareerPointsFor: 0, CareerPointsAgainst: 0 }, { ActiveTalentTree: { tableId: 0, rowNumber: 0 } });
  const realNobody = fakeRecord(6, { Name: 'Real Nobody', ContractStatus: 'FreeAgent', Age: 50, Level: 0, CareerPointsFor: 0, CareerPointsAgainst: 0 }, CHAIN_REF);
  const file3 = fakeFile({ coachRecords: [brokenNobody, realNobody] });
  const pick3 = await findDisposableCfbSlot(file3, 'HeadCoach');
  check('a chainless free agent is skipped in favor of one with a real chain', pick3.record.index, 6);

  // ---------------------------------------------------------------------
  // If an empty row DOES happen to carry a usable chain (not observed live,
  // but the guard should accept it rather than reject empty rows outright --
  // hasUsableChain is the real test, not isEmpty), it is still a valid tier-3
  // landing slot.
  // ---------------------------------------------------------------------
  const emptyWithChain = { index: 7, isEmpty: true, getValueByKey: (k) => (k === 'Name' ? 'Placeholder' : undefined), getReferenceDataByKey: (k) => (k === 'ActiveTalentTree' ? CHAIN_REF.ActiveTalentTree : null) };
  const file4 = fakeFile({ coachRecords: [emptyWithChain] });
  const pick4 = await findDisposableCfbSlot(file4, 'HeadCoach');
  check('an empty row WITH a usable chain is still accepted as tier 3', pick4.record.index, 7);
  check('and reported as an empty row', pick4.reason, 'empty Coach row');

  // ---------------------------------------------------------------------
  // Genuine exhaustion -- a Coach table with NO free rows at all (every row
  // occupied by an established coach) still throws, with allocation on or
  // off. Allocation adds a tier; it doesn't remove the guardrail.
  // ---------------------------------------------------------------------
  const occupant = fakeRecord(0, { Name: 'Real Coach', ContractStatus: 'First_Active', Age: 45, Level: 30, CareerPointsFor: 500, CareerPointsAgainst: 400 }, CHAIN_REF);
  const fullFile = fakeFile({ coachRecords: [occupant], minCapacity: 1 });
  let exhaustedThrew = false;
  try {
    await findDisposableCfbSlot(fullFile, 'HeadCoach');
  } catch (e) { exhaustedThrew = /no disposable Coach row available/.test(e.message); }
  check('a save whose Coach table is genuinely full still throws', exhaustedThrew, true);

  // ---------------------------------------------------------------------
  // countDisposableCfbSlots -- the pre-flight check (run.js): reports how
  // many rows are safely usable WITHOUT picking or claiming one, so the UI
  // can warn before a batch runs headfirst into the throw above.
  // ---------------------------------------------------------------------
  check('a claimed row is excluded from the count, same as from selection',
    await countDisposableCfbSlots(file1, { excludeRows: [3] }), 1);
  check('a genuinely full Coach table counts zero',
    await countDisposableCfbSlots(fullFile), 0);

  console.log(`\n  Carousel placeOnCfbTeam spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
