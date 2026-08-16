// Regression test for lib/pipeline.js's fillMissingSkinTones -- the
// dynasty-relative fallback for players whose skin tone can't be read from
// their CFB record at all (scanned Unique_* heads carry no tone digit
// anywhere).
//
// Written after a real 2032 save where 69% of a generated 402-player class
// had no recoverable tone. The old behaviour (an unset numeric tone defaults
// to bucket 1 downstream, in appearanceCatalog.js's poolForTone) meant almost
// three quarters of that class came out skin tone 1 regardless of who the
// players actually were. Run: node test/skinTone.spec.js (or npm test).

const assert = require('assert');
const { fillMissingSkinTones } = require('../lib/pipeline');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

const row = (key, tone) => ({ _playerKey: key, SkinTone: tone });

// 1. Rows that already have a tone are never touched.
{
  const rows = [row('a', 3), row('b', 7)];
  fillMissingSkinTones(rows);
  check('known tones are left exactly as they were', rows.map((r) => r.SkinTone), [3, 7]);
}

// 2. A missing tone is filled from SOMETHING known, not left blank and not
//    silently defaulted to a fixed value.
{
  const rows = [row('a', 5), row('b', '')];
  fillMissingSkinTones(rows);
  ok('the blank one now has a tone', typeof rows[1].SkinTone === 'number');
  ok('...one that is actually a valid skin tone (1-8)', rows[1].SkinTone >= 1 && rows[1].SkinTone <= 8);
}

// 3. THE REGRESSION THIS EXISTS TO CATCH. With every known tone the SAME
//    value, a fallback that ignores the distribution and defaults to bucket 1
//    would happen to pass this by coincidence if that value were 1 -- so the
//    known tone here is deliberately NOT 1, and every filled-in row must
//    match it exactly, not fall back to the old hardcoded default.
{
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(row(`known${i}`, 6));
  for (let i = 0; i < 20; i++) rows.push(row(`unknown${i}`, ''));
  fillMissingSkinTones(rows);
  const filled = rows.slice(5);
  check('every filled row matches the ONLY tone this dynasty actually has',
    filled.map((r) => r.SkinTone), new Array(20).fill(6));
}

// 4. A real spread of known tones must actually reach the fallback -- not
//    collapse onto whichever tone happens to be numerically first/last, and
//    not reproduce the old "always tone 1" bug by coincidence.
{
  const rows = [];
  // 8 known players, evenly spread across every tone EXCEPT 1.
  for (const t of [2, 3, 4, 5, 6, 7, 8, 2]) rows.push(row(`known${t}`, t));
  for (let i = 0; i < 200; i++) rows.push(row(`unknown${i}`, ''));
  fillMissingSkinTones(rows);
  const filled = rows.slice(8).map((r) => r.SkinTone);
  ok('none of the 200 filled rows landed on tone 1 (not present in the known set)',
    filled.every((t) => t !== 1));
  const distinctUsed = new Set(filled).size;
  ok('the fallback used more than one tone (a real spread, not one collapsed pick)', distinctUsed > 1);
}

// 5. Determinism: the SAME rows filled twice (fresh row objects, same keys)
//    must produce the SAME result -- this runs once per save-load and is
//    cached with the pool, so it must not silently change on every call.
{
  const build = () => {
    const rows = [];
    for (const t of [2, 4, 6, 8]) rows.push(row(`k${t}`, t));
    for (let i = 0; i < 30; i++) rows.push(row(`u${i}`, ''));
    return rows;
  };
  const a = build(); fillMissingSkinTones(a);
  const b = build(); fillMissingSkinTones(b);
  check('identical player keys produce identical fills, run to run',
    a.map((r) => r.SkinTone), b.map((r) => r.SkinTone));
}

// 6. Different players (different _playerKey) must not all collapse onto the
//    same pick just because they were processed in the same batch -- each
//    player's fallback is independent, not one shared roll for the group.
{
  const rows = [row('k2', 2), row('k4', 4), row('k6', 6), row('k8', 8)];
  for (let i = 0; i < 40; i++) rows.push(row(`indep${i}`, ''));
  fillMissingSkinTones(rows);
  const filled = rows.slice(4).map((r) => r.SkinTone);
  ok('the 40 fills are not all identical to each other', new Set(filled).size > 1);
}

// 7. No known tones anywhere: nothing to learn a distribution from, so blanks
//    are left as '' rather than inventing a number from nothing.
{
  const rows = [row('a', ''), row('b', null), row('c', '')];
  fillMissingSkinTones(rows);
  check('with no signal at all, rows are left untouched', rows.map((r) => r.SkinTone), ['', null, '']);
}

// 8. null and '' are both treated as "missing" the same way (a real row can
//    carry either depending on which code path produced it).
{
  const rows = [row('k', 4), row('a', null), row('b', '')];
  fillMissingSkinTones(rows);
  ok('null is filled', typeof rows[1].SkinTone === 'number');
  ok('empty string is filled', typeof rows[2].SkinTone === 'number');
}

// 9. A single known player is a valid (degenerate) distribution -- every
//    unknown row must get exactly that one tone, not throw.
{
  const rows = [row('only', 3), row('u1', ''), row('u2', '')];
  let threw = false;
  try { fillMissingSkinTones(rows); } catch (e) { threw = true; }
  ok('a single-value distribution does not throw', !threw);
  check('...and fills with the only value available', [rows[1].SkinTone, rows[2].SkinTone], [3, 3]);
}

console.log(`\n  Skin-tone fallback spec: ${passed} assertions passed.`);
