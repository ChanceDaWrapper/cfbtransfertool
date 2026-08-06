// Regression test for lib/carousel/cfbNormalize.js.
//
// This module went through THREE designs before landing here, and the
// mistakes are exactly what this file guards against:
//   1. A "value unlike other coaches" statistical rule -- failed both ways:
//      blind to damage measured against a save the damage was already in
//      (the broken coaches polluted their own baseline), and it flagged 134
//      of 414 coaches in a genuinely healthy save (rare-but-real values).
//   2. A frequency-threshold version of the same idea -- still flagged
//      rare-but-real values (CoachBackstory "StaffBuilder", 1 of 414).
//   3. THE REAL REGRESSION THIS FILE MOST NEEDS TO CATCH: an early version
//      of the final design included ContractLength/ContractYearsRemaining in
//      the fields to "fix". It shipped, was told "that worked" by the user
//      whose crash it solved, and only afterward was found to have shortened
//      four real coordinators' contracts from 4 years to 1 -- because 4
//      happened to be uncommon in THAT save, not because it is invalid
//      anywhere. A second healthy save has coordinators on 1/2/3/5-year
//      deals with no 4 either, which is the same "uncommon, not invalid"
//      trap in a different shape. ContractLength/ContractYearsRemaining must
//      never be touched by this module again.
//
// Run with: node test/cfbNormalize.spec.js (or npm test).

const assert = require('assert');
const {
  findDamagedCoaches, employedPeersByPosition, buildEmploymentProfile,
  applyEmploymentProfile, employmentProblems, EMPLOYMENT_FIELDS,
} = require('../lib/carousel/cfbNormalize');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function makeRecord(index, fields = {}) {
  const rec = { index, isEmpty: false };
  Object.assign(rec, fields);
  rec.getValueByKey = function (k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined; };
  rec.getReferenceDataByKey = () => null;
  return rec;
}
function makeEmpty(index) { return { index, isEmpty: true, getValueByKey: () => undefined, getReferenceDataByKey: () => null }; }
function dense(recs) {
  const max = recs.reduce((m, r) => Math.max(m, r.index), -1);
  const a = new Array(max + 1);
  for (let i = 0; i < a.length; i++) a[i] = makeEmpty(i);
  for (const r of recs) a[r.index] = r;
  return a;
}

// --------------------------------------------------------------------
// THE REGRESSION: ContractLength/ContractYearsRemaining must never appear
// in the fixed field list, and must survive being wildly uncommon.
// --------------------------------------------------------------------
(function testContractLengthNeverTouched() {
  check('ContractLength is not in the employment field list', EMPLOYMENT_FIELDS.includes('ContractLength'), false);
  check('ContractYearsRemaining is not in the employment field list', EMPLOYMENT_FIELDS.includes('ContractYearsRemaining'), false);

  // A coordinator on a 4-year deal where every OTHER coordinator in the save
  // happens to be on 1 or 2 -- exactly the shape that broke real contracts.
  const peers = [
    makeRecord(0, { Position: 'OffensiveCoordinator', TeamIndex: 1, Level: 20, ContractLength: 1, CurrentContractExpectation: 'Win5Games' }),
    makeRecord(1, { Position: 'OffensiveCoordinator', TeamIndex: 2, Level: 22, ContractLength: 2, CurrentContractExpectation: 'Win6Games' }),
    makeRecord(2, { Position: 'OffensiveCoordinator', TeamIndex: 3, Level: 19, ContractLength: 1, CurrentContractExpectation: 'Win5Games' }),
  ];
  const damagedCoach = makeRecord(3, {
    Position: 'OffensiveCoordinator', TeamIndex: 4, Level: 26,
    ContractLength: 4, ContractYearsRemaining: 4, // uncommon here, but a real, legal contract term
    CurrentContractExpectation: 'Count_', // the actual damage signal
  });

  const profile = buildEmploymentProfile(peers);
  const problems = employmentProblems(damagedCoach, profile);
  check('ContractLength is never reported as a problem, no matter how uncommon',
    problems.some((p) => p.field === 'ContractLength'), false);

  const changes = applyEmploymentProfile(damagedCoach, profile);
  check('ContractLength is untouched by the fix', damagedCoach.ContractLength, 4);
  check('ContractYearsRemaining is untouched by the fix', damagedCoach.ContractYearsRemaining, 4);
  check('the real damage (Count_) is still fixed', changes.some((c) => c.field === 'CurrentContractExpectation'), true);
})();

