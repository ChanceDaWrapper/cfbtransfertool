// maddenTalentLayout.js -- discovering WHERE a Madden save keeps a coach's
// talent categories.
//
// Madden 26 hangs them off the Coach record directly; Madden 27 puts them on
// a holder row the coach's StaffTalents reference points at. Both shapes are
// built here from the real saves' observed numbers, so the M26 half doubles
// as the regression guard that the old hardcoded behavior is preserved:
// requiredCategories must come out as exactly [GamedayTalents,
// PlaysheetTalents], which is what talentTree.js hardcoded before this
// module existed.

const assert = require('assert');
const {
  describeTalentLayout, resolveHolder, categoryIsPopulated, talentArrayFieldNames, REQUIRED_SHARE,
} = require('../lib/carousel/maddenTalentLayout');

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
// Fixture kit. Records expose their fields as own properties so a reference
// reads back through getReferenceDataByKey, matching the real library.
// ---------------------------------------------------------------------
function rec(index, fields = {}) {
  const r = { index, isEmpty: false, ...fields };
  r.getValueByKey = function (k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined; };
  r.getReferenceDataByKey = function (k) {
    const v = this[k];
    return (v && typeof v === 'object' && ('tableId' in v || 'rowNumber' in v)) ? v : null;
  };
  return r;
}
const empty = (index) => ({ index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null });
function table(tableId, name, records, attrs = []) {
  const cap = Math.max(0, ...records.map((r) => r.index)) + 1;
  const arr = new Array(cap);
  for (let i = 0; i < cap; i++) arr[i] = empty(i);
  for (const r of records) arr[r.index] = r;
  return {
    name,
    header: { tableId, recordCapacity: cap },
    records: arr,
    schema: { attributes: attrs },
    readRecords: async () => {},
    getBinaryReferenceToRecord: (rowNumber) => ({ tableId, rowNumber }),
  };
}
function file(tables, coachAttrs) {
  const list = Object.values(tables);
  return {
    schemaList: { getSchema: (n) => (n === 'Coach' ? { attributes: coachAttrs } : null) },
    getTableById: (id) => tables[id] || null,
    getAllTablesByName: (n) => list.filter((t) => t.name === n),
  };
}
const REF = (tableId, rowNumber) => ({ tableId, rowNumber });
const arrRow = (index, size) => rec(index, { arraySize: size });
const named = (index, extra) => rec(index, { FirstName: `F${index}`, LastName: `L${index}`, ...extra });

const TALENT_ATTR = (name) => ({ name, type: 'Talent[]' });

// ---------------------------------------------------------------------
// talentArrayFieldNames -- categories are exactly the Talent[]-typed fields.
// ---------------------------------------------------------------------
{
  check('picks only Talent[] fields', talentArrayFieldNames({
    attributes: [TALENT_ATTR('GamedayTalents'), { name: 'Level', type: 'int' }, TALENT_ATTR('PlaysheetTalents')],
  }), ['GamedayTalents', 'PlaysheetTalents']);
  check('no schema yields no categories', talentArrayFieldNames(null), []);
}

// ---------------------------------------------------------------------
// The Madden 26 shape: categories directly on Coach. Populate rates are the
// real ones observed in a live save -- Gameday 135/136, Playsheet 115/136,
// WearAndTear 0/136 -- so `required` must come out as the first two only.
// ---------------------------------------------------------------------
async function m26() {
  const ARR = 5603;
  const arrRows = [];
  // rows 0..134 populated (gameday), 135..249 populated (playsheet), 250 empty (weartear target)
  for (let i = 0; i < 250; i++) arrRows.push(arrRow(i, 6));
  arrRows.push(arrRow(250, 0)); // the arraySize-0 row every WearAndTear ref points at
  const arrTable = table(ARR, 'Talent[]', arrRows);

  const coaches = [];
  for (let i = 0; i < 136; i++) {
    coaches.push(named(i, {
      GamedayTalents: i < 135 ? REF(ARR, i) : null,
      PlaysheetTalents: i < 115 ? REF(ARR, 135 + i) : null,
      WearAndTearTalents: REF(ARR, 250),
    }));
  }
  const f = file(
    { [ARR]: arrTable, 4160: table(4160, 'Coach', coaches) },
    [TALENT_ATTR('GamedayTalents'), TALENT_ATTR('PlaysheetTalents'), TALENT_ATTR('WearAndTearTalents')],
  );

  const L = await describeTalentLayout(f);
  check('M26 kind', L.kind, 'coachDirect');
  check('M26 has no holder field', L.holderField, null);
  check('M26 categories', L.categories, ['GamedayTalents', 'PlaysheetTalents', 'WearAndTearTalents']);
  check('M26 required matches the old hardcoded rule', L.requiredCategories, ['GamedayTalents', 'PlaysheetTalents']);
  check('M26 live coach count', L.liveCoaches, 136);
  check('M26 gameday rate', L.rates.GamedayTalents, { populated: 135, live: 136 });
  check('M26 weartear is universally empty', L.rates.WearAndTearTalents, { populated: 0, live: 136 });

  // Under this layout the holder IS the coach -- that identity is what lets
  // talentTree.js's clone loop stay unchanged from when it took coaches.
  const c = f.getTableById(4160).records[0];
  check('M26 holder is the coach itself', (await resolveHolder(f, c, L)) === c, true);
  check('M26 populated category', await categoryIsPopulated(f, c, 'GamedayTalents'), true);
  check('M26 arraySize-0 ref is not populated', await categoryIsPopulated(f, c, 'WearAndTearTalents'), false);
}

