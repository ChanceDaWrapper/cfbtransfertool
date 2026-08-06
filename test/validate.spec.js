// Regression test for lib/carousel/validate.js -- the pre-write schema
// check this project's own header calls "the last line of defense before
// bytes change," built specifically because a real incident (a 95-field
// coach write that produced a save Madden refused to load) went uncaught
// by every check that existed before it. Had ZERO fixture coverage before
// this file -- a regression here means the exact class of "damaged save"
// incident this file exists to prevent goes uncaught again.
//
// Purely fixture-testable: validateCoachFields only ever reads
// `destFile.schemaList.getSchema(table)`, no real save needed.
//
// Run with: node test/validate.spec.js (or npm test).

const assert = require('assert');
const { validateCoachFields, formatProblems, schemaAttrs } = require('../lib/carousel/validate');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function attr(name, rest) { return { name, ...rest }; }
function enumAttr(name, members) { return attr(name, { enum: { name: `${name}Enum`, members: members.map((m) => ({ name: m })) } }); }

const SCHEMA_ATTRS = [
  enumAttr('ContractStatus', ['First_Active', 'FreeAgent', 'Signed', 'Invalid_']),
  enumAttr('BigEnum', Array.from({ length: 15 }, (_, i) => `Member${i}`)), // >12 members, exercises truncation
  attr('IsMaxLevel', { type: 'bool' }),
  attr('Name', { type: 'string', maxLength: 20 }),
  attr('Level', { type: 'int', minValue: 0, maxValue: 99 }), // NOT offset-encoded (min is 0)
  // The exact real-world case this file's own comments describe: Weight
  // declares [150..512] but the writable/raw range is [0, 362].
  attr('Weight', { type: 'int', minValue: 150, maxValue: 512 }),
  attr('ContractSalary', { type: 'float', minValue: 0, maxValue: 99999999 }),
  attr('OffensiveScheme', { type: 'SchemeRef' }), // anything not enum/bool/string/int/float is reference-typed
];

function makeFile(attrs = SCHEMA_ATTRS, table = 'Coach') {
  return {
    schemaList: {
      getSchema: (t) => (t === table ? { attributes: attrs } : null),
    },
  };
}

const VALID_REF = '1' + '0'.repeat(31);

(function testSchemaAttrs() {
  const byName = schemaAttrs(makeFile(), 'Coach');
  check('schemaAttrs returns a Map keyed by field name', byName.get('Level').type, 'int');

  let threw = false, message = '';
  try { schemaAttrs(makeFile(), 'NoSuchTable'); } catch (e) { threw = true; message = e.message; }
  check('schemaAttrs throws when the destination schema has no such table', threw, true);
  check('the throw names the missing table', /no "NoSuchTable" table/.test(message), true);
})();

(function testEnum() {
  check('a valid enum member is accepted', validateCoachFields(makeFile(), { ContractStatus: 'Signed' }).ok, true);

  const bad = validateCoachFields(makeFile(), { ContractStatus: 'NotAMember' });
  check('an invalid enum value is rejected', bad.ok, false);
  check('reports the field/value/reason', bad.problems[0].field, 'ContractStatus');
  check('reason names the enum and does not blow up on a small member list', /valid: First_Active/.test(bad.problems[0].reason), true);

  const badBig = validateCoachFields(makeFile(), { BigEnum: 'NotAMember' });
  check('a large enum truncates its listed members with "..." rather than dumping all 15', /\.\.\./.test(badBig.problems[0].reason), true);
})();

(function testBool() {
  check('a real boolean is accepted', validateCoachFields(makeFile(), { IsMaxLevel: true }).ok, true);
  const bad = validateCoachFields(makeFile(), { IsMaxLevel: 'true' }); // string, not boolean
  check('a string is rejected for a bool field', bad.ok, false);
  check('reason says a boolean was expected', bad.problems[0].reason, 'expected a boolean');
})();

(function testString() {
  check('a string within maxLength is accepted', validateCoachFields(makeFile(), { Name: 'M. Freeman' }).ok, true);
  const wrongType = validateCoachFields(makeFile(), { Name: 12345 });
  check('a non-string is rejected for a string field', wrongType.ok, false);
  check('reason says a string was expected', wrongType.problems[0].reason, 'expected a string');

  const tooLong = validateCoachFields(makeFile(), { Name: 'A'.repeat(25) });
  check('a string longer than maxLength is rejected', tooLong.ok, false);
  check('reason reports the actual length vs the schema max', /25 chars, schema maxLength is 20/.test(tooLong.problems[0].reason), true);
})();

