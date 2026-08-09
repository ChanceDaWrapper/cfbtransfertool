// Regression test for pipeline.js's college matcher -- the thing that turns a
// CFB school name into the Madden college asset written onto a drafted player.
//
// THE BUG THIS PINS. The matcher's last-resort rule was
//
//     for (const [key, bin] of normMap) if (key.includes(n) || n.includes(key)) return bin;
//
// a bare substring test, in both directions, returning the first hit in JSON
// key order. Three independent ways to be wrong, and a real dynasty hit all
// three at once:
//
//   - "na", the normalized form of the "N/A" PLACEHOLDER entry, is a substring
//     of "caroliNA" and "louisiaNA", so "C. Carolina" and "Louisiana Tech"
//     were both written as N/A;
//   - matching in either direction let a short key swallow a longer school:
//     "C. Michigan" and "E. Michigan" both became plain Michigan, and
//     "Ga Southern" became Southern;
//   - returning the FIRST hit made the answer depend on key order rather than
//     on which school it is: "Louisiana" became "Louisiana Christian".
//
// Undrafted free agents surfaced it because they come from these schools far
// more often than early-round picks do.
//
// Run with: node test/collegeMatch.spec.js (or npm test).

const assert = require('assert');
const { buildCollegeMatcher } = require('../lib/pipeline');
const raw = require('../data/college_lookup.json');

let passed = 0;
const match = buildCollegeMatcher();

// Reverse the lookup so a failure names the school it landed on rather than a
// binary asset id nobody can read.
const nameOf = new Map();
for (const [name, bin] of Object.entries(raw)) if (!nameOf.has(bin)) nameOf.set(bin, name);
const resolves = (school) => { const b = match(school); return b == null ? null : nameOf.get(b); };

function check(school, expected) {
  const got = resolves(school);
  assert.strictEqual(got, expected, `"${school}": got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  passed++;
}

// ---------------------------------------------------------------------
// 1. The exact schools that were wrong, taken from a real dynasty's Team
//    table. Each one is a rule the matcher has to get right.
// ---------------------------------------------------------------------
check('C. Carolina', 'Coastal Carolina');        // was N/A -- "na" inside "carolina"
check('Louisiana Tech', 'L.A. Tech');            // was N/A -- "na" inside "louisiana"
check('C. Michigan', 'Central Michigan');        // was Michigan
check('E. Michigan', 'Eastern Michigan');        // was Michigan
check('Ga Southern', 'Georgia Southern');        // was Southern
check('Louisiana', 'UL Lafayette');              // was Louisiana Christian
check('Miami (OH)', 'Miami of Ohio');            // was Miami
check('Jax State', 'Jacksonville State');        // was unmatched
check('NIU', 'Northern Illinois');               // was unmatched
check('Sac State', 'Sacramento State');          // was unmatched

// These two resolved via containment and happened to be RIGHT. They must stay
// right now that containment is word-aligned and longest-match.
check('Bowling Green', 'Bowling Green State');
check('Middle Tenn', 'Middle Tennessee State');

// ---------------------------------------------------------------------
// 2. The placeholder must never be matched by containment. This is the
//    single highest-value assertion here: N/A was being written onto real
//    players as though it were their school.
// ---------------------------------------------------------------------
for (const school of ['Carolina', 'Louisiana', 'C. Carolina', 'Louisiana Tech', 'North Carolina', 'Indiana']) {
  assert.notStrictEqual(resolves(school), 'N/A', `"${school}" must never resolve to the N/A placeholder`);
  passed++;
}

// ---------------------------------------------------------------------
// 3. Ordinary schools must be untouched -- a matcher that fixes the edge
//    cases by breaking the common path is worse than the bug.
// ---------------------------------------------------------------------
for (const s of ['Alabama', 'Ohio State', 'Michigan', 'Texas', 'Georgia', 'Oregon', 'Notre Dame',
  'Miami', 'Southern', 'Duke', 'Clemson', 'LSU']) {
  const got = resolves(s);
  assert.ok(got != null, `"${s}" must resolve to something`);
  assert.strictEqual(got, s, `"${s}" must resolve to itself, got ${JSON.stringify(got)}`);
  passed += 2;
}

// ---------------------------------------------------------------------
// 4. A school with no entry returns null rather than a wrong guess. The
//    game's FCS placeholders are the real instance of this -- they are
//    regions, not schools, and inventing a college for them would be worse
//    than leaving the field alone.
// ---------------------------------------------------------------------
for (const s of ['FCS East', 'FCS Midwest', 'FCS Northwest', 'FCS Southeast', 'FCS West']) {
  assert.strictEqual(match(s), null, `"${s}" is a placeholder region and must not resolve`);
  passed++;
}
assert.strictEqual(match(''), null, 'an empty school name must not resolve');
assert.strictEqual(match(null), null, 'a null school name must not resolve');
passed += 2;

// ---------------------------------------------------------------------
// 5. Every alias's target must actually exist in the lookup. An alias
//    pointing at a name the table does not have silently falls through to
//    containment, which is exactly how "Miami (OH)" broke -- it aliased to
//    "miami ohio" while the table calls it "Miami of Ohio".
// ---------------------------------------------------------------------
{
  const aliasTargets = ['coastal carolina', 'central michigan', 'eastern michigan',
    'northern illinois', 'georgia southern', 'georgia state', 'jacksonville state', 'sacramento state',
    'middle tennessee state', 'bowling green state', 'ul lafayette', 'la tech', 'miami of ohio',
    'appalachian state', 'north dakota state', 'massachusetts', 'connecticut', 'fau'];
  const normalized = new Set(Object.keys(raw).map((k) => k.toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()));
  for (const t of aliasTargets) {
    assert.ok(normalized.has(t), `alias target "${t}" is not present in college_lookup.json`);
    passed++;
  }
}

console.log(`\n  College match spec: ${passed} assertions passed.`);
