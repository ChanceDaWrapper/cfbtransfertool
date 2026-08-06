// Regression test for lib/carousel/person.js and coachFacet.js -- Phase 0 of
// COACH_CAROUSEL_ROADMAP.md ("Done when: a unit test asserting round-trip
// fidelity of the 19 shared Person fields"). No real save file needed:
// extractPerson/extractCoachFacet take a duck-typed record (`.index` +
// `.getValueByKey`), so a fake record is enough -- same fixture-object
// convention as test/bioFields.spec.js uses for calibratePlayers.
// Run with: node test/carouselPerson.spec.js (or npm test, which runs all specs).

const assert = require('assert');
const { PERSON_FIELDS, PERSON_FIELD_GROUPS, extractPerson } = require('../lib/carousel/person');
const { classifyCoachSchema, extractCoachFacet, isReferenceType } = require('../lib/carousel/coachFacet');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function fakeRecord(index, fields) {
  return {
    index,
    isEmpty: false,
    getValueByKey(key) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) throw new Error(`no such field: ${key}`);
      return fields[key];
    },
  };
}

// ---------------------------------------------------------------------
// 1. PERSON_FIELDS is the Coach<->Player intersection verified (by direct
//    schema query, not just name-matching) to be genuinely shared in BOTH
//    games -- 19 same-name/same-type fields, MINUS `Position`, which is
//    deliberately excluded even though the name is shared: CFB/Madden
//    Coach.Position uses CoachPosition/StaffPosition (job title) while
//    Player.Position uses PositionE (playing position) in both games -- a
//    same-name, different-enum trap. So PERSON_FIELDS has 18 entries.
// ---------------------------------------------------------------------
check('PERSON_FIELDS has exactly 18 fields (19 shared names minus Position)', PERSON_FIELDS.length, 18);
check('Position is not a Person field', PERSON_FIELDS.includes('Position'), false);
check('PERSON_FIELD_GROUPS flattens to the same set as PERSON_FIELDS',
  Object.values(PERSON_FIELD_GROUPS).flat().slice().sort(),
  PERSON_FIELDS.slice().sort());

// ---------------------------------------------------------------------
// 2. Round-trip fidelity: identical real-world values, extracted from a
//    CFB-shaped record and a Madden-shaped record, must produce the SAME
//    Person (apart from sourceGame/sourceRow) -- this is what "Person is a
//    game-agnostic core" means operationally.
// ---------------------------------------------------------------------
const sharedValues = {
  FirstName: 'Garrett', LastName: 'Altman', IsCreated: false, IsLegend: false,
  IsUserControlled: false, PresentationId: 375,
  Age: 47, Height: 72, Weight: 45, CharacterBodyType: 'Thin', Personality: 'Unpredictable',
  GenericHeadAssetName: 'Unique_C_AltmanGarrett_900', CharacterVisuals: '00100000110101000000000110000001',
  ExperiencePoints: 8890, LegacyScore: 0, YearlyAwardCount: 0,
  TeamIndex: 99, PrevTeamIndex: 255,
};
const cfbRecord = fakeRecord(111, sharedValues);
const maddenRecord = fakeRecord(222, sharedValues);

const cfbPerson = extractPerson(cfbRecord, { sourceGame: 'cfb', sourceTable: 'Coach' });
const maddenPerson = extractPerson(maddenRecord, { sourceGame: 'madden', sourceTable: 'Coach' });

check('cfb Person bio/appearance/career/assignment match Madden Person exactly (same source values)',
  { bio: cfbPerson.bio, appearance: cfbPerson.appearance, career: cfbPerson.career, assignment: cfbPerson.assignment },
  { bio: maddenPerson.bio, appearance: maddenPerson.appearance, career: maddenPerson.career, assignment: maddenPerson.assignment });
check('cfb identity.sourceGame', cfbPerson.identity.sourceGame, 'cfb');
check('madden identity.sourceGame', maddenPerson.identity.sourceGame, 'madden');
check('cfb identity.sourceRow == record.index (canonical id)', cfbPerson.identity.sourceRow, 111);
check('madden identity.sourceRow == record.index (canonical id)', maddenPerson.identity.sourceRow, 222);
check('cfb identity.firstName/lastName round-trip', [cfbPerson.identity.firstName, cfbPerson.identity.lastName], ['Garrett', 'Altman']);

