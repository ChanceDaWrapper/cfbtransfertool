// Regression test for lib/writeErrors.js.
//
// Written after a field report where the export failed with the entire user-
// facing message being "Could not write file: EBADF: bad file descriptor,
// write". That told the user nothing to try and told us almost nothing about
// the cause. Every branch below has to name a real, checkable situation.
//
// Run with: node test/writeErrors.spec.js (or npm test).

const assert = require('assert');
const { describeWriteFailure } = require('../lib/writeErrors');

let passed = 0;
function ok(label, cond) { assert.ok(cond, label); passed++; }

const PATHISH = 'C:\\Users\\someone\\Documents\\Madden NFL 27\\saves\\CAREERDRAFT-TEST';
const err = (code, message) => Object.assign(new Error(message || `${code}: something failed`), { code });

// Every message must name the path, so a screenshot of the error is enough to
// tell where it was writing -- the original report did not include that.
for (const code of ['EBADF', 'EIO', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ENOSPC', 'EROFS', 'EWEIRD']) {
  const msg = describeWriteFailure(err(code), PATHISH);
  ok(`${code} names the path it tried`, msg.includes(PATHISH));
  ok(`${code} keeps the raw code for a bug report`, msg.includes(code));
  ok(`${code} does not lead with a raw errno string`, !/^Could not write file: E[A-Z]+/.test(msg));
}

// EBADF is the reported one. It must point at the cause that actually produces
// it on Windows -- a folder that is not really local -- and give something to
// try, not just a description.
{
  const msg = describeWriteFailure(err('EBADF', 'EBADF: bad file descriptor, write'), PATHISH);
  ok('EBADF mentions OneDrive', /OneDrive/i.test(msg));
  ok('EBADF mentions online-only', /online-only/i.test(msg));
  ok('EBADF mentions network or external drives', /network|external/i.test(msg));
  ok('EBADF suggests closing Madden', /close Madden/i.test(msg));
  ok('EBADF leads with a concrete quick fix', /Quick fix/i.test(msg));
  ok('...naming Desktop as the workaround target', /Desktop/i.test(msg));
  ok('...and moving the file back in manually', /move that file|drag it/i.test(msg));
}

// EIO shares the branch, since it fails the same way for the same reasons.
ok('EIO gets the same guidance as EBADF',
  /OneDrive/i.test(describeWriteFailure(err('EIO'), PATHISH)));

// Permission errors must not send someone chasing OneDrive.
{
  const msg = describeWriteFailure(err('EPERM'), PATHISH);
  ok('EPERM talks about permission', /permission/i.test(msg));
  ok('EPERM mentions the usual culprits', /Program Files|read-only|antivirus|Controlled Folder/i.test(msg));
  ok('EPERM does not mention OneDrive', !/OneDrive/i.test(msg));
}

// A locked file is the one case where "close Madden" is the whole answer.
{
  const msg = describeWriteFailure(err('EBUSY'), PATHISH);
  ok('EBUSY says the file is in use', /in use/i.test(msg));
  ok('EBUSY says to close Madden', /close Madden/i.test(msg));
}

ok('ENOENT points at the missing folder', /folder no longer exists/i.test(describeWriteFailure(err('ENOENT'), PATHISH)));
ok('ENOSPC says the drive is full', /full/i.test(describeWriteFailure(err('ENOSPC'), PATHISH)));
ok('EROFS says read-only drive', /read-only/i.test(describeWriteFailure(err('EROFS'), PATHISH)));

// An unrecognized code must still be reportable rather than swallowed.
{
  const msg = describeWriteFailure(err('ESOMETHINGNEW', 'ESOMETHINGNEW: brand new failure'), PATHISH);
  ok('an unknown code still surfaces its message', msg.includes('brand new failure'));
  ok('an unknown code still names the path', msg.includes(PATHISH));
}

// Must not throw on the degenerate inputs a catch block can actually hand it.
for (const bad of [null, undefined, {}, new Error('no code at all'), 'a string']) {
  let threw = false;
  try { describeWriteFailure(bad, PATHISH); } catch (e) { threw = true; }
  ok(`does not throw on ${JSON.stringify(bad)}`, !threw);
}
// ...including with no path, which is how a caller without one would use it.
ok('works with no path', typeof describeWriteFailure(err('EBADF'), undefined) === 'string');

console.log(`\n  Write-error message spec: ${passed} assertions passed.`);
