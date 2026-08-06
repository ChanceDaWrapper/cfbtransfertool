// Regression test for lib/carousel/appearance.js.
//
// Two areas, both previously verified only ONCE, live, against a single save:
//
//   1. cfbSkinTone -- the tone-name parser the entire CFB-side tone-matching
//      system rests on ("263/493 parse exact, zero false positives").
//
//   2. findUsableVisualsDonor -- the donor fallback for catalog-only heads.
//      This exists because of a REAL USER BUG (2026-07-26): grantAppearance
//      borrowed `catalog.entries[0]`'s CharacterVisuals blob unconditionally
//      and assumed it would parse. In the sample save entries[0].visualsRow
//      is literally row 0 and happens to be readable, so it always worked
//      here -- but a user's Madden save had an unreadable row 0 and every
//      single transfer failed with "could not read a donor CharacterVisuals
//      blob (row 0)". Because that one row was the fallback for ~117 of the
//      200 catalog heads, one bad row broke every appearance grant in that
//      save. These tests pin the fallback behaviour so it cannot regress.
//
// Run with: node test/carouselAppearance.spec.js (or npm test).

const fs = require('fs');
const assert = require('assert');
const {
  cfbSkinTone, clearCfbToneCache, CFB_TONE_PATH,
  findUsableVisualsDonor, grantAppearance, withHead,
} = require('../lib/carousel/appearance');

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
// 1a. cfbSkinTone -- name parsing. No file I/O; runs against the shipped
// overrides file, but none of these fixture names collide with a real
// override, so this only ever exercises the regex fallback path.
// ---------------------------------------------------------------------
function testNameParsing() {
  check('the documented real example (appearance.js\'s own header) parses to tone 8',
    cfbSkinTone('Generic_0011_C_T0010_H_8_1'), 8);
  check('a second documented real example parses to tone 2',
    cfbSkinTone('Generic_0103_C_T0102_H_2_3'), 2);
  check('the real head from the reported user bug (K. Gauthier, Oregon) parses to tone 7',
    cfbSkinTone('Generic_0160_C_T0159_M_7_4'), 7);

  for (let tone = 1; tone <= 8; tone++) {
    check(`tone digit ${tone} parses correctly in isolation`,
      cfbSkinTone(`Generic_0001_C_T0001_H_${tone}_1`), tone);
  }

  check('a Unique_* authored-likeness name (no tone anywhere) is null, not a false positive',
    cfbSkinTone('Unique_C_FreemanMarcus_659'), null);
  check('a second Unique_* name, different shape, also null', cfbSkinTone('Unique_C_ArandaDave_458'), null);

  check('non-string input (number) returns null rather than throwing', cfbSkinTone(42), null);
  check('non-string input (null) returns null rather than throwing', cfbSkinTone(null), null);
  check('non-string input (undefined) returns null rather than throwing', cfbSkinTone(undefined), null);
  check('empty string returns null', cfbSkinTone(''), null);
  check('a name with no trailing numeric pattern returns null', cfbSkinTone('NotARealHeadName'), null);
}

// ---------------------------------------------------------------------
// 1b. cfbSkinTone -- override precedence. Mutates the REAL
// data/cfbCoachTones.json (there is no injection point for a fake path),
// using the same capture-mutate-restore pattern research/probe26 already
// established, with the restore in a `finally` so a failed assertion can
// never leave the shipped file dirty.
// ---------------------------------------------------------------------
async function testOverridePrecedence() {
  const FAKE_UNIQUE = 'Unique_C_ZZZTestFixtureCoach_999999';
  const FAKE_GENERIC = 'Generic_9999_C_T9999_H_3_1'; // would parse to tone 3 via regex alone

  const original = fs.readFileSync(CFB_TONE_PATH, 'utf8');
  try {
    const json = JSON.parse(original);
    json.overrides = { ...json.overrides, [FAKE_UNIQUE]: 6, [FAKE_GENERIC]: 7 };
    fs.writeFileSync(CFB_TONE_PATH, JSON.stringify(json, null, 2));
    clearCfbToneCache();

    check('an override resolves a Unique_* name that has no regex match at all', cfbSkinTone(FAKE_UNIQUE), 6);
    check('an override WINS over a name that would otherwise parse to a different tone', cfbSkinTone(FAKE_GENERIC), 7);
    check('a name with neither an override nor a parseable pattern is still null',
      cfbSkinTone('Unique_C_ZZZNoOverrideAtAll_888888'), null);
  } finally {
    fs.writeFileSync(CFB_TONE_PATH, original);
    clearCfbToneCache();
  }
  check('after restore, the fixture override no longer applies', cfbSkinTone(FAKE_UNIQUE), null);
}

