// Regression test for tools/convertDraftClass.js's resolveOutputPath -- where
// a user-typed output name actually lands.
//
// THE BUG THIS PINS. Before this existed, a typed answer with no directory in
// it (just a plain name, e.g. "MyCoolClass") was passed straight through as
// the output path. Node then resolved that RELATIVE PATH against the
// process's CURRENT WORKING DIRECTORY -- which, launched via the Desktop
// shortcut, is the project folder itself -- rather than the sensible default
// directory the prompt had just shown (the target game's own Saves folder).
// Confirmed live: typing "MyCoolClass" wrote the file into the app's own
// source tree, not anywhere Madden would ever look for it.
//
// Run with: node test/convertDraftClass.spec.js (or npm test).

const assert = require('assert');
const path = require('path');
const { resolveOutputPath, cleanDroppedPath } = require('../tools/convertDraftClass');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

const DEFAULT = path.join('C:', 'Users', 'x', 'Documents', 'Madden NFL 27', 'Saves', 'CAREERDRAFT-Foo-M27');

// ---------------------------------------------------------------------
// 1. A bare name -- no path separator at all -- keeps the DEFAULT's
//    directory. This is the exact case that was broken.
// ---------------------------------------------------------------------
check('a bare name lands in the default directory, not CWD',
  resolveOutputPath('MyCoolClass', DEFAULT),
  path.join(path.dirname(DEFAULT), 'MyCoolClass'));

check('a bare name with spaces still lands in the default directory',
  resolveOutputPath('My Cool Class 2027', DEFAULT),
  path.join(path.dirname(DEFAULT), 'My Cool Class 2027'));

// ---------------------------------------------------------------------
// 2. Anything with an actual directory component is respected exactly as
//    typed -- an explicit path is explicit intent, absolute or relative.
// ---------------------------------------------------------------------
check('an absolute path is used verbatim',
  resolveOutputPath('C:/Users/x/Desktop/MyClass', DEFAULT), 'C:/Users/x/Desktop/MyClass');

check('a relative path with a subdirectory is used verbatim',
  resolveOutputPath('sub/MyClass', DEFAULT), 'sub/MyClass');

check('explicit parent-directory navigation is used verbatim',
  resolveOutputPath('../MyClass', DEFAULT), '../MyClass');

// ---------------------------------------------------------------------
// 3. Nothing typed (Enter pressed at the prompt) falls through to the
//    default UNCHANGED -- not joined with itself.
// ---------------------------------------------------------------------
check('empty string falls back to the default as-is', resolveOutputPath('', DEFAULT), DEFAULT);
check('null falls back to the default as-is', resolveOutputPath(null, DEFAULT), DEFAULT);
check('undefined falls back to the default as-is', resolveOutputPath(undefined, DEFAULT), DEFAULT);

// ---------------------------------------------------------------------
// 4. Drag-and-drop path cleanup. The tool asks the user to drag their file
//    into the window, and terminals do NOT hand that over as a bare path:
//    Windows wraps it in double quotes when it contains spaces, PowerShell
//    uses single quotes in some cases, and both leave a trailing space
//    behind after the drop. Left unhandled, the quotes become part of the
//    filename and every drag reports "Not found".
// ---------------------------------------------------------------------
check('a plain path is unchanged',
  cleanDroppedPath('C:\\Saves\\CAREERDRAFT-Foo'), 'C:\\Saves\\CAREERDRAFT-Foo');

check('double quotes from a Windows drag are stripped',
  cleanDroppedPath('"C:\\My Saves\\CAREERDRAFT-Foo"'), 'C:\\My Saves\\CAREERDRAFT-Foo');

check('single quotes from a PowerShell drag are stripped',
  cleanDroppedPath("'C:\\My Saves\\CAREERDRAFT-Foo'"), 'C:\\My Saves\\CAREERDRAFT-Foo');

check('the trailing space a drop leaves behind is removed',
  cleanDroppedPath('"C:\\My Saves\\CAREERDRAFT-Foo" '), 'C:\\My Saves\\CAREERDRAFT-Foo');

check('leading whitespace is removed too',
  cleanDroppedPath('   C:\\Saves\\CAREERDRAFT-Foo  '), 'C:\\Saves\\CAREERDRAFT-Foo');

// Spaces INSIDE the path are exactly why terminals quote it -- they must
// survive, or every path under "My Saves" breaks.
check('spaces inside the path are preserved',
  cleanDroppedPath('"C:\\Users\\a b\\My Saves\\CAREERDRAFT-Foo Bar"'),
  'C:\\Users\\a b\\My Saves\\CAREERDRAFT-Foo Bar');

// Only WRAPPING quotes are stripped -- a stray quote mid-path is left alone
// rather than mangling a legitimate (if unusual) filename.
check('a non-wrapping quote is left alone',
  cleanDroppedPath('C:\\Saves\\od"d'), 'C:\\Saves\\od"d');

check('empty input yields empty string', cleanDroppedPath(''), '');
check('null yields empty string', cleanDroppedPath(null), '');
check('undefined yields empty string', cleanDroppedPath(undefined), '');

console.log(`\n  Convert draft-class CLI spec: ${passed} assertions passed.`);
