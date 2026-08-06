// Regression test for lib/carousel/placeOnTeam.js's clearStaleTeamLoadouts
// -- the L5 fix (COACH_TRANSFER_AUDIT.md §9.5): a Team's GamedayLoadout/
// PlaysheetLoadout/WearAndTearLoadout slots hold a `Talent` reference into
// whichever coach personally equipped that ability, and that reference goes
// stale the moment the HeadCoach changes. Had ZERO fixture coverage before
// this file -- only ever verified live (research/probe33/34).
//
// Records here store a `Talent` value as EITHER a plain {tableId,rowNumber}
// object OR a raw 32-character binary string, matching the two shapes the
// real code actually produces/reads: `slotRec.Talent = NULL_REFERENCE`
// writes a raw bitstring (mirroring how a real madden-franchise reference
// field setter works -- see placeOnTeam.js's own NULL_REFERENCE comment),
// while a freshly-seeded "already equipped" fixture is easiest to write as
// a plain object. getReferenceDataByKey below parses either into the same
// {tableId, rowNumber} shape the production code's `refOf`-style checks
// expect.
//
// Run with: node test/clearStaleTeamLoadouts.spec.js (or npm test).

const assert = require('assert');
const { clearStaleTeamLoadouts } = require('../lib/carousel/placeOnTeam');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function parseBitstringRef(bits) {
  return { tableId: parseInt(bits.slice(0, 15), 2), rowNumber: parseInt(bits.slice(15), 2) };
}