// ---------------------------------------------------------------------
// Fixture kit for the visuals-donor tests.
// ---------------------------------------------------------------------
const VISUALS_TABLE = 4204;
const COACH_TABLE = 4160;
const GOOD_BLOB = JSON.stringify({
  loadouts: [{ loadoutType: 'Head', loadoutCategory: 'Head', loadoutElements: [{ slotType: 'PlusHead', itemAssetName: 'coachhead_M_0013_HS' }] }],
});

function visualsRow(index, raw) {
  return {
    index,
    isEmpty: raw === null,
    RawData: raw,
    getValueByKey(key) { return key === 'RawData' ? this.RawData : undefined; },
    getReferenceDataByKey: () => null,
  };
}
function makeVisualsTable(rows) {
  return {
    name: 'CharacterVisuals',
    header: { tableId: VISUALS_TABLE, recordCapacity: rows.length },
    records: rows,
    readRecords: async () => {},
    getBinaryReferenceToRecord: (index) => ({ tableId: VISUALS_TABLE, rowNumber: index }),
  };
}
function coachRow(index, head, visualsRowNumber, portrait) {
  return {
    index, isEmpty: false,
    getValueByKey: (k) => ({ GenericHeadAssetName: head, Portrait: portrait }[k]),
    getReferenceDataByKey: (k) => (k === 'CharacterVisuals' ? { tableId: VISUALS_TABLE, rowNumber: visualsRowNumber } : null),
  };
}
function makeFile(coachRows, visualsRows) {
  const coachTable = {
    name: 'Coach', header: { tableId: COACH_TABLE, recordCapacity: coachRows.length },
    records: coachRows, readRecords: async () => {},
  };
  const visualsTable = makeVisualsTable(visualsRows);
  return {
    getAllTablesByName: (n) => (n === 'Coach' ? [coachTable] : n === 'CharacterVisuals' ? [visualsTable] : []),
    getTableById: (id) => (id === VISUALS_TABLE ? visualsTable : id === COACH_TABLE ? coachTable : null),
  };
}

