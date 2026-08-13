// Regression test for lib/customPlayers.js -- user-added players.
// Run with: node test/customPlayers.spec.js (or npm test).
//
// Fixture-based: builds a synthetic pool with a known shape rather than
// reading a real save, so the assertions pin behaviour rather than whatever
// one dynasty happens to contain.

const assert = require('assert');
const {
  POSITIONS, MIN_OVERALL, MAX_OVERALL, MAX_NAME, SHIFT_FLOOR,
  isRatingField, normalizeCustomPlayer, pickDonor, buildCustomRow, withCustomPlayers,
} = require('../lib/customPlayers');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }
function throws(label, fn, re) {
  assert.throws(fn, re, label);
  passed++;
}

// A pool row carries bio fields, ~n rating fields, and some non-rating extras.
function poolRow(first, last, pos, ovr, extra = {}) {
  return {
    FirstName: first, LastName: last, Position: pos, OverallRating: ovr,
    Height: 74, Weight: 210, Age: 21, JerseyNum: 7,
    CharacterBodyType: 'Standard', PlayerType: 'ScrambleQB',
    PLYR_GENERICHEAD: 'gen_3_head', FormerTeam: 'Testeru',
    AwardsScore: 5, CareerStats: { games: 30, passYds: 4000 },
    rowIndex: 100,
    SpeedRating: 80, AwarenessRating: 70, StrengthRating: 60,
    ThrowPowerRating: 90, CatchingRating: 45, KickPowerRating: 20,
    ...extra,
  };
}

const POOL = [
  poolRow('Real', 'Quarterback', 'QB', 80, { rowIndex: 1 }),
  poolRow('Other', 'Quarterback', 'QB', 90, { rowIndex: 2 }),
  poolRow('Some', 'Halfback', 'HB', 75, { rowIndex: 3 }),
];

// 1. Field classification matches lib/saveIO.js's own ratingFields rule.
{
  ok('SpeedRating is a rating field', isRatingField('SpeedRating'));
  ok('AwarenessRating is a rating field', isRatingField('AwarenessRating'));
  ok('OverallRating is NOT a rating field -- it is the target, not a shape input',
    !isRatingField('OverallRating'));
  ok('Height is not a rating field', !isRatingField('Height'));
  ok('CareerStats is not a rating field', !isRatingField('CareerStats'));
}

// 2. Validation. Each branch names the offending field, because these are
//    typed by hand into a form.
{
  check('a good spec normalizes',
    normalizeCustomPlayer({ firstName: ' Chance ', lastName: ' Wrapper ', position: 'qb', overall: '81' }),
    { firstName: 'Chance', lastName: 'Wrapper', position: 'QB', overall: 81 });

  check('a fractional overall rounds',
    normalizeCustomPlayer({ firstName: 'A', lastName: 'B', position: 'WR', overall: 80.6 }).overall, 81);

  throws('missing first name is rejected',
    () => normalizeCustomPlayer({ lastName: 'B', position: 'QB', overall: 80 }), /first name/i);
  throws('missing last name is rejected',
    () => normalizeCustomPlayer({ firstName: 'A', position: 'QB', overall: 80 }), /last name/i);
  throws('whitespace-only name is rejected',
    () => normalizeCustomPlayer({ firstName: '   ', lastName: 'B', position: 'QB', overall: 80 }), /first name/i);
  throws('an unknown position is rejected and lists the valid ones',
    () => normalizeCustomPlayer({ firstName: 'A', lastName: 'B', position: 'RB', overall: 80 }), /unknown position/i);
  throws('an over-range overall is rejected',
    () => normalizeCustomPlayer({ firstName: 'A', lastName: 'B', position: 'QB', overall: 120 }), /between/i);
  throws('a non-numeric overall is rejected',
    () => normalizeCustomPlayer({ firstName: 'A', lastName: 'B', position: 'QB', overall: 'elite' }), /between/i);
  throws('an absurdly long name is rejected',
    () => normalizeCustomPlayer({ firstName: 'x'.repeat(MAX_NAME + 1), lastName: 'B', position: 'QB', overall: 80 }),
    /longer than/i);

  ok('every position in POSITIONS is accepted', POSITIONS.every((p) => {
    try { normalizeCustomPlayer({ firstName: 'A', lastName: 'B', position: p, overall: 70 }); return true; }
    catch (e) { return false; }
  }));
  ok('the range constants are sane', MIN_OVERALL === 1 && MAX_OVERALL === 99);
}

// 3. Donor selection: same position, closest overall, deterministic.
{
  check('picks the closest same-position donor (80 target -> the 80)',
    pickDonor(POOL, 'QB', 80).rowIndex, 1);
  check('picks the closest same-position donor (95 target -> the 90)',
    pickDonor(POOL, 'QB', 95).rowIndex, 2);
  check('never crosses positions', pickDonor(POOL, 'HB', 99).rowIndex, 3);
  check('returns null when the position is absent from the pool',
    pickDonor(POOL, 'LS', 70), null);

  // Determinism: a tie must not depend on pool order, or a seeded run would
  // stop being reproducible the moment extraction ordering changed.
  //
  // Both rows share an overall AND a rowIndex, so NAME is the only thing that
  // can separate them. That matters: an earlier version of this test gave them
  // different rowIndexes, which left rowIndex as a working tie-break and let
  // the test pass even with the name comparison deleted. Verified by sabotage
  // -- removing the name tie-break now fails this block.
  const tie = [
    poolRow('Bbb', 'Zzz', 'WR', 70, { rowIndex: 10 }),
    poolRow('Aaa', 'Yyy', 'WR', 70, { rowIndex: 10 }),
  ];
  const forward = pickDonor(tie, 'WR', 70);
  const reversed = pickDonor([...tie].reverse(), 'WR', 70);
  check('a tie breaks the same way regardless of pool order', forward.FirstName, reversed.FirstName);
  check('...and breaks toward the alphabetically first name, not array position',
    forward.FirstName, 'Aaa');
}

