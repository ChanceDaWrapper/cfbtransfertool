// Phase 5b spike tool -- produces the single-edit test file for the real-Madden
// import gate (FACES_AND_DRAFT_ROADMAP.md, Phase 5). NOT part of the shipped
// app; run manually from a checkout with `node tools/phase5bTestEdit.js`.
//
// What it does: starts from the app's BUNDLED template (no file needed), changes
// exactly one player's bodyType (to a same-byte-length alternative) and that
// same player's lastName (padded within its existing allocation), and writes the
// result to a file. Byte-diffs the output against the template and prints exactly
// which bytes changed, so you can confirm the edit stayed contained to one
// player's slot before importing it in Madden.
//
// Usage:
//   node tools/phase5bTestEdit.js [input-file] [playerIndex] [lastNameMarker]
//
//   - With no input-file, it uses the app's bundled template -- this is the
//     realistic test, since the shipped exporter builds from that same template.
//   - Pass an input-file to test against a specific real export instead.
//
// The gate this feeds: import the printed output file into Madden via its own
// "Import Draft Class" flow and confirm (a) Madden accepts it (not rejected as
// corrupt) and (b) the two changed fields show up on the right player, with
// nothing else in the class visibly broken. If Madden rejects it, see Phase 5's
// risk-1 note in the roadmap (check for a checksum) before concluding the path
// is blocked.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseDraftClassFile, serializeDraftClassFile, make5bTestEdit, SAME_LENGTH_BODY_TYPES } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

function main() {
  const [, , inputPath, playerIndexArg, markerArg] = process.argv;
  const lastNameMarker = markerArg || 'PHASE5BTEST';

  // Source model: bundled template by default, or a real export if a path is given.
  let model;
  let sourceLabel;
  if (inputPath) {
    model = parseDraftClassFile(fs.readFileSync(inputPath));
    sourceLabel = inputPath;
  } else {
    model = loadTemplateModel();
    sourceLabel = 'bundled template (data/draftClassTemplate.bin.gz)';
  }
  const baselineBuf = serializeDraftClassFile(model); // what the diff compares against
  console.log(`Source: ${sourceLabel} -- ${model.header.playerCount} players, schema tag "${model.header.schemaTag}".`);

  let playerIndex = playerIndexArg !== undefined ? Number(playerIndexArg) : undefined;
  const isCompatible = (i) => SAME_LENGTH_BODY_TYPES.includes(model.players[i] && model.players[i].json.visuals.bodyType);
  if (playerIndex === undefined || !isCompatible(playerIndex)) {
    const found = model.players.findIndex((_, i) => isCompatible(i));
    if (found === -1) {
      console.error(`No player has a bodyType from ${JSON.stringify(SAME_LENGTH_BODY_TYPES)} -- can't do a same-length edit.`);
      process.exit(1);
    }
    if (playerIndex !== undefined) {
      console.log(`Player ${playerIndex}'s bodyType isn't one of ${JSON.stringify(SAME_LENGTH_BODY_TYPES)}; using player ${found} instead.`);
    }
    playerIndex = found;
  }

  const before = model.players[playerIndex];
  console.log(`Editing player ${playerIndex}: ${before.binary.firstName} ${before.binary.lastName} (bodyType: ${before.json.visuals.bodyType}).`);

  const { buffer: editedBuf, change } = make5bTestEdit(model, playerIndex, { lastNameMarker });

  console.log(`  bodyType: "${change.bodyType.from}" -> "${change.bodyType.to}" (same length, ${change.bodyType.from.length} bytes)`);
  console.log(`  lastName: "${change.lastName.from}" -> "${change.lastName.to}"`);

  // Byte-diff: report every differing byte range so it's obvious the edit
  // stayed contained to this one player's slot before anyone tries importing.
  if (editedBuf.length !== baselineBuf.length) {
    console.error(`UNEXPECTED: output length ${editedBuf.length} !== source length ${baselineBuf.length}. This should never happen for a same-length edit -- STOP, do not import this file.`);
    process.exit(1);
  }
  const diffRanges = [];
  let i = 0;
  while (i < baselineBuf.length) {
    if (baselineBuf[i] !== editedBuf[i]) {
      let j = i;
      while (j < baselineBuf.length && baselineBuf[j] !== editedBuf[j]) j++;
      diffRanges.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  console.log(`\nByte-diff: ${diffRanges.length} differing range(s) out of ${baselineBuf.length} total bytes.`);
  for (const [s, e] of diffRanges) {
    console.log(`  [0x${s.toString(16)}, 0x${e.toString(16)}) -- ${e - s} byte(s)`);
  }

  // Write next to the input if given, else to the desktop (easy to find for the
  // Madden import), falling back to the OS temp dir.
  const outDir = inputPath
    ? path.dirname(inputPath)
    : (fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir());
  const outputPath = path.join(outDir, 'CAREERDRAFT-phase5b-test');
  fs.writeFileSync(outputPath, editedBuf);
  console.log(`\nWrote edited file to: ${outputPath}`);
  if (inputPath) console.log('The original input file was NOT modified.');
  console.log('\nNext: import this file into Madden via "Import Draft Class" and confirm it is accepted');
  console.log('(not rejected as corrupt), the two changes above show up on the right player, and');
  console.log('nothing else in the class looks broken.');
}

main();