function makeRecord(index, fields = {}) {
  const rec = { index, isEmpty: false };
  Object.assign(rec, fields);
  rec.getValueByKey = function getValueByKey(key) {
    return Object.prototype.hasOwnProperty.call(this, key) ? this[key] : undefined;
  };
  rec.getReferenceDataByKey = function getReferenceDataByKey(key) {
    const v = this[key];
    if (v == null) return null;
    if (typeof v === 'object' && ('tableId' in v || 'rowNumber' in v)) return v;
    if (typeof v === 'string' && /^[01]{32}$/.test(v)) return parseBitstringRef(v);
    return null;
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
function makeTable(tableId, records) {
  const records_ = dense(records);
  return { header: { tableId, recordCapacity: records_.length }, records: records_, readRecords: async () => {} };
}
function makeFile(tables) {
  return { getTableById: (id) => tables[id] || null };
}
const REF = (tableId, rowNumber) => ({ tableId, rowNumber });

const ARR_TABLE = 5604; // TalentLoadoutSlot[]
const SLOT_TABLE = 4119; // TalentLoadoutSlot

// Builds one loadout category: a TalentLoadoutSlot[] array row of `n` slots,
// each optionally pre-seeded with a Talent reference (a real ref, the null
// bitstring, or absent entirely). Returns the array row's own index (to
// reference from the Team record) plus the built slot records for
// inspection after the call.
let nextRow = 0;
function buildLoadout(slotTalents) {
  const arrIndex = nextRow++;
  const slotRecords = [];
  const arrFields = { arraySize: slotTalents.length };
  for (let i = 0; i < slotTalents.length; i++) {
    if (slotTalents[i] === undefined) continue; // simulate a missing slot reference entirely
    const slotIndex = nextRow++;
    const fields = { IsLocked: false };
    if (slotTalents[i] !== null) fields.Talent = slotTalents[i]; // null means "no Talent field seeded at all"
    slotRecords.push(makeRecord(slotIndex, fields));
    arrFields[`TalentLoadoutSlot${i}`] = REF(SLOT_TABLE, slotIndex);
  }
  return { arrIndex, arrRecord: makeRecord(arrIndex, arrFields), slotRecords };
}

(async () => {
  // ---------------------------------------------------------------------
  // No reference at all for a loadout field -- skipped cleanly.
  // ---------------------------------------------------------------------
  {
    const team = makeRecord(0, {});
    const cleared = await clearStaleTeamLoadouts(makeFile({}), team);
    check('no loadout references at all -> nothing to clear, no crash', cleared, []);
  }

  // ---------------------------------------------------------------------
  // Reference exists but the array table isn't present in the file.
  // ---------------------------------------------------------------------
  {
    const team = makeRecord(0, { GamedayLoadout: REF(9999, 0) });
    const cleared = await clearStaleTeamLoadouts(makeFile({}), team);
    check('reference into an absent table -> skipped, not a crash', cleared, []);
  }

  // ---------------------------------------------------------------------
  // Reference resolves to a missing/empty array row.
  // ---------------------------------------------------------------------
  {
    const team = makeRecord(0, { GamedayLoadout: REF(ARR_TABLE, 5) });
    const file = makeFile({ [ARR_TABLE]: makeTable(ARR_TABLE, []) }); // row 5 resolves empty
    const cleared = await clearStaleTeamLoadouts(file, team);
    check('array row missing/empty -> skipped', cleared, []);
  }

  // ---------------------------------------------------------------------
  // A real, populated loadout: mix of an already-clear slot, a slot with no
  // Talent field at all, a genuinely stale slot, and a missing slot
  // reference entirely -- only the ONE genuinely stale slot should clear.
  // ---------------------------------------------------------------------
  {
    const gameday = buildLoadout([
      REF(4112, 42),       // slot 0: a real, stale Talent reference -- must clear
      '0'.repeat(32),      // slot 1: already the null bitstring -- untouched, not re-reported
      null,                // slot 2: exists but never had a Talent field set -- untouched
      undefined,           // slot 3: no TalentLoadoutSlot ref at all -- skipped
    ]);
    const team = makeRecord(0, { GamedayLoadout: REF(ARR_TABLE, gameday.arrIndex) });
    const file = makeFile({
      [ARR_TABLE]: makeTable(ARR_TABLE, [gameday.arrRecord]),
      [SLOT_TABLE]: makeTable(SLOT_TABLE, gameday.slotRecords),
    });

    const cleared = await clearStaleTeamLoadouts(file, team);
    check('exactly one stale slot reported', cleared, [{ field: 'GamedayLoadout', slot: 0 }]);
    check('the stale slot\'s Talent is now the null bitstring', gameday.slotRecords[0].Talent, '0'.repeat(32));
    check('the already-clear slot is untouched (not re-reported, value unchanged)', gameday.slotRecords[1].Talent, '0'.repeat(32));
  }

  // ---------------------------------------------------------------------
  // All three loadout categories are processed independently -- clearing
  // GamedayLoadout must not touch PlaysheetLoadout/WearAndTearLoadout, and
  // each reports its own field name correctly.
  // ---------------------------------------------------------------------
  {
    const gameday = buildLoadout([REF(4112, 1)]);
    const playsheet = buildLoadout([REF(4235, 2)]);
    const wearAndTear = buildLoadout(['0'.repeat(32)]); // already clear -- should NOT be reported
    const team = makeRecord(0, {
      GamedayLoadout: REF(ARR_TABLE, gameday.arrIndex),
      PlaysheetLoadout: REF(ARR_TABLE, playsheet.arrIndex),
      WearAndTearLoadout: REF(ARR_TABLE, wearAndTear.arrIndex),
    });
    const file = makeFile({
      [ARR_TABLE]: makeTable(ARR_TABLE, [gameday.arrRecord, playsheet.arrRecord, wearAndTear.arrRecord]),
      [SLOT_TABLE]: makeTable(SLOT_TABLE, [...gameday.slotRecords, ...playsheet.slotRecords, ...wearAndTear.slotRecords]),
    });

    const cleared = await clearStaleTeamLoadouts(file, team);
    check('clears exactly the two genuinely stale slots, one per populated category',
      cleared.sort((a, b) => a.field.localeCompare(b.field)),
      [{ field: 'GamedayLoadout', slot: 0 }, { field: 'PlaysheetLoadout', slot: 0 }]);
    check('WearAndTearLoadout (already clear) reports nothing', cleared.some((c) => c.field === 'WearAndTearLoadout'), false);
    check('Gameday slot actually cleared', gameday.slotRecords[0].Talent, '0'.repeat(32));
    check('Playsheet slot actually cleared', playsheet.slotRecords[0].Talent, '0'.repeat(32));
  }

  console.log(`\n  clearStaleTeamLoadouts spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
