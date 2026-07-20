// Phase 5d real-class build (FACES_AND_DRAFT_ROADMAP.md "PHASE 5 RESTRUCTURE").
// NOT shipped -- a manual tool to produce a full, real CAREERDRAFT-* file from an
// actual CFB save, for the final in-game validation pass (5e).
//
// Runs the real extraction + generation pipeline (exit-mode population, same as
// the app), then buildDraftClassFile to patch all 402 template slots with real
// generated players -- name, position, archetype, age/jersey/H/W, dev trait,
// draft round/pick, all 55 ratings, body type, and a real render-band face.
//
// Usage: node tools/phase5dBuildRealClass.js <path-to-a-real-CFB27-dynasty-save>

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractLeavingPlayers, generateClass } = require('../lib/pipeline');
const { buildDraftClassFile } = require('../lib/draftClassExporter');

async function main() {
  const cfbPath = process.argv[2];
  if (!cfbPath) {
    console.error('Usage: node tools/phase5dBuildRealClass.js <path-to-a-real-CFB27-dynasty-save>');
    process.exit(1);
  }
  console.log(`Extracting departed players from: ${cfbPath}`);
  const departed = await extractLeavingPlayers(cfbPath, () => {}, { populationMode: 'exit' });
  console.log(`  ${departed.length} departed players found.`);

  const config = { general: { seed: 'phase5d-real-class' }, translation: { strategy: 'powercurve' } };
  const generated = generateClass(departed, config, () => {});
  console.log(`  Generated class: ${generated.length} players.`);

  const warnings = [];
  const buf = buildDraftClassFile(generated, { log: (m) => warnings.push(m) });
  console.log(`Built draft-class file: ${buf.length} bytes.`);
  if (warnings.length) {
    console.log(`  ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 20)) console.log(`    ${w}`);
  } else {
    console.log('  0 warnings (no name truncation, no body-type failures).');
  }

  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outputPath = path.join(outDir, 'CAREERDRAFT-fullclass');
  fs.writeFileSync(outputPath, buf);
  console.log(`\nWrote ${outputPath}`);
  console.log('\nNext: import this into Madden via "Import Draft Class" and check the full class --');
  console.log('names, positions, sizes, ratings, dev traits, faces, no corruption, all 402 present.');
}

main().catch((e) => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
