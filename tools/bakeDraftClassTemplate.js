// Bakes a real Madden "Import Draft Class" export into the app's bundled
// template asset (data/draftClassTemplate.bin.gz). Run this ONCE to create the
// asset, or again to refresh it if the app's built-in template ever needs to
// match a different Madden build's schema tag (see FACES_AND_DRAFT_ROADMAP.md
// Phase 5, decision #2). NOT part of the shipped app -- a dev/maintenance tool.
//
// The bundled template is what the exporter patches in place to produce a draft
// class, so the user never has to export their own file for normal use. Only
// the STRUCTURE and non-fillable sections (gear loadouts, face blends, header)
// are used from it -- every fillable field (names, ratings, body/head/skin) is
// overwritten per generated player, so the specific players baked in here never
// appear in real output.
//
// Usage:
//   node tools/bakeDraftClassTemplate.js <path-to-a-real-exported-draft-class-file>

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { verifyRoundTrip } = require('../lib/draftClassFile');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'draftClassTemplate.bin.gz');

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node tools/bakeDraftClassTemplate.js <path-to-a-real-exported-draft-class-file>');
    process.exit(1);
  }

  const buf = fs.readFileSync(inputPath);

  // Never bake a file we can't perfectly round-trip -- that would mean we don't
  // fully understand this build's layout and shouldn't be shipping it as a base.
  const { identical, model } = verifyRoundTrip(buf);
  if (!identical) {
    console.error('REFUSING TO BAKE: this file does not byte-perfect round-trip through the parser.');
    console.error('That means its layout is not fully understood -- do not use it as a template.');
    process.exit(1);
  }

  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(OUTPUT_PATH, gz);

  console.log(`Baked template from: ${inputPath}`);
  console.log(`  players:    ${model.header.playerCount}`);
  console.log(`  schema tag: ${model.header.schemaTag}`);
  console.log(`  original:   ${buf.length} bytes`);
  console.log(`  compressed: ${gz.length} bytes -> ${OUTPUT_PATH}`);
  console.log('\nThe template is now bundled. The app builds draft-class files from it without');
  console.log('asking the user for a file. Re-run this tool against a fresh export only if the');
  console.log('bundled template needs to match a different Madden build (its schema tag above).');
}

main();