// ---------------------------------------------------------------------
// 2a. findUsableVisualsDonor in isolation.
// ---------------------------------------------------------------------
async function testFindUsableVisualsDonor() {
  const rows = [
    visualsRow(0, null),                 // empty -- EXACTLY the user's reported failure
    visualsRow(1, 'not valid json{{{'),  // present but unparseable
    visualsRow(2, GOOD_BLOB),            // the first genuinely usable one
    visualsRow(3, GOOD_BLOB),
  ];
  const file = makeFile([], rows);

  const found = await findUsableVisualsDonor(file, VISUALS_TABLE, [0, 1, 2, 3]);
  check('skips an EMPTY row and an UNPARSEABLE row, landing on the first usable one', found.row, 2);
  check('returns the parsed blob, not the raw string', typeof found.json, 'object');
  check('reports every row it tried, in order', found.tried, [0, 1, 2]);

  const nulls = await findUsableVisualsDonor(file, VISUALS_TABLE, [null, undefined, 2]);
  check('null/undefined candidates are skipped without being counted as tried', nulls.tried, [2]);
  check('and it still resolves', nulls.row, 2);

  const deduped = await findUsableVisualsDonor(file, VISUALS_TABLE, [0, 0, 0, 2]);
  check('a repeated candidate row is only tried once', deduped.tried, [0, 2]);

  const none = await findUsableVisualsDonor(file, VISUALS_TABLE, [0, 1]);
  check('when nothing is readable, json is null rather than throwing', none.json, null);
  check('and row is null', none.row, null);
  check('and it still reports what it tried, so the caller can say so', none.tried, [0, 1]);

  const noTable = await findUsableVisualsDonor(file, 9999, [0]);
  check('a missing visuals table resolves to no donor rather than throwing', noTable.json, null);

  // THE REGRESSION THAT MATTERS MOST. The real bug was zlib.zstdDecompressSync
  // being absent on the app's old Electron runtime (Node 20.18): reading
  // RawData THREW, the throw was swallowed, and every row reported simply as
  // "unreadable" -- which sent the diagnosis chasing the save file instead of
  // the runtime, twice. A throw from the read path must now name itself.
  const throwingRow = {
    index: 0, isEmpty: false,
    getValueByKey() { throw new TypeError('zlib.zstdDecompressSync is not a function'); },
    getReferenceDataByKey: () => null,
  };
  const throwingFile = makeFile([], [throwingRow]);
  const threw = await findUsableVisualsDonor(throwingFile, VISUALS_TABLE, [0]);
  check('a THROW while reading a blob does not crash the search', threw.json, null);
  check('and the underlying error text is preserved, not flattened to "unreadable"',
    /zstdDecompressSync is not a function/.test(threw.reasons.join(' ')), true);

  // An ENVIRONMENT failure repeats identically across every row (its reason
  // carries no row number), so it collapses to a single line -- which is what
  // makes "the runtime is wrong" legible instead of drowning in 83 lines.
  // A DATA failure names its row, so those stay separate. That asymmetry is
  // deliberate: it is the signal that told the two cases apart.
  const envThrow = (index) => ({
    index, isEmpty: false,
    getValueByKey() { throw new TypeError('zlib.zstdDecompressSync is not a function'); },
    getReferenceDataByKey: () => null,
  });
  const allEnvBad = makeFile([], [envThrow(0), envThrow(1), envThrow(2)]);
  const envRes = await findUsableVisualsDonor(allEnvBad, VISUALS_TABLE, [0, 1, 2]);
  check('the same environment failure on every row collapses to ONE reason', envRes.reasons.length, 1);
  check('it still records that all three rows were attempted', envRes.tried, [0, 1, 2]);

  const dataBad = makeFile([], [visualsRow(0, null), visualsRow(1, 'bad{{{')]);
  const dataRes = await findUsableVisualsDonor(dataBad, VISUALS_TABLE, [0, 1]);
  check('per-row data failures stay distinct (each names its own row)', dataRes.reasons.length, 2);
}

