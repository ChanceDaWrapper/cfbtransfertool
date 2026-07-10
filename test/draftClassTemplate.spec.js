// Regression test for the BUNDLED draft-class template (data/draftClassTemplate.bin.gz)
// and its loader (lib/draftClassTemplate.js). See FACES_AND_DRAFT_ROADMAP.md
// Phase 5, decision #2: the app builds draft-class files from this bundled base
// so the user never has to export their own. Run with: node test/draftClassTemplate.spec.js
//
// Unlike draftClassFile.spec.js (synthetic fixture, runs anywhere), this test
// exercises the REAL bundled asset -- so it also proves the committed asset is
// present, inflates, parses, and round-trips byte-for-byte. If the template is
// ever re-baked (tools/bakeDraftClassTemplate.js) this keeps it honest.

const assert = require('assert');
const {
  serializeDraftClassFile, SAME_LENGTH_BODY_TYPES, getPosition, POSITION_ENUM, getHeight, getWeight,
} = require('../lib/draftClassFile');
const { loadTemplateBuffer, loadTemplateModel } = require('../lib/draftClassTemplate');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// 1. The bundled asset inflates and parses into a full class.
const buffer = loadTemplateBuffer();
const model = loadTemplateModel();
check('template has a positive player count', model.header.playerCount > 0, true);
check('template player count matches parsed players', model.players.length, model.header.playerCount);
check('template schema tag looks like a Madden tag', /^Madden-/.test(model.header.schemaTag), true);

// 2. The bundled template round-trips byte-for-byte (it must, or bakeDraftClassTemplate
//    would have refused to write it -- this locks that invariant into the suite).
const reemitted = serializeDraftClassFile(model);
check('template round-trips byte-for-byte', Buffer.compare(buffer, reemitted), 0);

// 3. loadTemplateModel hands back an independent copy each call -- mutating one
//    must not affect the next (the exporter patches the model in place per class).
const a = loadTemplateModel();
const b = loadTemplateModel();
a.players[0].json.raw = Buffer.from('mutated');
check('each loadTemplateModel call is independent', b.players[0].json.raw.equals(Buffer.from('mutated')), false);

// 4. At least one player carries a same-length-swappable bodyType, so the exporter
//    (and the 5b spike) always has a safe edit target in the bundled base.
const hasSwappable = model.players.some((p) => SAME_LENGTH_BODY_TYPES.includes(p.json.visuals.bodyType));
check('template has at least one same-length-swappable bodyType player', hasSwappable, true);

// 5. Position ground truth (from real in-game scouting screenshots, ranks 1-10,
//    idx = rank-1): OT/OT/DT/DT/DT/QB/QB/IOL/OT/CB. "OT" in-game maps to the real
//    LT enum value, "IOL" maps to LG -- see FACES_AND_DRAFT_ROADMAP.md Phase 5c.
const GROUND_TRUTH_POSITIONS = { 0: 'LT', 1: 'LT', 2: 'DT', 3: 'DT', 4: 'DT', 5: 'QB', 6: 'QB', 7: 'LG', 8: 'LT', 9: 'CB' };
for (const [idx, expected] of Object.entries(GROUND_TRUTH_POSITIONS)) {
  check(`template player ${idx} position matches in-game ground truth`, getPosition(model.players[idx]), expected);
}

// 6. Every one of the 402 template players decodes to a real, known position
//    (no leftover/invalid enum values) -- this is what "position offset found and
//    understood" actually means at the whole-population level, not just 10 samples.
{
  let unknown = 0;
  const counts = {};
  const knownPositions = new Set(Object.values(POSITION_ENUM));
  for (const p of model.players) {
    const pos = getPosition(p);
    if (!knownPositions.has(pos)) unknown++;
    else counts[pos] = (counts[pos] || 0) + 1;
  }
  check('every template player has a recognized position (no unknowns)', unknown, 0);
  check('template position distribution accounts for all 402 players', Object.values(counts).reduce((a, b) => a + b, 0), 402);
  // sanity: WR should be the most common position in a real draft class (skill positions dominate)
  const mostCommon = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  check('most common position in the template is WR (realistic draft-class shape)', mostCommon, 'WR');
}

// 7. Height/Weight ground truth from real in-game screenshots: Beau Johnson
//    (idx8) 297lb/6'5"=77in, Jericho Johnson (idx4) 342lb/6'3"=75in, Malik
//    Washington (idx6) 231lb/6'4"=76in.
const HW_GROUND_TRUTH = { 8: { weight: 297, height: 77 }, 4: { weight: 342, height: 75 }, 6: { weight: 231, height: 76 } };
for (const [idx, gt] of Object.entries(HW_GROUND_TRUTH)) {
  check(`template player ${idx} height matches in-game ground truth`, getHeight(model.players[idx]), gt.height);
  check(`template player ${idx} weight matches in-game ground truth`, getWeight(model.players[idx]), gt.weight);
}

// 8. Whole-population sanity: every one of the 402 template players has a
//    realistic height/weight, and offensive linemen average bigger than DBs/WRs
//    (a real structural property of football body types, not just 3 samples).
{
  let outOfRange = 0;
  const byPos = {};
  for (const p of model.players) {
    const h = getHeight(p), w = getWeight(p);
    if (h < 60 || h > 90 || w < 140 || w > 400) outOfRange++;
    const pos = getPosition(p);
    (byPos[pos] = byPos[pos] || []).push(w);
  }
  check('every template player has a realistic height/weight', outOfRange, 0);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  check('offensive tackles (LT) average heavier than cornerbacks', avg(byPos.LT) > avg(byPos.CB), true);
}

console.log(`\n  Draft-class template spec: ${passed} assertions passed.`);
