// READ-ONLY. Compares how a CFB 27 DYNASTY and a Madden 27 FRANCHISE each store
// player likeness, to answer one question: now that EA ships its own CFB->Madden
// transfer, do the two games describe a player's appearance the same way?
//
// This is deliberately NOT about the draft-class export file. That file is a
// separate, narrower format, and the M27 one carries no tattoo slots at all.
// The question here is whether the two LIVE saves agree -- because if they do,
// the ceiling on likeness carry-over is set by the file we route through, not
// by the games themselves.
//
// Both games turn out to keep this in an identically-shaped CharacterVisuals
// table (two fields, Overflow + RawData) whose RawData is a ZSTD-compressed
// JSON blob -- the same blob shape the draft-class file embeds. So slot types
// and asset names are INSIDE the blob, not table columns; this walks the JSON.
//
// Run: node research/probe50-likenessParity.js [cfbSave] [maddenSave]
'use strict';

const path = require('path');
const { openCfbSave, openMaddenSave, biggestTableByName } = require('../lib/saveIO');

const HOME = require('os').homedir();
const CFB = process.argv[2]
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-MAINDYNASTY');
const MAD = process.argv[3]
  || path.join(HOME, 'Documents', 'Madden NFL 27', 'saves', 'CAREER-AUG10-07h58m08a-AUTOSAVE');

// Cap the rows read per save. Both tables run to thousands of ZSTD blobs and
// the vocabulary saturates long before then; this is a parity check, not a
// census, and it says so in the output.
const SAMPLE = Number(process.env.SAMPLE || 1200);

function walkLoadouts(json, onElement) {
  for (const lo of (json && json.loadouts) || []) {
    const type = lo.loadoutType || lo.loadoutCategory || '(none)';
    for (const el of lo.loadoutElements || []) onElement(type, el);
  }
}

async function inventory(label, file) {
  console.log(`\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`);
  const vt = biggestTableByName(file, 'CharacterVisuals');
  if (!vt) { console.log('  no CharacterVisuals table'); return null; }
  await vt.readRecords();

  const slots = new Map();       // slotType -> {rows, filled}
  const assetsBySlot = new Map();// slotType -> Set(asset)
  const containers = new Map();  // loadoutType -> count
  let read = 0, failed = 0, empty = 0;

  for (let i = 0; i < vt.records.length && read < SAMPLE; i++) {
    const rec = vt.records[i];
    if (!rec || rec.isEmpty) { empty++; continue; }
    let json;
    try {
      const raw = rec.getValueByKey('RawData');
      if (typeof raw !== 'string') { failed++; continue; }
      json = JSON.parse(raw);
    } catch (e) { failed++; continue; }
    read++;
    walkLoadouts(json, (type, el) => {
      containers.set(type, (containers.get(type) || 0) + 1);
      const slot = el.slotType || el.slot || '(unnamed)';
      const c = slots.get(slot) || { rows: 0, filled: 0 };
      c.rows++;
      const asset = el.itemAssetName;
      if (asset && String(asset).trim()) {
        c.filled++;
        const set = assetsBySlot.get(slot) || new Set();
        if (set.size < 400) set.add(String(asset));
        assetsBySlot.set(slot, set);
      }
      slots.set(slot, c);
    });
  }

  console.log(`  CharacterVisuals: ${vt.records.length} rows total; read ${read}, unreadable ${failed}, empty ${empty}`);
  console.log(`  loadout containers: ${[...containers.entries()].map(([k, v]) => `${k} (${v})`).join(', ')}`);
  console.log(`  distinct slotTypes: ${slots.size}`);
  const sorted = [...slots.entries()].sort((a, b) => b[1].rows - a[1].rows);
  for (const [slot, c] of sorted) {
    const tat = /tattoo/i.test(slot) ? '  <-- TATTOO' : '';
    const set = assetsBySlot.get(slot);
    const sample = set ? `  e.g. ${[...set].slice(0, 2).join(' | ')}` : '';
    console.log(`    ${slot.padEnd(24)} ${String(c.rows).padStart(6)} seen, ${String(c.filled).padStart(6)} filled, ${String(set ? set.size : 0).padStart(4)} distinct${tat}${sample}`);
  }
  const tattoo = sorted.filter(([s]) => /tattoo/i.test(s));
  console.log(`\n  TATTOO SLOTS: ${tattoo.length ? tattoo.map(([s, c]) => `${s} (${c.filled}/${c.rows} filled)`).join(', ') : 'NONE'}`);
  return { slots, assetsBySlot };
}

(async () => {
  console.log(`CFB dynasty  : ${CFB}`);
  console.log(`M27 franchise: ${MAD}`);
  console.log(`sample cap   : ${SAMPLE} rows per save`);

  const { cfbFile } = await openCfbSave(CFB);
  const cfb = await inventory('CFB 27 DYNASTY', cfbFile);
  const { maddenFile } = await openMaddenSave(MAD);
  const mad = await inventory('MADDEN 27 FRANCHISE', maddenFile);
  if (!cfb || !mad) return;

  console.log(`\n${'='.repeat(70)}\nPARITY\n${'='.repeat(70)}`);
  const cS = new Set(cfb.slots.keys()); const mS = new Set(mad.slots.keys());
  const shared = [...cS].filter((s) => mS.has(s)).sort();
  console.log(`  shared slotTypes   (${shared.length}): ${shared.join(', ') || '(none)'}`);
  console.log(`  CFB-only slotTypes (${[...cS].filter((s) => !mS.has(s)).length}): ${[...cS].filter((s) => !mS.has(s)).sort().join(', ') || '(none)'}`);
  console.log(`  M27-only slotTypes (${[...mS].filter((s) => !cS.has(s)).length}): ${[...mS].filter((s) => !cS.has(s)).sort().join(', ') || '(none)'}`);

  // The real question: on the slots both games have, do they name assets the
  // same way? Overlap near zero means EA's own transfer must be REMAPPING, not
  // copying -- which would mean there is no shared vocabulary to ride on.
  console.log('\n  asset-name overlap on shared slots (CFB distinct -> also in M27):');
  let tc = 0, ts = 0;
  for (const slot of shared) {
    const c = cfb.assetsBySlot.get(slot); const m = mad.assetsBySlot.get(slot);
    if (!c || !c.size) continue;
    const mm = m || new Set();
    const hit = [...c].filter((a) => mm.has(a));
    tc += c.size; ts += hit.length;
    const pct = ((hit.length / c.size) * 100).toFixed(0);
    console.log(`    ${slot.padEnd(24)} ${String(hit.length).padStart(4)}/${String(c.size).padEnd(4)} ${pct.padStart(3)}%${hit.length ? `   e.g. ${hit.slice(0, 2).join(' | ')}` : ''}`);
  }
  console.log(`\n  TOTAL: ${ts}/${tc} CFB asset names on shared slots also appear in M27 (${((ts / (tc || 1)) * 100).toFixed(1)}%)`);
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
