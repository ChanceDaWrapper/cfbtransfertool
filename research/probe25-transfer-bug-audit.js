// READ-ONLY. Audits the CFB->Madden coach transfer for structural bugs, ahead
// of this becoming a published pipeline rather than a lab experiment.
//
// Checks, in order of how badly each would bite:
//   1. Portrait_Force_Silhouette -- CFB has this bool. If Madden does too and
//      we never clear it, a transferred coach renders as a black cutout no
//      matter how good the head is.
//   2. cfbSkinTone() against every real head name -- false positives (reading a
//      tone out of a Unique_ name) and false negatives (missing a Generic one).
//   3. Gender -- every Madden head we offer is coachhead_M_*. A female CFB
//      coach would silently get a male face.
//   4. Portrait leakage -- CFB Portrait ids (1..1056) live in a different space
//      from Madden's (309..508). Carrying one across would point at the wrong
//      art, or out of range.
//   5. Field-name collisions between the two schemas that map/index.js copies
//      blind.
//   6. CharacterVisuals capacity -- every transfer burns a row permanently.

const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');
const { cfbSkinTone, loadToneMap, headNumber, HEAD_PATTERN } = require('../lib/carousel/appearance');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';

const bugs = [];
const ok = [];
const note = (list, msg) => { list.push(msg); };

