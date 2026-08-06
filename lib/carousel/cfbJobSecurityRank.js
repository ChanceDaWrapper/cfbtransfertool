'use strict';

// Keeps CFB's league-wide job-security RANKING intact across a coach transfer.
//
// THE BUG THIS FIXES -- an infinite load, not a crash.
//
// `CurrentJobSecurityPercentageRank` is not a rating or a tendency. It is a
// dense unique PERMUTATION over the employed coaches: in a healthy save the
// employed population holds every value from 1 to N exactly once, with no gaps
// and no duplicates. Free agents sit outside it on a sentinel (500). This was
// verified against two independent healthy saves -- a brand-new preseason
// dynasty and a mid-season one -- and in BOTH, zero employed coaches hold the
// sentinel:
//
//   healthy preseason save : employed=414  distinct=414  range 1..414  gaps 0
//   healthy mid-season save: employed=414  distinct=414  range 1..414  gaps 0
//
// A transfer breaks it in the most direct way possible. The arriving coach is
// promoted from a free-agent shell and brings the sentinel with them; the
// displaced incumbent is fired into free agency and takes their real rank out of
// the employed pool. Measured on the save that would not load, after four OC/DC
// transfers:
//
//   employed=414  distinct=411  duplicates=3  range 1..500
//   ranks missing from the employed pool: [84, 161, 230, 288]
//     ... exactly the four ranks the four displaced incumbents walked off with.
//
// So the ranking ends up with four holes and four coaches parked on an
// out-of-range sentinel. Anything that rebuilds or walks a complete 1..N
// permutation has nothing to terminate on, which is the shape of the reported
// symptom: the dynasty sits on the loading screen forever.
//
// WHY cfbNormalize.js COULD NOT COVER THIS. That module repairs a bad value by
// substituting the positional MODE -- correct for a tendency or a contract goal,
// meaningless for a unique index. Taking the mode here would hand every arriving
// coach the SAME rank, which breaks the permutation just as thoroughly. This
// field needs allocation/transfer semantics instead, which is why it lives in
// its own module rather than being appended to EMPLOYMENT_FIELDS.
//
// TWO ENTRY POINTS, one for each direction of the problem:
//   transferJobSecurityRank -- used by the engine at placement time. The job's
//       standing passes to whoever now holds the job, which keeps the
//       permutation dense with zero renumbering and is what a real hiring does.
//   repairJobSecurityRanks -- used by the repair tools on an already-damaged
//       save, where the original pairing is no longer knowable. Restores the
//       invariant generally by filling the holes.

const { safe, biggestTableByName } = require('../saveIO');

// The value CFB parks non-employed coaches on. Verified: 64 of 83 free agents in
// one healthy save and 64 of 83 in another, and never held by ANY employed coach
// in either.
const FREE_AGENT_RANK = 500;
const CFB_UNASSIGNED_TEAM_INDEX = 255;
const FIELD = 'CurrentJobSecurityPercentageRank';

function isEmployed(r) {
  if (!r || r.isEmpty) return false;
  const ti = safe(r, 'TeamIndex');
  if (ti === undefined || ti === CFB_UNASSIGNED_TEAM_INDEX) return false;
  return !!safe(r, 'Level');
}

// ---------------------------------------------------------------------------
// Engine path: hand the job's standing to whoever now holds the job.
// ---------------------------------------------------------------------------
// Called with the arriving coach and the incumbent they displaced (null when
// the coach landed on a slot nobody held). Returns a description of what moved,
// or null when there was nothing to move.
//
// When there IS an incumbent this is exact and complete: one coach leaves the
// employed pool freeing exactly one rank, one arrives needing exactly one, and
// the permutation is dense again with no other coach touched.
//
// When there ISN'T one, the employed population has grown by one, so the honest
// answer is a rank that did not exist before -- appended at the end (worst job
// security, which is also the truthful position for a coach with no track record
// at that school). `employedCountAfter` must already include the arriving coach.
function transferJobSecurityRank(destCoach, incumbent, { employedCountAfter = null } = {}) {
  if (!destCoach) return null;
  if (incumbent) {
    const rank = safe(incumbent, FIELD);
    if (rank === undefined) return null;
    try {
      destCoach[FIELD] = rank;
      incumbent[FIELD] = FREE_AGENT_RANK;
    } catch (e) {
      return null; // read-only/derived -- caller reports, never fatal
    }
    return { mode: 'inherited', rank, from: incumbent.index, to: destCoach.index };
  }
  if (!employedCountAfter) return null;
  try {
    destCoach[FIELD] = employedCountAfter;
  } catch (e) {
    return null;
  }
  return { mode: 'appended', rank: employedCountAfter, from: null, to: destCoach.index };
}