// ---------------------------------------------------------------------
// 3. A field the source schema doesn't have (getValueByKey throws) comes
//    back undefined via safe(), not an exception -- extraction must never
//    blow up on a field one game's schema lacks.
// ---------------------------------------------------------------------
const sparse = fakeRecord(1, { FirstName: 'X', LastName: 'Y' });
const sparsePerson = extractPerson(sparse, { sourceGame: 'cfb', sourceTable: 'Coach' });
check('missing Age comes back undefined, not throw', sparsePerson.bio.age, undefined);
check('present FirstName still extracted', sparsePerson.identity.firstName, 'X');

// ---------------------------------------------------------------------
// 4. extractPerson rejects an unrecognized sourceGame rather than silently
//    tagging a Person with a bogus game label.
// ---------------------------------------------------------------------
assert.throws(() => extractPerson(sparse, { sourceGame: 'xbox', sourceTable: 'Coach' }), /sourceGame/);
passed++;

// ---------------------------------------------------------------------
// 5. CoachFacet: classifyCoachSchema splits scalar/enum fields from
//    reference fields, and excludes anything already in Person.
// ---------------------------------------------------------------------
const fakeFile = {
  schemaList: {
    getSchema(name) {
      assert.strictEqual(name, 'Coach');
      return {
        attributes: [
          { name: 'FirstName', type: 'string', enum: null },       // Person field -- must be excluded
          { name: 'Level', type: 'int', enum: null },               // scalar
          { name: 'ContractStatus', type: 'StaffPersonContractStatus', enum: { name: 'StaffPersonContractStatus' } }, // enum -> scalar bucket
          { name: 'OffensiveScheme', type: 'Scheme', enum: null },  // reference
          { name: 'CareerStats', type: 'CareerCoachStats', enum: null }, // reference
        ],
      };
    },
  },
};
const classification = classifyCoachSchema(fakeFile);
check('scalar fields exclude Person fields, include int + enum fields',
  classification.scalarFields.slice().sort(), ['ContractStatus', 'Level']);
check('reference fields are the non-scalar, non-enum, non-Person attributes',
  classification.referenceFields.slice().sort(), ['CareerStats', 'OffensiveScheme']);
check('isReferenceType: enum attribute is not a reference',
  isReferenceType({ name: 'ContractStatus', type: 'StaffPersonContractStatus', enum: { name: 'x' } }), false);
check('isReferenceType: Scheme attribute (no enum, non-scalar type) is a reference',
  isReferenceType({ name: 'OffensiveScheme', type: 'Scheme', enum: null }), true);

// ---------------------------------------------------------------------
// 6. extractCoachFacet pulls raw scalar/enum values via getValueByKey and
//    reference values via getReferenceDataByKey, never mixing the two up
//    (a reference field's raw bitstring must never leak into `raw`, and a
//    scalar's value must never be looked up as a reference).
// ---------------------------------------------------------------------
const coachRecord = {
  index: 5,
  isEmpty: false,
  getValueByKey(key) {
    const vals = { Level: 41, ContractStatus: 'FreeAgent', FirstName: 'ShouldNotAppear' };
    if (!(key in vals)) throw new Error(`unexpected getValueByKey(${key})`);
    return vals[key];
  },
  getReferenceDataByKey(key) {
    if (key !== 'OffensiveScheme') throw new Error(`unexpected getReferenceDataByKey(${key})`);
    return { tableId: 16433, rowNumber: 111496 };
  },
};
const facet = extractCoachFacet(coachRecord, {
  sourceGame: 'cfb',
  fieldClassification: { scalarFields: ['Level', 'ContractStatus'], referenceFields: ['OffensiveScheme'] },
});
check('facet.raw has scalar + enum values', facet.raw, { Level: 41, ContractStatus: 'FreeAgent' });
check('facet.refs has the resolved pointer, not a bitstring', facet.refs, { OffensiveScheme: { tableId: 16433, rowNumber: 111496 } });
check('facet.sourceGame tagged', facet.sourceGame, 'cfb');

console.log(`\n  Carousel Person spec: ${passed} assertions passed.`);
