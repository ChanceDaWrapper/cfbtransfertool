// READ-ONLY. How is a Madden COACH's face/portrait stored, and what would we
// have to write to give a transferred coach a real one instead of a
// silhouette?
//
// Four fields are in play, and FINDINGS.md section 5 already established
// that CFB's blobs are useless here (a CFB coach's CharacterVisuals contains
// NO head loadout at all, and the head-asset vocabularies have zero overlap):
//   GenericHeadAssetName : string, e.g. "coachhead_M_0013_HS"
//   Portrait             : int [0..8191]
//   CharacterVisuals     : reference -> a row whose RawData is a JSON blob
//   FaceShape            : CoachFace enum (mostly Invalid_/MustBeUnique)
//
// So the head must be SYNTHESIZED from Madden's own catalog. This probe maps
// that catalog: which head assets exist, how Portrait pairs with them, what
// the visuals JSON actually contains, and what a blank shell is missing.
const fs = require('fs');
const path = require('path');
const { openMadden, safe } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const refOf = (r, k) => { try { const x = r.getReferenceDataByKey(k); return x && (x.tableId || x.rowNumber) ? x : null; } catch (e) { return null; } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mad = await openMadden();
  const coachT = biggest(mad, 'Coach');
  await coachT.readRecords();

  const visualsCache = new Map();
  async function visualsJson(rec) {
    const ref = refOf(rec, 'CharacterVisuals');
    if (!ref) return { ref: null, json: null };
    const key = ref.tableId;
    if (!visualsCache.has(key)) { const t = mad.getTableById(ref.tableId); if (t) await t.readRecords(); visualsCache.set(key, t); }
    const vt = visualsCache.get(key);
    if (!vt) return { ref, json: null };
    const vr = vt.records[ref.rowNumber];
    if (!vr || vr.isEmpty) return { ref, json: null, empty: true };
    const raw = safe(vr, 'RawData');
    if (typeof raw !== 'string') return { ref, json: null };
    try { return { ref, json: JSON.parse(raw), bytes: raw.length, table: vt.name, tableId: ref.tableId }; }
    catch (e) { return { ref, json: null, parseError: true }; }
  }

  const rows = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const v = await visualsJson(r);
    let headAsset = null;
    if (v.json && Array.isArray(v.json.loadouts)) {
      for (const lo of v.json.loadouts) {
        if (lo.loadoutType === 'Head' || lo.loadoutCategory === 'Head') {
          for (const el of (lo.loadoutElements || [])) if (/head/i.test(el.slotType)) headAsset = el.itemAssetName;
        }
      }
    }
    rows.push({
      row: r.index, name: safe(r, 'Name'), position: safe(r, 'Position'),
      head: safe(r, 'GenericHeadAssetName'), portrait: safe(r, 'Portrait'),
      faceShape: safe(r, 'FaceShape'),
      visualsRow: v.ref ? v.ref.rowNumber : null, visualsTable: v.tableId || null,
      visualsHead: headAsset, visualsBytes: v.bytes || 0,
      loadoutTypes: v.json && v.json.loadouts ? v.json.loadouts.map((l) => l.loadoutType).join('+') : null,
    });
  }

  console.log(`######## ${rows.length} coaches`);
  const withVisuals = rows.filter((r) => r.visualsRow !== null);
  const withHead = rows.filter((r) => r.visualsHead);
  console.log(`  with a CharacterVisuals reference: ${withVisuals.length}`);
  console.log(`  with a Head loadout inside it:     ${withHead.length}`);
  console.log(`  GenericHeadAssetName populated:    ${rows.filter((r) => r.head).length}`);

  console.log('\n######## Does GenericHeadAssetName match the visuals Head loadout?');
  const agree = withHead.filter((r) => r.head === r.visualsHead).length;
  console.log(`  identical in ${agree}/${withHead.length} coaches`);
  for (const r of withHead.slice(0, 6)) console.log(`    ${String(r.name).padEnd(18)} field="${r.head}" visuals="${r.visualsHead}" portrait=${r.portrait}`);

  console.log('\n######## Head asset vocabulary');
  const heads = {};
  for (const r of rows) if (r.head) heads[r.head] = (heads[r.head] || 0) + 1;
  const headNames = Object.keys(heads).sort();
  console.log(`  ${headNames.length} distinct head assets`);
  console.log('  samples: ' + headNames.slice(0, 16).join(', '));
  // naming pattern: coachhead_<X>_<NNNN>_<SS>
  const pattern = {};
  for (const h of headNames) {
    const m = h.match(/^coachhead_([A-Za-z]+)_(\d+)_([A-Za-z]+)$/);
    if (m) { const k = `coachhead_${m[1]}_####_${m[3]}`; pattern[k] = (pattern[k] || 0) + 1; }
    else pattern[`(other) ${h}`] = (pattern[`(other) ${h}`] || 0) + 1;
  }
  console.log('  naming patterns: ' + JSON.stringify(pattern));

  console.log('\n######## Portrait <-> head pairing (is Portrait derivable from head?)');
  const byHead = {};
  for (const r of rows) { if (!r.head) continue; (byHead[r.head] = byHead[r.head] || []).push(r.portrait); }
  const multi = Object.entries(byHead).filter(([, ps]) => ps.length > 1);
  console.log(`  head assets used by >1 coach: ${multi.length}`);
  for (const [h, ps] of multi.slice(0, 10)) console.log(`    ${h}: portraits ${ps.join(', ')}${new Set(ps).size === 1 ? '  (STABLE)' : '  (VARIES)'}`);
  const stable = multi.filter(([, ps]) => new Set(ps).size === 1).length;
  console.log(`  -> portrait is stable per head in ${stable}/${multi.length} of the shared cases`);

  console.log('\n######## A full visuals blob for a real coach (the shape we must synthesize)');
  const sample = rows.find((r) => r.visualsHead);
  if (sample) {
    const rec = coachT.records[sample.row];
    const v = await visualsJson(rec);
    console.log(`  ${sample.name} -- CharacterVisuals table ${v.tableId} row ${v.ref.rowNumber}, ${v.bytes} bytes`);
    console.log('  ' + JSON.stringify(v.json).slice(0, 1200));
  }

  console.log('\n######## The blank shell (row 109) for comparison');
  const blank = rows.find((r) => r.row === 109);
  console.log('  ' + JSON.stringify(blank));

  console.log('\n######## CharacterVisuals table headroom');
  const vt = mad.getTableById(sample ? sample.visualsTable : 4204);
  if (vt) {
    await vt.readRecords();
    const filled = vt.records.filter((r) => !r.isEmpty).length;
    console.log(`  "${vt.name}" id=${vt.header.tableId} capacity=${vt.header.recordCapacity} filled=${filled} FREE=${vt.header.recordCapacity - filled}`);
  }

  fs.writeFileSync(path.join(OUT, 'coach-appearance.json'), JSON.stringify(rows, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
