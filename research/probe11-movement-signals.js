// READ-ONLY. What signals do the two saves actually expose that could drive a
// realistic "why would this coach leave?" model?
//
// Three questions:
//   1. VACANCY -- how do we detect an open//about-to-open job in each game?
//      (null Team.HeadCoach/OC/DC refs, expiring contracts, fire flags)
//   2. PUSH -- what makes a coach WANT to leave / be forced out?
//      (CFB job security + contract expectation; Madden fired/free-agent flags)
//   3. PULL -- what makes a coach DESIRABLE to the other league?
//      (CFB prestige/level/record; Madden level/career record)
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe, stats } = require('./_saves');

const OUT = path.join(__dirname, 'out');
const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const refOf = (rec, k) => { try { const r = rec.getReferenceDataByKey(k); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

async function vacancies(file, label) {
  const teamT = biggest(file, 'Team');
  const coachT = biggest(file, 'Coach');
  await teamT.readRecords();
  await coachT.readRecords();
  const coachIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  const coachByRow = new Map();
  for (const r of coachT.records) if (!r.isEmpty) coachByRow.set(r.index, r);

  const slots = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];
  const counts = { teams: 0 };
  for (const s of slots) counts[`${s}_null`] = 0;
  for (const s of slots) counts[`${s}_danglingRef`] = 0;
  for (const s of slots) counts[`${s}_filled`] = 0;
  const examples = [];

  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    const name = safe(tr, 'DisplayName');
    if (!name) continue;
    counts.teams++;
    const row = { team: name, teamIndex: safe(tr, 'TeamIndex') };
    for (const s of slots) {
      const ref = refOf(tr, s);
      if (!ref || !coachIds.has(ref.tableId)) { counts[`${s}_null`]++; row[s] = null; continue; }
      const cr = coachByRow.get(ref.rowNumber);
      if (!cr) { counts[`${s}_danglingRef`]++; row[s] = 'DANGLING'; continue; }
      counts[`${s}_filled`]++;
      row[s] = `${safe(cr, 'Name')} (L${safe(cr, 'Level')})`;
    }
    if (examples.length < 6) examples.push(row);
  }
  console.log(`\n######## ${label} VACANCY SCAN`);
  console.log('  ', JSON.stringify(counts));
  console.log('   sample teams:');
  for (const e of examples) console.log('    ', JSON.stringify(e));
  return counts;
}

async function pushPull(file, label, fields) {
  const t = biggest(file, 'Coach');
  await t.readRecords();
  const rows = t.records.filter((r) => !r.isEmpty);
  console.log(`\n######## ${label} PUSH/PULL SIGNALS (n=${rows.length})`);
  for (const f of fields) {
    const vals = rows.map((r) => safe(r, f));
    if (vals.every((v) => v === undefined)) { console.log(`   ${f}: (absent)`); continue; }
    const nums = vals.filter((v) => typeof v === 'number');
    if (nums.length === vals.filter((v) => v !== undefined).length && nums.length) {
      console.log(`   ${f}: ${JSON.stringify(stats(nums))}`);
    } else {
      const c = {};
      for (const v of vals) { const k = String(v); c[k] = (c[k] || 0) + 1; }
      const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`   ${f}: ${top.map(([k, n]) => `${k}:${n}`).join(', ')}`);
    }
  }
  return rows;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();

  const madVac = await vacancies(mad, 'MADDEN26');
  const cfbVac = await vacancies(cfb, 'CFB27');

  await pushPull(mad, 'MADDEN26', [
    'ContractStatus', 'ContractLength', 'ContractYearsRemaining', 'ContractSalary',
    'COACH_FIREREPORTED', 'COACH_RESIGNREPORTED', 'COACH_LASTTEAMFIRED', 'COACH_LASTTEAMRESIGNED',
    'COACH_CONSECTEAMCONTRACTS', 'Level', 'CareerWins', 'CareerLosses', 'SeasWins', 'SeasLosses',
    'CareerAssistant', 'Age', 'Position', 'TeamIndex', 'IsMaxLevel', 'LegacyScore',
  ]);

  await pushPull(cfb, 'CFB27', [
    'ContractStatus', 'ContractLength', 'ContractYearsRemaining',
    'CurrentJobSecurityStatus', 'SeasonStartJobSecurityStatus', 'CurrentJobSecurityPercentage',
    'CurrentContractExpectation', 'ContractExpectationProgress',
    'CoachPrestige', 'CoachPrestigeScore', 'Level', 'CurrentWinStreak',
    'CareerWinSeasons', 'CareerPlayoffsMade', 'CurrentStatRankPosition',
    'COACH_FIREREPORTED', 'COACH_RESIGNREPORTED', 'Age', 'Position', 'TeamIndex',
    'EarnedContractPoints_LastYear', 'NumContractOffers', 'PersuadeAttempts',
  ]);

  // Team-side desirability: does each game expose a team prestige/quality signal
  // we can use to decide WHICH job a coach would jump to?
  for (const [file, label, fields] of [
    [mad, 'MADDEN26', ['DisplayName', 'TeamIndex', 'PrestigeRank', 'PrestigeDisplay', 'TEAM_RATINGOVR', 'CurSeasonLeagStanding', 'OverallPopularity']],
    [cfb, 'CFB27', ['DisplayName', 'TeamIndex', 'TeamPrestige', 'PrestigeRank', 'PrestigeDisplay', 'TEAM_RATINGOVR', 'CurSeasonConfStanding', 'OverallPopularity']],
  ]) {
    const t = biggest(file, 'Team');
    await t.readRecords();
    const rows = t.records.filter((r) => !r.isEmpty && safe(r, 'DisplayName'));
    console.log(`\n######## ${label} TEAM DESIRABILITY FIELDS (n=${rows.length})`);
    for (const f of fields) {
      const vals = rows.map((r) => safe(r, f));
      if (vals.every((v) => v === undefined)) { console.log(`   ${f}: (absent)`); continue; }
      const nums = vals.filter((v) => typeof v === 'number');
      if (nums.length) console.log(`   ${f}: ${JSON.stringify(stats(nums))}`);
      else console.log(`   ${f}: e.g. ${vals.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')}`);
    }
    console.log('   top-5 by TEAM_RATINGOVR:');
    rows.slice().sort((a, b) => (safe(b, 'TEAM_RATINGOVR') || 0) - (safe(a, 'TEAM_RATINGOVR') || 0)).slice(0, 5)
      .forEach((r) => console.log(`     ${safe(r, 'DisplayName')} ovr=${safe(r, 'TEAM_RATINGOVR')} prestigeRank=${safe(r, 'PrestigeRank')} prestige=${safe(r, 'TeamPrestige')}`));
  }

  fs.writeFileSync(path.join(OUT, 'movement-signals.json'), JSON.stringify({ madVac, cfbVac }, null, 2));
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
