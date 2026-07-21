// Regression test for lib/draftBoard.js -- draft-board organization.
// Run with: node test/draftBoard.spec.js (or npm test).
//
// Uses a SYNTHETIC pool so the suite runs anywhere without a CFB save. The
// invariants locked here are the ones that make the feature safe:
//   - the default strategy never reorders anything (byte-identical behavior)
//   - NO strategy may change class membership (roadmap Decision 1)
//   - sliding is one-directional: a player falling must never catapult someone
//     from deep in the class up into the top of round 1 (that's the failure
//     mode of the random-swap approach this engine deliberately rejects)
//   - identical inputs reproduce identically (seeded, no Math.random)

const assert = require('assert');
const { organizeBoard, talentScoreOf, drawFall, PICKS_PER_ROUND, DRAFTED_PICKS } = require('../lib/draftBoard');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

// Deterministic PRNG so the spec never depends on Math.random.
const mulberry = (seed) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const POSITIONS = ['QB', 'HB', 'WR', 'TE', 'LT', 'DT', 'CB', 'FS'];
function makePool(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      FirstName: `First${i}`, LastName: `Last${i}`,
      Position: POSITIONS[i % POSITIONS.length],
      // descending overall so index order == talent order by construction
      OverallRating: 99 - Math.floor(i / 5),
      AwardsScore: 0,
      _prodScore: 50,
      _athScore: 50,
    });
  }
  return out;
}
const key = (p) => `${p.FirstName}|${p.LastName}`;
const cfgWith = (draftBoard) => ({ draftBoard, draftValue: {}, positionValue: {} });

// 1. Default strategy is a pure pass-through: order preserved exactly.
{
  const pool = makePool(402);
  const before = pool.map(key);
  const out = organizeBoard(pool, cfgWith({ organization: 'cfbProjected' }), mulberry(1));
  check('default preserves length', out.length, 402);
  check('default preserves order', out.map(key).join(), before.join());
  // an unknown/missing mode must fall back to the default, never throw
  const fallback = organizeBoard(makePool(402), cfgWith({ organization: 'nope' }), mulberry(1));
  check('unknown mode falls back to pass-through', fallback.map(key).join(), before.join());
  const noCfg = organizeBoard(makePool(402), { draftValue: {}, positionValue: {} }, mulberry(1));
  check('missing draftBoard config falls back', noCfg.map(key).join(), before.join());
}

// 2. Round/pick stamping: 7 x 32 drafted, remainder is the UDFA tail.
{
  const out = organizeBoard(makePool(402), cfgWith({ organization: 'cfbProjected' }), mulberry(2));
  check('first pick is Rd1 P1', `${out[0]._round}-${out[0]._pick}`, '1-1');
  check('pick 32 is Rd1 P32', `${out[31]._round}-${out[31]._pick}`, '1-32');
  check('pick 33 is Rd2 P1', `${out[32]._round}-${out[32]._pick}`, '2-1');
  check('last drafted pick is Rd7 P32', `${out[DRAFTED_PICKS - 1]._round}-${out[DRAFTED_PICKS - 1]._pick}`, '7-32');
  check('past 224 has no round', out[DRAFTED_PICKS]._round, null);
  check('past 224 has no pick', out[DRAFTED_PICKS]._pick, null);
  check('ranks are 1-based and dense', out.every((r, i) => r._rank === i + 1), true);
}

// 3. Membership is invariant across every strategy and chaos level.
{
  const expected = makePool(402).map(key).sort().join();
  for (const chaos of [0, 25, 50, 100]) {
    const out = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos }), mulberry(3));
    check(`membership unchanged at chaos ${chaos}`, out.map(key).sort().join(), expected);
    check(`no duplicates at chaos ${chaos}`, new Set(out.map(key)).size, 402);
  }
}

// 4. chaos 0 == pure talent order (no displacement at all).
{
  const a = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos: 0 }), mulberry(4));
  const b = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos: 0 }), mulberry(999));
  check('chaos 0 ignores the rng entirely', a.map(key).join(), b.map(key).join());
  // pool is built strictly descending by overall, so talent order == input order
  check('chaos 0 is talent-descending', a.map(key).join(), makePool(402).map(key).join());
}

// 5. One-directional: nobody is catapulted up from deep in the class.
//    This is THE property that separates displacement from random swaps.
{
  const pool = makePool(402);
  const startRank = new Map(pool.map((p, i) => [key(p), i + 1]));
  for (const chaos of [50, 100]) {
    const out = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos }), mulberry(5));
    let biggestRise = 0;
    out.forEach((p, i) => {
      const rise = startRank.get(key(p)) - (i + 1);
      if (rise > biggestRise) biggestRise = rise;
    });
    // A rise only happens because players ahead of you fell past you, so it is
    // bounded by how many fell -- never a single dramatic jump. A random swap
    // could move someone 300+ slots; this must stay far below that.
    ok(`chaos ${chaos}: biggest rise (${biggestRise}) stays modest`, biggestRise < 150);
    // and nobody from the bottom third should ever reach round 1
    const bottomThirdInRd1 = out.slice(0, PICKS_PER_ROUND)
      .filter((p) => startRank.get(key(p)) > 268).length;
    check(`chaos ${chaos}: no bottom-third player reaches Rd1`, bottomThirdInRd1, 0);
  }
}

// 6. Determinism: same pool + same seed + same settings -> same board.
{
  const a = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos: 60 }), mulberry(6));
  const b = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos: 60 }), mulberry(6));
  check('reproducible under the same seed', a.map(key).join(), b.map(key).join());
  const c = organizeBoard(makePool(402), cfgWith({ organization: 'realisticDraftDay', chaos: 60 }), mulberry(7));
  ok('a different seed gives a different board', c.map(key).join() !== a.map(key).join());
}

// 7. talentScoreOf excludes CFB's projected round (the whole point of the
//    engine being independent -- see DRAFTBOARD_ROADMAP.md 1e).
{
  const cfg = { draftValue: {}, positionValue: {} };
  const base = { Position: 'QB', OverallRating: 80, AwardsScore: 0, _prodScore: 50, _athScore: 50 };
  const withRound = { ...base, ProjectRound: 1 };
  const withoutRound = { ...base, ProjectRound: 7 };
  check('talent score ignores ProjectRound', talentScoreOf(withRound, cfg), talentScoreOf(withoutRound, cfg));
  const generational = { ...base, _generational: true };
  ok('generational still outranks an identical non-generational', talentScoreOf(generational, cfg) > talentScoreOf(base, cfg));
}

// 8. drawFall is always downward and scales with chaos.
{
  const rng = mulberry(8);
  let allNonNegative = true;
  for (let i = 0; i < 2000; i++) if (drawFall(rng, 50) < 0) allNonNegative = false;
  ok('drawFall never returns a negative (upward) displacement', allNonNegative);
  const avg = (chaos) => {
    const r = mulberry(11); let s = 0;
    for (let i = 0; i < 4000; i++) s += drawFall(r, chaos);
    return s / 4000;
  };
  check('chaos 0 produces no movement', avg(0), 0);
  ok('higher chaos falls further on average', avg(100) > avg(50) && avg(50) > avg(10));
}

console.log(`\n  Draft-board spec: ${passed} assertions passed.`);
