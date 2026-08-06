// READ-ONLY. Follow-up to probe11's two surprises:
//   (a) Madden shows 2 null HeadCoach / 3 null OC / 3 null DC across 35 teams --
//       are those REAL franchises (a genuine open job) or pseudo-teams
//       (Practice/AFC/NFC/Free Agents), which would mean zero real vacancies?
//   (b) COACH_FIREREPORTED is `true` for every coach in BOTH games (it's just
//       the schema default, never toggled) -- so it is useless as a "was
//       fired" signal. Is COACH_LASTTEAMFIRED usable instead?
const { openCfb, openMadden, safe } = require('./_saves');

const biggest = (f, n) => (f.getAllTablesByName(n) || []).reduce((b, t) => (t.header.recordCapacity > (b ? b.header.recordCapacity : 0) ? t : b), null);
const refOf = (rec, k) => { try { const r = rec.getReferenceDataByKey(k); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

(async () => {
  const mad = await openMadden();
  const cfb = await openCfb();

  // ---- (a) which Madden teams actually have an empty slot? ----
  const teamT = biggest(mad, 'Team');
  await teamT.readRecords();
  const coachIds = new Set((mad.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  console.log('######## MADDEN: every team, with slot status');
  console.log('  teamIndex | name              | ovr | prestigeRank | HC  OC  DC');
  const rows = [];
  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    const name = safe(tr, 'DisplayName');
    if (!name) continue;
    const slot = (k) => { const r = refOf(tr, k); return (r && coachIds.has(r.tableId)) ? 'Y' : '.'; };
    rows.push({
      idx: safe(tr, 'TeamIndex'), name, ovr: safe(tr, 'TEAM_RATINGOVR'),
      rank: safe(tr, 'PrestigeRank'), hc: slot('HeadCoach'), oc: slot('OffensiveCoordinator'), dc: slot('DefensiveCoordinator'),
    });
  }
  rows.sort((a, b) => a.idx - b.idx);
  for (const r of rows) {
    const gap = (r.hc === '.' || r.oc === '.' || r.dc === '.') ? '   <-- OPEN SLOT' : '';
    console.log(`  ${String(r.idx).padStart(9)} | ${String(r.name).padEnd(17)} | ${String(r.ovr).padStart(3)} | ${String(r.rank).padStart(12)} | ${r.hc}   ${r.oc}   ${r.dc}${gap}`);
  }

  // ---- (b) COACH_LASTTEAMFIRED as a "was fired" signal ----
  const coachT = biggest(mad, 'Coach');
  await coachT.readRecords();
  const coaches = coachT.records.filter((r) => !r.isEmpty);
  const SENTINEL = 1023;
  const fired = coaches.filter((r) => { const v = safe(r, 'COACH_LASTTEAMFIRED'); return typeof v === 'number' && v !== SENTINEL; });
  const notFired = coaches.filter((r) => safe(r, 'COACH_LASTTEAMFIRED') === SENTINEL);
  console.log(`\n######## MADDEN: COACH_LASTTEAMFIRED as a "was fired" signal`);
  console.log(`   has a real team index (was fired): ${fired.length}/${coaches.length}`);
  console.log(`   sentinel 1023 (never fired):        ${notFired.length}/${coaches.length}`);
  const xtab = (list, field) => {
    const c = {}; for (const r of list) { const k = String(safe(r, field)); c[k] = (c[k] || 0) + 1; } return c;
  };
  console.log(`   FIRED   x ContractStatus: ${JSON.stringify(xtab(fired, 'ContractStatus'))}`);
  console.log(`   NOTFIRED x ContractStatus: ${JSON.stringify(xtab(notFired, 'ContractStatus'))}`);
  console.log(`   FIRED   x Position: ${JSON.stringify(xtab(fired, 'Position'))}`);
  const lvl = (list) => { const a = list.map((r) => safe(r, 'Level')).filter((n) => typeof n === 'number').sort((x, y) => x - y); return a.length ? `n=${a.length} min=${a[0]} p50=${a[Math.floor(a.length / 2)]} max=${a[a.length - 1]}` : 'n=0'; };
  console.log(`   FIRED    Level: ${lvl(fired)}`);
  console.log(`   NOTFIRED Level: ${lvl(notFired)}`);

  // The realistic NFL->college candidate: fired AND currently unemployed
  const firedAndFree = fired.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent');
  console.log(`\n   fired AND currently FreeAgent (the NFL->college candidate pool): ${firedAndFree.length}`);
  for (const r of firedAndFree.slice(0, 15)) {
    console.log(`     ${String(safe(r, 'Name')).padEnd(16)} ${String(safe(r, 'Position')).padEnd(22)} L${String(safe(r, 'Level')).padStart(2)} `
      + `firedBy=${safe(r, 'COACH_LASTTEAMFIRED')} W-L=${safe(r, 'CareerWins')}-${safe(r, 'CareerLosses')} age=${safe(r, 'Age')}`);
  }

  // ---- (c) CFB: who are the realistic NFL candidates? ----
  const cfbCoachT = biggest(cfb, 'Coach');
  const cfbTeamT = biggest(cfb, 'Team');
  await cfbCoachT.readRecords();
  await cfbTeamT.readRecords();
  const teamByIdx = new Map();
  for (const tr of cfbTeamT.records) {
    if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
    teamByIdx.set(safe(tr, 'TeamIndex'), { name: safe(tr, 'DisplayName'), prestige: safe(tr, 'TeamPrestige'), ovr: safe(tr, 'TEAM_RATINGOVR') });
  }
  const cfbCoaches = cfbCoachT.records.filter((r) => !r.isEmpty && safe(r, 'Position') === 'HeadCoach');
  const ranked = cfbCoaches
    .map((r) => ({
      name: safe(r, 'Name'), lvl: safe(r, 'Level'), prestige: safe(r, 'CoachPrestigeScore'),
      grade: safe(r, 'CoachPrestige'), sec: safe(r, 'CurrentJobSecurityStatus'),
      team: teamByIdx.get(safe(r, 'TeamIndex')) || { name: '(none)', prestige: null, ovr: null },
      winSeasons: safe(r, 'CareerWinSeasons'),
    }))
    .sort((a, b) => (b.prestige || 0) - (a.prestige || 0));
  console.log('\n######## CFB: top-15 head coaches by CoachPrestigeScore (the NFL-candidate shortlist)');
  for (const c of ranked.slice(0, 15)) {
    console.log(`   ${String(c.name).padEnd(16)} L${String(c.lvl).padStart(2)} prestige=${String(c.prestige).padStart(5)} (${String(c.grade).padEnd(6)}) `
      + `winSeas=${String(c.winSeasons).padStart(2)} job=${String(c.sec).padEnd(10)} @ ${c.team.name} (teamPrestige=${c.team.prestige})`);
  }
  console.log('\n   ...and the bottom 5 (would NOT be NFL candidates):');
  for (const c of ranked.slice(-5)) {
    console.log(`   ${String(c.name).padEnd(16)} L${String(c.lvl).padStart(2)} prestige=${String(c.prestige).padStart(5)} (${String(c.grade).padEnd(6)}) `
      + `job=${String(c.sec).padEnd(10)} @ ${c.team.name} (teamPrestige=${c.team.prestige})`);
  }

  // CFB hot-seat coaches -- the "pushed out" population
  const hotSeat = cfbCoachT.records.filter((r) => !r.isEmpty && safe(r, 'CurrentJobSecurityStatus') === 'HotSeat');
  console.log(`\n######## CFB: HotSeat coaches (the pushed-out pool): ${hotSeat.length}`);
  const hsPos = {}; for (const r of hotSeat) { const k = String(safe(r, 'Position')); hsPos[k] = (hsPos[k] || 0) + 1; }
  console.log(`   by position: ${JSON.stringify(hsPos)}`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