// --------------------------------------------------------------------
// findDamagedCoaches -- keys off Count_ alone, and only among the employed.
// --------------------------------------------------------------------
(function testFindDamagedCoaches() {
  const genuineEmployed = makeRecord(0, { TeamIndex: 1, Level: 30, CurrentContractExpectation: 'Win5Games' });
  const genuineFreeAgent = makeRecord(1, { TeamIndex: 255, Level: 20, CurrentContractExpectation: 'Count_' }); // normal for a FA
  const blankShell = makeRecord(2, { TeamIndex: 5, Level: 0, CurrentContractExpectation: 'Count_' }); // never employed
  const damaged = makeRecord(3, { TeamIndex: 5, Level: 25, CurrentContractExpectation: 'Count_' }); // employed + Count_ = damaged

  const recs = dense([genuineEmployed, genuineFreeAgent, blankShell, damaged]);
  const found = findDamagedCoaches(recs);
  check('finds exactly the employed coach carrying Count_', found.map((r) => r.index), [3]);
})();

// --------------------------------------------------------------------
// buildEmploymentProfile / applyEmploymentProfile -- damage is excluded from
// the baseline, so it cannot make itself look normal.
// --------------------------------------------------------------------
(function testBaselineExcludesDamage() {
  const peers = [
    makeRecord(0, { Position: 'HeadCoach', TeamIndex: 1, Level: 40, CurrentContractExpectation: 'Win7Games', CoachBackstory: 'Motivator' }),
    makeRecord(1, { Position: 'HeadCoach', TeamIndex: 2, Level: 38, CurrentContractExpectation: 'Win6Games', CoachBackstory: 'Motivator' }),
  ];
  const damaged = makeRecord(2, { Position: 'HeadCoach', TeamIndex: 3, Level: 30, CurrentContractExpectation: 'Count_', CoachBackstory: 'HCSalesman' });

  // Baseline built WITHOUT excluding the damaged coach -- the mistake that
  // made the very first detector design blind to its own target.
  const pollutedByPos = employedPeersByPosition(dense([...peers, damaged]));
  const pollutedProfile = buildEmploymentProfile(pollutedByPos.get('HeadCoach'));
  check('a damaged coach IS a legitimate value if counted in its own baseline (the original bug)',
    pollutedProfile.get('CurrentContractExpectation').legitimate.has('Count_'), true);

  // Baseline correctly excluding it (what findDamagedCoaches + exclusion is for).
  const cleanByPos = employedPeersByPosition(dense([...peers, damaged]), { excludeRows: [damaged.index] });
  const cleanProfile = buildEmploymentProfile(cleanByPos.get('HeadCoach'));
  check('excluding the damaged coach makes Count_ correctly illegitimate',
    cleanProfile.get('CurrentContractExpectation').legitimate.has('Count_'), false);

  const changes = applyEmploymentProfile(damaged, cleanProfile);
  check('CurrentContractExpectation is replaced with a real value', changes.find((c) => c.field === 'CurrentContractExpectation').to, 'Win7Games');
  check('CoachBackstory is replaced with what real head coaches use', damaged.CoachBackstory, 'Motivator');
})();

// --------------------------------------------------------------------
// applyEmploymentProfile -- preferFrom (the displaced incumbent) wins when
// it holds a legitimate value; the job's own prior holder is more faithful
// than a positional mode.
// --------------------------------------------------------------------
(function testPreferFromIncumbent() {
  const peers = [
    makeRecord(0, { Position: 'HeadCoach', TeamIndex: 1, Level: 40, CurrentContractExpectation: 'Win9Games' }),
    makeRecord(1, { Position: 'HeadCoach', TeamIndex: 2, Level: 38, CurrentContractExpectation: 'Win9Games' }),
    makeRecord(2, { Position: 'HeadCoach', TeamIndex: 3, Level: 35, CurrentContractExpectation: 'WinConfChamp' }),
  ];
  const profile = buildEmploymentProfile(peers);
  const damaged = makeRecord(4, { Position: 'HeadCoach', TeamIndex: 4, CurrentContractExpectation: 'Count_' });
  const incumbent = makeRecord(5, { CurrentContractExpectation: 'WinConfChamp' }); // the job's own prior goal

  const changes = applyEmploymentProfile(damaged, profile, { preferFrom: incumbent });
  check('inherits the incumbent\'s own value rather than the positional mode', damaged.CurrentContractExpectation, 'WinConfChamp');
  check('reports the source as the outgoing coach', changes[0].source, 'the outgoing coach');
})();

console.log(`\n  CFB normalize spec: ${passed} assertions passed.`);
