// Regression test for lib/appearanceCatalog.js -- the skin-coherent appearance
// assigner that reuses EA-shipped (faceId, genericHeadName) pairs baked from
// EA's auto-drafts. Run: node test/appearanceCatalog.spec.js (or npm test).

const assert = require('assert');
const {
  createAppearanceAssigner, poolForTone, loadCatalog, parseAssetName, CFB_ASSET_FAMILY,
} = require('../lib/appearanceCatalog');

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

// assignExact() -- honour the player's OWN CFB head when the destination game
// ships it. CFB writes "<skin>_<facialHair>_<hairstyle>_<variant>"; Madden
// writes the same string with a "gen_" prefix.
//
// This exists because substituting a same-tone head is NOT skin-neutral: a real
// M27 report had a skin-5 tackle come out pale because the tone-5 head he was
// handed rendered lighter than his own. Keeping his real head avoids the
// substitution entirely.
{
  const a = createAppearanceAssigner(catalog);

  const own = a.assignExact('2_H_N_02');
  check('a CFB head the game ships is used verbatim', own && own.head, 'gen_2_H_N_02');
  check('...paired with that head\'s own portrait', own && own.faceId, 3501);
  check('...and is flagged as the player\'s own head', own && own.ownHead, true);
  check('...with the tone read off the head itself', own && own.tone, 2);

  check('a head the game does NOT ship returns null so the caller can fall back',
    a.assignExact('9_B_N_99'), null);
  check('a CFB player with no head at all returns null', a.assignExact(''), null);
  check('a missing head field returns null', a.assignExact(undefined), null);
  check('the "NoHead" sentinel CFB uses is not treated as a real head',
    a.assignExact('NoHead'), null);

  // The fallback must still work, and must still be tone-correct.
  const sub = a.assign(7);
  check('fallback still returns a same-tone pair', sub.head, 'gen_7_B_N_01');

  // Own-head picks count toward reuse spreading, so a head used exactly once
  // via assignExact isn't then handed out again by assign() as "least used".
  const a2 = createAppearanceAssigner(catalog);
  a2.assignExact('1_B_N_01');
  check('an own-head pick is recorded in the usage stats', a2.stats().distinctPairs, 1);
}

// parseAssetName() -- CFB's GenericHeadAssetName carries a SEPARATE signal
// (skin tone + facial-hair-combo code) from PLYR_GENERICHEAD, ground-truthed
// against 429 real players who carry both fields: H/T/M pass through as
// themselves, D always lands in Madden's "B" family (100% of 264 samples).
{
  check('a real Generic_* name parses to its tone and family',
    JSON.stringify(parseAssetName('Generic_0917_P_T0045_T_7_3')), JSON.stringify({ tone: 7, family: 'T' }));
  check('the "D" combo code maps to Madden\'s "B" family',
    JSON.stringify(parseAssetName('Generic_0146_P_T0007_D_2_1')), JSON.stringify({ tone: 2, family: 'B' }));
  check('H maps to itself', parseAssetName('Generic_0001_P_T0001_H_5_2').family, 'H');
  check('M maps to itself', parseAssetName('Generic_0001_P_T0001_M_3_4').family, 'M');
  check('a scanned real-player name (no combo/tone suffix) does not parse',
    parseAssetName('Unique_LehmanReston_203396'), null);
  check('a blank name does not parse', parseAssetName(''), null);
  check('a non-string does not parse', parseAssetName(undefined), null);
  check('every CFB asset combo code CFB actually ships resolves to a family',
    Object.keys(CFB_ASSET_FAMILY).sort().join(','), 'D,H,M,T');
}

// assignByAssetName() -- the second tier, tried when assignExact fails: match
// skin tone AND facial-hair family instead of skin tone alone. A tone with
// several different combo codes proves the filter actually discriminates
// (not just "any pair at this tone" relabeled).
const familyCatalog = {
  bySkin: {
    3: {
      pairs: [
        { faceId: 100, head: 'gen_3_B_N_01' },
        { faceId: 101, head: 'gen_3_BMH_N_01' },
        { faceId: 102, head: 'gen_3_H_N_01' },
        { faceId: 103, head: 'gen_3_T_N_01' },
        { faceId: 104, head: 'gen_3_M_N_01' },
        { faceId: 105, head: 'gen_3_N_N_01' },
      ],
    },
    // Tone 9 exists but has NOTHING in the H family -- proves the tier
    // returns null (defers to assign()'s tone-widening) instead of quietly
    // handing back a wrong-family pair from the same tone.
    9: { pairs: [{ faceId: 900, head: 'gen_9_B_N_01' }] },
  },
};
{
  const a = createAppearanceAssigner(familyCatalog);

  // D asset code -> Madden's B family. Both B and BMH qualify (both start
  // with "B"); H/T/M/N at the same tone must never be picked.
  const seenForD = new Set();
  for (let i = 0; i < 2; i++) seenForD.add(a.assignByAssetName('Generic_0001_P_T0001_D_3_1').head);
  check('D (2 picks) only ever returns B-family heads',
    [...seenForD].every((h) => /^gen_3_B/.test(h)), true);
  check('...and actually spreads across BOTH B-family heads (least-used-first)', seenForD.size, 2);

  check('H asset code returns exactly the H head, not B/T/M/N',
    a.assignByAssetName('Generic_0001_P_T0001_H_3_1').head, 'gen_3_H_N_01');
  check('T asset code returns exactly the T head',
    a.assignByAssetName('Generic_0001_P_T0001_T_3_1').head, 'gen_3_T_N_01');
  check('M asset code returns exactly the M head',
    a.assignByAssetName('Generic_0001_P_T0001_M_3_1').head, 'gen_3_M_N_01');

  check('no matching family at that tone -> null (defers to assign(), does not widen tone itself)',
    a.assignByAssetName('Generic_0001_P_T0001_H_9_1'), null);
  check('a tone the catalog has no bucket for at all -> null',
    a.assignByAssetName('Generic_0001_P_T0001_H_6_1'), null);
  check('an unparseable (scanned/Unique_*) asset name -> null',
    a.assignByAssetName('Unique_LehmanReston_203396'), null);
  check('no asset name at all -> null', a.assignByAssetName(''), null);

  const hit = a.assignByAssetName('Generic_0001_P_T0001_T_3_1');
  check('a successful match is flagged familyMatch (not exact/ownHead)', hit.familyMatch, true);
  check('...is not marked exact', !!hit.exact, false);
  check('...and reports the tone it matched on', hit.tone, 3);

  // Reuse counting is shared with assign()/assignExact() -- an assignByAssetName
  // pick must count toward "least used" the same way, or the spreading logic
  // those two already rely on would be silently defeated by this new tier.
  const a2 = createAppearanceAssigner(familyCatalog);
  a2.assignByAssetName('Generic_0001_P_T0001_H_3_1'); // uses gen_3_H_N_01 once
  check('an assignByAssetName pick is recorded in the shared usage stats', a2.stats().distinctPairs, 1);
}

console.log(`\n  Appearance catalog spec: ${passed} assertions passed.`);
