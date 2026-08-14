'use strict';

// Converts an exported draft-class file between Madden 26 and Madden 27.
//
// Run with no arguments and it asks you to DRAG THE FILE into the window:
//
//   node tools/convertDraftClass.js
//
// Or give it a path directly (for scripting):
//
//   node tools/convertDraftClass.js <input> [output] [--to m26|m27]
//
// The target is inferred from the input's own schema tag (a Madden 26 file
// converts to 27 and vice versa) unless --to says otherwise.
//
// NOTHING IS AUTO-LOCATED. An earlier version scanned both games' Saves
// folders to list files to pick from, and defaulted the output INTO the
// target game's Saves folder. Both were reported as unreliable in practice
// -- that discovery has to guess through OneDrive-redirected Documents
// folders, a "Saves" vs "saves" casing difference between the two games, and
// multiple installs, and when it guesses wrong the file silently lands
// somewhere the user never looks. Dragging the file in states exactly which
// file is meant, and the output is written next to that same file, so the
// result is always somewhere already open on screen. Moving it into Madden's
// Saves folder is one obvious drag the user can do themselves and see
// succeed.
//
// The output name can be ANYTHING -- a plain name with no path lands beside
// the input; a full path saves it wherever you point it. Either way it always
// ends up starting with "CAREERDRAFT-" (Madden's importer only lists files
// named that), adding the prefix automatically if you didn't type it.
//
// See lib/draftClassConvert.js for what actually differs between the two
// formats and how each gap is filled.

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const { convertDraftClassFile } = require('../lib/draftClassConvert');
const { parseDraftClassFile } = require('../lib/draftClassFile');

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage: node tools/convertDraftClass.js [<input> [output] [--to m26|m27]]

  (no arguments)  interactive -- drag your draft-class file into the window
  <input>         an exported draft-class file (CAREERDRAFT-*)
  [output]        where to write it; defaults to beside the input file
  --to            force the target game instead of inferring the opposite

Examples:
  node tools/convertDraftClass.js
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS"
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS" "CAREERDRAFT-M27" --to m27
`);
  process.exit(msg ? 1 : 0);
}

// Cleans up a path as a terminal hands it over after a drag-and-drop.
// Windows wraps a dragged path in double quotes when it contains spaces;
// PowerShell uses single quotes in some cases; either way a trailing space is
// left behind after the drop, and users often paste quoted paths by hand too.
// Quotes are only stripped when they WRAP the whole string, so a path that
// legitimately contains a quote character is left alone.
function cleanDroppedPath(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1)
    || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

// A typed answer with no directory in it (just a name) keeps the SAME
// directory `fallbackFullPath` was already going to use -- confirmed as a
// real bug before this existed: typing a bare name resolved it against
// whatever the terminal's CURRENT WORKING DIRECTORY happened to be (the
// project folder itself, when launched via the Desktop shortcut), not the
// Saves folder the default was pointing at, so the file landed somewhere
// the user would never think to look. `convertDraftClassFile` still adds the
// CAREERDRAFT- prefix if it's missing either way -- that part already
// worked -- this only fixes WHERE a bare name lands, not naming itself.
function resolveOutputPath(typed, fallbackFullPath) {
  if (!typed) return fallbackFullPath;
  return path.dirname(typed) === '.'
    ? path.join(path.dirname(fallbackFullPath), typed)
    : typed;
}

// Where the default OUTPUT lands: right next to the INPUT file, always.
//
// Deliberately not the target game's Saves folder, even though that would
// save a manual move -- see the header. Locating that folder means guessing
// through OneDrive redirection, a casing difference between the two games,
// and multiple installs, and a wrong guess writes the file somewhere the
// user will never find it. Beside the input is somewhere they definitionally
// just had open, so the result is never lost even when the guess would have
// been wrong.
function defaultOutputPath(input, target) {
  const base = path.basename(input).replace(/^CAREERDRAFT-/i, '');
  const suffix = target ? target.toUpperCase() : 'CONVERTED';
  return path.join(path.dirname(input), `CAREERDRAFT-${base}-${suffix}`);
}

// Runs one conversion and prints the same report shape either code path uses.
function runOne(input, output, target) {
  const r = convertDraftClassFile(input, output, { target, log: (m) => console.log(`  ${m}`) });
  console.log('');
  console.log(`  from        ${r.from.toUpperCase()}  (${r.sourceSchemaTag})`);
  console.log(`  to          ${r.to.toUpperCase()}`);
  console.log(`  players     ${r.converted} converted of ${r.sourcePlayers}`
    + (r.dropped ? `, ${r.dropped} dropped (no slot)` : ''));
  console.log(`  slots       ${r.slotCount}` + (r.leftover ? `, ${r.leftover} kept the template's prospects` : ''));
  if (r.warnings.length) console.log(`  warnings    ${r.warnings.length}`);
  console.log(`  written     ${r.outputPath}`);
  console.log('');
  return r;
}

