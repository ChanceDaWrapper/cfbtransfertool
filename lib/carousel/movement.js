// The Movement Model -- "why would this coach leave?"
//
// Everything above this file can MOVE a coach; nothing decides whether a
// coach WOULD move. This does. It answers three questions, scored 0..1, and
// pairs them into ranked, human-explainable proposals.
//
// ---------------------------------------------------------------------
// The constraint that shapes the whole design (verified, research/probe12):
// THERE ARE NO VACANCIES IN A STATIC SAVE. All 32 real NFL franchises and
// all 143 CFB schools have HeadCoach/OC/DC filled; the only empty slots in
// the Madden save belong to pseudo-teams (AFC/NFC/Free Agents, all
// TeamIndex 32). A real carousel's openings are created by firings during
// the offseason -- they don't exist to be found in a snapshot.
//
// So the model does not look for an open job. It scores how VULNERABLE each
// existing job is (a weak incumbent on a good team = the job most likely to
// come open) and treats the highest-vulnerability jobs as the openings.
// ---------------------------------------------------------------------
//
// The three scores, and why they're separate:
//
//   DESIRABILITY -- would the destination league want this coach?
//   WILLINGNESS  -- would this coach actually take the job?
//   VULNERABILITY -- how likely is this particular job to come open?
//
// Desirability and willingness are deliberately NOT merged, because the most
// desirable college coach is usually the least willing one. Ryan Day at Ohio
// State (CoachPrestigeScore 10000, teamPrestige 10) is the single most
// attractive NFL candidate in the sample save AND the least likely to leave
// -- he already has one of the best jobs in football. The NFL realistically
// hires the coach ranked 3rd-8th, not 1st. Multiplying the two reproduces
// that; a single blended "how good are they" score would not, and would
// hand the NFL the top college coach every single time.
//
// Every score returns its `reasons` -- the human-readable "why" that the UI
// shows and that makes a proposal auditable instead of a magic number.

const { safe, biggestTableByName } = require('../saveIO');
const { pctOf } = require('./map/levelScale');

const HC_OC_DC = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];
const MADDEN_FA_TEAM_INDEX = 32;   // verified: Madden TeamIndex range [0..32], 32 = free-agent pool
const MADDEN_NEVER_FIRED = 1023;   // verified: COACH_LASTTEAMFIRED sentinel

