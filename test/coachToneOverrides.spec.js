// Regression test for where coach skin-tone overrides are STORED.
//
// The bug this locks down: the Tone Overrides UI wrote straight into the
// shipped data/cfbCoachTones.json. That works from a dev checkout and fails
// for every actual user -- in a packaged build that file lives inside
// app.asar, a read-only archive, so setting a tone died with
//   ENOENT ... open '...\resources\app.asar\data\cfbCoachTones.json'
// Reads from an asar work fine under Electron, so this only ever surfaced on
// WRITE, which is why a dev checkout never showed it.
//
// The fix splits the two roles apart:
//   - data/cfbCoachTones.json  -- shipped, read-only base (comments, scale,
//                                 fallbackDistribution, any shipped overrides)
//   - <userData>/coachToneOverrides.json -- the user's own choices, writable,
//                                 layered on top and winning on conflict
//
// setCfbToneOverridePath is also the injection point test/cfbSkinTone.spec.js
// notes it lacked, so this file can use a real temp dir instead of mutating
// the shipped file. Head names below are obvious fixtures, never real coaches.
//
// Run with: node test/coachToneOverrides.spec.js (or npm test).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  cfbSkinTone, loadCfbTones, clearCfbToneCache,
  setCfbToneOverridePath, setCoachToneOverride, CFB_TONE_PATH,
} = require('../lib/carousel/appearance');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const FAKE_A = 'Unique_C_TestFixtureAlpha_001';
const FAKE_B = 'Unique_C_TestFixtureBravo_002';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tone-'));
// Deliberately NESTED and not pre-created: a first-run userData subdir may not
// exist yet, and the writer has to create it rather than ENOENT all over again.
const userFile = path.join(tmpRoot, 'nested', 'coachToneOverrides.json');
const shippedBefore = fs.readFileSync(CFB_TONE_PATH, 'utf8');

try {
  setCfbToneOverridePath(userFile);

  // --- baseline: no override yet ------------------------------------------
  check('Unique_* head starts with no readable tone', cfbSkinTone(FAKE_A), null);
  check('Generic_* head still parses its tone from the name',
    cfbSkinTone('Generic_0011_C_T0010_H_8_1'), 8);

  // --- writing --------------------------------------------------------------
  setCoachToneOverride(FAKE_A, 6);
  ok('user override file is created, parent dirs and all', fs.existsSync(userFile));
  check('override reads back', cfbSkinTone(FAKE_A), 6);

  // The whole point of the fix: the bundle is never written to.
  check('shipped file is byte-for-byte untouched', fs.readFileSync(CFB_TONE_PATH, 'utf8'), shippedBefore);
  ok('override landed in the user file',
    JSON.parse(fs.readFileSync(userFile, 'utf8')).overrides[FAKE_A] === 6);

  // --- persistence ----------------------------------------------------------
  clearCfbToneCache(); // stand-in for the next app launch
  check('override survives a cold re-read', cfbSkinTone(FAKE_A), 6);

  // --- the shipped base still loads alongside user data ---------------------
  const { distribution } = loadCfbTones();
  ok('fallback distribution still comes from the shipped file',
    Array.isArray(distribution) && distribution.length === 8);

  // --- clearing one entry ---------------------------------------------------
  setCoachToneOverride(FAKE_B, 3);
  setCoachToneOverride(FAKE_A, null);
  check('cleared coach goes back to being guessed', cfbSkinTone(FAKE_A), null);
  check('an unrelated override survives that clear', cfbSkinTone(FAKE_B), 3);

  // --- no writable path configured (plain node: tests, probes) --------------
  // Must refuse loudly rather than falling back to the read-only bundle.
  setCfbToneOverridePath(null);
  assert.throws(() => setCoachToneOverride(FAKE_B, 2), /writable tone path/i);
  passed++;
  check('reads still work with no user path', cfbSkinTone('Generic_0011_C_T0010_H_8_1'), 8);
  check('shipped file STILL untouched after a refused write',
    fs.readFileSync(CFB_TONE_PATH, 'utf8'), shippedBefore);
} finally {
  // Never leave global module state or a temp dir behind for the next spec.
  setCfbToneOverridePath(null);
  clearCfbToneCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  Coach tone override storage spec: ${passed} assertions passed.\n`);
