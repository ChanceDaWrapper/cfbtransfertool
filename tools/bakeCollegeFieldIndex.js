'use strict';

// One-time bake: reads the bundled draft-class template's 402 players plus a
// real Madden 26 franchise save's Player table, joins them on the leftover
// PLYR_ASSETNAME (a clean 1:1 key), and records each template slot's college
// index (the u16LE field at binary offset 66 -- see draftClassFile.js's
// COLLEGE_INDEX_OFFSET) keyed by the College reference bitstring used in
// data/college_lookup.json. Run manually when re-baking against a new
// franchise/template; output is committed as data/collegeFieldIndex.json and
// loaded at runtime with no franchise file needed.
//
// Usage: node tools/bakeCollegeFieldIndex.js "<path to a Madden 26 franchise save>"

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

const FRAN = process.argv[2];
if (!FRAN) {
  console.error('Usage: node tools/bakeCollegeFieldIndex.js "<path to a Madden 26 franchise save>"');
  process.exit(1);
}

(async () => {
  const model = loadTemplateModel();
  const tokenToSlot = new Map();
  model.players.forEach((p, i) => { if (p.binary.assetToken) tokenToSlot.set(p.binary.assetToken, i); });

  const file = await FranchiseFile.create(FRAN, { autoUnempty: true });
  const t = file.getTableByName('Player');
  await t.readRecords();
  const safe = (r, k) => { try { return r.getValueByKey(k); } catch { return undefined; } };
  const refOf = (r) => { try { return r.getReferenceDataByKey('College'); } catch { return null; } };

  // Majority-vote college reference per template slot -- the franchise save
  // may carry pollution from prior imports (a token can appear on multiple
  // rows if the save has imported >1 draft class), so take the modal value.
  const slotVotes = new Map();
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const an = safe(r, 'PLYR_ASSETNAME');
    if (!an || !tokenToSlot.has(an)) continue;
    const slot = tokenToSlot.get(an);
    const rd = refOf(r);
    if (!rd || rd.tableId === 0) continue;
    if (!slotVotes.has(slot)) slotVotes.set(slot, new Map());
    const m = slotVotes.get(slot);
    const key = `${rd.tableId}:${rd.rowNumber}`;
    m.set(key, (m.get(key) || 0) + 1);
  }

  const lookupPath = path.join(__dirname, '..', 'data', 'college_lookup.json');
  const lookup = JSON.parse(fs.readFileSync(lookupPath, 'utf-8'));
  // reference bitstring -> rowNumber, so we can join against tableId:rowNumber
  const refByRow = new Map();
  for (const ref of Object.values(lookup)) {
    const row = parseInt(ref.slice(15), 2);
    if (!refByRow.has(row)) refByRow.set(row, ref);
  }

  const out = {};
  let filled = 0;
  for (const [slot, m] of slotVotes) {
    let bestKey = null, bestCount = -1;
    for (const [key, c] of m) if (c > bestCount) { bestKey = key; bestCount = c; }
    const rowNumber = Number(bestKey.split(':')[1]);
    const ref = refByRow.get(rowNumber);
    if (!ref) continue;
    const fieldVal = model.players[slot].binary.raw.readUInt16LE(66);
    if (!(ref in out)) { out[ref] = fieldVal; filled++; }
  }

  const outPath = path.join(__dirname, '..', 'data', 'collegeFieldIndex.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}: ${filled} college indices (of ${slotVotes.size} template slots with a resolvable college)`);
})().catch((e) => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