const DEFAULTS = {
  // A candidate below this combined score isn't proposed at all -- most
  // coaches in both leagues should never move in a given cycle.
  minMoveScore: 0.35,
  // How many proposals to return per direction.
  maxProposalsPerDirection: 5,
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------
// Cohort distributions, read once from the live saves. Every score below is
// a PERCENTILE within the relevant cohort, never an absolute threshold --
// same posture as map/levelScale.js, and for the same reason: absolute
// numbers differ wildly between saves (CoachPrestigeScore is p50=194 but
// max=10000 in the sample save -- a heavily right-skewed distribution where
// any hardcoded cutoff would be meaningless on a different dynasty).
// ---------------------------------------------------------------------
async function buildMovementContext({ cfbFile, maddenFile }) {
  const cfbCoachT = biggestTableByName(cfbFile, 'Coach');
  const cfbTeamT = biggestTableByName(cfbFile, 'Team');
  const madCoachT = biggestTableByName(maddenFile, 'Coach');
  const madTeamT = biggestTableByName(maddenFile, 'Team');
  await Promise.all([cfbCoachT.readRecords(), cfbTeamT.readRecords(), madCoachT.readRecords(), madTeamT.readRecords()]);

  const sortedNums = (arr) => arr.filter((n) => typeof n === 'number').sort((a, b) => a - b);

  // CFB cohorts, per position -- a coordinator's prestige means something
  // different from a head coach's, so they're never pooled.
  const cfbByPos = {};
  for (const pos of HC_OC_DC) cfbByPos[pos] = { prestige: [], level: [], winSeasons: [] };
  // ...but a LEAGUE-WIDE prestige scale is also needed. A DC at the 95th
  // percentile of DCs and a head coach at the 95th percentile of head
  // coaches are NOT equally big NFL hires -- the head coach's raw prestige
  // score is several times larger. Percentile-within-position alone flattens
  // that away and makes elite coordinators indistinguishable from marquee
  // head coaches, which is exactly what suppressed every HC proposal in the
  // first run of this model.
  const cfbAllPrestige = [];
  for (const r of cfbCoachT.records) {
    if (r.isEmpty) continue;
    const pos = safe(r, 'Position');
    if (!cfbByPos[pos]) continue;
    const prestige = safe(r, 'CoachPrestigeScore');
    // Level 0 / prestige 0 rows are the save's blank filler shells (verified:
    // 68 CFB free-agent coaches are all Level 0 / Dminus / TeamIndex 255),
    // not real coaches -- they'd drag every percentile toward zero.
    if (safe(r, 'Level') > 0) {
      cfbByPos[pos].prestige.push(typeof prestige === 'number' ? prestige : 0);
      cfbByPos[pos].level.push(safe(r, 'Level'));
      cfbByPos[pos].winSeasons.push(safe(r, 'CareerWinSeasons') || 0);
      cfbAllPrestige.push(typeof prestige === 'number' ? prestige : 0);
    }
  }
  for (const pos of HC_OC_DC) for (const k of ['prestige', 'level', 'winSeasons']) cfbByPos[pos][k] = sortedNums(cfbByPos[pos][k]);
  cfbAllPrestige.sort((a, b) => a - b);
  // p95 of the whole league is the "big name" yardstick. Read live, never
  // hardcoded -- prestige is heavily right-skewed and its scale differs per
  // dynasty (p50=194 but max=10000 in the sample save).
  const cfbPrestigeP95 = cfbAllPrestige.length
    ? cfbAllPrestige[Math.min(cfbAllPrestige.length - 1, Math.round(0.95 * (cfbAllPrestige.length - 1)))] : 1;

  const madByPos = {};
  for (const pos of HC_OC_DC) madByPos[pos] = { level: [] };
  for (const r of madCoachT.records) {
    if (r.isEmpty) continue;
    const pos = safe(r, 'Position');
    if (!madByPos[pos]) continue;
    if (safe(r, 'Level') > 0) madByPos[pos].level.push(safe(r, 'Level'));
  }
  for (const pos of HC_OC_DC) madByPos[pos].level = sortedNums(madByPos[pos].level);

  // Team quality cohorts. CFB has an explicit TeamPrestige (0..10); Madden
  // has no equivalent field populated (PrestigeDisplay reads null), so
  // PrestigeRank (0 = best) is inverted into a comparable 0..1 desirability.
  const cfbTeams = new Map();
  for (const r of cfbTeamT.records) {
    if (r.isEmpty || !safe(r, 'DisplayName')) continue;
    cfbTeams.set(safe(r, 'TeamIndex'), {
      name: safe(r, 'DisplayName'), prestige: safe(r, 'TeamPrestige') || 0, ovr: safe(r, 'TEAM_RATINGOVR') || 0,
    });
  }
  const madTeams = new Map();
  const madRanks = [];
  for (const r of madTeamT.records) {
    if (r.isEmpty || !safe(r, 'DisplayName')) continue;
    const idx = safe(r, 'TeamIndex');
    // TeamIndex 32 is the FA/pseudo-team bucket (AFC, NFC, Free Agents) --
    // never a real job.
    if (idx === MADDEN_FA_TEAM_INDEX) continue;
    const rank = safe(r, 'PrestigeRank');
    madTeams.set(idx, { name: safe(r, 'DisplayName'), rank, ovr: safe(r, 'TEAM_RATINGOVR') || 0 });
    if (typeof rank === 'number') madRanks.push(rank);
  }
  const maxRank = madRanks.length ? Math.max(...madRanks) : 31;

  // Live CFB roster-quality distribution, for cfbJobAttractiveness's secondary
  // term -- a percentile within the league's own spread, never an absolute
  // threshold (TEAM_RATINGOVR's scale differs between the two games).
  const cfbTeamOvrSorted = sortedNums([...cfbTeams.values()].map((t) => t.ovr));

  return {
    cfbByPos, cfbPrestigeP95, madByPos, cfbTeams, madTeams,
    maxMaddenRank: maxRank, cfbTeamOvrSorted,
  };
}

// ---------------------------------------------------------------------
// CFB -> NFL
// ---------------------------------------------------------------------

// Would an NFL team want this college coach? Prestige dominates -- it's the
// signal that cleanly separates Day/Riley/Kiffin/Smart (5000-10000) from the
// Troy/South Alabama coaches (0-4) in the sample save.
function scoreCfbDesirability(c, ctx) {
  const cohort = ctx.cfbByPos[c.position];
  if (!cohort) return { score: 0, reasons: ['not a head coach or coordinator'] };
  const reasons = [];

  // Two prestige terms, deliberately: percentile-WITHIN-position ("are they
  // elite at their job?") and raw-vs-league ("how big a name are they in
  // college football at all?"). Only the second one distinguishes a marquee
  // head coach from a very good coordinator -- see buildMovementContext.
  const prestigePct = pctOf(cohort.prestige, c.prestigeScore);
  const prestigeAbsolute = clamp01((c.prestigeScore || 0) / (ctx.cfbPrestigeP95 || 1));
  const levelPct = pctOf(cohort.level, c.level);
  const winPct = pctOf(cohort.winSeasons, c.careerWinSeasons);
  const teamPrestige = clamp01((c.teamPrestige || 0) / 10);

  if (prestigePct >= 0.9) reasons.push(`elite prestige (${c.prestigeGrade}, top ${Math.round((1 - prestigePct) * 100)}% of college ${c.position}s)`);
  else if (prestigePct >= 0.7) reasons.push(`strong prestige (${c.prestigeGrade})`);
  if (prestigeAbsolute >= 0.9) reasons.push('a national name');
  if (levelPct >= 0.85) reasons.push(`high coach level (${c.level})`);
  if (c.careerWinSeasons >= 10) reasons.push(`${c.careerWinSeasons} winning seasons`);
  if (teamPrestige >= 0.95) reasons.push(`runs a blue-blood program (${c.teamName})`);
  else if (teamPrestige >= 0.75) reasons.push(`runs a strong program (${c.teamName})`);

  const score = clamp01(
    0.32 * prestigePct + 0.28 * prestigeAbsolute + 0.15 * levelPct + 0.10 * winPct + 0.15 * teamPrestige
  );
  return { score, reasons, parts: { prestigePct, prestigeAbsolute, levelPct, winPct, teamPrestige } };
}

// Would this college coach actually leave? The inverse of how good their
// current job already is, nudged up by job insecurity. This is what stops
// the model from handing the NFL the #1 college coach every cycle.
function scoreCfbWillingness(c, ctx) {
  const reasons = [];
  // A 10-prestige blue blood is the hardest job to walk away from -- but the
  // penalty is deliberately moderate (0.40, not 0.75). Real marquee moves do
  // happen off the very best college jobs (Harbaugh left a national-title
  // Michigan team for the Chargers), and an over-strong penalty scored every
  // top head coach out of contention entirely -- the NFL then only ever hired
  // hot-seat coordinators, which is not a believable carousel.
  const jobQuality = clamp01((c.teamPrestige || 0) / 10);
  let willingness = 1 - 0.40 * jobQuality;

  // Softened from 0.35: over half of CFB's coordinators sit on the hot seat
  // (107 of 213 in the sample save), so an outsized bonus here stopped
  // discriminating and simply drowned out prestige.
  if (c.jobSecurity === 'HotSeat') { willingness += 0.20; reasons.push('on the hot seat -- would jump before being fired'); }
  else if (c.jobSecurity === 'Low') { willingness += 0.12; reasons.push('shaky job security'); }
  else if (c.jobSecurity === 'Safe' && jobQuality >= 0.9) reasons.push(`secure at a top program (${c.teamName}) -- would take a strong offer to pry away`);

  // A coordinator has more to gain from an NFL move than a sitting HC does.
  if (c.position !== 'HeadCoach') { willingness += 0.15; reasons.push('a coordinator -- an NFL job is a step up'); }

  // Late-career coaches are less likely to uproot.
  if (typeof c.age === 'number' && c.age >= 60) { willingness -= 0.25; reasons.push(`age ${c.age} -- unlikely to start over`); }

  return { score: clamp01(willingness), reasons };
}

function scoreCfbToNfl(c, ctx) {
  const desirability = scoreCfbDesirability(c, ctx);
  const willingness = scoreCfbWillingness(c, ctx);
  return {
    direction: 'cfbToNfl',
    coach: c,
    desirability: desirability.score,
    willingness: willingness.score,
    score: desirability.score * willingness.score,
    reasons: [...desirability.reasons, ...willingness.reasons],
  };
}

// ---------------------------------------------------------------------
// NFL -> CFB
// ---------------------------------------------------------------------

// Would a college program want this NFL coach? NFL pedigree is itself the
// draw, so this is much flatter than the CFB side -- but a coach who was
// just run out of the league on a 12-39 record is a harder sell than a
// respected coordinator.
function scoreNflDesirability(c, ctx) {
  const cohort = ctx.madByPos[c.position];
  const reasons = ['NFL coaching experience'];
  const levelPct = cohort ? pctOf(cohort.level, c.level) : 0.5;

  let winPct = 0.5;
  const games = (c.careerWins || 0) + (c.careerLosses || 0);
  if (games >= 10) {
    winPct = (c.careerWins || 0) / games;
    if (winPct >= 0.55) reasons.push(`winning NFL record (${c.careerWins}-${c.careerLosses})`);
    else if (winPct <= 0.40) reasons.push(`poor NFL record (${c.careerWins}-${c.careerLosses})`);
  }
  if (levelPct >= 0.75) reasons.push(`well-regarded (level ${c.level})`);

  // Deliberately generous baseline: college programs hire NFL names even
  // after a bad stint -- the pedigree carries real weight on the trail.
  const score = clamp01(0.35 + 0.35 * levelPct + 0.30 * winPct);
  return { score, reasons, parts: { levelPct, winPct } };
}

// Would this NFL coach take a college job? Being fired and unemployed is the
// dominant signal -- verified as a real, populated field (COACH_LASTTEAMFIRED
// is a genuine team index for 44/127 coaches; 8 are fired AND currently free
// agents, all low-level with losing records). Note COACH_FIREREPORTED is NOT
// usable: it reads `true` for every coach in both games (it's the schema
// default and is never toggled), so it carries no information at all.
function scoreNflWillingness(c, ctx) {
  const reasons = [];
  let willingness = 0.10; // a happily-employed NFL coach almost never leaves for college

  if (c.contractStatus === 'FreeAgent') { willingness += 0.45; reasons.push('currently unemployed'); }
  if (c.wasFired) { willingness += 0.25; reasons.push(`fired by ${c.firedByTeamName || 'a previous team'}`); }

  const cohort = ctx.madByPos[c.position];
  const levelPct = cohort ? pctOf(cohort.level, c.level) : 0.5;
  // The lower their standing in the NFL, the more a college job appeals --
  // exactly the population the sample save exposes (L1-L9, losing records).
  if (levelPct <= 0.35) { willingness += 0.25; reasons.push(`low standing in the NFL (level ${c.level}) -- college is a realistic landing spot`); }
  else if (levelPct >= 0.85) { willingness -= 0.30; reasons.push(`too well-regarded in the NFL (level ${c.level}) to drop down`); }

  if (c.position !== 'HeadCoach') { willingness += 0.15; reasons.push('a coordinator -- a college HC job is a promotion'); }
  if (typeof c.age === 'number' && c.age >= 62) { willingness -= 0.20; reasons.push(`age ${c.age}`); }

  return { score: clamp01(willingness), reasons };
}

function scoreNflToCfb(c, ctx) {
  const desirability = scoreNflDesirability(c, ctx);
  const willingness = scoreNflWillingness(c, ctx);
  return {
    direction: 'nflToCfb',
    coach: c,
    desirability: desirability.score,
    willingness: willingness.score,
    score: desirability.score * willingness.score,
    reasons: [...desirability.reasons, ...willingness.reasons],
  };
}

// ---------------------------------------------------------------------
// Job vulnerability -- which NFL job is most likely to come open?
// (No literal vacancy exists; see this file's header.)
// ---------------------------------------------------------------------
function scoreJobVulnerability(job, ctx) {
  const reasons = [];
  const cohort = ctx.madByPos[job.position];
  const levelPct = cohort ? pctOf(cohort.level, job.incumbentLevel) : 0.5;

  let vulnerability = 0;
  // A weak incumbent is the main thing that opens a job.
  vulnerability += 0.45 * (1 - levelPct);
  if (levelPct <= 0.25) reasons.push(`weak incumbent (${job.incumbentName}, level ${job.incumbentLevel})`);

  const games = (job.incumbentWins || 0) + (job.incumbentLosses || 0);
  if (games >= 10) {
    const winPct = (job.incumbentWins || 0) / games;
    vulnerability += 0.30 * (1 - clamp01(winPct / 0.6));
    if (winPct <= 0.40) reasons.push(`losing record (${job.incumbentWins}-${job.incumbentLosses})`);
  }

  if (job.incumbentWasFired) { vulnerability += 0.10; reasons.push('incumbent has been fired before'); }
  if (typeof job.incumbentYearsRemaining === 'number' && job.incumbentYearsRemaining <= 1) {
    vulnerability += 0.15;
    reasons.push(`contract expiring (${job.incumbentYearsRemaining} yr left)`);
  }

  // A good roster with a bad coach is the most attractive opening of all --
  // it's the job a big-name college coach would actually want.
  const rosterQuality = clamp01((job.teamOvr - 70) / 12);
  const attractiveness = clamp01(0.5 * rosterQuality + 0.5 * (1 - (job.teamRank || 0) / (ctx.maxMaddenRank || 31)));
  if (attractiveness >= 0.75) reasons.push(`attractive job (${job.teamName}, roster ${job.teamOvr})`);

  return {
    score: clamp01(vulnerability),
    attractiveness,
    // What a candidate actually weighs: how likely it opens AND how good it is.
    openingScore: clamp01(vulnerability) * (0.5 + 0.5 * attractiveness),
    reasons,
    job,
  };
}

// ---------------------------------------------------------------------
// Job vulnerability -- which CFB job is most likely to come open?
//
// The CFB side is BETTER instrumented than the NFL side for this. Madden has
// no "how hot is this seat" field, so scoreJobVulnerability above has to
// INFER vulnerability from a weak incumbent + losing record + expiring
// contract. CFB gives it to us directly: Coach.CurrentJobSecurityPercentage,
// a real 0-100 field, populated for all 414 employed coaches in the sample
// save (mean 70, p10 16). So job security is the DOMINANT term here rather
// than one signal among several.
//
// Verified live, and the reason the enum is not used as the primary signal:
// CurrentJobSecurityStatus is just a 4-way banding of that percentage
// (HotSeat 0-49, Low 50-64, SafeForNow 60-78, Safe 80-100), so the raw
// percentage carries strictly more resolution. The enum is still surfaced in
// `reasons` because it is what the game shows the user.
//
// NOT used: CurrentJobSecurityPercentageRank. It looks like it should be a
// least-secure-first ordering and is not -- rank 1 in the sample save is a
// 65% "SafeForNow" coach while the max rank is a 100% "Safe" one, so it
// ranks something else entirely (or is stale). Reading it as vulnerability
// would invert the model for a large part of the pool.
function scoreCfbJobVulnerability(job, ctx) {
  const reasons = [];

  // A literally vacant slot is maximally open -- nothing to displace.
  if (job.vacant) {
    const attractivenessVacant = cfbJobAttractiveness(job, ctx);
    return {
      score: 1,
      attractiveness: attractivenessVacant,
      openingScore: 0.5 + 0.5 * attractivenessVacant,
      reasons: [`${job.teamName} has no ${job.position} at all`],
      job,
    };
  }

  let vulnerability = 0;

  // The direct signal, and deliberately the bulk of the weight.
  const pct = typeof job.incumbentJobSecurityPct === 'number' ? job.incumbentJobSecurityPct : 100;
  vulnerability += 0.70 * clamp01(1 - (pct / 100));
  if (job.incumbentJobSecurityStatus === 'HotSeat') reasons.push(`${job.incumbentName} is on the hot seat (${pct}% job security)`);
  else if (job.incumbentJobSecurityStatus === 'Low') reasons.push(`${job.incumbentName}'s job security is low (${pct}%)`);

  // An expiring contract makes a change cheap for the school.
  if (typeof job.incumbentYearsRemaining === 'number' && job.incumbentYearsRemaining <= 1) {
    vulnerability += 0.15;
    reasons.push(`contract expiring (${job.incumbentYearsRemaining} yr left)`);
  }

  // A weak incumbent, as a secondary signal -- percentile within their own
  // position cohort, same posture as everywhere else in this file.
  const cohort = ctx.cfbByPos[job.position];
  const levelPct = cohort ? pctOf(cohort.level, job.incumbentLevel) : 0.5;
  vulnerability += 0.15 * (1 - levelPct);
  if (levelPct <= 0.25) reasons.push(`weak incumbent (${job.incumbentName}, level ${job.incumbentLevel})`);

  const attractiveness = cfbJobAttractiveness(job, ctx);
  if (attractiveness >= 0.75) reasons.push(`marquee job (${job.teamName}, prestige ${job.teamPrestige})`);

  return {
    score: clamp01(vulnerability),
    attractiveness,
    // Same shape as the NFL side: how likely it opens AND how good it is.
    openingScore: clamp01(vulnerability) * (0.5 + 0.5 * attractiveness),
    reasons,
    job,
  };
}

// How much would a coach WANT this school? CFB has an explicit TeamPrestige
// (0..10, verified populated across all 139 schools), which is a far cleaner
// signal than Madden's inverted PrestigeRank -- so it carries most of the
// weight, with roster quality as a secondary term.
function cfbJobAttractiveness(job, ctx) {
  const prestige = clamp01((job.teamPrestige || 0) / 10);
  const cohortOvr = ctx.cfbTeamOvrSorted || [];
  const rosterQuality = cohortOvr.length ? pctOf(cohortOvr, job.teamOvr || 0) : 0.5;
  return clamp01(0.75 * prestige + 0.25 * rosterQuality);
}

// ---------------------------------------------------------------------
// Reading the live saves into the plain shapes the scorers above take.
// ---------------------------------------------------------------------
async function readCfbCandidates(cfbFile, ctx) {
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const out = [];
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const position = safe(r, 'Position');
    if (!HC_OC_DC.includes(position)) continue;
    const level = safe(r, 'Level');
    if (!level) continue; // blank filler shell
    const teamIndex = safe(r, 'TeamIndex');
    const team = ctx.cfbTeams.get(teamIndex);
    out.push({
      sourceRow: r.index, name: safe(r, 'Name'), position, level, age: safe(r, 'Age'),
      prestigeScore: safe(r, 'CoachPrestigeScore') || 0, prestigeGrade: safe(r, 'CoachPrestige'),
      jobSecurity: safe(r, 'CurrentJobSecurityStatus'), careerWinSeasons: safe(r, 'CareerWinSeasons') || 0,
      teamIndex, teamName: team ? team.name : '(unassigned)', teamPrestige: team ? team.prestige : 0,
    });
  }
  return out;
}

