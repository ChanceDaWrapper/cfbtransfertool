// READ-ONLY. Narrows probe43's noisy diff to the fields that could actually
// CRASH the game on advance. probe43 flags anything unlike a real coach, but
// most of those are harmless-by-design (a freshly transferred coach really
// does have 0 career points). What matters is a value the game will
// DEREFERENCE or INDEX with: a null pointer where every real coach has one,
// or an id/rank outside the range the game has entries for.
//
// The crash happens advancing past BowlSeason1 -- i.e. exactly when the game
// closes out a season and walks every coach's season/career records. So a
// null stats pointer on an EMPLOYED coach is the prime hypothesis.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = process.argv[2] || 'C:/Users/tripl/Downloads/DYNASTY-AZSTATEOFFICIAL';
const TARGETS = [118, 461, 490];
const NULL_REF = '0'.repeat(32);

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  const { cfbFile } = await openCfbSave(SAVE);
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();

  const targetSet = new Set(TARGETS);
  // The population the game actually processes at season end: coaches with a
  // real job. Free-agent shells are not comparable.
  const employed = t.records.filter((r) => !r.isEmpty && !targetSet.has(r.index)
    && safe(r, 'TeamIndex') !== 255 && safe(r, 'TeamIndex') !== undefined && safe(r, 'Level') > 0);
  console.log(`Employed, untouched coaches for comparison: ${employed.length}\n`);

  const targets = TARGETS.map((i) => t.records[i]);

  // ---- A. Null pointers where real coaches always have one ----
  console.log('=== A. POINTER FIELDS: is ours null where every real coach has one? ===');
  const ptrFields = ['CareerStats', 'SeasonStats', 'CharacterVisuals', 'ActiveTalentTree',
    'OffensiveScheme', 'DefensiveScheme', 'OffensivePlaybook', 'DefensivePlaybook',
    'TeamPhilosophy', 'DefaultTeamPhilosophy', 'ProgramPointsBudgetAllocationPosture'];
  for (const f of ptrFields) {
    const nullPeers = employed.filter((r) => {
      const v = safe(r, f);
      return v === NULL_REF || !refOf(r, f);
    }).length;
    const line = targets.map((tc) => {
      const v = safe(tc, f);
      const isNull = v === NULL_REF || !refOf(tc, f);
      return `${safe(tc, 'Name')}=${isNull ? 'NULL' : 'set'}`;
    }).join('  ');
    const anyTargetNull = targets.some((tc) => { const v = safe(tc, f); return v === NULL_REF || !refOf(tc, f); });
    const flag = anyTargetNull && nullPeers === 0 ? '  <<<< NULL ON OURS, NEVER NULL ON A REAL COACH' : '';
    console.log(`  ${f.padEnd(38)} real-null: ${String(nullPeers).padStart(3)}/${employed.length}   ${line}${flag}`);
  }

  // ---- B. Which static-asset TABLE do the reference fields point at? ----
  // A reference whose first bit is 1 points at a static asset table outside
  // the save; that is normal. What is NOT normal is pointing at a DIFFERENT
  // asset table than every real coach in the same game uses -- that means a
  // reference was carried across from the other game.
  console.log('\n=== B. Asset-table agreement (a different table id = a foreign reference) ===');
  for (const f of ptrFields) {
    const tally = new Map();
    for (const r of employed) { const ref = refOf(r, f); if (ref) tally.set(ref.tableId, (tally.get(ref.tableId) || 0) + 1); }
    if (!tally.size) continue;
    const realTables = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}(${n})`).join(' ');
    const mine = targets.map((tc) => { const ref = refOf(tc, f); return `${safe(tc, 'Name').split(' ').pop()}:${ref ? ref.tableId : 'null'}`; }).join(' ');
    const bad = targets.some((tc) => { const ref = refOf(tc, f); return ref && !tally.has(ref.tableId); });
    console.log(`  ${f.padEnd(38)} real=[${realTables}]  ours=[${mine}]${bad ? '  <<<< FOREIGN TABLE' : ''}`);
  }

  // ---- C. Numeric ids/ranks the game may use as an index ----
  console.log('\n=== C. Ids / ranks -- could index out of bounds ===');
  for (const f of ['Portrait', 'PresentationId', 'SpeechId', 'CurrentJobSecurityPercentageRank', 'Weight', 'Height']) {
    const nums = employed.map((r) => safe(r, f)).filter((x) => typeof x === 'number');
    if (!nums.length) continue;
    const min = Math.min(...nums), max = Math.max(...nums);
    const mine = targets.map((tc) => `${safe(tc, 'Name').split(' ').pop()}=${safe(tc, f)}`).join(' ');
    const bad = targets.some((tc) => { const v = safe(tc, f); return typeof v === 'number' && (v < min || v > max); });
    console.log(`  ${f.padEnd(38)} real=[${min}..${max}]  ours=[${mine}]${bad ? '  <<<< OUT OF RANGE' : ''}`);
  }

  // ---- D. Enum members no real coach ever uses ----
  console.log('\n=== D. Enum values unused by any real coach (sentinels are the danger) ===');
  for (const f of ['CurrentContractExpectation', 'CoachBackstory', 'COACH_ADAPTIVE_AI', 'PrevPosition',
    'ContractStatus', 'CurrentJobSecurityStatus', 'SeasonStartJobSecurityStatus', 'DominantArchetype',
    'PrimaryPipeline', 'CoachPrestige', 'TeamBuilding', 'TradingTendency', 'HatType']) {
    const vals = new Set(employed.map((r) => safe(r, f)));
    const offenders = targets.filter((tc) => { const v = safe(tc, f); return v !== undefined && !vals.has(v); });
    if (!offenders.length) continue;
    console.log(`  ${f}:`);
    for (const tc of offenders) console.log(`     ${safe(tc, 'Name')} = ${JSON.stringify(safe(tc, f))}  (real coaches use: ${[...vals].slice(0, 10).map((x) => JSON.stringify(x)).join(', ')})`);
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
