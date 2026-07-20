'use strict';

// One-time bake: reads EA's auto-generated CAREERDRAFT-* draft-class files and
// distills them into data/appearanceCatalog.json -- per skin tone, a pool of
// EA-SHIPPED (faceId, genericHeadName) PAIRS. faceId (binary offset 146, the
// portrait) and genericHeadName (the 3D head/body) are independent systems in
// Madden -- see FACES_AND_DRAFT_ROADMAP.md's "appearance model" -- but each EA
// prospect ships one of each together, so keeping the pair intact reuses
// whatever coherence EA itself achieved between the two, instead of picking a
// portrait and a head separately.
//
// Only pairs where EA kept the portrait and head on the SAME skin tone are kept
// (a render-band faceId carries an inherent skin, recorded in that prospect's
// JSON `skinTone`; a head's skin is genericHeadName's leading digit) -- EA does
// not always keep these coherent itself, so incoherent occurrences are dropped
// rather than baked in.
//
// Usage: node tools/bakeAppearanceCatalog.js "<dir with CAREERDRAFT-* files>"
//   (defaults to the modding-saves folder these were captured from)

const fs = require('fs');
const path = require('path');
const { parseDraftClassFile, getFaceId } = require('../lib/draftClassFile');

const DIR = process.argv[2] || 'C:/Users/tripl/Desktop/Chance/Modding File Saves';
const RENDER_MIN = 3347;   // render band = portraits that display (vs 15800s = blank)
const RENDER_MAX = 4287;

function main() {
  const files = fs.readdirSync(DIR).filter((f) => /^CAREERDRAFT-/i.test(f));
  if (!files.length) { console.error(`No CAREERDRAFT-* files in ${DIR}`); process.exit(1); }

  const pairsByTone = {}; // skinTone -> [{faceId, head}]
  const seen = new Set(); // dedupe identical pairs within a tone
  let prospects = 0, coherentPairs = 0;
  for (const f of files) {
    const model = parseDraftClassFile(fs.readFileSync(path.join(DIR, f)));
    for (const p of model.players) {
      prospects++;
      const head = p.json.visuals.genericHeadName || '';
      const faceId = getFaceId(p);
      const skinTone = p.json.visuals.skinTone;
      const dm = head.match(/^gen_(\d+)_/);
      if (!dm || skinTone == null) continue;
      if (!(faceId >= RENDER_MIN && faceId <= RENDER_MAX)) continue; // must actually render
      if (Number(dm[1]) !== skinTone) continue; // skin-coherent occurrences only
      const key = `${skinTone}|${faceId}|${head}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (pairsByTone[skinTone] = pairsByTone[skinTone] || []).push({ faceId, head });
      coherentPairs++;
    }
  }
  for (const tone of Object.keys(pairsByTone)) pairsByTone[tone].sort((a, b) => a.faceId - b.faceId || a.head.localeCompare(b.head));

  const bySkin = {};
  for (const tone of Object.keys(pairsByTone).sort((a, b) => a - b)) bySkin[tone] = { pairs: pairsByTone[tone] };

  const out = {
    meta: {
      source: files.sort(),
      prospects,
      coherentPairs,
      renderBand: [RENDER_MIN, RENDER_MAX],
      note: 'bySkin[tone].pairs = EA-shipped (faceId, genericHeadName) pairs where portrait skin == head skin. Baked by tools/bakeAppearanceCatalog.js.',
    },
    bySkin,
  };
  const outPath = path.join(__dirname, '..', 'data', 'appearanceCatalog.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const cov = Object.entries(bySkin).map(([s, v]) => `skin ${s}: ${v.pairs.length} pairs`).join('\n  ');
  console.log(`Wrote ${outPath} from ${files.length} files (${prospects} prospects, ${coherentPairs} skin-coherent pairs)\n  ${cov}`);
}

main();