// 4. Row construction.
{
  const row = buildCustomRow({ firstName: 'Chance', lastName: 'Wrapper', position: 'QB', overall: 90 }, POOL);

  check('the requested identity is written',
    [row.FirstName, row.LastName, row.Position, row.OverallRating],
    ['Chance', 'Wrapper', 'QB', 90]);
  ok('the row is flagged as custom', row.IsCustomPlayer === true);
  ok('the donor is recorded for the UI', /Quarterback/.test(row.CustomDonor));
  ok('rowIndex is namespaced so it can never collide with a real save row',
    typeof row.rowIndex === 'string' && row.rowIndex.startsWith('custom:'));

  // Bio comes from the donor, so the row is complete without inventing values.
  ok('bio fields are inherited from the donor',
    row.Height === 74 && row.Weight === 210 && row.CharacterBodyType === 'Standard'
    && row.PlayerType === 'ScrambleQB' && row.PLYR_GENERICHEAD === 'gen_3_head');

  // Exact-overall match: donor is the 90 QB, so delta is 0 and NOTHING shifts.
  ok('an exact-overall match leaves every rating untouched',
    row.SpeedRating === 80 && row.AwarenessRating === 70 && row.ThrowPowerRating === 90);

  // The donor row itself must not be mutated -- it is a live pool member.
  check('the donor row is not modified', POOL[1].OverallRating, 90);
  check('the donor keeps its own name', POOL[1].FirstName, 'Other');
}

// 5. The rating shift, and the sub-50 floor that bounds it.
{
  // Target 100 is out of range; use 99 against the 90 donor -> delta +9.
  const up = buildCustomRow({ firstName: 'A', lastName: 'B', position: 'QB', overall: 99 }, POOL);
  check('ratings at/above the floor shift by the overall delta (80 + 9)', up.SpeedRating, 89);
  check('a shifted rating clamps at 99 rather than overflowing', up.ThrowPowerRating, 99);
  check('a sub-50 rating is NOT shifted -- it carries no signal about how good the player is',
    up.CatchingRating, 45);
  check('a far-below-floor rating is likewise untouched', up.KickPowerRating, 20);
  ok('the floor is the same one diceRoll.js uses', SHIFT_FLOOR === 50);

  const down = buildCustomRow({ firstName: 'A', lastName: 'B', position: 'QB', overall: 70 }, POOL);
  // Closest donor to 70 is the 80 QB -> delta -10.
  check('a downward shift applies too', down.SpeedRating, 70);
  check('a downward shift also respects the floor', down.CatchingRating, 45);
  check('a downward shift clamps at 1, never zero or negative',
    buildCustomRow({ firstName: 'A', lastName: 'B', position: 'QB', overall: 1 },
      [poolRow('D', 'Onor', 'QB', 99, { SpeedRating: 50 })]).SpeedRating, 1);
}

// 6. A position with no donor is a clear refusal, not a silent bad row.
{
  throws('no donor at that position refuses by name and says why',
    () => buildCustomRow({ firstName: 'Long', lastName: 'Snapper', position: 'LS', overall: 70 }, POOL),
    /No LS in this dynasty/);
}

// 7. withCustomPlayers -- the property main.js depends on.
{
  const specs = [{ firstName: 'A', lastName: 'One', position: 'QB', overall: 85 }];
  const out = withCustomPlayers(POOL, specs);
  check('the custom player is appended', out.length, POOL.length + 1);
  check('the source pool is NOT mutated', POOL.length, 3);

  // This is the one that matters: main.js caches the pool and generates from
  // it repeatedly. In-place appending would stack a duplicate every run.
  const again = withCustomPlayers(POOL, specs);
  check('calling twice does not stack duplicates onto the cached pool', again.length, POOL.length + 1);
  check('...and the source pool is still untouched after two calls', POOL.length, 3);

  check('an empty list returns the pool unchanged', withCustomPlayers(POOL, []).length, 3);
  check('a null list returns the pool unchanged', withCustomPlayers(POOL, null).length, 3);
  check('nulls inside the list are skipped',
    withCustomPlayers(POOL, [null, specs[0], undefined]).length, 4);

  // Rosetta tags lifecycle metadata onto the pool ARRAY as own properties.
  // A bare concat drops them, and callers read pool.source.
  const tagged = [...POOL];
  tagged.source = 'leaving';
  tagged.populationMode = 'exit';
  const kept = withCustomPlayers(tagged, specs);
  check('array-level pool metadata survives (source)', kept.source, 'leaving');
  check('array-level pool metadata survives (populationMode)', kept.populationMode, 'exit');

  // Several at once get distinct identities.
  const many = withCustomPlayers(POOL, [
    { firstName: 'A', lastName: 'One', position: 'QB', overall: 85 },
    { firstName: 'B', lastName: 'Two', position: 'HB', overall: 75 },
  ]);
  const idx = many.filter((r) => r.IsCustomPlayer).map((r) => r.rowIndex);
  check('each custom player gets a distinct rowIndex', new Set(idx).size, 2);

  // A bad spec anywhere in the list fails the whole batch loudly rather than
  // silently dropping one player from the class.
  throws('one bad spec fails the batch instead of being skipped',
    () => withCustomPlayers(POOL, [specs[0], { firstName: 'x', lastName: 'y', position: 'NOPE', overall: 70 }]),
    /unknown position/i);
}

console.log(`\n  Custom players spec: ${passed} assertions passed.`);
