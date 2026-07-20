// Regression test for lib/appearanceCatalog.js -- the skin-coherent appearance
// assigner that reuses EA-shipped (faceId, genericHeadName) pairs baked from
// EA's auto-drafts. Run: node test/appearanceCatalog.spec.js (or npm test).

const assert = require('assert');
const { createAppearanceAssigner, poolForTone, loadCatalog } = require('../lib/appearanceCatalog');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A small synthetic catalog so the test doesn't depend on the exact baked data.
const catalog = {
  bySkin: {
    1: { pairs: [{ faceId: 3400, head: 'gen_1_B_N_01' }, { faceId: 3401, head: 'gen_1_H_N_02' }] },
    2: { pairs: [{ faceId: 3500, head: 'gen_2_B_N_01' }, { faceId: 3501, head: 'gen_2_H_N_02' }, { faceId: 3502, head: 'gen_2_M_N_03' }] },
    7: { pairs: [{ faceId: 4200, head: 'gen_7_B_N_01' }] },
  },
};

// 1. assign() returns a matched faceId+head PAIR from the requested tone's pool
//    (not independently chosen), so head skin == faceId's tone by construction.
{
  const a = createAppearanceAssigner(catalog);
  const r = a.assign(2);
  const wantPairs = catalog.bySkin[2].pairs;
  check('faceId+head is one of the tone\'s shipped pairs', wantPairs.some((p) => p.faceId === r.faceId && p.head === r.head), true);
  check('tone is exact when covered', r.exact, true);
  check('head skin digit matches the tone', r.head.match(/^gen_(\d+)_/)[1], '2');
}

// 2. Spreading: within a tone, pairs rotate least-used-first rather than
//    collapsing onto one identity.
{
  const a = createAppearanceAssigner(catalog);
  const seenPairs = new Set();
  for (let i = 0; i < 2; i++) { const r = a.assign(1); seenPairs.add(`${r.faceId}|${r.head}`); } // tone 1 has 2 pairs
  check('both tone-1 pairs used across 2 picks (spread)', seenPairs.size, 2);
}

// 3. Fallback: an uncovered tone borrows the nearest covered tone.
{
  const a = createAppearanceAssigner(catalog);
  const r = a.assign(8); // no skin 8 -> nearest is 7
  check('uncovered tone 8 falls back', r.tone, 7);
  check('fallback is flagged non-exact', r.exact, false);
  check('fallback pair from tone 7', r.faceId, 4200);
}

// 4. poolForTone clamps a non-numeric tone to a real bucket instead of throwing.
{
  const r = poolForTone(catalog, undefined);
  check('poolForTone tolerates a bad tone', typeof r.tone, 'number');
}

// 5. The real baked catalog loads and covers the common skin tones with pairs.
{
  const real = loadCatalog();
  let covered = 0;
  for (let s = 1; s <= 7; s++) {
    const b = real.bySkin[s];
    if (b && b.pairs.length) covered++;
  }
  check('baked catalog covers skin tones 1-7 with pairs', covered, 7);
}

console.log(`\n  Appearance catalog spec: ${passed} assertions passed.`);
