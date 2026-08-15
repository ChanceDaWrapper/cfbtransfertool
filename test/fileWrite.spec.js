// Regression test for lib/fileWrite.js.
//
// From a field report: exporting a draft class into a OneDrive-backed
//   ...\OneDrive\Documents\Madden NFL 27\saves\
// failed with "EBADF: bad file descriptor, write", while the same export to the
// Desktop worked and dragging the file into that same folder in Explorer also
// worked. It failed for a brand-new filename too, so it was the folder refusing
// our write rather than a clash with an existing file.
//
// EBADF on the WRITE means the handle went invalid mid-operation -- a filter
// driver taking it away. The fix is to stop holding a handle across that:
// stage the file locally, then let the OS place it with CopyFileW, the same
// call Explorer uses.
//
// Run with: node test/fileWrite.spec.js (or npm test).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileSafely, StagedWriteError, STAGE_WORTHY } = require('../lib/fileWrite');

let passed = 0;
function ok(label, cond) { assert.ok(cond, label); passed++; }
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-filewrite-spec-'));
const PAYLOAD = Buffer.alloc(64 * 1024, 7); // stand-in for a draft-class buffer

// Swaps in a fake fs.writeFileSync that fails for the DESTINATION only, the way
// a hostile folder does, while still writing normally everywhere else (the
// staging copy has to succeed for the fallback to mean anything).
function withHostileDestination(destPath, code, run) {
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, data, opts) {
    if (path.resolve(String(file)) === path.resolve(destPath)) {
      const e = new Error(`${code}: ${code.toLowerCase()}, write`);
      e.code = code;
      throw e;
    }
    return realWrite.call(fs, file, data, opts);
  };
  try { return run(); } finally { fs.writeFileSync = realWrite; }
}

// 1. Normal folder: writes directly, no staging, byte-exact.
{
  const dest = path.join(workDir, 'plain-write');
  const res = writeFileSafely(dest, PAYLOAD);
  check('writes directly when the folder is fine', res.staged, false);
  check('...at the requested path', res.path, dest);
  ok('...with the exact bytes', fs.readFileSync(dest).equals(PAYLOAD));
}

// 2. THE REPORTED CASE. A destination that throws EBADF on a direct write must
//    still end up with the correct file, via staging.
{
  const dest = path.join(workDir, 'CAREERDRAFT-EBADF');
  const res = withHostileDestination(dest, 'EBADF', () => writeFileSafely(dest, PAYLOAD));
  check('recovers from EBADF', res.staged, true);
  ok('the file really exists at the destination', fs.existsSync(dest));
  ok('and is byte-identical to what was asked for', fs.readFileSync(dest).equals(PAYLOAD));
}

// 3. The other codes a cloud/AV filter can surface for the same situation.
for (const code of ['EIO', 'EBUSY', 'EPERM']) {
  const dest = path.join(workDir, `staged-${code}`);
  const res = withHostileDestination(dest, code, () => writeFileSafely(dest, PAYLOAD));
  check(`recovers from ${code}`, res.staged, true);
  ok(`${code} lands the right bytes`, fs.readFileSync(dest).equals(PAYLOAD));
}

// 4. Errors that staging cannot help are re-thrown untouched, NOT retried.
//    Re-copying into a full disk or a read-only volume just wastes time and
//    buries the real cause.
for (const code of ['ENOSPC', 'EROFS', 'ENOENT', 'EACCES']) {
  const dest = path.join(workDir, `passthrough-${code}`);
  let thrown = null;
  try {
    withHostileDestination(dest, code, () => writeFileSafely(dest, PAYLOAD));
  } catch (e) { thrown = e; }
  ok(`${code} is re-thrown`, thrown && thrown.code === code);
  ok(`${code} is not a StagedWriteError`, !(thrown instanceof StagedWriteError));
  ok(`${code} left no file behind`, !fs.existsSync(dest));
}
ok('EACCES is deliberately NOT stage-worthy', !STAGE_WORTHY.has('EACCES'));
ok('EBADF is stage-worthy', STAGE_WORTHY.has('EBADF'));

// 5. When even the copy fails, the finished file must be KEPT and its location
//    reported. Throwing away a completed export to tidy a temp folder would be
//    the wrong trade -- the user can move it by hand.
{
  const dest = path.join(workDir, 'nested', 'CAREERDRAFT-COPYFAIL');
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = () => { const e = new Error('EBADF: copy refused'); e.code = 'EBADF'; throw e; };
  let err = null;
  try {
    withHostileDestination(dest, 'EBADF', () => writeFileSafely(dest, PAYLOAD));
  } catch (e) { err = e; } finally { fs.copyFileSync = realCopy; }

  ok('a failed placement raises StagedWriteError', err instanceof StagedWriteError);
  ok('...naming where the finished file is', err && typeof err.stagedPath === 'string');
  ok('...and that file still exists', err && fs.existsSync(err.stagedPath));
  ok('...with the complete, correct bytes', err && fs.readFileSync(err.stagedPath).equals(PAYLOAD));
  ok('...and remembers the intended destination', err && err.destPath === dest);
  try { fs.rmSync(path.dirname(err.stagedPath), { recursive: true, force: true }); } catch (e) { /* cleanup */ }
}

// 6. Staging must not leave litter behind on the happy path.
{
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pipeline-export-')).length;
  const dest = path.join(workDir, 'no-litter');
  withHostileDestination(dest, 'EBADF', () => writeFileSafely(dest, PAYLOAD));
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pipeline-export-')).length;
  check('a successful staging cleans up its temp directory', after, before);
}

// 7. Overwriting an existing file through the fallback must fully replace it,
//    not merge into it -- a shorter class must not leave the old tail behind.
{
  const dest = path.join(workDir, 'CAREERDRAFT-OVERWRITE');
  fs.writeFileSync(dest, Buffer.alloc(256 * 1024, 9)); // bigger, different content
  const res = withHostileDestination(dest, 'EBADF', () => writeFileSafely(dest, PAYLOAD));
  check('overwrite goes through staging too', res.staged, true);
  check('the old file is fully replaced, not appended to', fs.statSync(dest).size, PAYLOAD.length);
  ok('and holds only the new bytes', fs.readFileSync(dest).equals(PAYLOAD));
}

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\n  Safe file-write spec: ${passed} assertions passed.`);
