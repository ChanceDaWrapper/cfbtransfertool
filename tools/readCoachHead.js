// Reads back which head asset the GAME assigned to a coach.
//
// This exists because none of the obvious inferences work: coach skin tone is
// baked into the head asset, and neither the CFB head numbering nor the
// in-game Generic Heads browser's labels correspond to the asset id (writing
// coachhead_M_0047_HS produced a light-skinned face while browser "Head 047"
// is visibly dark-skinned -- the browser shows catalog POSITION, not asset id).
//
// So the only reliable way to learn which asset is which face is to let the
// GAME write it: pick a face in-game, save, and read the result here.
//
//   node tools/readCoachHead.js "<save path>"                 -- every coach with a head
//   node tools/readCoachHead.js "<save path>" Freeman         -- just matching names
//   node tools/readCoachHead.js "<save path>" --team Giants   -- a team's staff
//
// Feed what it prints into data/coachHeadTones.json.

const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');

async function open(p) {
  const f = await FranchiseFile.create(p, { autoUnempty: true });
  await new Promise((res, rej) => { if (f.isLoaded) res(); else { f.on('ready', res); f.on('error', rej); } });
  return f;
}

(async () => {
  const [savePath, ...rest] = process.argv.slice(2);
  if (!savePath) {
    console.error('usage: node tools/readCoachHead.js "<save path>" [nameFilter] [--team <TeamName>]');
    process.exit(1);
  }
  const teamFlag = rest.indexOf('--team');
  const teamName = teamFlag >= 0 ? rest[teamFlag + 1] : null;
  const nameFilter = rest.filter((a, i) => i !== teamFlag && i !== teamFlag + 1 && !a.startsWith('--'))[0] || null;

  const mad = await open(savePath);
  const coachT = biggestTableByName(mad, 'Coach');
  await coachT.readRecords();

  // Optionally narrow to one team's staff, via the Team slot references.
  let allowedRows = null;
  if (teamName) {
    const teamT = biggestTableByName(mad, 'Team');
    await teamT.readRecords();
    const coachIds = new Set((mad.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
    const team = teamT.records.find((r) => !r.isEmpty && String(safe(r, 'DisplayName') || '').toLowerCase() === teamName.toLowerCase());
    if (!team) { console.error(`No team named "${teamName}".`); process.exit(1); }
    allowedRows = new Set();
    for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
      let ref; try { ref = team.getReferenceDataByKey(slot); } catch (e) { ref = null; }
      if (ref && coachIds.has(ref.tableId)) allowedRows.add(ref.rowNumber);
    }
  }

  const rows = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    if (allowedRows && !allowedRows.has(r.index)) continue;
    const name = safe(r, 'Name') || '';
    if (nameFilter && !name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
    const head = safe(r, 'GenericHeadAssetName');
    if (!head) continue;
    rows.push({
      row: r.index, name, position: safe(r, 'Position'),
      head, portrait: safe(r, 'Portrait'),
      assetNumber: (String(head).match(/^coachhead_M_(\d+)_HS$/) || [])[1] || null,
    });
  }

  if (!rows.length) { console.log('No matching coaches with a head asset.'); return; }

  console.log(`\n${rows.length} coach(es):\n`);
  console.log('  row   assetNum  head                        portrait  name');
  for (const r of rows) {
    console.log(`  ${String(r.row).padStart(3)}   ${String(r.assetNumber ?? '-').padStart(8)}  ${String(r.head).padEnd(26)}  ${String(r.portrait).padStart(8)}  ${r.name} (${r.position})`);
  }
  console.log('\nTo record a tone, add the assetNum to data/coachHeadTones.json under "tones".');
  console.log('NOTE: assetNum is NOT the number the in-game browser shows -- always read it here.\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
