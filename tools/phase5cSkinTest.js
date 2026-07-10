// Phase 5c face-ID-as-look test (FACES_AND_DRAFT_ROADMAP.md, Phase 5). NOT shipped.
//
// The look-test showed the JSON (head/skin) is IGNORED at import -- the rendered
// face comes from the face-ID (offset 146-147). So to control appearance we copy
// a face-ID whose baked face we want. This test proves face-IDs reproduce their
// DONOR template player's actual face: it copies a real render-band face-ID from
// a light-skin-head donor onto rank 1, and a dark-skin-head donor onto rank 2,
// changing nothing else. If rank 1 renders light and rank 2 dark, then:
//   (a) copying a face-ID reproduces that donor's face, and
//   (b) the exporter can map each CFB player to the template player whose generic
//       head matches theirs and copy that face-ID -> a face close to the CFB one.
//
// Usage: node tools/phase5cSkinTest.js
// Then import CAREERDRAFT-skintest and report: is rank 1 light and rank 2 dark?

const fs = require('fs');
const path = require('path');
const os = require('os');
const { serializeDraftClassFile, setFaceId, getFaceId } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

// A render-band donor (byte 147 in 13..16) whose generic-head skin digit is `skin`.
function findDonor(model, skin) {
  for (const p of model.players) {
    const b147 = p.binary.raw[147];
    const head = p.json.visuals.genericHeadName;
    if (b147 >= 13 && b147 <= 16 && typeof head === 'string' && head.startsWith(`gen_${skin}_`)) {
      return { faceId: getFaceId(p), head, name: `${p.binary.firstName} ${p.binary.lastName}` };
    }
  }
  return null;
}

function main() {
  const model = loadTemplateModel();
  const light = findDonor(model, 1) || findDonor(model, 2);
  const dark = findDonor(model, 7) || findDonor(model, 8);
  if (!light || !dark) { console.error('Could not find both donors.'); process.exit(1); }

  const r1was = getFaceId(model.players[0]);
  const r2was = getFaceId(model.players[1]);
  model.players[0] = setFaceId(model.players[0], light.faceId); // rank 1 -> light donor's face
  model.players[1] = setFaceId(model.players[1], dark.faceId);  // rank 2 -> dark donor's face

  const buf = serializeDraftClassFile(model);
  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outputPath = path.join(outDir, 'CAREERDRAFT-skintest');
  fs.writeFileSync(outputPath, buf);

  console.log(`Wrote ${outputPath} (${buf.length} bytes).`);
  console.log(`  Rank 1 (Fasusi): face-ID ${r1was} -> ${light.faceId}  [donor head ${light.head}, LIGHT-skin generic head]`);
  console.log(`  Rank 2 (Sanders): face-ID ${r2was} -> ${dark.faceId}  [donor head ${dark.head}, DARK-skin generic head]`);
  console.log('\nImport CAREERDRAFT-skintest and report:');
  console.log('  - Rank 1 LIGHT, rank 2 DARK -> copying a face-ID reproduces the donor\'s face.');
  console.log('    Exporter plan confirmed: match CFB head -> template face-ID -> close-to-CFB face.');
  console.log('  - Not matching -> face-IDs are not head-derived; we\'d need to catalog faces by eye.');
}

main();