async function readNflCandidates(maddenFile, ctx) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();
  const out = [];
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const position = safe(r, 'Position');
    if (!HC_OC_DC.includes(position)) continue;
    const firedBy = safe(r, 'COACH_LASTTEAMFIRED');
    const wasFired = typeof firedBy === 'number' && firedBy !== MADDEN_NEVER_FIRED;
    const firedTeam = wasFired ? ctx.madTeams.get(firedBy) : null;
    const teamIndex = safe(r, 'TeamIndex');
    const team = ctx.madTeams.get(teamIndex);
    out.push({
      sourceRow: r.index, name: safe(r, 'Name'), position, level: safe(r, 'Level'), age: safe(r, 'Age'),
      contractStatus: safe(r, 'ContractStatus'),
      careerWins: safe(r, 'CareerWins') || 0, careerLosses: safe(r, 'CareerLosses') || 0,
      wasFired, firedByTeamName: firedTeam ? firedTeam.name : null,
      teamIndex,
      // Mirrors readCfbCandidates' own `teamName` -- without it, any consumer
      // formatting "<coach> (<teamName>)" prints "(undefined)" for every NFL
      // candidate. TeamIndex 32 is the free-agent pool, which is where most
      // realistic NFL->CFB candidates sit, so it gets a real label rather
      // than falling through to the unassigned one.
      teamName: team ? team.name : (teamIndex === MADDEN_FA_TEAM_INDEX ? '(free agent)' : '(unassigned)'),
    });
  }
  return out;
}