(function testInt() {
  check('a value inside a non-offset range is accepted', validateCoachFields(makeFile(), { Level: 48 }).ok, true);

  const notNumber = validateCoachFields(makeFile(), { Level: '48' });
  check('a non-number is rejected for an int field', notNumber.ok, false);
  check('reason says a finite number was expected', /expected a finite number for int/.test(notNumber.problems[0].reason), true);

  const notFinite = validateCoachFields(makeFile(), { Level: NaN });
  check('NaN is rejected', notFinite.ok, false);

  const notInteger = validateCoachFields(makeFile(), { Level: 48.5 });
  check('a non-integer written to an int field is rejected', notInteger.ok, false);
  check('reason names the non-integer problem specifically', notInteger.problems[0].reason, 'non-integer written to an int field');

  const belowRange = validateCoachFields(makeFile(), { Level: -1 });
  check('below the declared minimum (non-offset field) is rejected', belowRange.ok, false);
  check('reason cites the writable minimum directly (0), no offset note', belowRange.problems[0].reason, 'below the writable minimum 0');

  const aboveRange = validateCoachFields(makeFile(), { Level: 100 });
  check('above the declared maximum (non-offset field) is rejected', aboveRange.ok, false);
  check('reason cites the writable maximum directly (99), no offset note', aboveRange.problems[0].reason, 'above the writable maximum 99');
})();

(function testOffsetEncodedInt() {
  // The exact real bug this offset logic exists to prevent: Weight declares
  // [150..512] in the schema, but the RAW writable range is [0, 362] --
  // checking against the declared minimum (150) would wrongly reject a
  // perfectly valid raw value like 70.
  check('a raw value within the offset-adjusted range (0..362) is accepted even though it looks "below 150"',
    validateCoachFields(makeFile(), { Weight: 70 }).ok, true);
  check('0 itself (the offset-adjusted floor) is accepted', validateCoachFields(makeFile(), { Weight: 0 }).ok, true);

  const below = validateCoachFields(makeFile(), { Weight: -1 });
  check('below the OFFSET-ADJUSTED floor (not the declared 150) is rejected', below.ok, false);
  check('reason explains the offset encoding', /below the writable minimum 0 \(offset-encoded field declared \[150\.\.512\]\)/.test(below.problems[0].reason), true);

  const above = validateCoachFields(makeFile(), { Weight: 363 }); // max-min+1 = 363
  check('above the offset-adjusted ceiling (max - min = 362) is rejected', above.ok, false);
  check('reason explains the offset encoding for the ceiling too', /above the writable maximum 362 \(offset-encoded field declared \[150\.\.512\]\)/.test(above.problems[0].reason), true);
})();

(function testFloat() {
  check('a fractional float is accepted (unlike int, no integer requirement)', validateCoachFields(makeFile(), { ContractSalary: 1234.56 }).ok, true);
  const bad = validateCoachFields(makeFile(), { ContractSalary: 'a lot' });
  check('a non-number float field is rejected', bad.ok, false);
})();

(function testReferenceField() {
  check('a valid 32-bit binary string is accepted for a reference-typed field',
    validateCoachFields(makeFile(), { OffensiveScheme: VALID_REF }).ok, true);

  const wrongLength = validateCoachFields(makeFile(), { OffensiveScheme: '10101' });
  check('a too-short binary string is rejected', wrongLength.ok, false);
  check('reason names the field type and what was actually received', /reference field \(SchemeRef\) needs a 32-bit binary string, got string/.test(wrongLength.problems[0].reason), true);

  const wrongType = validateCoachFields(makeFile(), { OffensiveScheme: 12345 });
  check('a non-string is rejected for a reference field too', wrongType.ok, false);
  check('reason reports the actual JS type received', /got number/.test(wrongType.problems[0].reason), true);
})();

(function testFieldNotInSchema() {
  const result = validateCoachFields(makeFile(), { TotallyMadeUpField: 5 });
  check('a field absent from the destination schema is rejected', result.ok, false);
  check('reason says it is not a field on the destination table', /not a field on Coach in the destination schema/.test(result.problems[0].reason), true);
})();

(function testUndefinedSkipped() {
  // "deliberately unset" -- the writer skips undefined values entirely, so
  // validation must not flag them, EVEN for a field that isn't in the
  // schema at all (an unset field never gets as far as being looked up).
  check('undefined is always skipped, even for an unrecognized field name',
    validateCoachFields(makeFile(), { TotallyMadeUpField: undefined, Level: undefined }), { ok: true, problems: [] });
})();

(function testMultipleProblemsAndFormat() {
  const result = validateCoachFields(makeFile(), { Level: 200, Name: 12345, ContractStatus: 'Bogus' });
  check('multiple bad fields all get reported, not just the first', result.problems.length, 3);
  check('ok is false when anything is wrong', result.ok, false);

  const formatted = formatProblems(result.problems);
  check('formatProblems renders one line per problem', formatted.split('\n').length, 3);
  check('each line names the field and the offending value', /^ {2}Level = 200 --/.test(formatted), true);
})();

(function testAllValid() {
  check('a fully valid bag reports ok:true with an empty problems array',
    validateCoachFields(makeFile(), {
      ContractStatus: 'Signed', IsMaxLevel: false, Name: 'Test Coach', Level: 40, Weight: 70,
      ContractSalary: 500000, OffensiveScheme: VALID_REF,
    }),
    { ok: true, problems: [] });
})();

console.log(`\n  Validate spec: ${passed} assertions passed.`);
