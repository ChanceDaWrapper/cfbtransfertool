'use strict';

// Converts an exported draft-class file between Madden 26 and Madden 27.
//
// Run with no arguments for an interactive picker -- it scans both games'
// Saves folders for CAREERDRAFT-* files, lists them, and walks you through
// the rest:
//
//   node tools/convertDraftClass.js
//
// Or skip the picker and give it a path directly (for scripting):
//
//   node tools/convertDraftClass.js <input> [output] [--to m26|m27]
//
// The target is inferred from the input (a Madden 26 file converts to 27 and
// vice versa) unless --to says otherwise. With no output path, the converted
// file defaults into the TARGET game's own Saves folder -- so it's already
// somewhere Madden's Import Draft Class browser will find it -- falling back
// to alongside the input if that folder isn't there.
//
// See lib/draftClassConvert.js for what actually differs between the two
// formats and how each gap is filled.

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const { convertDraftClassFile } = require('../lib/draftClassConvert');
const { parseDraftClassFile } = require('../lib/draftClassFile');
const { maddenSavesDirForYear } = require('../lib/saveIO');

const YEARS = [26, 27];

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage: node tools/convertDraftClass.js [<input> [output] [--to m26|m27]]

  (no arguments)  interactive -- pick a file from your Saves folders
  <input>         an exported draft-class file (CAREERDRAFT-*)
  [output]        where to write it; defaults into the target game's own
                  Saves folder
  --to            force the target game instead of inferring the opposite

Examples:
  node tools/convertDraftClass.js
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS"
  node tools/convertDraftClass.js "CAREERDRAFT-MYCLASS" "CAREERDRAFT-M27" --to m27
`);
  process.exit(msg ? 1 : 0);
}

// Where the default OUTPUT path lands when the caller doesn't name one: the
// target game's own Saves folder when it can be found (so the file is
// immediately visible to Madden's importer with no moving it around),
// falling back to right beside the input otherwise.
function defaultOutputPath(input, target) {
  const base = path.basename(input).replace(/^CAREERDRAFT-/i, '');
  const suffix = target ? target.toUpperCase() : 'CONVERTED';
  const name = `CAREERDRAFT-${base}-${suffix}`;
  const targetYear = target === 'm27' ? 27 : target === 'm26' ? 26 : null;
  const dir = (targetYear && maddenSavesDirForYear(targetYear)) || path.dirname(input);
  return path.join(dir, name);
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

// Scans both games' Saves folders for CAREERDRAFT-* files, newest first.
// Read-only -- this never touches anything, only lists what's there.
function findCandidates() {
  const groups = [];
  for (const year of YEARS) {
    const dir = maddenSavesDirForYear(year);
    if (!dir || !fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    const files = entries
      .filter((n) => /^CAREERDRAFT-/i.test(n))
      .map((n) => {
        const full = path.join(dir, n);
        let stat; try { stat = fs.statSync(full); } catch (e) { return null; }
        return stat && stat.isFile() ? { name: n, path: full, size: stat.size, mtime: stat.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) groups.push({ year, dir, files });
  }
  return groups;
}

function fmtSize(n) { return `${(n / 1024).toFixed(0)} KB`; }
function fmtDate(ms) { return new Date(ms).toLocaleString(); }

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
      const groups = findCandidates();

      if (!groups.length) {
        console.log('No CAREERDRAFT-* files found in your Madden Saves folders.');
        console.log('(Checked Madden NFL 26 and 27 -- export one from Madden first, or pass a path directly:');
        console.log('  node tools/convertDraftClass.js "<path to your exported file>")\n');
        return;
      }

      const flat = [];
      for (const g of groups) {
        console.log(`Madden ${g.year}  (${g.dir})`);
        for (const f of g.files) {
          flat.push(f);
          console.log(`  ${String(flat.length).padStart(2)}) ${f.name.padEnd(32)} ${fmtSize(f.size).padStart(9)}   ${fmtDate(f.mtime)}`);
        }
        console.log('');
      }
      console.log('   0) Enter a file path manually\n');

      let input = null;
      while (!input) {
        const raw = await ask('Pick a file to convert: ');
        if (raw === null) return; // stdin closed
        const pick = raw.trim();
        if (pick === '0') {
          const rawPath = await ask('File path: ');
          if (rawPath === null) return;
          const p = rawPath.trim().replace(/^"(.*)"$/, '$1');
          if (!p) continue;
          if (!fs.existsSync(p)) { console.log(`  Not found: ${p}\n`); continue; }
          input = p;
        } else {
          const n = Number(pick);
          if (Number.isInteger(n) && n >= 1 && n <= flat.length) input = flat[n - 1].path;
          else console.log('  Not a valid choice.\n');
        }
      }

      const info = peek(input);
      if (info) {
        console.log(`\nSelected: ${path.basename(input)}`);
        console.log(`  ${info.from.toUpperCase()}, ${info.players} players, ${info.schemaTag}`);
        const to = info.from === 'm26' ? 'm27' : 'm26';
        console.log(`  Will convert to: ${to.toUpperCase()}\n`);

        const out = defaultOutputPath(input, to);
        const rawOut = await ask(`Output file [${out}]: `);
        if (rawOut === null) return;
        const chosen = rawOut.trim().replace(/^"(.*)"$/, '$1');
        const outputPath = chosen || out;

        console.log('');
        try { runOne(input, outputPath, to); }
        catch (e) { console.error(`\nConversion failed: ${e.message}\n`); }
      } else {
        console.log(`\nCould not read "${path.basename(input)}" as a draft-class file -- it may not be one.\n`);
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

// ---------------------------------------------------------------------
// Entry point: interactive with no arguments, direct with any.
// ---------------------------------------------------------------------
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
    const output = positional[1] || defaultOutputPath(input, inferredTarget);
    runOne(input, output, target);
  } catch (e) {
    console.error(`\nConversion failed: ${e.message}\n`);
    process.exit(1);
  }
}