// ---------------------------------------------------------------------
// The Madden 27 shape: one hop through a holder row, two categories.
// ---------------------------------------------------------------------
async function m27() {
  const ARR = 5713, HOLD = 4304;
  const arrRows = [];
  for (let i = 0; i < 220; i++) arrRows.push(arrRow(i, 8));
  const arrTable = table(ARR, 'Talent[]', arrRows);

  // 106 coaches, 105 with a holder row that has both categories populated.
  const holders = [];
  for (let i = 0; i < 105; i++) {
    holders.push(rec(i, { GamedayTalents: REF(ARR, i), PlaysheetTalents: REF(ARR, 105 + i) }));
  }
  const holdTable = table(HOLD, 'CoachingTalents', holders,
    [TALENT_ATTR('GamedayTalents'), TALENT_ATTR('PlaysheetTalents')]);

  const coaches = [];
  for (let i = 0; i < 106; i++) coaches.push(named(i, { StaffTalents: i < 105 ? REF(HOLD, i) : null }));
  const f = file(
    { [ARR]: arrTable, [HOLD]: holdTable, 4168: table(4168, 'Coach', coaches) },
    [{ name: 'StaffTalents', type: 'AbstractTalentList' }, { name: 'Level', type: 'int' }],
  );

  const L = await describeTalentLayout(f);
  check('M27 kind', L.kind, 'staffStruct');
  check('M27 holder field', L.holderField, 'StaffTalents');
  check('M27 holder table discovered from a live reference', L.holderTableName, 'CoachingTalents');
  check('M27 holder table id', L.holderTableId, HOLD);
  // Read off the HOLDER's schema, not the Coach's -- the Coach schema only
  // declares the abstract base type, so the categories are unknowable there.
  check('M27 categories come from the holder schema', L.categories, ['GamedayTalents', 'PlaysheetTalents']);
  check('M27 required', L.requiredCategories, ['GamedayTalents', 'PlaysheetTalents']);
  check('M27 rates', L.rates.GamedayTalents, { populated: 105, live: 106 });

  const withHolder = f.getTableById(4168).records[0];
  const holder = await resolveHolder(f, withHolder, L);
  check('M27 holder is a different record than the coach', holder !== withHolder, true);
  check('M27 holder row index', holder.index, 0);
  check('M27 populated through the hop', await categoryIsPopulated(f, holder, 'GamedayTalents'), true);

  // The one coach with no holder is a real state, not an error.
  const noHolder = f.getTableById(4168).records[105];
  check('M27 missing holder resolves to null', await resolveHolder(f, noHolder, L), null);
  check('null holder is never populated', await categoryIsPopulated(f, null, 'GamedayTalents'), false);
}

// ---------------------------------------------------------------------
// The threshold itself, and the refusals.
// ---------------------------------------------------------------------
async function edges() {
  check('required share is a majority rule', REQUIRED_SHARE, 0.5);

  // A category populated for exactly half the league is required (>=), one
  // just under is not. Guards the boundary the M26 numbers sit far from.
  const ARR = 5603;
  const arrTable = table(ARR, 'Talent[]', [arrRow(0, 4), arrRow(1, 0)]);
  const mk = (populatedCount) => {
    const coaches = [];
    for (let i = 0; i < 10; i++) coaches.push(named(i, { GamedayTalents: REF(ARR, i < populatedCount ? 0 : 1) }));
    return file({ [ARR]: arrTable, 4160: table(4160, 'Coach', coaches) }, [TALENT_ATTR('GamedayTalents')]);
  };
  check('exactly half -> required', (await describeTalentLayout(mk(5))).requiredCategories, ['GamedayTalents']);
  check('just under half -> not required', (await describeTalentLayout(mk(4))).requiredCategories, []);

  // A Coach table with neither shape: refuse with a message that names the
  // way out, rather than dereferencing null deep inside the clone.
  const bare = file({ 4160: table(4160, 'Coach', [named(0)]) }, [{ name: 'Level', type: 'int' }]);
  await throws('neither shape refuses', () => describeTalentLayout(bare), /Skip talent tree/);
  await throws('neither shape names the missing field', () => describeTalentLayout(bare), /StaffTalents/);

  // StaffTalents declared, but no coach actually points anywhere -- the
  // categories can never be discovered, so this refuses too.
  const dangling = file(
    { 4160: table(4160, 'Coach', [named(0, { StaffTalents: null })]) },
    [{ name: 'StaffTalents', type: 'AbstractTalentList' }],
  );
  await throws('no resolvable holder refuses', () => describeTalentLayout(dangling), /no coach in this Madden save/);

  const noSchema = { schemaList: { getSchema: () => null } };
  await throws('missing Coach schema refuses', () => describeTalentLayout(noSchema), /no Coach schema/);
}

(async () => {
  await m26();
  await m27();
  await edges();
  console.log(`\n  Madden talent layout spec: ${passed} assertions passed.\n`);
})().catch((e) => { console.error(e.stack); process.exit(1); });
