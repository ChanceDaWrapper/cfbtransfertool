// Regression test for the shipped face catalog (data/faceCatalog.json) and its
// assigner (lib/faceCatalog.js). See FACES_AND_DRAFT_ROADMAP.md Phase 5c.
// Run with: node test/faceCatalog.spec.js (or npm test).

const assert = require('assert');
const { loadCatalog, poolForTone, createFaceAssigner } = require('../lib/faceCatalog');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// 1. The shipped catalog loads and is well-formed: skin tones present, every
//    face-ID sits inside the render band (blank-band IDs would show no face).
const cat = loadCatalog();
check('catalog version', cat.version, 2);
const tones = Object.keys(cat.bySkinTone).map(Number).sort((a, b) => a - b);
check('has skin tone 1', tones.includes(1), true);
check('has skin tone 7', tones.includes(7), true);
let allInBand = true, total = 0;
for (const t of tones) for (const fid of cat.bySkinTone[t]) {
  total++;
  if (fid < cat.renderBand.min || fid > cat.renderBand.max) allInBand = false;
}
check('all catalog face-IDs are in the render band', allInBand, true);
check('catalog is non-trivial', total > 50, true);

// 2. poolForTone returns the exact bucket when it exists, nearest otherwise.
{
  const exact = poolForTone(cat, 7);
  check('poolForTone(7) is exact', exact.tone, 7);
  // a tone with no bucket (e.g. 8 -- CFB/Madden top out at 7) falls back to nearest
  const fallback = poolForTone(cat, 8);
  check('poolForTone(8) falls back to a real tone', tones.includes(fallback.tone), true);
  check('poolForTone(8) returns a non-empty pool', fallback.pool.length > 0, true);
}

// 3. assign() returns a face-ID from the requested tone's pool, flagged exact.
{
  const a = createFaceAssigner();
  const r = a.assign(6);
  check('assign(6) is exact tone', r.exact, true);
  check('assign(6) returns a face-ID from tone-6 pool', cat.bySkinTone['6'].includes(r.faceId), true);
}

// 4. Spreading: assigning N players of the same tone must cycle the pool, so no
//    face repeats more than ceil(N/poolSize) times -- this is the anti-cloning
//    guarantee the exporter relies on.
{
  const a = createFaceAssigner();
  const pool = cat.bySkinTone['3']; // smallest bucket, worst case
  const N = pool.length * 3 + 1;
  for (let i = 0; i < N; i++) a.assign(3);
  const s = a.stats();
  const expectedMax = Math.ceil(N / pool.length);
  check('spreading uses the whole tone-3 pool', s.distinctUsed, pool.length);
  check('spreading caps reuse at ceil(N/pool)', s.maxReuse <= expectedMax, true);
}

// 5. Deterministic: same call sequence -> identical assignments (reproducible export).
{
  const a = createFaceAssigner(), b = createFaceAssigner();
  const seq = [1, 7, 7, 2, 6, 6, 6, 3, 1, 7];
  const ra = seq.map((s) => a.assign(s).faceId);
  const rb = seq.map((s) => b.assign(s).faceId);
  check('two assigners agree on the same sequence', JSON.stringify(ra), JSON.stringify(rb));
}

console.log(`\n  Face catalog spec: ${passed} assertions passed.`);