// A quick, best-effort identification for the picker's "Selected:" line --
// swallows a parse failure rather than blocking the picker on a file that
// turns out not to be a real draft-class export (the conversion step itself
// gives the real error).
function peek(filePath) {
  try {
    const j = parseDraftClassFile(fs.readFileSync(filePath));
    return { players: j.players.length, schemaTag: j.header.schemaTag, from: j.format.key };
  } catch (e) {
    return null;
  }
}

// Reads answers via a SINGLE async iterator over one readline interface,
// rather than repeated `rl.question()` calls -- chained `.question()` calls
// are unreliable once stdin is a non-TTY pipe (confirmed directly: with
// piped input, only the FIRST call in a sequence ever resolves; every one
// after it hangs and the process exits without asking). One iterator,
// consumed manually one line at a time, does not have that problem and is
// Node's own documented idiom for reading multiple lines from stdin.
function makeAsker(rl) {
  const it = rl[Symbol.asyncIterator]();
  return async function ask(promptText) {
    process.stdout.write(promptText);
    const { value, done } = await it.next();
    return done ? null : value; // null only on stdin closing (e.g. Ctrl+D)
  };
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);
  try {
    for (;;) {
      console.log('\nPipeline Draft-Class Converter\n');
      console.log('Drag your draft-class file into this window and press Enter.');
      console.log('(the CAREERDRAFT-... file you exported from Madden)\n');

      // Loops rather than exiting on a bad answer: a mistyped or mis-dropped
      // path is the single most likely thing to go wrong here, and making the
      // user relaunch the whole tool over it would be needless.
      let input = null;
      while (!input) {
        const raw = await ask('File: ');
        if (raw === null) return; // stdin closed (Ctrl+D / piped input ended)
        const p = cleanDroppedPath(raw);
        if (!p) continue; // bare Enter -- just ask again
        if (!fs.existsSync(p)) { console.log(`  Not found: ${p}\n`); continue; }
        if (!fs.statSync(p).isFile()) { console.log('  That is a folder, not a file.\n'); continue; }
        input = p;
      }

      const info = peek(input);
      if (info) {
        const to = info.from === 'm26' ? 'm27' : 'm26';
        console.log(`\n  ${path.basename(input)}`);
        console.log(`  ${info.from.toUpperCase()}, ${info.players} players`);
        console.log(`  Converting to ${to.toUpperCase()}\n`);

        const out = defaultOutputPath(input, to);
        console.log(`Output name (Enter to accept, or type a name / full path)`);
        const rawOut = await ask(`  [${path.basename(out)}]: `);
        if (rawOut === null) return;
        const outputPath = resolveOutputPath(cleanDroppedPath(rawOut), out);

        console.log('');
        try { runOne(input, outputPath, to); }
        catch (e) { console.error(`\nConversion failed: ${e.message}\n`); }
      } else {
        console.log(`\n  Could not read "${path.basename(input)}" as a draft-class file.`);
        console.log('  Make sure it is a CAREERDRAFT-... file exported from Madden.\n');
      }

      const rawAgain = await ask('Convert another file? (y/N): ');
      if (rawAgain === null) return;
      const again = rawAgain.trim().toLowerCase();
      if (again !== 'y' && again !== 'yes') return;
    }
  } finally {
    rl.close();
  }
}

module.exports = { resolveOutputPath, defaultOutputPath, cleanDroppedPath };

// ---------------------------------------------------------------------
// Entry point: interactive with no arguments, direct with any. Guarded so
// requiring this file (test/convertDraftClass.spec.js does, to reach
// resolveOutputPath directly) doesn't launch the picker or read argv --
// this only runs when the file is the process's actual entry point, i.e.
// `node tools/convertDraftClass.js`.
// ---------------------------------------------------------------------
if (require.main !== module) return;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) usage();

if (!args.length) {
  interactive().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
} else {
  let target = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to') { target = args[++i]; continue; }
    if (args[i].startsWith('--to=')) { target = args[i].slice(5); continue; }
    positional.push(args[i]);
  }

  const input = positional[0];
  if (!fs.existsSync(input)) usage(`Input file not found: ${input}`);

  try {
    const inferredTarget = target || (peek(input)?.from === 'm26' ? 'm27' : 'm26');
    const dflt = defaultOutputPath(input, inferredTarget);
    // Same rule the interactive picker applies: a bare filename with no
    // directory in it keeps the default's directory rather than resolving
    // against whatever the shell's CWD happens to be at invocation time.
    const output = resolveOutputPath(positional[1], dflt);
    runOne(input, output, target);
  } catch (e) {
    console.error(`\nConversion failed: ${e.message}\n`);
    process.exit(1);
  }
}
