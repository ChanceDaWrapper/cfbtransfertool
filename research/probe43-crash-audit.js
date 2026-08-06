// READ-ONLY audit of a user's CFB dynasty that CRASHES on advance after a
// Madden->CFB coach transfer (Joe Brady -> Iowa State HC, Brian Daboll ->
// Tulane OC, Mike LaFleur -> Cal HC). Transfers were done during bowl weeks.
//
// Goal: find any field or reference on the three written coaches that is
// out of distribution versus the ~490 untouched coaches in the same save.
// A crash on advance is almost always the game dereferencing something we
// wrote that real data never contains.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = process.argv[2] || 'C:/Users/tripl/Downloads/DYNASTY-AZSTATEOFFICIAL';
const TARGET_ROWS = [118, 461, 490]; // LaFleur, Daboll, Brady

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };
const refKey = (rec, key) => { const r = refOf(rec, key); return r ? `${r.tableId}:${r.rowNumber}` : null; };

(async () => {
  const { cfbFile } = await openCfbSave(SAVE);
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  const attrs = coachT.schema ? coachT.schema.attributes : [];

  const targets = TARGET_ROWS.map((i) => coachT.records[i]);
  const targetSet = new Set(TARGET_ROWS);

  // Peers = real, employed coaches NOT written by us, same position.
  const peersFor = (position) => coachT.records.filter((r) => !r.isEmpty && !targetSet.has(r.index)
    && safe(r, 'Position') === position && safe(r, 'TeamIndex') !== 255 && safe(r, 'Level') > 0);

  console.log('=== FIELD-BY-FIELD vs REAL PEERS (same position) ===');
  for (const tc of targets) {
    const pos = safe(tc, 'Position');
    const peers = peersFor(pos);
    console.log(`\n### ${safe(tc, 'Name')} (row ${tc.index}, ${pos}, TeamIndex ${safe(tc, 'TeamIndex')}) -- ${peers.length} real peers`);

    for (const a of attrs) {
      const v = safe(tc, a.name);
      if (v === undefined) continue;

      // Reference-typed fields: check the target points somewhere real peers also point.
      const tref = refOf(tc, a.name);
      if (tref) {
        const peerTargets = new Set(peers.map((p) => refKey(p, a.name)).filter(Boolean));
        const mine = refKey(tc, a.name);
        const peerTables = new Set([...peerTargets].map((k) => k.split(':')[0]));
        if (peerTargets.size && !peerTables.has(String(tref.tableId))) {
          console.log(`  !! ${a.name}: points at table ${tref.tableId}, but every peer points at table(s) ${[...peerTables].join('/')}`);
        }
        // Does the referenced row actually exist and is it non-empty?
        const rt = cfbFile.getTableById(tref.tableId);
        if (!rt) { console.log(`  !! ${a.name}: table ${tref.tableId} DOES NOT EXIST in this save`); continue; }
        await rt.readRecords();
        const rr = rt.records[tref.rowNumber];
        if (!rr) console.log(`  !! ${a.name}: row ${tref.rowNumber} is OUT OF RANGE in table ${tref.tableId} (cap ${rt.header.recordCapacity})`);
        else if (rr.isEmpty) console.log(`  !! ${a.name}: points at an EMPTY row (${mine})`);
        continue;
      }

      if (typeof v === 'number') {
        const nums = peers.map((p) => safe(p, a.name)).filter((x) => typeof x === 'number');
        if (!nums.length) continue;
        const min = Math.min(...nums), max = Math.max(...nums);
        if (v < min || v > max) {
          console.log(`  !! ${a.name} = ${v} -- OUTSIDE real range [${min}..${max}]`);
        }
      } else if (typeof v === 'string' || typeof v === 'boolean') {
        const vals = new Set(peers.map((p) => safe(p, a.name)));
        if (vals.size && !vals.has(v)) {
          const show = [...vals].slice(0, 8).map((x) => JSON.stringify(x)).join(', ');
          console.log(`  !! ${a.name} = ${JSON.stringify(v)} -- NEVER used by a real ${pos} (they use: ${show}${vals.size > 8 ? ', ...' : ''})`);
        }
      }
    }
  }

  // ---- Team-side reciprocity ----
  console.log('\n\n=== TEAM POINTERS ===');
  const teamT = biggestTableByName(cfbFile, 'Team');
  await teamT.readRecords();
  const coachIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  for (const tc of targets) {
    const ti = safe(tc, 'TeamIndex');
    const team = teamT.records.find((r) => !r.isEmpty && safe(r, 'TeamIndex') === ti);
    if (!team) { console.log(`!! ${safe(tc, 'Name')}: NO TEAM with TeamIndex ${ti}`); continue; }
    const slot = safe(tc, 'Position');
    const ref = refOf(team, slot);
    const points = ref && coachIds.has(ref.tableId) ? ref.rowNumber : null;
    const ok = points === tc.index;
    console.log(`${ok ? 'OK  ' : '!!  '} ${safe(team, 'DisplayName')}.${slot} -> row ${points} | coach is row ${tc.index} ${ok ? '' : '<-- MISMATCH'}`);
  }

  // ---- Duplicate employment: two coaches claiming the same team+slot ----
  console.log('\n=== DUPLICATE JOB CLAIMS (a coach pointing at a team that does not point back) ===');
  const byJob = new Map();
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const ti = safe(r, 'TeamIndex');
    if (ti === 255 || ti === undefined) continue;
    const key = `${ti}:${safe(r, 'Position')}`;
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(r);
  }
  let dupes = 0;
  for (const [key, rows] of byJob) {
    if (rows.length < 2) continue;
    dupes++;
    const [ti, pos] = key.split(':');
    const team = teamT.records.find((r) => !r.isEmpty && safe(r, 'TeamIndex') === Number(ti));
    const ref = refOf(team, pos);
    const owner = ref ? ref.rowNumber : null;
    console.log(`!! TeamIndex ${ti} ${pos}: ${rows.length} coaches claim it -- `
      + rows.map((r) => `${safe(r, 'Name')}(row ${r.index}${r.index === owner ? ', team points here' : ''})`).join(', '));
  }
  if (!dupes) console.log('none');

  // ---- Season / timing state ----
  console.log('\n=== SEASON STATE ===');
  const si = biggestTableByName(cfbFile, 'SeasonInfo');
  if (si) {
    await si.readRecords();
    const r = si.records.find((x) => !x.isEmpty);
    for (const f of ['CurrentSeasonYear', 'CurrentWeek', 'CurrentStage', 'CurrentWeekType', 'IsCarouselPeriodActive']) {
      console.log(`  ${f} = ${safe(r, f)}`);
    }
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
