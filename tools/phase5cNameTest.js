// Phase 5c face-cause probe #2 (FACES_AND_DRAFT_ROADMAP.md, Phase 5). NOT shipped.
//
// Tests the strongest hypothesis for the missing faces: that Madden blanks a
// draft prospect's face when the player's NAME matches a real cyberface in its
// database that isn't available in the import context, and otherwise falls back
// to the (rendering) generic head. Evidence for this: idx3 Boireau (no face) and
// idx4 Johnson (face) carry the IDENTICAL generic head, so the head isn't the
// cause -- the player identity is. The faceless players are all marquee real
// 2026 prospects (Fasusi, Sanders, Griffin, Boireau); the faced ones are not.
//
// This renames four known-faceless marquee players to clearly-fake names while
// keeping their heads/skins untouched (names use setBinaryName, which fits within
// each name's existing allocation -- no length/offset shift, stays in the
// 5b-validated edit path). Rank 6 (Carr, faceless) is left UNCHANGED as a control.
//
// If the renamed players now show a generic face -> faces are name/identity
// driven, which means our real CFB players (names not in Madden's NFL cyberface
// DB) will render generic heads fine, and the faces story is effectively solved.
// If they stay blank -> not name-driven; keep hunting the flag field.
//
// Usage: node tools/phase5cNameTest.js
// Then import DRAFTCLASS-nametest and check the listed ranks.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { serializeDraftClassFile, setBinaryName } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

// idx -> fake name (kept short to fit safely inside each original allocation).
const RENAMES = {
  0: { first: 'Zeb', last: 'Qwolt' },   // was Michael Fasusi  (rank 1, faceless)
  1: { first: 'Cal', last: 'Vronk' },   // was David Sanders Jr (rank 2, faceless)
  2: { first: 'Rio', last: 'Blint' },   // was Elijah Griffin  (rank 3, faceless)
  3: { first: 'Kip', last: 'Draxo' },   // was Michael Boireau (rank 4, faceless)
};

function main() {
  const model = loadTemplateModel();
  const legend = [];
  for (const [idxStr, name] of Object.entries(RENAMES)) {
    const idx = Number(idxStr);
    const p = model.players[idx];
    const was = `${p.binary.firstName} ${p.binary.lastName}`;
    let edited = setBinaryName(p, 'firstName', name.first);
    edited = setBinaryName(edited, 'lastName', name.last);
    model.players[idx] = edited;
    legend.push({ rank: idx + 1, was, now: `${name.first} ${name.last}`, head: p.json.visuals.genericHeadName });
  }

  const buf = serializeDraftClassFile(model);
  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outputPath = path.join(outDir, 'CAREERDRAFT-nametest');
  fs.writeFileSync(outputPath, buf);

  console.log(`Wrote ${outputPath} (${buf.length} bytes).`);
  console.log('\nRenamed (head/skin kept identical) -- import and check if a face now appears:');
  for (const l of legend) {
    console.log(`  Rank ${l.rank}  ${l.was.padEnd(20)} -> ${l.now.padEnd(12)}  head ${l.head}`);
  }
  console.log('  Rank 6  CJ Carr (UNCHANGED control -- should still be faceless)');
  console.log('\nRead:');
  console.log('  - Renamed players now show a generic face  -> faces are name/identity driven.');
  console.log('    Our CFB players (not in Madden\'s NFL cyberface DB) will render generic heads.');
  console.log('    Faces effectively solved for the real class.');
  console.log('  - Renamed players still blank -> not name-driven; keep hunting the flag field.');
}

main();
