// READ-ONLY. Does a CFB 27 FACE survive into Madden 27, and by what route?
//
// probe50 showed the two games share a CharacterVisuals blob shape and ~71% of
// their GEAR asset vocabulary. It also showed 19 slot types M27 has that a CFB
// DYNASTY does not -- and almost all of them are face structure (Face, Hair,
// Eyes, Nose, Jaw, Chin, Cheek, Ears, Eyebrow, Mouth, FacialHair, CustomHead,
// PlusHead, CharacterBodyType). That gap is the whole question here.
//
// A dynasty is the wrong place to look for it. Dynasty players are generated
// from head presets; Road to Glory is CFB's face-CREATOR mode, and a coach is
// its own separate case (the app already records that CFB coach blobs carry no
// head loadout at all -- see lib/carousel/appearance.js). So this compares four
// save kinds side by side and asks, per slot: does it exist, and do the two
// games name the assets the same way?
//
// Run: node research/probe51-faceParity.js
'use strict';

const path = require('path');
const fs = require('fs');
const { openCfbSave, openMaddenSave, biggestTableByName } = require('../lib/saveIO');

const HOME = require('os').homedir();
const CFBDIR = path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves');
const MADDIR = path.join(HOME, 'Documents', 'Madden NFL 27', 'saves');

// The slots that describe a FACE rather than kit. Everything probe50 found on
// the M27-only list, plus the head-asset slots both games use for presets.
const FACE_SLOTS = /^(Face|FacialHair|Hair|Mouth|Eyes|Eyebrow|Nose|Jaw|Chin|Cheek|Ears|CustomHead|PlusHead|CharacterBodyType|Head)$/i;

// NOTE on CAREER-STARTTODAYPLUSREALISTIC, which lives in the CFB saves folder:
// it is NOT a CFB save. Opened as Madden it reports gameYear 26, schema major
// 682, and carries Madden-only tables (DraftPick, PlayerReSignNegotiation); its
// coach heads read coachhead_M_0178_HS. An earlier run of this probe listed it
// as "CFB27 CAREER (coach)" and its Madden-style head names looked like CFB and
// Madden sharing a coach-head vocabulary -- i.e. like a direct contradiction of
// the zero-overlap finding recorded in lib/carousel/appearance.js. That was an
// artifact of the mislabel: it was Madden being compared against Madden. The
// real CFB dynasty (schema major 809) still reads Generic_0103_C_T0102_H_2_3 /
// Unique_C_AltmanGarrett_900, and appearance.js's finding stands. Left listed,
// correctly labelled, precisely so the trap is documented rather than re-set.
const SAVES = [
  ['CFB27 DYNASTY', path.join(CFBDIR, 'DYNASTY-MAINDYNASTY'), 'cfb'],
  ['CFB27 ROAD TO GLORY', path.join(CFBDIR, 'RTG-JUL25-12h11m31pm-AUTOSAVE'), 'cfb'],
  ['MADDEN 26 save misfiled in the CFB folder', path.join(CFBDIR, 'CAREER-STARTTODAYPLUSREALISTIC'), 'madden'],
  ['M27 FRANCHISE', path.join(MADDIR, 'CAREER-AUG10-07h58m08a-AUTOSAVE'), 'madden'],
];

async function scan(label, savePath, kind) {
  if (!fs.existsSync(savePath)) return { label, missing: true };
  const opened = kind === 'cfb' ? await openCfbSave(savePath) : await openMaddenSave(savePath);
  const file = opened.cfbFile || opened.maddenFile;
  const vt = biggestTableByName(file, 'CharacterVisuals');
  if (!vt) return { label, missing: true };
  await vt.readRecords();

  const containers = new Map();
  const faceSlots = new Map();  // slot -> Set(asset)
  let rows = 0;
  for (const rec of vt.records) {
    if (!rec || rec.isEmpty) continue;
    let j;
    try {
      const r = rec.getValueByKey('RawData');
      if (typeof r !== 'string') continue;
      j = JSON.parse(r);
    } catch (e) { continue; }
    rows++;
    for (const lo of j.loadouts || []) {
      const t = lo.loadoutType || lo.loadoutCategory || '(none)';
      containers.set(t, (containers.get(t) || 0) + 1);
      for (const el of lo.loadoutElements || []) {
        const s = el.slotType || '';
        if (!FACE_SLOTS.test(s)) continue;
        const set = faceSlots.get(s) || new Set();
        if (el.itemAssetName && set.size < 3000) set.add(String(el.itemAssetName));
        faceSlots.set(s, set);
      }
    }
  }
  return { label, rows, total: vt.records.length, containers, faceSlots };
}

(async () => {
  const results = [];
  for (const [label, p, kind] of SAVES) {
    try { results.push(await scan(label, p, kind)); } catch (e) {
      results.push({ label, error: e.message });
    }
  }

  for (const r of results) {
    console.log(`\n${'='.repeat(72)}\n${r.label}\n${'='.repeat(72)}`);
    if (r.missing) { console.log('  (save not found)'); continue; }
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
    console.log(`  CharacterVisuals rows parsed: ${r.rows} / ${r.total}`);
    console.log(`  containers: ${[...r.containers.entries()].map(([k, v]) => `${k} (${v})`).join(', ')}`);
    if (!r.faceSlots.size) { console.log('  FACE SLOTS: none'); continue; }
    console.log('  FACE SLOTS:');
    for (const [s, set] of [...r.faceSlots.entries()].sort()) {
      console.log(`    ${s.padEnd(20)} ${String(set.size).padStart(5)} distinct   e.g. ${[...set].slice(0, 3).join(' | ')}`);
    }
  }

  // The comparison that matters: any CFB save vs the M27 franchise, per slot.
  const mad = results.find((r) => r.label === 'M27 FRANCHISE');
  if (!mad || !mad.faceSlots) return;
  console.log(`\n${'='.repeat(72)}\nFACE VOCABULARY OVERLAP vs M27 FRANCHISE\n${'='.repeat(72)}`);
  for (const r of results) {
    if (!r.faceSlots || r === mad) continue;
    console.log(`\n  ${r.label}`);
    let any = false;
    for (const [s, set] of [...r.faceSlots.entries()].sort()) {
      const m = mad.faceSlots.get(s);
      if (!m) { console.log(`    ${s.padEnd(20)} slot ABSENT in M27`); any = true; continue; }
      const hit = [...set].filter((a) => m.has(a));
      console.log(`    ${s.padEnd(20)} ${String(hit.length).padStart(4)}/${String(set.size).padEnd(5)} names shared${hit.length ? `   e.g. ${hit.slice(0, 2).join(' | ')}` : '   <-- ZERO OVERLAP'}`);
      any = true;
    }
    if (!any) console.log('    (no face slots at all)');
  }
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