// ---------------------------------------------------------------------
// 2b. grantAppearance end-to-end at the level the user actually hit it:
// a save whose row 0 is unreadable must still grant a face.
// ---------------------------------------------------------------------
async function testGrantAppearanceSurvivesBadDonorRow() {
  // Mirrors the user's save: several coaches, and the FIRST one (which
  // becomes catalog.entries[0] -- the old hardcoded fallback) points at an
  // unreadable row 0, while other coaches point at perfectly good rows.
  //
  // Note the donor pool is drawn only from rows COACHES point at, never the
  // visuals table at large -- that table is shared with players ~24:1, so a
  // blind scan would dress a coach in a player's uniform. See
  // findUsableVisualsDonor's header.
  const coaches = [
    coachRow(0, 'coachhead_M_0013_HS', 0, 321), // -> the bad row
    coachRow(1, 'coachhead_M_0024_HS', 1, 332), // -> a good row
    coachRow(2, 'coachhead_M_0037_HS', 3, 345), // -> another good row
  ];
  const rows = [
    visualsRow(0, null),      // the old fallback -- unreadable, as in the user's save
    visualsRow(1, GOOD_BLOB), // a usable COACH donor exists
    visualsRow(2, null),      // a free row for the new coach's private blob
    visualsRow(3, GOOD_BLOB),
  ];
  const file = makeFile(coaches, rows);

  const dest = {};
  const report = await grantAppearance(file, dest, { seed: 'test', sourceRow: 433, targetTone: 7 });

  check('grants a head despite the old fallback row being unreadable', typeof report.head, 'string');
  check('the donor it actually used is NOT the unreadable row 0', report.donorVisualsRow !== 0, true);
  check('writes the head onto the destination coach', dest.GenericHeadAssetName, report.head);
  check('writes a portrait', typeof dest.Portrait, 'number');
  check('gives the coach a PRIVATE visuals row (not the donor\'s own)', dest.CharacterVisuals.rowNumber !== report.donorVisualsRow, true);
  check('the written blob is valid JSON', typeof JSON.parse(rows[dest.CharacterVisuals.rowNumber].RawData), 'object');

  // And when NO coach-referenced row is readable, it fails with an
  // actionable message rather than the old bare "(row 0)".
  const allBad = makeFile(
    [coachRow(0, 'coachhead_M_0013_HS', 0, 321), coachRow(1, 'coachhead_M_0024_HS', 1, 332)],
    [visualsRow(0, null), visualsRow(1, null), visualsRow(2, null)],
  );
  // The message must explain WHY, not just how many rows failed -- a single
  // reason repeated across every row points at the runtime/environment, while
  // differing reasons point at the data. Getting that wrong cost three rounds
  // of misdiagnosis on the real bug (a zstd decompress unavailable on the old
  // Electron's Node 20, silently swallowed as "unreadable").
  await throws('with no readable donor anywhere, the error reports the underlying reason',
    () => grantAppearance(allBad, {}, { seed: 'test', sourceRow: 1, targetTone: 7 }),
    /could not read any usable donor CharacterVisuals blob.*Reasons?: .*row 0 is empty/s);
}

// ---------------------------------------------------------------------
// 2c. withHead -- the borrowed blob must keep its apparel and only swap
// the head, since that is the entire reason a donor is borrowed at all.
// ---------------------------------------------------------------------
function testWithHead() {
  const donor = {
    skinTone: 3,
    loadouts: [
      { loadoutType: 'Head', loadoutCategory: 'Head', loadoutElements: [{ slotType: 'PlusHead', itemAssetName: 'coachhead_M_0013_HS' }] },
      { loadoutType: 'Apparel', loadoutElements: [{ slotType: 'Shoes', itemAssetName: 'some_shoes' }] },
    ],
  };
  const out = withHead(donor, 'coachhead_M_0151_HS');
  check('the head item is swapped', out.loadouts[0].loadoutElements[0].itemAssetName, 'coachhead_M_0151_HS');
  check('apparel is left untouched', out.loadouts[1].loadoutElements[0].itemAssetName, 'some_shoes');
  check('the donor object itself is NOT mutated (deep copy)', donor.loadouts[0].loadoutElements[0].itemAssetName, 'coachhead_M_0013_HS');

  const noHead = withHead({ loadouts: [{ loadoutType: 'Apparel', loadoutElements: [] }] }, 'coachhead_M_0151_HS');
  const added = noHead.loadouts.find((l) => l.loadoutType === 'Head');
  check('a donor with no Head loadout gets one appended rather than silently keeping none',
    added.loadoutElements[0].itemAssetName, 'coachhead_M_0151_HS');
}

(async () => {
  testNameParsing();
  await testOverridePrecedence();
  await testFindUsableVisualsDonor();
  await testGrantAppearanceSurvivesBadDonorRow();
  testWithHead();
  console.log(`\n  Carousel appearance spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