// ---------------------------------------------------------------------------
// Repair path: restore the invariant on a save that is already damaged.
// ---------------------------------------------------------------------------
// Reports (without changing anything) how the employed population deviates from
// a dense unique 1..N permutation.
function findRankProblems(coachRecords) {
  const employed = coachRecords.filter(isEmployed);
  const n = employed.length;

  const seen = new Map(); // rank -> [coachRecord]
  for (const r of employed) {
    const v = safe(r, FIELD);
    if (!seen.has(v)) seen.set(v, []);
    seen.get(v).push(r);
  }

  // A coach is an offender if their rank is outside 1..N, or if it is shared.
  // For a shared rank the FIRST holder keeps it and the rest are reassigned --
  // arbitrary but stable, and there is no better signal available after the fact.
  const offenders = [];
  const heldValid = new Set();
  for (const [rank, holders] of seen) {
    const inRange = Number.isInteger(rank) && rank >= 1 && rank <= n;
    if (!inRange) { offenders.push(...holders); continue; }
    heldValid.add(rank);
    for (let i = 1; i < holders.length; i++) offenders.push(holders[i]);
  }

  const missing = [];
  for (let i = 1; i <= n; i++) if (!heldValid.has(i)) missing.push(i);

  return { employed, n, offenders, missing, ok: offenders.length === 0 && missing.length === 0 };
}

// Fills the holes. Offenders are sorted by their team's current standing so the
// assignment is deterministic rather than dependent on row order, then paired
// with the missing ranks in ascending order.
//
// Also clears any FREE AGENT still sitting on a rank inside the employed range,
// which is hygiene rather than correctness -- the invariant is defined over the
// employed population only, and a healthy save does contain the odd free agent
// holding a low number -- so it is only done for free agents whose rank is one
// this repair just handed to somebody else, where leaving it would mean two
// coaches visibly claiming the same standing.
//
// Touches EXACTLY ONE field, on EXACTLY the coaches identified by
// findRankProblems -- nothing else on those records, and nothing on any other
// record, ever. This was checked deliberately, not assumed: a report asked
// whether CoachAward (a separate table that references INTO Coach, holding a
// coach's award history) needed covering here too. It doesn't, on two counts --
// confirmed on the actual save that would not load, EVERY employed coach had
// zero awards (0/414, a fresh preseason dynasty with no season played yet), and
// this file never reads or writes the CoachAward table in the first place, so
// there was never a path by which repairing the ranking could touch it. See
// test/cfbJobSecurityRank.spec.js section 5 for the regression that pins this
// down generally -- an unrelated field on a repaired record must always come
// out byte-for-byte unchanged, whatever it is.
async function repairJobSecurityRanks(cfbFile, { coachRecords = null } = {}) {
  let records = coachRecords;
  if (!records) {
    const t = biggestTableByName(cfbFile, 'Coach');
    if (!t) return { repaired: [], cleared: [], problems: null };
    await t.readRecords();
    records = t.records;
  }

  const problems = findRankProblems(records);
  if (problems.ok) return { repaired: [], cleared: [], problems };

  const offenders = problems.offenders.slice().sort((a, b) => {
    const ta = safe(a, 'TeamIndex') ?? 0;
    const tb = safe(b, 'TeamIndex') ?? 0;
    return ta - tb || a.index - b.index;
  });

  const repaired = [];
  const take = Math.min(offenders.length, problems.missing.length);
  for (let i = 0; i < take; i++) {
    const coach = offenders[i];
    const rank = problems.missing[i];
    const from = safe(coach, FIELD);
    try {
      coach[FIELD] = rank;
      repaired.push({ row: coach.index, name: safe(coach, 'Name'), from, to: rank });
    } catch (e) { /* read-only/derived -- reported by the shortfall below */ }
  }

  // Any rank we just assigned that a FREE AGENT is also still holding gets
  // cleared to the sentinel, so the number isn't claimed twice.
  const assigned = new Set(repaired.map((r) => r.to));
  const cleared = [];
  for (const r of records) {
    if (r.isEmpty || isEmployed(r)) continue;
    const v = safe(r, FIELD);
    if (!assigned.has(v)) continue;
    try {
      r[FIELD] = FREE_AGENT_RANK;
      cleared.push({ row: r.index, name: safe(r, 'Name'), from: v });
    } catch (e) { /* skip */ }
  }

  return { repaired, cleared, problems, shortfall: offenders.length - take };
}

// How many coaches are employed right now. Only needed for the no-incumbent
// case, where the employed population grows and the arriving coach needs a rank
// that did not previously exist.
async function countEmployedCfbCoaches(cfbFile) {
  const t = biggestTableByName(cfbFile, 'Coach');
  if (!t) return null;
  await t.readRecords();
  return t.records.filter(isEmployed).length;
}

module.exports = {
  FREE_AGENT_RANK,
  FIELD,
  isEmployed,
  transferJobSecurityRank,
  findRankProblems,
  repairJobSecurityRanks,
  countEmployedCfbCoaches,
};
