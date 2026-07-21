// READ-ONLY. Record-level distributions for the Coach table in both games.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden, safe, stats } = require('./_saves');

const OUT = path.join(__dirname, 'out');

const NUMERIC = [
  'Level', 'ExperiencePoints', 'LegacyScore', 'Age', 'YearsCoaching', 'SeasonsWithTeam',
  'ContractLength', 'ContractSalary', 'ContractYearsRemaining', 'Height', 'Weight',
  'TeamIndex', 'PrevTeamIndex', 'Portrait', 'PresentationId', 'SpeechId',
  'CareerPointsFor', 'CareerPointsAgainst', 'CareerLongWinStreak', 'CareerPlayoffsMade',
  'CareerWinSeasons', 'CareerTies', 'CareerBigWinMargin', 'CareerBigLossMargin',
  'AwardPoints', 'YearlyAwardCount', 'RegularWinStreak', 'SeasWinStreak',
  'COACH_RATING', 'COACH_QB', 'COACH_RB', 'COACH_WR', 'COACH_OL', 'COACH_DL', 'COACH_LB',
  'COACH_DB', 'COACH_K', 'COACH_P', 'COACH_OFFENSE', 'COACH_DEFENSE',
  'COACH_OFFTENDENCYRUNPASS', 'COACH_DEFTENDENCYRUNPASS',
  'COACH_OFFTENDENCYAGGRESSCONSERV', 'COACH_DEFTENDENCYAGGRESSCONSERV',
  'COACH_RBTENDENCY', 'COACH_PERFORMANCELEVEL', 'COACH_RETIREYRSLEFT',
  'COACH_CONSECTEAMCONTRACTS', 'COACH_LASTCONTRACTTEAM', 'COACH_LASTTEAMFIRED', 'COACH_LASTTEAMRESIGNED',
  'OWNER_COMMENTID', 'OWNER_COMMENTTYPE',
  // CFB only
  'CoachPrestigeScore', 'CoachPoints', 'CurrentJobSecurityPercentage',
  'CurrentJobSecurityPercentageRank', 'CurrentStatRankPosition', 'CurrentWinStreak',
  'EarnedContractPoints_ThisYear', 'EarnedContractPoints_LastYear', 'EarnedContractPoints_TwoYearsAgo',
  'AlmaMater', 'PersuadeAttempts', 'NumContractOffers',
  // Madden only
  'CareerWins', 'CareerLosses', 'CareerPlayoffWins', 'CareerPlayoffLosses',
  'CareerSuperbowlWins', 'CareerSuperbowlLosses', 'CareerProBowlPlayers',
  'SeasWins', 'SeasLosses', 'CurrentPurchasedTalentCosts', 'IndexInUnlockList',
];
const CATEGORICAL = [
  'Position', 'PrevPosition', 'ContractStatus', 'Personality', 'CoachBackstory',
  'COACH_SPECIALTY', 'SpecialtyType', 'COACH_DEMEANOR', 'COACH_STANCE', 'COACH_ADAPTIVE_AI',
  'COACH_NO_HUDDLE_TEMPO', 'CharacterBodyType', 'TeamBuilding', 'TradingTendency',
  'Archetype', 'DominantArchetype', 'CoachPrestige', 'HatType', 'PrimaryPipeline', 'HomeState',
  'CurrentJobSecurityStatus', 'SeasonStartJobSecurityStatus', 'CurrentContractExpectation',
  'ProgramPointsBudgetAllocationPosture', 'OriginalPosition', 'FaceShape',
  'COACH_WASPLAYER', 'IsCreated', 'IsLegend', 'IsUserControlled', 'TraitExpertScout',
  'Probation', 'IsNIL', 'IsMaxLevel', 'CareerAssistant', 'Portrait_Force_Silhouette',
  'OffensiveScheme', 'DefensiveScheme', 'OffensivePlaybook', 'DefensivePlaybook',
  'TeamPhilosophy', 'DefaultTeamPhilosophy', 'OffenseAudibles', 'DefenseAudibles',
  'ActiveTalentTree', 'HasTrait',
];
const STRINGY = ['Name', 'FirstName', 'LastName', 'AssetName', 'GenericHeadAssetName'];

