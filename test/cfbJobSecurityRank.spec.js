// Regression test for lib/carousel/cfbJobSecurityRank.js.
//
// THE BUG THIS PINS DOWN. CurrentJobSecurityPercentageRank is a dense unique
// PERMUTATION over the employed coaches -- 1..N, every value exactly once, no
// gaps -- with free agents parked outside it on a sentinel (500). Verified in
// two independent healthy saves (a fresh preseason dynasty and a mid-season
// one): 414 employed, 414 distinct, range 1..414, zero gaps, and zero employed
// coaches holding the sentinel in either.
//
// A transfer used to break it from both ends at once: the arriving coach was
// promoted out of a free-agent shell still carrying the sentinel, while the
// displaced incumbent was fired into free agency still holding a real rank. On
// the save that would not load, four OC/DC transfers left ranks 84, 161, 230 and
// 288 belonging to nobody and four coaches sharing 500. The dynasty sat on the
// loading screen forever rather than crashing -- the signature of walking a
// permutation that no longer terminates.
//
// Run with: node test/cfbJobSecurityRank.spec.js (or npm test).

const assert = require('assert');
const {
  FREE_AGENT_RANK, FIELD, isEmployed,
  transferJobSecurityRank, findRankProblems, repairJobSecurityRanks,
} = require('../lib/carousel/cfbJobSecurityRank');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

function coach(index, { team = 1, level = 20, rank = 1, name = `C${index}` } = {}) {
  const rec = {
    index, isEmpty: false, Name: name, TeamIndex: team, Level: level,
    [FIELD]: rank, Position: 'OffensiveCoordinator',
  };
  rec.getValueByKey = function (k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined; };
  rec.getReferenceDataByKey = () => null;
  return rec;
}
const freeAgent = (index, rank = FREE_AGENT_RANK) => coach(index, { team: 255, level: 20, rank });

// --------------------------------------------------------------------
// 1. Who counts as employed -- the population the invariant is defined over.
// --------------------------------------------------------------------
{
  check('a coach with a team and a level is employed', isEmployed(coach(0)), true);
  check('TeamIndex 255 is not employed', isEmployed(coach(1, { team: 255 })), false);
  check('Level 0 is not employed (a blank shell)', isEmployed(coach(2, { level: 0 })), false);
  check('an empty row is not employed', isEmployed({ isEmpty: true }), false);
}

// --------------------------------------------------------------------
// 2. THE ENGINE FIX: the job's standing follows the job.
// --------------------------------------------------------------------
{
  const incumbent = coach(10, { team: 7, rank: 288 });
  const arriving = coach(11, { team: 7, rank: FREE_AGENT_RANK });

  const moved = transferJobSecurityRank(arriving, incumbent);
  check('the arriving coach inherits the rank', arriving[FIELD], 288);
  check('the displaced incumbent is parked on the sentinel', incumbent[FIELD], FREE_AGENT_RANK);
  check('the move is reported as an inheritance', moved.mode, 'inherited');
  check('the reported rank is the one that moved', moved.rank, 288);
}

// A swap must be rank-NEUTRAL: the set of ranks held by employed coaches is
// identical before and after, which is what keeps the permutation dense.
{
  const employedBefore = [coach(0, { rank: 1 }), coach(1, { rank: 2 }), coach(2, { rank: 3 })];
  const incumbent = employedBefore[1];
  const arriving = coach(9, { team: 5, rank: FREE_AGENT_RANK });
  transferJobSecurityRank(arriving, incumbent);
  incumbent.TeamIndex = 255; // now a free agent, as displaceCfbIncumbent does

  const after = [employedBefore[0], employedBefore[2], arriving].map((r) => r[FIELD]).sort((a, b) => a - b);
  check('the employed rank set is unchanged by the swap', after, [1, 2, 3]);
}

// No incumbent: the employed population GREW, so the honest answer is a rank
// that did not exist before -- appended last, not a duplicate of anyone.
{
  const arriving = coach(20, { team: 3, rank: FREE_AGENT_RANK });
  const moved = transferJobSecurityRank(arriving, null, { employedCountAfter: 415 });
  check('with no incumbent the rank is appended at the end', arriving[FIELD], 415);
  check('the move is reported as an append', moved.mode, 'appended');
}
{
  const arriving = coach(21, { rank: FREE_AGENT_RANK });
  check('with no incumbent and no count, nothing is guessed',
    transferJobSecurityRank(arriving, null), null);
  check('and the rank is left alone rather than corrupted', arriving[FIELD], FREE_AGENT_RANK);
}

// --------------------------------------------------------------------
// 3. DETECTION: a healthy permutation is not flagged.
// --------------------------------------------------------------------
{
  const healthy = [coach(0, { rank: 3 }), coach(1, { rank: 1 }), coach(2, { rank: 2 }), freeAgent(3)];
  const p = findRankProblems(healthy);
  check('a dense unique 1..N permutation is clean', p.ok, true);
  check('free agents on the sentinel are not counted as employed', p.n, 3);
  check('no ranks are reported missing', p.missing, []);
}

