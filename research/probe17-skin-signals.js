// READ-ONLY. Is there ANY skin-tone / ethnicity signal we can attach to
// Madden's coach head assets?
//
// The problem: heads are named coachhead_M_<N>_HS, which carries no parseable
// tone (unlike CFB's Generic_1450_P_T0071_H_7_1, where the digit before the
// trailing index IS the tone). Without a tone signal a transferred coach gets
// a plausible but unmatched face.
//
// Four angles, cheapest first:
//   1. The odd one out -- one head in the save is named "2_M_WHT_H_003",
//      which looks like <tone>_<gender>_<ETHNICITY>_<hair>_<variant>. If that
//      naming scheme is real, it is a direct signal.
//   2. CharacterVisuals blobs -- probe08 found a couple of Madden coaches
//      carry an explicit `skinTone` key. Even a handful of head->tone pairs
//      anchors the catalog.
//   3. The CoachFace enum -- FINDINGS recorded explicit FirstSkinTone1_ ..
//      LastSkinTone7_ band markers around coachhead_<tone>_<facial>_<hair>_<v>
//      names. That is a DIFFERENT namespace, but it proves Madden bands coach
//      heads by tone, and may be usable directly.
//   4. Head-number banding -- do the coachhead_M_#### numbers cluster by
//      anything observable (e.g. via the few coaches we can tie to a tone)?
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

  // ---- 1 + 2: walk every coach, parse head names, mine visuals blobs ----
  const visCache = new Map();
  async function visualsOf(rec) {
    const ref = refOf(rec, 'CharacterVisuals');
    if (!ref) return null;
    if (!visCache.has(ref.tableId)) { const t = mad.getTableById(ref.tableId); if (t) await t.readRecords(); visCache.set(ref.tableId, t); }
    const vt = visCache.get(ref.tableId);
    if (!vt) return null;
    const r = vt.records[ref.rowNumber];
    if (!r || r.isEmpty) return null;
    const raw = safe(r, 'RawData');
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  const allKeys = new Map();
  const withSkin = [];
  const oddHeads = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const head = safe(r, 'GenericHeadAssetName');
    if (head && !/^coachhead_M_\d+_HS$/.test(head)) oddHeads.push({ row: r.index, name: safe(r, 'Name'), head, portrait: safe(r, 'Portrait'), faceShape: safe(r, 'FaceShape') });
    const j = await visualsOf(r);
    if (!j) continue;
    const walk = (o, prefix) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, prefix + '[]')); return; }
      for (const k of Object.keys(o)) {
        allKeys.set(prefix + k, (allKeys.get(prefix + k) || 0) + 1);
        if (/skin|tone|ethnic|complexion/i.test(k)) {
          withSkin.push({ row: r.index, name: safe(r, 'Name'), head, key: k, value: o[k] });
        }
        walk(o[k], prefix + k + '.');
      }
    };
    walk(j, '');
  }

  console.log('######## 1. Head assets NOT matching coachhead_M_####_HS');
  for (const o of oddHeads) console.log('   ' + JSON.stringify(o));

  console.log('\n######## 2. Any skin/tone/ethnicity key anywhere in a coach visuals blob');
  console.log('   found: ' + withSkin.length);
  for (const s of withSkin) console.log('     ' + JSON.stringify(s));
  console.log('\n   all distinct JSON keys across coach visuals blobs:');
  for (const [k, n] of [...allKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);

  // ---- 3: the CoachFace enum's tone bands ----
  console.log('\n######## 3. CoachFace enum -- explicit skin-tone bands');
  const attr = mad.schemaList.getSchema('Coach').attributes.find((a) => a.name === 'FaceShape');
  if (attr && attr.enum) {
    const members = attr.enum.members;
    const bands = [];
    let current = null;
    for (const m of members) {
      const first = m.name.match(/^FirstSkinTone(\d)_$/);
      const last = m.name.match(/^LastSkinTone(\d)_$/);
      if (first) { current = { tone: Number(first[1]), startValue: m.value, heads: [] }; bands.push(current); }
      else if (last && current) { current.endValue = m.value; current = null; }
      else if (current && /^coachhead_/.test(m.name)) current.heads.push({ name: m.name, value: m.value });
    }
    for (const b of bands) {
      console.log(`   tone ${b.tone}: values ${b.startValue}..${b.endValue} -- ${b.heads.length} heads`);
      console.log(`      ${b.heads.map((h) => h.name).join(', ')}`);
    }
    console.log(`\n   (total enum members: ${members.length})`);
  }

  // ---- 4: which FaceShape values are actually used, vs the head asset ----
  console.log('\n######## 4. FaceShape usage vs GenericHeadAssetName');
  const combos = new Map();
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const k = `${safe(r, 'FaceShape')}  ||  ${safe(r, 'GenericHeadAssetName')}`;
    combos.set(k, (combos.get(k) || 0) + 1);
  }
  const sorted = [...combos.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of sorted.slice(0, 14)) console.log(`   ${String(n).padStart(3)}x  ${k}`);

  fs.writeFileSync(path.join(OUT, 'skin-signals.json'), JSON.stringify({ oddHeads, withSkin, keys: [...allKeys.entries()] }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