async function scan(file, label) {
  const t = file.getTableByName('Coach');
  await t.readRecords();
  const present = new Set(file.schemaList.getSchema('Coach').attributes.map((a) => a.name));
  const rows = t.records.filter((r) => !r.isEmpty);
  const out = { label, totalRows: t.records.length, filledRows: rows.length, numeric: {}, categorical: {}, samples: [] };

  for (const f of NUMERIC) {
    if (!present.has(f)) continue;
    out.numeric[f] = stats(rows.map((r) => safe(r, f)));
  }
  for (const f of CATEGORICAL) {
    if (!present.has(f)) continue;
    const c = {};
    for (const r of rows) { const v = String(safe(r, f)); c[v] = (c[v] || 0) + 1; }
    out.categorical[f] = Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 40));
  }
  // Level split by Position
  out.levelByPosition = {};
  for (const r of rows) {
    const p = String(safe(r, 'Position'));
    (out.levelByPosition[p] = out.levelByPosition[p] || []).push(safe(r, 'Level'));
  }
  for (const k of Object.keys(out.levelByPosition)) out.levelByPosition[k] = stats(out.levelByPosition[k]);

  // a handful of full sample rows
  for (const r of rows.slice(0, 6)) {
    const o = { _row: r.index };
    for (const f of [...STRINGY, ...NUMERIC, ...CATEGORICAL]) if (present.has(f)) o[f] = safe(r, f);
    out.samples.push(o);
  }
  return { out, table: t, rows };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();
  const c = await scan(cfb, 'CFB27');
  const m = await scan(mad, 'MADDEN26');
  fs.writeFileSync(path.join(OUT, 'coach-records.json'), JSON.stringify({ cfb: c.out, madden: m.out }, null, 2));

  console.log(`CFB rows ${c.out.totalRows} filled ${c.out.filledRows} | MAD rows ${m.out.totalRows} filled ${m.out.filledRows}`);

  const show = (f) => {
    const cs = c.out.numeric[f], ms = m.out.numeric[f];
    const fmt = (s) => s ? `n=${s.n} min=${s.min} p25=${s.p25} p50=${s.p50} p70=${s.p70} p90=${s.p90} max=${s.max} mean=${s.mean} zeros=${s.zeros}` : '(absent)';
    console.log(`  ${f.padEnd(34)} CFB: ${fmt(cs)}`);
    console.log(`  ${''.padEnd(34)} MAD: ${fmt(ms)}`);
  };
  console.log('\n=== KEY NUMERIC ===');
  for (const f of ['Level', 'ExperiencePoints', 'LegacyScore', 'Age', 'YearsCoaching', 'CoachPrestigeScore',
    'CoachPoints', 'CurrentJobSecurityPercentage', 'COACH_RATING', 'COACH_QB', 'COACH_OFFENSE', 'COACH_DEFENSE',
    'CareerWins', 'CareerLosses', 'CareerPointsFor', 'CareerPointsAgainst', 'CareerWinSeasons', 'CareerLongWinStreak',
    'ContractSalary', 'ContractLength', 'ContractYearsRemaining', 'TeamIndex', 'AlmaMater', 'Height', 'Weight']) show(f);

  console.log('\n=== LEVEL BY POSITION ===');
  console.log('CFB:', JSON.stringify(c.out.levelByPosition, null, 1));
  console.log('MAD:', JSON.stringify(m.out.levelByPosition, null, 1));

  console.log('\n=== CATEGORICAL (top values) ===');
  const allCat = [...new Set([...Object.keys(c.out.categorical), ...Object.keys(m.out.categorical)])];
  for (const f of allCat) {
    console.log(`\n## ${f}`);
    console.log('  CFB:', JSON.stringify(c.out.categorical[f] || '(absent)'));
    console.log('  MAD:', JSON.stringify(m.out.categorical[f] || '(absent)'));
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
