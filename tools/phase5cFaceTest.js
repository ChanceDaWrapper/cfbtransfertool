// Phase 5c face-rendering probe (FACES_AND_DRAFT_ROADMAP.md, Phase 5). NOT part
// of the shipped app -- a manual spike, like phase5bTestEdit.js.
//
// Purpose: 5b proved edits survive import, but the imported class showed missing
// faces. We found the format stores ONLY generic heads (no face scans), so the
// question that decides the whole faces story is: does WRITING a generic head +
// skin tone actually produce a rendered face on import? CFB players use generic
// heads too, so if "yes", faces are solved for our real class.
//
// What it does: on the bundled template, it overwrites a handful of the
// top-ranked players' skin tone -- by swapping the leading skin digit of their
// genericHeadName (gen_<skin>_...) to a visibly different value and setting the
// matching skinTone field. Both are strictly SAME-LENGTH edits (single digit ->
// single digit, rest of the head string untouched), so it stays inside the
// import-validated edit path from 5b and can't be blamed on a length/offset
// shift. The swapped heads are guaranteed valid: same category + variant as the
// original, only the skin digit differs (skins 1-8 all exist).
//
// Usage: node tools/phase5cFaceTest.js
// Then import the DRAFTCLASS-facetest file it writes to your Desktop and check
// the listed ranks: did their skin tone / face visibly change, or are those
// players' faces still missing?

const fs = require('fs');
const path = require('path');
const os = require('os');
const { serializeDraftClassFile, setJsonFieldSameLength } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

// A distinct target skin for each probe slot, so each edited player looks clearly
// different from the next -- makes it obvious at a glance which changes took.
const TARGET_SKINS = [1, 8, 2, 7, 3, 6];

function main() {
  const model = loadTemplateModel();
  const baseline = serializeDraftClassFile(model);

  const legend = [];
  let probeCount = 0;
  for (let i = 0; i < model.players.length && probeCount < TARGET_SKINS.length; i++) {
    const player = model.players[i];
    const head = player.json.visuals.genericHeadName;
    const m = String(head).match(/^gen_(\d)_(.+)$/);
    if (!m) continue;
    const currentSkin = Number(m[1]);
    const newSkin = TARGET_SKINS[probeCount];
    if (newSkin === currentSkin) continue; // pick a visibly different one; skip if same
    const newHead = `gen_${newSkin}_${m[2]}`; // same length, same category+variant, different skin digit

    let edited = setJsonFieldSameLength(player, 'genericHeadName', newHead);
    edited = setJsonFieldSameLength(edited, 'skinTone', newSkin);
    model.players[i] = edited;

    legend.push({
      rank: i + 1, // draft rank ~= index+1 (verified against the 5b import screenshot)
      name: `${player.binary.firstName} ${player.binary.lastName}`,
      head: `${head} -> ${newHead}`,
      skin: `${currentSkin} -> ${newSkin}`,
    });
    probeCount++;
  }

  const editedBuf = serializeDraftClassFile(model);

  // Diff sanity: must be same length and only a few small ranges.
  if (editedBuf.length !== baseline.length) {
    console.error(`UNEXPECTED length change (${editedBuf.length} vs ${baseline.length}) -- do not import.`);
    process.exit(1);
  }
  let ranges = 0, i = 0;
  while (i < baseline.length) {
    if (baseline[i] !== editedBuf[i]) { let j = i; while (j < baseline.length && baseline[j] !== editedBuf[j]) j++; ranges++; i = j; }
    else i++;
  }

  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outputPath = path.join(outDir, 'CAREERDRAFT-facetest');
  fs.writeFileSync(outputPath, editedBuf);

  console.log(`Wrote ${outputPath} (${editedBuf.length} bytes, ${ranges} changed byte-ranges, ${legend.length} players edited).`);
  console.log('\nImport it in Madden and check these players (draft rank = the number in the list):');
  for (const l of legend) {
    console.log(`  Rank ${l.rank}  ${l.name.padEnd(22)} skin ${l.skin}   head ${l.head}`);
  }
  console.log('\nWhat we\'re learning:');
  console.log('  - If these players\' skin tone / face visibly CHANGED to the new value -> writing');
  console.log('    generic heads + skin works, and generic faces DO render. Faces are solved for our');
  console.log('    real CFB class (CFB players use these same generic heads).');
  console.log('  - If these exact players still have MISSING faces -> generic heads alone don\'t render');
  console.log('    on draft-class import, and we need to dig into what else the face requires.');
}

main();
