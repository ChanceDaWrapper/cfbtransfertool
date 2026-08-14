// Guards package.json against being silently gutted.
//
// This has now happened TWICE, from the same cause: running
//
//     npx asar extract-file dist/win-unpacked/resources/app.asar package.json
//
// to peek inside a build. asar extract-file writes to the CURRENT DIRECTORY,
// so run from the project root it overwrites the real package.json with the
// stripped copy electron-builder puts in the bundle -- no scripts, no
// devDependencies, no build config, ~700 bytes. `npm test` and `npm run build`
// then both fail with "Missing script", and the first time it went unnoticed
// long enough to be committed.
//
// (If you need to look inside a bundle, cd somewhere scratch first.)
//
// WHAT THIS SPEC CAN AND CANNOT CATCH -- worth stating plainly, because it
// cannot catch the very case that prompted it. A TOTAL gutting removes the
// "test" script, so `npm test` dies with "Missing script" before any spec runs;
// that failure is at least loud, and the real damage last time was that it went
// unnoticed and got committed anyway. Run this file directly
// (`node test/packageJson.spec.js`) to check a suspect package.json.
//
// What it DOES catch, on every ordinary test run, is PARTIAL damage and drift:
// a dropped files entry (a broken installer that only shows up after
// packaging), a devDependency promoted to a runtime one, lost attribution, a
// changed appId, or a version that no longer matches the newest CHANGELOG
// heading -- i.e. shipping an installer whose filename disagrees with its own
// release notes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
function ok(label, cond) { assert.ok(cond, label); passed++; }
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// The four scripts. "test" and "build" are the two whose loss breaks everything.
for (const script of ['start', 'build', 'build:fixtool', 'test']) {
  ok(`scripts.${script} exists`, typeof (pkg.scripts || {})[script] === 'string');
}
ok('test runs the discovering runner', /test\/run\.js/.test(pkg.scripts.test));
ok('build runs electron-builder', /electron-builder/.test(pkg.scripts.build));

// electron-builder config. Without this the installer silently loses its
// identity (appId, product name, icon, NSIS behaviour).
ok('build config present', !!pkg.build);
check('appId', pkg.build.appId, 'com.chance.pipeline');
check('productName', pkg.build.productName, 'Pipeline');
ok('win target is nsis', JSON.stringify(pkg.build.win.target).includes('nsis'));

// The files list decides what ships. A missing entry means a broken install
// that only shows up after packaging.
const files = pkg.build.files || [];
for (const entry of ['main.js', 'preload.js', 'lib/**/*', 'renderer/**/*', 'data/**/*', 'schema/**/*', 'node_modules/**/*']) {
  ok(`build.files includes ${entry}`, files.includes(entry));
}
// ...and the two deliberate exclusions, which keep ~3.7 MB of raw research data
// and any stray .backup-* file out of the installer.
ok('excludes the raw veteran dataset', files.includes('!data/real_draft_classes_veteran.json'));
ok('excludes backup files', files.includes('!data/*.backup-*'));

// Dependencies. The vendored madden-franchise tarball is the one runtime dep;
// electron/electron-builder are dev-only and must not migrate.
ok('madden-franchise dependency present', !!(pkg.dependencies || {})['madden-franchise']);
ok('madden-franchise is the vendored tarball', /^file:vendor\//.test(pkg.dependencies['madden-franchise']));
for (const dev of ['electron', 'electron-builder']) {
  ok(`devDependencies.${dev} present`, !!(pkg.devDependencies || {})[dev]);
}

// Identity and metadata that a stripped copy loses.
check('name', pkg.name, 'pipeline');
check('main', pkg.main, 'main.js');
check('license', pkg.license, 'MIT');
ok('author set', !!pkg.author);
ok('contributors credit is intact (see NOTICE.md)', Array.isArray(pkg.contributors) && pkg.contributors.length > 0);
ok('repository url set', !!(pkg.repository && pkg.repository.url));
ok('engines pins a minimum node', !!(pkg.engines && pkg.engines.node));

// Version must be a plain semver, and match the newest CHANGELOG release
// heading -- catches shipping an installer whose filename says one version
// while the changelog documents another.
ok('version is semver', /^\d+\.\d+\.\d+$/.test(pkg.version));
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const firstRelease = (changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
ok('CHANGELOG has a released version heading', !!firstRelease);
check('package version matches the newest CHANGELOG release', pkg.version, firstRelease);

// Blunt backstop: the gutted copy was ~700 bytes. A healthy one is far bigger.
const bytes = fs.statSync(path.join(ROOT, 'package.json')).size;
ok(`package.json is not a stripped bundle copy (${bytes} bytes)`, bytes > 1200);

console.log(`\n  package.json integrity spec: ${passed} assertions passed.`);