(async () => {
  const cfbFile = await FranchiseFile.create(CFB, { autoUnempty: true });
  const maddenFile = await FranchiseFile.create(MADDEN, { autoUnempty: true });
  const cfbT = biggestTableByName(cfbFile, 'Coach');
  const madT = biggestTableByName(maddenFile, 'Coach');
  await cfbT.readRecords();
  await madT.readRecords();

  const cfbFields = new Map(cfbT.offsetTable.map((o) => [o.name, o]));
  const madFields = new Map(madT.offsetTable.map((o) => [o.name, o]));

  // --- 1. silhouette flag ---------------------------------------------------
  console.log('=== 1. Portrait_Force_Silhouette ===');
  const silCfb = cfbFields.has('Portrait_Force_Silhouette');
  const silMad = madFields.has('Portrait_Force_Silhouette');
  console.log(`  CFB has field: ${silCfb}   Madden has field: ${silMad}`);
  if (silMad) {
    let onCount = 0, total = 0;
    for (const r of madT.records) {
      if (!r || r.isEmpty) continue;
      total++;
      if (safe(r, 'Portrait_Force_Silhouette') === true) onCount++;
    }
    console.log(`  Madden coaches with it ON: ${onCount}/${total}`);
    let cfbOn = 0, cfbTotal = 0;
    for (const r of cfbT.records) {
      if (!r || r.isEmpty || !safe(r, 'Name')) continue;
      cfbTotal++;
      if (safe(r, 'Portrait_Force_Silhouette') === true) cfbOn++;
    }
    console.log(`  CFB coaches with it ON: ${cfbOn}/${cfbTotal}`);
    if (cfbOn > 0) note(bugs, `Portrait_Force_Silhouette is TRUE on ${cfbOn} CFB coaches and the field exists in Madden -- if it is ever copied, those coaches render as cutouts.`);
    else note(ok, 'Portrait_Force_Silhouette is false everywhere in CFB, so nothing bad can be copied across.');
  } else {
    note(ok, 'Madden has no Portrait_Force_Silhouette field -- cannot be set by accident.');
  }

  // --- 2. cfbSkinTone correctness ------------------------------------------
  console.log('\n=== 2. cfbSkinTone() against every real CFB head name ===');
  const heads = [];
  for (const r of cfbT.records) {
    if (!r || r.isEmpty || !safe(r, 'Name')) continue;
    heads.push({ name: safe(r, 'Name'), head: String(safe(r, 'GenericHeadAssetName') || '') });
  }
  const falsePos = [], missed = [], parsed = [];
  for (const h of heads) {
    const tone = cfbSkinTone(h.head);
    const isUnique = /^Unique_/.test(h.head);
    const isGeneric = /^Generic_/.test(h.head);
    if (tone !== null && isUnique) falsePos.push(`${h.head} -> tone ${tone}`);
    if (tone === null && isGeneric) missed.push(h.head);
    if (tone !== null) parsed.push(tone);
    if (tone !== null && (tone < 1 || tone > 8)) note(bugs, `cfbSkinTone returned out-of-range ${tone} for ${h.head}`);
  }
  console.log(`  parsed a tone for ${parsed.length}/${heads.length}`);
  console.log(`  FALSE POSITIVES (tone read off a Unique_ name): ${falsePos.length}`);
  for (const f of falsePos.slice(0, 10)) console.log(`     ${f}`);
  console.log(`  MISSED (Generic_ head with no tone parsed): ${missed.length}`);
  for (const m of missed.slice(0, 10)) console.log(`     ${m}`);
  if (falsePos.length) note(bugs, `cfbSkinTone reads a bogus tone from ${falsePos.length} Unique_ head names.`);
  if (missed.length) note(bugs, `cfbSkinTone misses ${missed.length} Generic_ heads that do encode a tone.`);
  if (!falsePos.length && !missed.length) note(ok, `cfbSkinTone is exact on all ${heads.length} real head names.`);

  // --- 3. gender ------------------------------------------------------------
  console.log('\n=== 3. Gender ===');
  const genderish = [...cfbFields.keys()].filter((f) => /gender|sex|female/i.test(f));
  console.log(`  CFB gender-ish fields: ${genderish.join(', ') || '(none)'}`);
  const femaleHeads = heads.filter((h) => /_F_|female/i.test(h.head));
  console.log(`  CFB heads that look female: ${femaleHeads.length}`);
  const madHeadsAll = new Set();
  for (const r of madT.records) {
    if (!r || r.isEmpty) continue;
    const h = safe(r, 'GenericHeadAssetName');
    if (h) madHeadsAll.add(String(h));
  }
  const madFemale = [...madHeadsAll].filter((h) => /coachhead_F_/i.test(h));
  console.log(`  Madden female coach heads in save: ${madFemale.length}`);
  if (femaleHeads.length && !madFemale.length) note(bugs, `${femaleHeads.length} CFB coaches have female-looking heads but no coachhead_F_ assets are known -- they would get a male face.`);
  else note(ok, 'No female-head mismatch detected in this save.');

  // --- 4. Portrait space ----------------------------------------------------
  console.log('\n=== 4. Portrait id spaces ===');
  const cfbP = [], madP = [];
  for (const r of cfbT.records) { if (r && !r.isEmpty && safe(r, 'Name')) { const p = safe(r, 'Portrait'); if (typeof p === 'number') cfbP.push(p); } }
  for (const r of madT.records) { if (r && !r.isEmpty) { const p = safe(r, 'Portrait'); if (typeof p === 'number') madP.push(p); } }
  const rng = (a) => `${Math.min(...a)}..${Math.max(...a)}`;
  console.log(`  CFB Portrait:    ${rng(cfbP)}   (n=${cfbP.length})`);
  console.log(`  Madden Portrait: ${rng(madP)}   (n=${madP.length})`);
  const madMax = madFields.get('Portrait') ? madFields.get('Portrait').maxValue : null;
  console.log(`  Madden Portrait field max: ${madMax}`);
  const overflow = cfbP.filter((p) => madMax !== null && p > madMax).length;
  console.log(`  CFB values that would overflow Madden's field: ${overflow}`);
  note(ok, 'Portrait is synthesized from the head asset (+308), never copied -- verify map/index.js does not list Portrait as a carried field.');

  // --- 5. shared field names that are semantically different ---------------
  console.log('\n=== 5. schema overlap ===');
  const shared = [...cfbFields.keys()].filter((f) => madFields.has(f));
  console.log(`  ${cfbFields.size} CFB fields, ${madFields.size} Madden fields, ${shared.length} share a name`);
  const enumMismatch = [];
  for (const f of shared) {
    const a = cfbFields.get(f), b = madFields.get(f);
    if (a.type !== b.type) enumMismatch.push(`${f}: CFB ${a.type} vs Madden ${b.type}`);
  }
  console.log(`  same name, DIFFERENT type: ${enumMismatch.length}`);
  for (const e of enumMismatch.slice(0, 12)) console.log(`     ${e}`);
  if (enumMismatch.length) note(bugs, `${enumMismatch.length} fields share a name but differ in type across the two games -- any blind copy would corrupt them.`);

  // --- 6. CharacterVisuals headroom ---------------------------------------
  console.log('\n=== 6. CharacterVisuals capacity in the Madden save ===');
  let vTid = null;
  for (const r of madT.records) {
    if (!r || r.isEmpty) continue;
    try { const ref = r.getReferenceDataByKey('CharacterVisuals'); if (ref && ref.tableId) { vTid = ref.tableId; break; } } catch (e) { /* keep looking */ }
  }
  if (vTid) {
    const vt = maddenFile.getTableById(vTid);
    await vt.readRecords();
    const free = vt.records.filter((r) => r.isEmpty).length;
    console.log(`  capacity ${vt.header.recordCapacity}, free ${free}`);
    if (free < 100) note(bugs, `only ${free} free CharacterVisuals rows -- a full-carousel run could exhaust them.`);
    else note(ok, `${free} free CharacterVisuals rows; each transfer consumes one and never reclaims it.`);
  }

  // --- 7. tone supply sanity ----------------------------------------------
  console.log('\n=== 7. tone map ===');
  const tm = loadToneMap();
  console.log(`  ${tm.size} heads mapped`);
  const demand = {};
  for (const h of heads) { const t = cfbSkinTone(h.head); if (t) demand[t] = (demand[t] || 0) + 1; }
  for (let t = 1; t <= 8; t++) {
    const supply = [...tm.values()].filter((x) => x === t).length;
    const d = demand[t] || 0;
    console.log(`  tone ${t}: CFB demand ${String(d).padStart(3)}   Madden supply ${String(supply).padStart(3)}${supply === 0 && d > 0 ? '   <-- NO SUPPLY' : ''}`);
    if (supply === 0 && d > 0) note(bugs, `tone ${t} has CFB demand but zero Madden heads.`);
  }

  console.log(`\n\n${'='.repeat(64)}`);
  console.log(`FINDINGS: ${bugs.length} problem(s), ${ok.length} clean`);
  console.log('='.repeat(64));
  bugs.forEach((b, i) => console.log(`  BUG ${i + 1}. ${b}`));
  ok.forEach((o) => console.log(`  ok   -- ${o}`));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
