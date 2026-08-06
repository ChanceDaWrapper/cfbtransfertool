// Builds data/coachHeadTones.json from the measured portrait lumas.
//
// probe18 only covered the 83 heads that happened to be in use in one save.
// probe19 showed the real catalog is assets 1..200 (portraits 309..508), dense,
// no gaps -- which matches the in-game Generic Heads browser's ~200 male faces.
// This regenerates the tone map over all 200.
//
// The luma -> tone mapping is deliberately UNCHANGED from probe18 (anchors
// 54.8 .. 139.6) so every previously-validated asset keeps its tone. The two
// new darker heads simply clamp to tone 8. Changing the anchors to the new
// observed range would silently reshuffle the validated points, so we don't.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const MAP_PATH = path.join(__dirname, '..', 'data', 'coachHeadTones.json');

const LUMA_LIGHT = 139.6; // tone 1 anchor -- from probe18, kept fixed
const LUMA_DARK = 54.8;   // tone 8 anchor

// darker => higher tone number, matching the CFB 1-8 scale
function toneFor(luma) {
  const t = 1 + 7 * ((LUMA_LIGHT - luma) / (LUMA_LIGHT - LUMA_DARK));
  return Math.min(8, Math.max(1, Math.round(t)));
}

const GROUND_TRUTH = {
  33: [7, 'the game itself wrote skinTone:7 for a created coach'],
  97: [8, 'Thomas Peters, observed clearly dark in-game'],
  57: [7, 'Roy Walker, observed dark'],
  47: [2, 'rendered as "a white guy" in a live test'],
  34: [3, 'Garrett Pratt, observed light'],
  56: [5, 'Chad Masters, observed olive/medium'],
};

const all = JSON.parse(fs.readFileSync(path.join(OUT, 'portrait-tones-all.json'), 'utf8'));
const generic = all
  .filter((r) => r.asset >= 1 && r.asset <= 200 && typeof r.luma === 'number')
  .sort((a, b) => a.asset - b.asset);

const inSave = new Set(
  JSON.parse(fs.readFileSync(path.join(OUT, 'coach-appearance.json'), 'utf8'))
    .map((r) => (String(r.head || '').match(/^coachhead_M_(\d+)_HS$/) || [])[1])
    .filter(Boolean).map(Number),
);

const tones = {};
for (let t = 1; t <= 8; t++) tones[String(t)] = [];
const lumaByAsset = {};
for (const r of generic) {
  const t = toneFor(r.luma);
  tones[String(t)].push(r.asset);
  lumaByAsset[r.asset] = r.luma;
}

console.log('=== ground-truth re-validation (must all pass) ===');
let fails = 0;
for (const [asset, [expected, why]] of Object.entries(GROUND_TRUTH)) {
  const got = toneFor(lumaByAsset[asset]);
  const ok = got === expected;
  if (!ok) fails++;
  console.log(`  asset ${String(asset).padStart(4, '0')}  luma ${String(lumaByAsset[asset]).padStart(5)}  -> tone ${got}  expected ${expected}  ${ok ? 'OK' : 'MISMATCH'}   (${why})`);
}
console.log(fails ? `\n${fails} MISMATCHES -- not writing the map.` : '\n6/6 pass.');
if (fails) process.exit(1);

console.log('\n=== supply per tone (was 83 heads, now 200) ===');
for (let t = 1; t <= 8; t++) {
  const list = tones[String(t)];
  const known = list.filter((a) => inSave.has(a)).length;
  console.log(`  tone ${t}: ${String(list.length).padStart(3)} heads  (${known} confirmed in-save, ${list.length - known} new from the catalog)`);
}

const out = {
  _comment: [
    'Madden coach head asset -> apparent skin tone (CFB 1-8 scale: 1 lightest, 8 darkest).',
    '',
    'DERIVED BY MEASUREMENT, not guesswork. The MyFranchise companion app ships every',
    'coach portrait as a PNG inside its app.asar, named <portraitId>--coachportraits.png.',
    'Portrait = headAssetNumber + 308 (verified 93/93, zero exceptions).',
    '',
    'COVERAGE: the full generic catalog is assets 1..200 (portraits 309..508) -- dense,',
    'no gaps, and matching the in-game Generic Heads browser\'s ~200 male faces. An',
    'earlier version of this file covered only the 83 heads that happened to be in use',
    'in one save; that was a sample, not the catalog.',
    '',
    'research/probe19-full-portrait-catalog.js extracts and measures every portrait;',
    'research/probe20-build-tone-map.js turns the lumas into this file. Measurement',
    'samples the central face region, keeps warm skin-like pixels (R>G>=B, excluding',
    'near-black hair/shadow and near-white cap/background), takes the interquartile',
    'mean, and computes luma. Luma maps linearly onto 1-8 across fixed anchors',
    '139.6 (tone 1) .. 54.8 (tone 8); anchors are held constant so the validated',
    'points below never shift when new heads are added.',
    '',
    'VALIDATED against every independently-known data point (6/6):',
    '  asset 0033 -> tone 7   (the game itself wrote skinTone:7 for a created coach)',
    '  asset 0097 -> tone 8   (Thomas Peters, observed clearly dark in-game)',
    '  asset 0057 -> tone 7   (Roy Walker, observed dark)',
    '  asset 0047 -> tone 2   (rendered as "a white guy" in a live test)',
    '  asset 0034 -> tone 3   (Garrett Pratt, observed light)',
    '  asset 0056 -> tone 5   (Chad Masters, observed olive/medium)',
    '',
    'Earlier inference attempts that FAILED and should not be retried: the CoachFace',
    'tone-banded namespace (coachhead_<tone>_<hair>_... -- MyFranchise\'s own',
    'genHeadPortrait.json proves that is the PLAYER head namespace, which is why it',
    'never resolved for a coach), the CharacterVisuals skinTone key (a descriptor, does',
    'not drive rendering), CFB head indices (different numbering system), and the',
    'in-game browser Head <N> labels (catalog positions, NOT asset ids).',
    '',
    'Entries are asset NUMBERS (the <N> in coachhead_M_<N>_HS).',
  ],
  scale: { min: 1, max: 8, note: 'matches CFB GenericHeadAssetName tone digit' },
  method: {
    source: 'MyFranchise app.asar coach portraits',
    catalog: 'assets 1-200 (portraits 309-508), complete',
    lumaAnchorLight: LUMA_LIGHT,
    lumaAnchorDark: LUMA_DARK,
    probes: ['research/probe19-full-portrait-catalog.js', 'research/probe20-build-tone-map.js'],
  },
  // Heads observed in a real save, so the asset name is proven to exist and
  // render. The rest come from the portrait catalog -- same numbering, but not
  // yet seen on a live coach.
  confirmedInSave: [...inSave].sort((a, b) => a - b),
  tones,
};

fs.writeFileSync(MAP_PATH, JSON.stringify(out, null, 2));
console.log(`\nwrote ${MAP_PATH}`);
console.log(`total heads mapped: ${generic.length} (was 83)`);
