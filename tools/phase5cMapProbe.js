// Phase 5c-map: field-mapping PROBE for the import -> read-roster loop
// (FACES_AND_DRAFT_ROADMAP.md, "PHASE 5 RESTRUCTURE"). NOT shipped -- a research
// instrument built only from existing tested primitives (setBinaryBytes /
// setBinaryName). Writes NO speculative field code.
//
// What it does: on the bundled template, it renames 3 findable probe players and
// fills every UNKNOWN byte of their 200-byte struct (offsets 50..145, skipping
// the already-solved Age/Height/Weight/Position at 70/71/72/74) with a distinct
// sentinel value = (offset - 46). That ramp is unique per offset and lands in the
// 4..99 range (valid for ratings), so after import every Madden field that shows
// value V was written by byte offset (V + 46). Known fields (name/pos/H/W/age/face)
// are left correct so they double as confirmation.
//
// The loop:
//   1. node tools/phase5cMapProbe.js   -> writes CAREERDRAFT-mapprobe to Desktop
//      (and the sentinel key to scratchpad so we can decode the readback).
//   2. User imports it into a real franchise, sims/runs the draft so the probe
//      players become rookie Player rows, and saves the franchise.
//   3. We open that franchise save with madden-franchise, find the 3 probe
//      rookies by name, and read every field -> offset->field map, definitively.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { serializeDraftClassFile, setBinaryBytes, setBinaryName, getPosition, getHeight, getWeight } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

const SKIP = new Set([70, 71, 72, 74]); // Age, Height, Weight, Position -- already solved; keep correct
const OFF_LO = 50, OFF_HI = 145;
const SENTINEL = (off) => off - 46; // unique per offset, range 4..99

// Only sentinel offsets that actually VARY across the 402 template players --
// those are the real per-player fields (ratings, dev trait, etc.). Offsets that
// are constant across the whole template are likely structural markers (e.g. the
// fixed 127 at 103, 50 at 139) or fields that don't differentiate prospects;
// leaving them untouched keeps the import safe and the probe targeted.
function varyingOffsets(model) {
  const out = [];
  for (let off = OFF_LO; off <= OFF_HI; off++) {
    if (SKIP.has(off)) continue;
    const first = model.players[0].binary.raw[off];
    if (model.players.some((p) => p.binary.raw[off] !== first)) out.push(off);
  }
  return out;
}

// 3 probe players: distinct, easy-to-search names that fit within the original
// allocation of the template players we overwrite (indices 0,1,2).
const PROBES = [
  { idx: 0, first: 'Probe', last: 'Alpha' },
  { idx: 1, first: 'Probe', last: 'Bravo' },
  { idx: 2, first: 'Probe', last: 'Delta' },
];

function main() {
  const model = loadTemplateModel();
  const key = {}; // offset -> sentinel value (identical for all 3 probes)
  for (const off of varyingOffsets(model)) key[off] = SENTINEL(off);

  const preserved = [];
  for (const pr of PROBES) {
    let p = model.players[pr.idx];
    const known = { position: getPosition(p), height: getHeight(p), weight: getWeight(p) };
    p = setBinaryBytes(p, Object.entries(key).map(([off, value]) => ({ offset: Number(off), value })));
    p = setBinaryName(p, 'firstName', pr.first);
    p = setBinaryName(p, 'lastName', pr.last);
    model.players[pr.idx] = p;
    preserved.push({ name: `${pr.first} ${pr.last}`, ...known });
  }

  const buf = serializeDraftClassFile(model);
  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();
  const outPath = path.join(outDir, 'CAREERDRAFT-mapprobe');
  fs.writeFileSync(outPath, buf);

  // Persist the sentinel key so the readback step can decode field->offset.
  const scratchKey = process.env.MAPPROBE_KEY_OUT || path.join(os.tmpdir(), 'mapprobe-key.json');
  fs.writeFileSync(scratchKey, JSON.stringify({ key, sentinelFormula: 'value = offset - 46, so offset = value + 46', probes: preserved }, null, 2));

  console.log(`Wrote ${outPath} (${buf.length} bytes).`);
  console.log(`Sentinel key written to ${scratchKey}`);
  console.log(`\n3 probe players (search the roster for these rookies after the draft):`);
  for (const p of preserved) console.log(`  ${p.name}  (should stay: position ${p.position}, ${p.height}in, ${p.weight}lb)`);
  console.log(`\nSentineled ${Object.keys(key).length} offsets (50..145 minus Age/Height/Weight/Position).`);
  console.log(`Decode after readback: a Madden field showing value V was written by byte offset (V + 46).`);
  console.log(`\nNext: import this into a franchise, sim the draft so these become rookies, save the`);
  console.log(`franchise, and point me at the CAREER-* save file -- I'll read the 3 probe rookies and`);
  console.log(`lock the offset->field map.`);
}

main();
