// Test runner. Replaces the 39-link `&&` chain that used to live in
// package.json's "test" script.
//
// The chain stopped at the first failing spec, so a change touching shared
// config (which is most changes) showed you one broken spec at a time and hid
// the rest behind it. This runs EVERY spec, then reports all failures together
// and exits non-zero if any failed -- same exit contract, strictly more
// information.
//
// Specs are DISCOVERED from the directory rather than listed here. The old
// hardcoded list had to be hand-edited for every new spec file, and a spec
// that was written but never added to that list would sit in the repo looking
// covered while never running once.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = __dirname;
const specs = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.spec.js'))
  .sort();

if (!specs.length) {
  console.error('No *.spec.js files found in test/ -- that is almost certainly wrong.');
  process.exit(1);
}

const failures = [];
const started = Date.now();

for (const spec of specs) {
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, spec)], {
    stdio: 'inherit',
    // Windows: spawnSync inherits the parent's cwd, which is what the specs
    // expect (they resolve fixtures relative to __dirname, not cwd) -- set it
    // explicitly anyway so `npm test` from a subdirectory behaves the same.
    cwd: path.join(TEST_DIR, '..'),
  });
  if (res.status !== 0) failures.push({ spec, status: res.status, signal: res.signal });
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log('');
if (!failures.length) {
  console.log(`  All ${specs.length} specs passed (${seconds}s).`);
  process.exit(0);
}

console.log(`  ${failures.length} of ${specs.length} specs FAILED (${seconds}s):`);
for (const f of failures) {
  const how = f.signal ? `killed by ${f.signal}` : `exit ${f.status}`;
  console.log(`    - ${f.spec} (${how})`);
}
process.exit(1);
