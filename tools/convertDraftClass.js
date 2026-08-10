'use strict';

// Converts an exported draft-class file between Madden 26 and Madden 27.
//
//   node tools/convertDraftClass.js <input> [output] [--to m26|m27]
//
// The target is inferred from the input (a Madden 26 file converts to 27 and
// vice versa) unless --to says otherwise. With no output path, the converted
// file lands beside the input with the target game in its name.
//
// See lib/draftClassConvert.js for what actually differs between the two
// formats and how each gap is filled.

const fs = require('fs');
const path = require('path');
const { convertDraftClassFile } = require('../lib/draftClassConvert');

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage: node tools/convertDraftClass.js <input> [output] [--to m26|m27]

  <input>    an exported draft-class file (CAREERDRAFT-*)
  [output]   where to write it; defaults to alongside the input
  --to       force the target game instead of inferring the opposite

Examples:
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS"
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS" "CAREERDRAFT-M27" --to m27
`);
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) usage();

let target = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--to') { target = args[++i]; continue; }
  if (args[i].startsWith('--to=')) { target = args[i].slice(5); continue; }
  positional.push(args[i]);
}

const input = positional[0];
if (!input) usage('No input file given.');
if (!fs.existsSync(input)) usage(`Input file not found: ${input}`);

try {
  // Default output name states the game it is FOR, since the two formats are
  // not interchangeable and the files are otherwise easy to mix up.
  const output = positional[1] || (() => {
    const dir = path.dirname(input);
    const base = path.basename(input).replace(/^CAREERDRAFT-/i, '');
    const suffix = target ? target.toUpperCase() : 'CONVERTED';
    return path.join(dir, `CAREERDRAFT-${base}-${suffix}`);
  })();

  const r = convertDraftClassFile(input, output, { target, log: (m) => console.log(m) });

  console.log('');
  console.log(`  from        ${r.from.toUpperCase()}  (${r.sourceSchemaTag})`);
  console.log(`  to          ${r.to.toUpperCase()}`);
  console.log(`  players     ${r.converted} converted of ${r.sourcePlayers}`
    + (r.dropped ? `, ${r.dropped} dropped (no slot)` : ''));
  console.log(`  slots       ${r.slotCount}` + (r.leftover ? `, ${r.leftover} kept the template's prospects` : ''));
  if (r.warnings.length) console.log(`  warnings    ${r.warnings.length}`);
  console.log(`  written     ${r.outputPath}`);
  console.log('');
} catch (e) {
  console.error(`\nConversion failed: ${e.message}\n`);
  process.exit(1);
}
