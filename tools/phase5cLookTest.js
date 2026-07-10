// Phase 5c look-source test (FACES_AND_DRAFT_ROADMAP.md, Phase 5). NOT shipped.
//
// We know offset 146-147 (the face-ID) gates render-vs-blank, and data analysis
// shows it's decoupled from head/skin (same head -> many face-IDs; face-ID
// doesn't track skin). That implies the LOOK comes from the JSON (genericHeadName
// + skinTone) and the face-ID just selects generic-render vs cyberface. This test
// proves it unambiguously: two top-of-list players get the SAME render-band
// face-ID but OPPOSITE skins (1 = lightest vs 8 = darkest), using real,
// same-length head strings pulled from the template (guaranteed valid, no length
// shift). If rank 1 renders clearly light and rank 2 clearly dark -> the JSON
// drives the look, so writing the CFB head+skin lands "close to the CFB face".
// If they look identical -> the face-ID drives the look and we'd map to face-IDs.
//
// Usage: node tools/phase5cLookTest.js
// Then import CAREERDRAFT-looktest and report: are ranks 1 and 2 obviously
// different skin tones, or the same face?

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  serializeDraftClassFile, setJsonFieldSameLength, setFaceId,
} = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

const SAME_FACE_ID = 3855; // arbitrary value inside the render band (3347..4287)

// Find a real head string in the template with the given skin digit and exact
// byte-length -- guarantees the head exists in this build AND keeps the JSON blob
// length unchanged (stays in the 5b-validated same-length edit path).
function realHeadForSkin(model, skin, length) {
  for (const p of model.players) {
    const h = p.json.visuals.genericHeadName;
    if (typeof h === 'string' && h.startsWith(`gen_${skin}_`) && h.length === length) return h;
  }
  return null;
}

function applySkin(model, idx, skin) {
  const p = model.players[idx];
  const curHead = p.json.visuals.genericHeadName;
  let newHead = realHeadForSkin(model, skin, curHead.length);
  if (!newHead) newHead = curHead.replace(/^gen_\d/, `gen_${skin}`); // fallback: digit swap (same length)
  let edited = setJsonFieldSameLength(p, 'genericHeadName', newHead);
  edited = setJsonFieldSameLength(edited, 'skinTone', skin);
  edited = setFaceId(edited, SAME_FACE_ID);
  model.players[idx] = edited;
  return { rank: idx + 1, name: `${p.binary.firstName} ${p.binary.lastName}`, head: `${curHead} -> ${newHead}`, skin };
}

function main() {
  const model = loadTemplateModel();
  const a = applySkin(model, 0, 1); // rank 1 -> lightest skin
  const b = applySkin(model, 1, 8); // rank 2 -> darkest skin, SAME face-ID

  const buf = serializeDraftClassFile(model);
  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outputPath = path.join(outDir, 'CAREERDRAFT-looktest');
  fs.writeFileSync(outputPath, buf);

  console.log(`Wrote ${outputPath} (${buf.length} bytes). Both players share face-ID ${SAME_FACE_ID}.`);
  console.log(`  Rank ${a.rank} ${a.name}: skin ${a.skin} (lightest)  head ${a.head}`);
  console.log(`  Rank ${b.rank} ${b.name}: skin ${b.skin} (darkest)   head ${b.head}`);
  console.log('\nImport CAREERDRAFT-looktest and report:');
  console.log('  - Rank 1 clearly LIGHT and rank 2 clearly DARK -> JSON (head+skin) drives the look.');
  console.log('    Faces are fully solved: exporter sets a render-band face-ID + writes the CFB head/skin.');
  console.log('  - Both look the SAME face -> the face-ID drives the look; we map CFB players to face-IDs.');
}

main();
