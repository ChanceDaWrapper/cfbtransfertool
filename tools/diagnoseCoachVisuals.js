// Diagnoses WHY a Madden save's coach CharacterVisuals blobs cannot be read.
//
// Written for a user-reported failure that two rounds of guessing did not
// explain: "could not read ANY usable donor CharacterVisuals blob from this
// save (tried 83 row(s) in table 4204)". Every candidate donor failed, which
// rules out a single bad row -- something about the whole table differs from
// every save we have on hand. This reports exactly which of the four failure
// conditions in readVisualsJson() is firing, and what the data looks like
// instead, so the fix targets the real cause.
//
// READ-ONLY. Opens the save, prints a report, writes nothing.
//
// Usage:
//   node tools/diagnoseCoachVisuals.js "<path to Madden save>"

const { openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');

const savePath = process.argv[2];
if (!savePath) {
  console.error('usage: node tools/diagnoseCoachVisuals.js "<path to Madden save>"');
  process.exit(1);
}

const HEAD_PATTERN = /^coachhead_M_(\d+)_HS$/;
const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  console.log(`\nSave: ${savePath}\n${'='.repeat(60)}`);

  // ---- 0. THE RUNTIME CHECK. Read this first. ----
  //
  // Coach visuals blobs are ZSTD-compressed, so reading one calls
  // zlib.zstdDecompressSync -- which only exists in Node 22.15+. Run this
  // script under a modern `node` and every blob reads fine; run the same
  // code inside an app whose Electron bundles Node 20 and every blob fails.
  // That is a real bug this project shipped, and a "everything is healthy"
  // verdict from this script means nothing unless the RUNTIME matches.
  const zlib = require('zlib');
  const hasZstd = typeof zlib.zstdDecompressSync === 'function';
  console.log(`\n0. Runtime: node ${process.versions.node}`
    + `${process.versions.electron ? ` (electron ${process.versions.electron})` : ' (plain node, NOT the app)'}`);
  console.log(`   zlib.zstdDecompressSync: ${hasZstd ? 'available' : '*** MISSING ***'}`);
  if (!hasZstd) {
    console.log('   *** This runtime CANNOT read coach visuals at all, regardless of the save.');
    console.log('   *** Everything below will fail for that reason alone. Needs Node 22.15+.');
  } else if (!process.versions.electron) {
    console.log('   NOTE: this is plain node, which may support zstd when the packaged app does');
    console.log('   not. A clean report here does NOT prove the app can read this save.');
  }

  const { maddenFile } = await openMaddenSave(savePath);

  // ---- 1. Which table do coaches actually point at? ----
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await coachT.readRecords();
  const tableIdCounts = new Map();
  const sampleRows = [];
  let coachesWithGenericHead = 0;
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const head = safe(r, 'GenericHeadAssetName');
    if (!head || !HEAD_PATTERN.test(head)) continue;
    coachesWithGenericHead++;
    const ref = refOf(r, 'CharacterVisuals');
    const key = ref ? ref.tableId : '(null ref)';
    tableIdCounts.set(key, (tableIdCounts.get(key) || 0) + 1);
    if (ref && sampleRows.length < 12) sampleRows.push({ coach: safe(r, 'Name'), head, tableId: ref.tableId, row: ref.rowNumber });
  }
  console.log(`\n1. Coaches wearing a generic coachhead_M_*_HS: ${coachesWithGenericHead}`);
  console.log('   CharacterVisuals table ids they point at:');
  for (const [id, n] of tableIdCounts) console.log(`     table ${id}: ${n} coach(es)`);

  // ---- 2. Does that table resolve, and what is its shape? ----
  const targetTableId = [...tableIdCounts.keys()].find((k) => typeof k === 'number');
  console.log(`\n2. Resolving table ${targetTableId} via getTableById():`);
  const vt = targetTableId !== undefined ? maddenFile.getTableById(targetTableId) : null;
  if (!vt) {
    console.log('   *** getTableById() returned NULL. This is the failure: the coaches reference a');
    console.log('   *** table id that this save does not expose. Nothing below can run.');
    const named = maddenFile.getAllTablesByName('CharacterVisuals') || [];
    console.log(`   Tables actually named "CharacterVisuals": ${named.map((t) => t.header.tableId).join(', ') || '(none)'}`);
    return;
  }
  console.log(`   name="${vt.name}" capacity=${vt.header.recordCapacity} hasThirdTable=${vt.header.hasThirdTable}`);
  console.log(`   schema: ${vt.schema ? vt.schema.attributes.map((a) => `${a.name}:${a.type}`).join(', ') : '(NO SCHEMA -- this alone would break reads)'}`);

  await vt.readRecords();
  const filled = vt.records.filter((r) => !r.isEmpty).length;
  console.log(`   rows: ${vt.records.length} total, ${filled} non-empty`);

  // ---- 3. Walk the actual donor rows and classify every failure ----
  console.log('\n3. Reading each coach-referenced row (the exact donors the app tries):');
  const stats = { missing: 0, empty: 0, notString: 0, unparseable: 0, ok: 0 };
  const examples = [];
  for (const s of sampleRows) {
    const rec = vt.records[s.row];
    let verdict, detail = '';
    if (!rec) { verdict = 'MISSING ROW'; stats.missing++; } else if (rec.isEmpty) { verdict = 'ROW IS EMPTY'; stats.empty++; } else {
      const raw = safe(rec, 'RawData');
      if (typeof raw !== 'string') {
        verdict = 'RawData NOT A STRING';
        detail = `typeof=${typeof raw}${raw === undefined ? ' (field absent from schema?)' : ''}`;
        stats.notString++;
      } else {
        try { JSON.parse(raw); verdict = 'OK'; detail = `${raw.length} chars`; stats.ok++; } catch (e) {
          verdict = 'RawData NOT VALID JSON';
          stats.unparseable++;
          detail = `${raw.length} chars, starts: ${JSON.stringify(raw.slice(0, 60))}, ends: ${JSON.stringify(raw.slice(-40))}`;
        }
      }
      // Overflow is how a blob too big for one record is split in two.
      const ovr = rec.getFieldByKey && rec.getFieldByKey('Overflow');
      if (ovr) {
        const oref = refOf(rec, 'Overflow');
        if (oref && (oref.tableId || oref.rowNumber)) detail += ` | Overflow -> ${oref.tableId}:${oref.rowNumber}`;
      }
    }
    examples.push(`   row ${String(s.row).padStart(5)} (${s.coach}): ${verdict}${detail ? ` -- ${detail}` : ''}`);
  }
  for (const line of examples) console.log(line);
  console.log(`\n   Tally over the sampled donors: ${JSON.stringify(stats)}`);

  // ---- 4. Is ANY row in the table readable, coach or not? ----
  console.log('\n4. Scanning the whole table for ANY parseable blob (diagnostic only --');
  console.log('   the app deliberately only borrows from coaches, since this table is shared with players):');
  let anyOk = 0, firstOk = null, scanned = 0;
  for (const rec of vt.records) {
    if (rec.isEmpty) continue;
    scanned++;
    const raw = safe(rec, 'RawData');
    if (typeof raw !== 'string') continue;
    try { JSON.parse(raw); anyOk++; if (firstOk === null) firstOk = rec.index; } catch (e) { /* not parseable */ }
  }
  console.log(`   ${anyOk} of ${scanned} non-empty rows parse as JSON` + (firstOk !== null ? ` (first: row ${firstOk})` : ''));
  if (anyOk === 0) {
    console.log('   => NOTHING in this table parses. The blob format itself differs from what the');
    console.log('      app expects (it assumes RawData is a JSON string).');
  } else if (stats.ok === 0) {
    console.log('   => Player rows parse but COACH rows do not, which is a genuinely different shape.');
  }

  console.log(`\n${'='.repeat(60)}\nSend this whole output back and the fix can target the real cause.\n`);
})().catch((e) => { console.error('\nFAILED to open or read the save:', e.message); process.exit(1); });
