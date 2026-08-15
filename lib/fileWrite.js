'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Writes a file to a destination that may not tolerate a normal write.
//
// THE PROBLEM, from the field. Exporting a draft class into
//   C:\Users\<user>\OneDrive\Documents\Madden NFL 27\saves\
// failed with "EBADF: bad file descriptor, write", while the identical export
// to the Desktop succeeded, and dragging that same file into the same folder
// in Explorer also succeeded. It failed for a brand-new filename as well as an
// existing one, so it is the FOLDER rejecting our write, not a clash with a
// file already there.
//
// EBADF on the WRITE (not the open) means the handle was valid and then became
// invalid: ERROR_INVALID_HANDLE. That is a filter driver -- OneDrive's -- tearing
// our handle out from under us partway through, which it can do when it decides
// to hydrate or take ownership of a file in a synced folder.
//
// THE FIX is to stop holding a handle across that. `fs.writeFileSync` opens the
// destination itself and streams into it, giving the driver a window to
// invalidate. `fs.copyFileSync` instead calls CopyFileW -- the same Win32 API
// Explorer's drag-and-drop uses, and which demonstrably works on the machine
// that reported this. So: build the file somewhere plainly local, then hand the
// whole finished thing to the OS to place.
//
// The direct write is still tried FIRST, because it is one syscall on a normal
// folder and staging is pure overhead there. Only the specific "the target got
// in our way" errors fall through to staging; a genuine out-of-space or
// permission failure is re-thrown untouched rather than retried pointlessly.
const STAGE_WORTHY = new Set([
  'EBADF',  // handle revoked mid-write -- the reported one
  'EIO',    // same family: the write was aborted by something below us
  'EBUSY',  // something else holds the target open
  'EPERM',  // sometimes what a cloud/AV filter returns instead of EBADF
]);

// Where a failed staging attempt leaves the finished file, so the caller can
// tell the user "it is built, it is here, move it yourself" rather than losing
// several seconds of work to an error message.
class StagedWriteError extends Error {
  constructor(message, { code, stagedPath, destPath }) {
    super(message);
    this.name = 'StagedWriteError';
    this.code = code;
    this.stagedPath = stagedPath;
    this.destPath = destPath;
  }
}

// Returns { path, staged } -- `staged` true when the fallback was used, which
// callers may want to log (it means the destination is misbehaving even though
// the export worked).
function writeFileSafely(destPath, buffer, { log = () => {} } = {}) {
  try {
    fs.writeFileSync(destPath, buffer);
    return { path: destPath, staged: false };
  } catch (direct) {
    if (!STAGE_WORTHY.has(direct.code)) throw direct;
    log(`  direct write failed (${direct.code}) -- staging locally and copying into place`);

    // mkdtemp, not a fixed name: two exports running at once must not fight
    // over the same staging file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-export-'));
    const staged = path.join(tmpDir, path.basename(destPath));
    try {
      fs.writeFileSync(staged, buffer);
    } catch (stageErr) {
      // The temp directory itself failed -- nothing to salvage, and the
      // ORIGINAL error is the more useful one to report.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
      throw direct;
    }

    try {
      fs.copyFileSync(staged, destPath);
    } catch (copyErr) {
      // Deliberately does NOT delete the staging directory: the file is
      // complete and correct, and the user can move it by hand. Throwing away
      // a finished 2.6 MB export to keep the temp folder tidy is the wrong
      // trade.
      throw new StagedWriteError(
        `Could not place the file in ${path.dirname(destPath)}`,
        { code: copyErr.code, stagedPath: staged, destPath },
      );
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* harmless */ }
    return { path: destPath, staged: true };
  }
}

module.exports = { writeFileSafely, StagedWriteError, STAGE_WORTHY };
