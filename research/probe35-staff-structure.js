// READ-ONLY. What does a full coaching STAFF look like in each game, and what
// would "move the whole staff" actually have to move?
//
// COACH_TRANSFER_AUDIT.md L4 says "only head coaches transfer" -- but the
// engine's position handling looks generic (movement/map/place all iterate
// HC_OC_DC). So the real questions are:
//   1. What coach slots does each game's Team record actually have? Is it
//      exactly HC/OC/DC, or is there a Trainer / other staff role we're
//      ignoring? (COACH_FIDELITY_ROADMAP 4.5 mentions a Giants "Trainer".)
//   2. What does the Coach.Position enum allow in each game? Are the member
//      lists the same across games (like COACH_SPECIALTY) or different?
//   3. How is a real staff actually populated -- do all 32 NFL teams / all
//      139 schools carry a full HC+OC+DC, or are coordinator slots often
//      empty? (Determines whether "bring your coordinators" has anywhere to
//      land.)
//   4. Is there any DATA LINK between a HC and their coordinators (a staff
//      reference, a "hired by" field), or is the only association
//      "same TeamIndex"? (Determines whether a staff is a real object we can
//      move, or just a query.)

const { openCfbSave, openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

function enumMembers(file, tableName, fieldName) {
  const t = biggestTableByName(file, tableName);
  if (!t || !t.schema) return null;
  const attr = t.schema.attributes.find((a) => a.name === fieldName);
  if (!attr || !attr.enum) return null;
  return attr.enum.members.map((m) => m.name);
}

async function analyze(label, file) {
  console.log(`\n########## ${label} ##########`);
  const teamT = biggestTableByName(file, 'Team');
  const coachT = biggestTableByName(file, 'Coach');
  await teamT.readRecords();
  await coachT.readRecords();

  // ---- 1. Which Team fields are COACH references? ----
  console.log('\n--- Team fields that reference the Coach table ---');
  const coachTableIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  const sampleTeam = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName'));
  const coachSlots = [];
  for (const a of (teamT.schema ? teamT.schema.attributes : [])) {
    const ref = refOf(sampleTeam, a.name);
    if (ref && coachTableIds.has(ref.tableId)) {
      coachSlots.push(a.name);
      const rec = coachT.records[ref.rowNumber];
      console.log(`  ${a.name.padEnd(26)} -> Coach row ${String(ref.rowNumber).padStart(4)} `
        + `${rec && !rec.isEmpty ? `${safe(rec, 'Name')} (Position=${safe(rec, 'Position')})` : '(empty row)'}`);
    }
  }
  // Also list any field whose NAME suggests staff but didn't resolve on this sample.
  const nameLooksStaff = (teamT.schema ? teamT.schema.attributes : [])
    .filter((a) => /coach|coordinator|trainer|staff/i.test(a.name))
    .map((a) => a.name);
  console.log(`  (fields whose NAME looks staff-related: ${nameLooksStaff.join(', ') || 'none'})`);
  console.log(`  => resolved coach slots: [${coachSlots.join(', ')}]`);

  // ---- 2. Coach.Position enum members ----
  const positions = enumMembers(file, 'Coach', 'Position');
  console.log(`\n--- Coach.Position enum members (${positions ? positions.length : '?'}) ---`);
  console.log(`  ${positions ? positions.join(', ') : '(could not read)'}`);

  // ---- 3. Actual population: how many real coaches per Position? ----
  console.log('\n--- Live Position distribution (non-empty coach rows) ---');
  const byPosition = new Map();
  let employed = 0;
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const p = safe(r, 'Position');
    byPosition.set(p, (byPosition.get(p) || 0) + 1);
  }
  for (const [p, n] of [...byPosition.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(p).padEnd(26)} ${String(n).padStart(4)}`);
  }

  // ---- 4. Staff completeness per team ----
  console.log('\n--- Staff completeness across teams ---');
  let fullStaff = 0, teamsCounted = 0;
  const missingBySlot = new Map();
  const staffSizes = [];
  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    if (!safe(tr, 'DisplayName')) continue; // pseudo-team
    teamsCounted++;
    let filled = 0;
    for (const slot of coachSlots) {
      const ref = refOf(tr, slot);
      const rec = ref && coachTableIds.has(ref.tableId) ? coachT.records[ref.rowNumber] : null;
      if (rec && !rec.isEmpty) filled++;
      else missingBySlot.set(slot, (missingBySlot.get(slot) || 0) + 1);
    }
    staffSizes.push(filled);
    if (filled === coachSlots.length) fullStaff++;
  }
  console.log(`  teams with a DisplayName: ${teamsCounted}`);
  console.log(`  teams with ALL ${coachSlots.length} slots filled: ${fullStaff}`);
  for (const slot of coachSlots) {
    console.log(`    ${slot.padEnd(26)} empty on ${String(missingBySlot.get(slot) || 0).padStart(4)} team(s)`);
  }

  // ---- 5. Is there a HC <-> coordinator data link beyond TeamIndex? ----
  console.log('\n--- Any Coach field linking a coordinator to their head coach? ---');
  const coachRefFields = [];
  const sampleCoach = coachT.records.find((r) => !r.isEmpty && safe(r, 'Position') === 'OffensiveCoordinator');
  if (sampleCoach) {
    for (const a of (coachT.schema ? coachT.schema.attributes : [])) {
      const ref = refOf(sampleCoach, a.name);
      if (ref) {
        const t = file.getTableById(ref.tableId);
        coachRefFields.push(`${a.name} -> ${t ? t.name : `table ${ref.tableId}`}`);
      }
    }
    console.log(`  sample OC: ${safe(sampleCoach, 'Name')} (row ${sampleCoach.index}, TeamIndex ${safe(sampleCoach, 'TeamIndex')})`);
    console.log(`  its reference-typed fields:`);
    for (const f of coachRefFields) console.log(`    ${f}`);
    const staffish = (coachT.schema ? coachT.schema.attributes : [])
      .filter((a) => /staff|headcoach|superior|boss|mentor|hiredby/i.test(a.name))
      .map((a) => a.name);
    console.log(`  fields whose NAME suggests a staff link: ${staffish.join(', ') || 'NONE'}`);
  } else {
    console.log('  (no OC found to sample)');
  }

  return { coachSlots, positions, byPosition };
}

(async () => {
  const { cfbFile } = await openCfbSave(CFB);
  const { maddenFile } = await openMaddenSave(MADDEN);

  const mad = await analyze('MADDEN 26', maddenFile);
  const cfb = await analyze('CFB 27', cfbFile);

  console.log('\n\n########## CROSS-GAME COMPARISON ##########');
  console.log(`  Madden coach slots: [${mad.coachSlots.join(', ')}]`);
  console.log(`  CFB    coach slots: [${cfb.coachSlots.join(', ')}]`);
  const onlyMad = mad.coachSlots.filter((s) => !cfb.coachSlots.includes(s));
  const onlyCfb = cfb.coachSlots.filter((s) => !mad.coachSlots.includes(s));
  console.log(`  Madden-only slots: [${onlyMad.join(', ') || 'none'}]`);
  console.log(`  CFB-only slots:    [${onlyCfb.join(', ') || 'none'}]`);

  const mp = new Set(mad.positions || []);
  const cp = new Set(cfb.positions || []);
  console.log(`  Position members Madden-only: [${[...mp].filter((x) => !cp.has(x)).join(', ') || 'none'}]`);
  console.log(`  Position members CFB-only:    [${[...cp].filter((x) => !mp.has(x)).join(', ') || 'none'}]`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