async function readNflJobs(maddenFile, ctx) {
  const teamT = biggestTableByName(maddenFile, 'Team');
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await Promise.all([teamT.readRecords(), coachT.readRecords()]);
  const coachIds = new Set((maddenFile.getAllTablesByName('Coach') || []).map((x) => x.header.tableId));
  const coachByRow = new Map();
  for (const r of coachT.records) if (!r.isEmpty) coachByRow.set(r.index, r);

  const jobs = [];
  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    const teamIndex = safe(tr, 'TeamIndex');
    const team = ctx.madTeams.get(teamIndex);
    if (!team) continue; // pseudo-team (AFC/NFC/Free Agents) -- never a real job
    for (const slot of HC_OC_DC) {
      let ref; try { ref = tr.getReferenceDataByKey(slot); } catch (e) { ref = null; }
      const incumbent = (ref && coachIds.has(ref.tableId)) ? coachByRow.get(ref.rowNumber) : null;
      const firedBy = incumbent ? safe(incumbent, 'COACH_LASTTEAMFIRED') : null;
      jobs.push({
        teamIndex, teamName: team.name, teamOvr: team.ovr, teamRank: team.rank, position: slot,
        vacant: !incumbent,
        incumbentRow: incumbent ? incumbent.index : null,
        incumbentName: incumbent ? safe(incumbent, 'Name') : null,
        incumbentLevel: incumbent ? safe(incumbent, 'Level') : 0,
        incumbentWins: incumbent ? safe(incumbent, 'CareerWins') : 0,
        incumbentLosses: incumbent ? safe(incumbent, 'CareerLosses') : 0,
        incumbentYearsRemaining: incumbent ? safe(incumbent, 'ContractYearsRemaining') : null,
        incumbentWasFired: incumbent ? (typeof firedBy === 'number' && firedBy !== MADDEN_NEVER_FIRED) : false,
      });
    }
  }
  return jobs;
}

