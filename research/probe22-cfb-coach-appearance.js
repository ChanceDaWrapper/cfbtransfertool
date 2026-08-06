// READ-ONLY. The Madden side of skin tone is solved (200-head measured
// catalog). The CFB side is the remaining gap: 231 of 497 CFB coaches use
// Unique_* heads that encode no tone digit, and those are exactly the marquee
// coaches people actually want to transfer.
//
// This probe asks, of the CFB save alone:
//   1. what appearance-ish fields does the CFB Coach table even have?
//   2. does CFB carry a Portrait / portrait-id field we could measure like we
//      did for Madden?
//   3. what's inside a CFB coach's CharacterVisuals blob -- any skinTone,
//      any head loadout, anything tone-bearing?
//   4. how do Generic_* vs Unique_* actually break down, and is there any
//      other field that correlates with the tone digit we CAN read?
//
// Nothing is modified.

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const OUT = path.join(__dirname, 'out');

const GENERIC = /^Generic_(\d+)_C_T(\d+)_([A-Z]+)_(\d)_(\d+)$/;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const file = await FranchiseFile.create(CFB, { autoUnempty: true });
  const t = biggestTableByName(file, 'Coach');
  await t.readRecords();

  // --- 1. schema ------------------------------------------------------------
  const fields = t.offsetTable.map((o) => ({
    name: o.name, type: o.type, bits: o.length,
    min: o.minValue, max: o.maxValue, enum: !!o.enum,
  }));
  const interesting = fields.filter((f) => /head|face|portrait|visual|skin|tone|ethnic|race|complexion|body|hair|asset|appearance|photo|image/i.test(f.name));
  console.log(`=== CFB Coach table: ${fields.length} fields ===`);
  console.log('appearance-ish fields:');
  for (const f of interesting) console.log(`   ${f.name.padEnd(34)} ${f.type.padEnd(10)} ${f.bits}b  [${f.min}..${f.max}]${f.enum ? ' enum' : ''}`);

  // --- 2. head-name breakdown ----------------------------------------------
  const rows = [];
  for (let i = 0; i < t.records.length; i++) {
    const r = t.records[i];
    if (!r || r.isEmpty) continue;
    const name = safe(r, 'Name');
    if (!name) continue;
    rows.push({
      row: i, name,
      position: safe(r, 'Position'),
      head: safe(r, 'GenericHeadAssetName'),
      portrait: safe(r, 'Portrait'),
      face: safe(r, 'FaceShape'),
      team: safe(r, 'TeamIndex'),
    });
  }
  console.log(`\n=== ${rows.length} CFB coaches ===`);

  const generic = rows.filter((r) => GENERIC.test(String(r.head)));
  const unique = rows.filter((r) => /^Unique_/.test(String(r.head)));
  const other = rows.filter((r) => !GENERIC.test(String(r.head)) && !/^Unique_/.test(String(r.head)));
  console.log(`Generic_*: ${generic.length}   Unique_*: ${unique.length}   other: ${other.length}`);
  if (other.length) console.log('  other heads:', [...new Set(other.map((r) => r.head))].slice(0, 15).join(', '));

  // --- 3. does CFB have a usable Portrait id? ------------------------------
  const portraits = rows.map((r) => r.portrait).filter((v) => typeof v === 'number');
  if (portraits.length) {
    const uniq = [...new Set(portraits)].sort((a, b) => a - b);
    console.log(`\nPortrait field: ${portraits.length} values, ${uniq.length} distinct, range ${uniq[0]}..${uniq[uniq.length - 1]}`);
    console.log('  first 25:', uniq.slice(0, 25).join(' '));
    // Is Portrait predictable from the Generic index, the way Madden's is?
    const withIdx = generic.filter((r) => typeof r.portrait === 'number')
      .map((r) => ({ idx: Number(r.head.match(GENERIC)[1]), p: r.portrait }));
    const deltas = [...new Set(withIdx.map((x) => x.p - x.idx))];
    console.log(`  Portrait - GenericIndex distinct deltas: ${deltas.length}` + (deltas.length <= 6 ? ` -> ${deltas.join(' ')}` : ''));
  } else {
    console.log('\nNo numeric Portrait field on CFB coaches.');
  }

  // --- 4. tone digit distribution among the readable ones ------------------
  const toneCount = {};
  for (const r of generic) {
    const tone = r.head.match(GENERIC)[4];
    toneCount[tone] = (toneCount[tone] || 0) + 1;
  }
  console.log('\ntone digit distribution (Generic_* only):');
  for (const k of Object.keys(toneCount).sort()) console.log(`   tone ${k}: ${toneCount[k]}`);

  // Does the T<texture> number correlate with tone? If it does, and Unique_*
  // heads also carry a texture id somewhere, that'd be a second signal.
  const byTone = {};
  for (const r of generic) {
    const m = r.head.match(GENERIC);
    (byTone[m[4]] = byTone[m[4]] || []).push(Number(m[2]));
  }
  console.log('\nT<texture> range per tone digit:');
  for (const k of Object.keys(byTone).sort()) {
    const v = byTone[k].sort((a, b) => a - b);
    console.log(`   tone ${k}: T${v[0]}..T${v[v.length - 1]}  (${[...new Set(v)].length} distinct)`);
  }

  // --- 5. CharacterVisuals contents ---------------------------------------
  console.log('\n=== CharacterVisuals blobs ===');
  const sample = [generic[0], unique[0], unique[1], unique[2]].filter(Boolean);
  let visualsTableId = null;
  for (const s of sample) {
    const rec = t.records[s.row];
    let ref; try { ref = rec.getReferenceDataByKey('CharacterVisuals'); } catch (e) { ref = null; }
    if (!ref || (!ref.tableId && !ref.rowNumber)) { console.log(`  ${s.name}: no CharacterVisuals ref`); continue; }
    visualsTableId = ref.tableId;
    const vt = file.getTableById(ref.tableId);
    await vt.readRecords();
    const vrec = vt.records[ref.rowNumber];
    const raw = vrec && safe(vrec, 'RawData');
    if (typeof raw !== 'string') { console.log(`  ${s.name}: no RawData`); continue; }
    let j; try { j = JSON.parse(raw); } catch (e) { console.log(`  ${s.name}: unparseable`); continue; }
    const topKeys = Object.keys(j);
    const loadoutTypes = (j.loadouts || []).map((l) => l.loadoutType || l.loadoutCategory);
    console.log(`  ${s.name} (${s.head})`);
    console.log(`     top keys: ${topKeys.join(', ')}`);
    console.log(`     loadouts: ${loadoutTypes.join(', ') || '(none)'}`);
    for (const k of topKeys) if (/skin|tone|complexion|ethnic|race/i.test(k)) console.log(`     >>> ${k} = ${JSON.stringify(j[k])}`);
    // any head-ish item anywhere in the blob?
    const heads = [];
    for (const lo of (j.loadouts || [])) for (const el of (lo.loadoutElements || [])) {
      if (/head|face/i.test(el.slotType || '')) heads.push(`${el.slotType}=${el.itemAssetName}`);
    }
    console.log(`     head elements: ${heads.join(', ') || '(none)'}`);
    fs.writeFileSync(path.join(OUT, `cfb-visuals-${s.name.replace(/\W/g, '')}.json`), JSON.stringify(j, null, 2));
  }

  // --- 6. scan EVERY blob for any tone-bearing key ------------------------
  if (visualsTableId) {
    const vt = file.getTableById(visualsTableId);
    await vt.readRecords();
    const keyCounts = new Map();
    let parsed = 0;
    for (const rec of vt.records) {
      if (!rec || rec.isEmpty) continue;
      const raw = safe(rec, 'RawData');
      if (typeof raw !== 'string') continue;
      let j; try { j = JSON.parse(raw); } catch (e) { continue; }
      parsed++;
      for (const k of Object.keys(j)) keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    console.log(`\n=== all top-level keys across ${parsed} CFB visuals blobs ===`);
    for (const [k, n] of [...keyCounts].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(6)}  ${k}`);
  }

  fs.writeFileSync(path.join(OUT, 'cfb-coach-appearance.json'), JSON.stringify(rows, null, 2));
  console.log(`\nwrote research/out/cfb-coach-appearance.json (${rows.length} coaches)`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