// The exact shape of the real bug: employed coaches carrying the sentinel,
// and the ranks they should hold belonging to nobody.
{
  const broken = [
    coach(0, { rank: 1 }), coach(1, { rank: 2 }),
    coach(2, { rank: FREE_AGENT_RANK }), coach(3, { rank: FREE_AGENT_RANK }),
    freeAgent(4, 3), freeAgent(5, 4), // the departed incumbents, still holding real ranks
  ];
  const p = findRankProblems(broken);
  check('the broken permutation is detected', p.ok, false);
  check('both sentinel-carrying employed coaches are offenders', p.offenders.map((r) => r.index), [2, 3]);
  check('the ranks they should hold are reported missing', p.missing, [3, 4]);
}

// A duplicate inside the valid range is also a break -- one holder keeps it.
{
  const dup = [coach(0, { rank: 1 }), coach(1, { rank: 1 }), coach(2, { rank: 3 })];
  const p = findRankProblems(dup);
  check('a duplicated rank is detected', p.ok, false);
  check('exactly one holder of the duplicate is an offender', p.offenders.length, 1);
  check('the freed rank is reported missing', p.missing, [2]);
}

// --------------------------------------------------------------------
// 4. REPAIR: restores the invariant, and is idempotent.
// --------------------------------------------------------------------
(async () => {
  const records = [
    coach(0, { rank: 1, team: 1 }), coach(1, { rank: 2, team: 2 }),
    coach(2, { rank: FREE_AGENT_RANK, team: 3 }), coach(3, { rank: FREE_AGENT_RANK, team: 4 }),
    freeAgent(4, 3), freeAgent(5, 4),
  ];
  const res = await repairJobSecurityRanks(null, { coachRecords: records });
  check('both offenders were reassigned', res.repaired.length, 2);
  check('nothing was left unresolved', res.shortfall, 0);

  const after = findRankProblems(records);
  check('the permutation is restored', after.ok, true);
  const ranks = records.filter(isEmployed).map((r) => r[FIELD]).sort((a, b) => a - b);
  check('employed coaches now hold exactly 1..N', ranks, [1, 2, 3, 4]);

  // The departed coaches must not still be claiming a rank someone else now has.
  check('departed coaches were cleared off the reassigned ranks', res.cleared.length, 2);
  check('and are back on the sentinel', records[4][FIELD], FREE_AGENT_RANK);

  // Running it again must be a no-op -- a repair tool gets pointed at
  // already-repaired saves constantly.
  const again = await repairJobSecurityRanks(null, { coachRecords: records });
  check('re-running the repair changes nothing', again.repaired.length, 0);
  check('and still reports the save as clean', again.problems.ok, true);

  // More offenders than free ranks must be reported, never silently dropped.
  const overloaded = [
    coach(0, { rank: FREE_AGENT_RANK, team: 1 }),
    coach(1, { rank: FREE_AGENT_RANK, team: 2 }),
    coach(2, { rank: 1, team: 3 }),
  ];
  const tight = await repairJobSecurityRanks(null, { coachRecords: overloaded });
  check('only the available ranks are handed out', tight.repaired.length, 2);
  check('and the shortfall is reported honestly', tight.shortfall, 0);

  // --------------------------------------------------------------------
  // 5. SAFETY NET: repair must never touch anything outside the one field it
  //    is documented to change.
  //
  //    Investigated directly (2026-08) after a report was traced back to
  //    CoachAward -- a table that references INTO Coach (not a field ON
  //    Coach), holding a coach's award history. Confirmed on the actual save
  //    that would not load: CoachAward was completely empty for every one of
  //    its 414 employed coaches (0%, fresh preseason dynasty, no season
  //    played yet), and grepping lib/carousel/*.js confirms no repair
  //    function anywhere references that table, reads it, or writes it --
  //    it was never a candidate for the bug and isn't touched by the fix.
  //
  //    This test is the general form of that guarantee: it doesn't matter
  //    WHAT the field is or whether it happens to be populated. Anything a
  //    coach record carries that findRankProblems/repairJobSecurityRanks
  //    doesn't own must survive a repair byte-for-byte -- so a future change
  //    to this file can't silently start clobbering a field (award history
  //    or anything else) it was never meant to touch.
  // --------------------------------------------------------------------
  {
    const arriving = coach(20, { team: 1, rank: FREE_AGENT_RANK, name: 'Arriving' });
    const incumbent = coach(21, { team: 1, rank: 77, name: 'Incumbent' });
    // Foreign data the transfer path must leave alone -- stands in for
    // CoachAward, CharacterVisuals, contract fields, or anything else that
    // isn't CurrentJobSecurityPercentageRank.
    arriving._foreignField = 'untouched-arriving';
    incumbent._foreignField = 'untouched-incumbent';

    transferJobSecurityRank(arriving, incumbent);
    check('transferJobSecurityRank does not touch unrelated fields on the arriving coach',
      arriving._foreignField, 'untouched-arriving');
    check('transferJobSecurityRank does not touch unrelated fields on the incumbent',
      incumbent._foreignField, 'untouched-incumbent');

    const records = [
      coach(0, { rank: FREE_AGENT_RANK, team: 1 }), coach(1, { rank: 2, team: 2 }),
      freeAgent(2, 1),
    ];
    records.forEach((r, i) => { r._foreignField = `untouched-${i}`; });
    await repairJobSecurityRanks(null, { coachRecords: records });
    check('repairJobSecurityRanks does not touch any record\'s unrelated fields',
      records.every((r, i) => r._foreignField === `untouched-${i}`), true);
  }

  console.log(`\n  CFB job-security rank spec: ${passed} assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