// CFB's counterpart to readNflJobs. Same walk (Team.<slot> -> Coach row),
// but carries the job-security fields scoreCfbJobVulnerability actually
// leans on instead of Madden's win/loss + fired history.
async function readCfbJobs(cfbFile, ctx) {
  const teamT = biggestTableByName(cfbFile, 'Team');
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await Promise.all([teamT.readRecords(), coachT.readRecords()]);
  const coachIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((x) => x.header.tableId));
  const coachByRow = new Map();
  for (const r of coachT.records) if (!r.isEmpty) coachByRow.set(r.index, r);

  const jobs = [];
  for (const tr of teamT.records) {
    if (tr.isEmpty) continue;
    const teamIndex = safe(tr, 'TeamIndex');
    const team = ctx.cfbTeams.get(teamIndex);
    if (!team) continue; // no DisplayName -- not a real school
    for (const slot of HC_OC_DC) {
      let ref; try { ref = tr.getReferenceDataByKey(slot); } catch (e) { ref = null; }
      const incumbent = (ref && coachIds.has(ref.tableId)) ? coachByRow.get(ref.rowNumber) : null;
      jobs.push({
        teamIndex, teamName: team.name, teamPrestige: team.prestige, teamOvr: team.ovr, position: slot,
        vacant: !incumbent,
        incumbentRow: incumbent ? incumbent.index : null,
        incumbentName: incumbent ? safe(incumbent, 'Name') : null,
        incumbentLevel: incumbent ? safe(incumbent, 'Level') : 0,
        incumbentJobSecurityPct: incumbent ? safe(incumbent, 'CurrentJobSecurityPercentage') : null,
        incumbentJobSecurityStatus: incumbent ? safe(incumbent, 'CurrentJobSecurityStatus') : null,
        incumbentYearsRemaining: incumbent ? safe(incumbent, 'ContractYearsRemaining') : null,
      });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------
// The whole thing: rank both directions and pair candidates to openings.
// Returns proposals ONLY -- this module never writes anything. Feeding a
// proposal to lib/carousel's moveCoachCfbToMadden is the caller's choice.
// ---------------------------------------------------------------------
async function proposeCarousel({ cfbFile, maddenFile, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const ctx = await buildMovementContext({ cfbFile, maddenFile });

  const cfbCandidates = (await readCfbCandidates(cfbFile, ctx))
    .map((c) => scoreCfbToNfl(c, ctx))
    .filter((s) => s.score >= cfg.minMoveScore)
    .sort((a, b) => b.score - a.score);

  const nflCandidates = (await readNflCandidates(maddenFile, ctx))
    .map((c) => scoreNflToCfb(c, ctx))
    .filter((s) => s.score >= cfg.minMoveScore)
    .sort((a, b) => b.score - a.score);

  const openings = (await readNflJobs(maddenFile, ctx))
    .map((j) => scoreJobVulnerability(j, ctx))
    .sort((a, b) => b.openingScore - a.openingScore);

  const cfbOpenings = (await readCfbJobs(cfbFile, ctx))
    .map((j) => scoreCfbJobVulnerability(j, ctx))
    .sort((a, b) => b.openingScore - a.openingScore);

  // Pair greedily: best available candidate to best available opening, one
  // coach per job, matching position. Greedy is the right shape here -- a
  // real carousel resolves in exactly this order (the best job hires first,
  // and the best candidate takes it).
  //
  // Filled PER POSITION rather than as one global top-N. A real carousel's
  // headline is who gets the head-coaching jobs; a single global ranking let
  // whichever position happened to score highest (coordinators, since there
  // are ~2x as many of them and they carry a willingness bonus) crowd head
  // coaches off the list entirely.
  function pairToOpenings(candidates, openingPool) {
    const usedJobs = new Set();
    const perPosition = Math.max(1, Math.ceil(cfg.maxProposalsPerDirection / HC_OC_DC.length));
    const paired = [];
    for (const position of HC_OC_DC) {
      let taken = 0;
      for (const cand of candidates) {
        if (taken >= perPosition) break;
        if (cand.coach.position !== position) continue;
        const opening = openingPool.find((o) => !usedJobs.has(`${o.job.teamIndex}:${o.job.position}`)
          && o.job.position === position);
        if (!opening) break;
        usedJobs.add(`${opening.job.teamIndex}:${opening.job.position}`);
        taken++;
        paired.push({
          ...cand,
          target: opening,
          why: `${cand.coach.name} (${cand.coach.teamName}) -> ${opening.job.teamName}: `
            + `${cand.reasons.join('; ')}. Job: ${opening.reasons.join('; ') || 'incumbent under pressure'}.`,
        });
      }
    }
    paired.sort((a, b) => b.score - a.score);
    return paired;
  }

  const cfbToNfl = pairToOpenings(cfbCandidates, openings);
  // The reverse direction now pairs to real destinations too, using CFB's own
  // job-security field (see scoreCfbJobVulnerability). Before this existed,
  // nflToCfb returned ranked candidates with NO target, which is why
  // run.js's auto-propose only supported the forward direction.
  const nflToCfb = pairToOpenings(nflCandidates, cfbOpenings);

  return {
    cfbToNfl,
    nflToCfb,
    openings: openings.slice(0, 10),
    cfbOpenings: cfbOpenings.slice(0, 10),
    counts: {
      cfbCandidatesConsidered: cfbCandidates.length,
      nflCandidatesConsidered: nflCandidates.length,
      realNflJobs: openings.length,
      realCfbJobs: cfbOpenings.length,
      literalVacancies: openings.filter((o) => o.job.vacant).length,
      literalCfbVacancies: cfbOpenings.filter((o) => o.job.vacant).length,
    },
  };
}

module.exports = {
  DEFAULTS, MADDEN_FA_TEAM_INDEX, MADDEN_NEVER_FIRED, HC_OC_DC,
  buildMovementContext,
  scoreCfbDesirability, scoreCfbWillingness, scoreCfbToNfl,
  scoreNflDesirability, scoreNflWillingness, scoreNflToCfb,
  scoreJobVulnerability, scoreCfbJobVulnerability, cfbJobAttractiveness,
  readCfbCandidates, readNflCandidates, readNflJobs, readCfbJobs,
  proposeCarousel,
};
