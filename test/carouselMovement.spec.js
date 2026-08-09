// Regression test for lib/carousel/movement.js -- the "why would this coach
// leave?" model. Pure scoring only; the cohort context is a fixture, so no
// real save is needed (same convention as the other carousel specs).
// Run with: node test/carouselMovement.spec.js (or npm test).

const assert = require('assert');
const {
  scoreCfbDesirability, scoreCfbWillingness, scoreCfbToNfl,
  scoreNflDesirability, scoreNflWillingness, scoreNflToCfb,
  scoreJobVulnerability, scoreCfbJobVulnerability,
} = require('../lib/carousel/movement');

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}
function checkEq(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// Cohort fixture roughly shaped like the real sample save: prestige is
// heavily right-skewed, head coaches carry far larger raw prestige than
// coordinators, and Madden levels are compressed.
const ctx = {
  cfbByPos: {
    HeadCoach: { prestige: [0, 50, 200, 800, 2000, 4000, 6000, 10000], level: [20, 30, 40, 50, 60, 70, 80, 87], winSeasons: [0, 2, 5, 8, 11, 14, 17, 20] },
    OffensiveCoordinator: { prestige: [0, 10, 50, 150, 400, 900, 1500, 2200], level: [10, 20, 30, 35, 40, 45, 50, 61], winSeasons: [0, 0, 1, 2, 4, 6, 8, 10] },
    DefensiveCoordinator: { prestige: [0, 10, 50, 150, 400, 900, 1500, 2200], level: [10, 20, 30, 35, 40, 45, 50, 63], winSeasons: [0, 0, 1, 2, 4, 6, 8, 10] },
  },
  cfbPrestigeP95: 5215,
  madByPos: {
    HeadCoach: { level: [2, 9, 12, 18, 23, 31, 41, 49] },
    OffensiveCoordinator: { level: [1, 3, 5, 6, 7, 8, 11, 15] },
    DefensiveCoordinator: { level: [3, 4, 10, 13, 14, 15, 18, 19] },
  },
  cfbTeams: new Map(), madTeams: new Map(), maxMaddenRank: 31,
};

// ---------------------------------------------------------------------
// 1. CFB desirability -- prestige dominates, and the league-wide term is
//    what separates a marquee head coach from an elite coordinator.
// ---------------------------------------------------------------------
const marqueeHC = {
  position: 'HeadCoach', prestigeScore: 10000, prestigeGrade: 'Aplus', level: 87,
  careerWinSeasons: 17, teamPrestige: 10, teamName: 'Ohio State', jobSecurity: 'Safe', age: 45,
};
const eliteCoordinator = {
  position: 'DefensiveCoordinator', prestigeScore: 2200, prestigeGrade: 'Aplus', level: 63,
  careerWinSeasons: 10, teamPrestige: 8, teamName: 'Miami', jobSecurity: 'HotSeat', age: 44,
};
const badHC = {
  position: 'HeadCoach', prestigeScore: 0, prestigeGrade: 'F', level: 20,
  careerWinSeasons: 0, teamPrestige: 1, teamName: 'Troy', jobSecurity: 'Safe', age: 50,
};

const marqueeD = scoreCfbDesirability(marqueeHC, ctx);
const coordD = scoreCfbDesirability(eliteCoordinator, ctx);
const badD = scoreCfbDesirability(badHC, ctx);

check('marquee HC is highly desirable to the NFL', marqueeD.score > 0.85);
check('a bottom-tier HC is not', badD.score < 0.25);
check('marquee HC outranks an elite coordinator on desirability (the league-wide prestige term)',
  marqueeD.score > coordD.score);
check('marquee HC is flagged as a national name', marqueeD.reasons.some((r) => /national name/.test(r)));
check('an elite coordinator at the top of their own cohort still reads as elite prestige',
  coordD.reasons.some((r) => /elite prestige/.test(r)));
// Guard the specific bug this term was added to fix: without a league-wide
// prestige component, both sit at the 100th percentile of their own cohort
// and become indistinguishable.
checkEq('both are at the top of their own position cohort (so percentile alone cannot separate them)',
  [marqueeD.parts.prestigePct, coordD.parts.prestigePct], [marqueeD.parts.prestigePct, marqueeD.parts.prestigePct]);
check('...but their league-wide prestige differs sharply',
  marqueeD.parts.prestigeAbsolute - coordD.parts.prestigeAbsolute > 0.5);

// ---------------------------------------------------------------------
// 2. CFB willingness -- the inverse of how good the current job already is.
// ---------------------------------------------------------------------
const marqueeW = scoreCfbWillingness(marqueeHC, ctx);
const coordW = scoreCfbWillingness(eliteCoordinator, ctx);
check('a secure coach at a blue blood is the least willing to leave', marqueeW.score < 0.7);
check('a hot-seat coordinator is highly willing', coordW.score > 0.9);
check('the blue-blood coach is explicitly explained as hard to pry away',
  marqueeW.reasons.some((r) => /pry away/.test(r)));
check('hot seat is given as a reason', coordW.reasons.some((r) => /hot seat/.test(r)));

const oldCoach = { ...marqueeHC, age: 63 };
check('a 60+ coach is less willing to uproot', scoreCfbWillingness(oldCoach, ctx).score < marqueeW.score);

// ---------------------------------------------------------------------
// 3. The multiplication is the point: desirability alone must NOT decide.
//    The most desirable coach in college football should not automatically
//    be the top proposal, because he is the least likely to leave.
// ---------------------------------------------------------------------
const marqueeMove = scoreCfbToNfl(marqueeHC, ctx);
const coordMove = scoreCfbToNfl(eliteCoordinator, ctx);
check('the most desirable coach does not automatically top the board',
  coordMove.score > marqueeMove.score);
check('...even though he is strictly more desirable',
  marqueeMove.desirability > coordMove.desirability);
checkEq('score is exactly desirability * willingness',
  Number(marqueeMove.score.toFixed(6)),
  Number((marqueeMove.desirability * marqueeMove.willingness).toFixed(6)));

// A coach on the hot seat at a mid program should beat an identical coach
// who is safe -- the push signal has to actually do something.
const safeVersion = { ...eliteCoordinator, jobSecurity: 'Safe' };
check('hot seat raises the move score vs an otherwise identical safe coach',
  scoreCfbToNfl(eliteCoordinator, ctx).score > scoreCfbToNfl(safeVersion, ctx).score);

// ---------------------------------------------------------------------
// 4. NFL -> CFB. The dominant signal is fired + unemployed + low standing --
//    the population probe12 found (8 coaches, all L1-L9, losing records).
// ---------------------------------------------------------------------
const firedFreeAgent = {
  position: 'HeadCoach', level: 3, age: 43, contractStatus: 'FreeAgent',
  careerWins: 12, careerLosses: 39, wasFired: true, firedByTeamName: 'Browns',
};
const happilyEmployedStar = {
  position: 'HeadCoach', level: 49, age: 50, contractStatus: 'Signed',
  careerWins: 120, careerLosses: 60, wasFired: false, firedByTeamName: null,
};

const firedMove = scoreNflToCfb(firedFreeAgent, ctx);
const starMove = scoreNflToCfb(happilyEmployedStar, ctx);
check('a fired, unemployed, low-level NFL coach is a strong college candidate', firedMove.score > 0.4);
check('a successful, employed NFL head coach is not', starMove.score < 0.15);
check('being unemployed is given as a reason', firedMove.reasons.some((r) => /unemployed/.test(r)));
check('who fired them is named', firedMove.reasons.some((r) => /fired by Browns/.test(r)));
check('a top NFL coach is explained as too well-regarded to drop down',
  starMove.reasons.some((r) => /too well-regarded/.test(r)));

const w = scoreNflWillingness(firedFreeAgent, ctx);
check('fired + unemployed + low standing stacks to near-total willingness', w.score > 0.9);
check('a poor NFL record is surfaced in desirability',
  scoreNflDesirability(firedFreeAgent, ctx).reasons.some((r) => /poor NFL record/.test(r)));
check('NFL experience is always credited as a draw',
  scoreNflDesirability(firedFreeAgent, ctx).reasons.some((r) => /NFL coaching experience/.test(r)));

// ---------------------------------------------------------------------
// 5. Job vulnerability -- no literal vacancies exist (probe12), so an
//    "opening" is a weak incumbent on a good roster.
// ---------------------------------------------------------------------
const weakIncumbentGoodTeam = {
  teamName: 'Chiefs', teamOvr: 80, teamRank: 8, position: 'HeadCoach',
  incumbentName: 'H. Flohr', incumbentLevel: 2, incumbentWins: 10, incumbentLosses: 26,
  incumbentYearsRemaining: 1, incumbentWasFired: true,
};
const strongIncumbentGoodTeam = {
  teamName: 'Lions', teamOvr: 82, teamRank: 0, position: 'HeadCoach',
  incumbentName: 'Star Coach', incumbentLevel: 49, incumbentWins: 120, incumbentLosses: 40,
  incumbentYearsRemaining: 5, incumbentWasFired: false,
};
const weakJob = scoreJobVulnerability(weakIncumbentGoodTeam, ctx);
const strongJob = scoreJobVulnerability(strongIncumbentGoodTeam, ctx);
check('a weak incumbent with a losing record is a vulnerable job', weakJob.score > 0.7);
check('a successful incumbent on a long deal is not', strongJob.score < 0.15);
check('the weak incumbent is named in the reasoning', weakJob.reasons.some((r) => /weak incumbent/.test(r)));
check('the losing record is named', weakJob.reasons.some((r) => /losing record/.test(r)));
check('an expiring contract is named', weakJob.reasons.some((r) => /expiring/.test(r)));
check('a good roster reads as an attractive job', strongJob.attractiveness > 0.8);
check('openingScore blends vulnerability with attractiveness (a great roster is a better prize)',
  weakJob.openingScore > 0 && weakJob.openingScore <= weakJob.score);

// ---------------------------------------------------------------------
// 6. CFB job vulnerability -- unlike the NFL side, CFB gives us the answer
//    directly (Coach.CurrentJobSecurityPercentage, 0-100, populated for all
//    414 employed coaches in the sample save), so job security is the
//    DOMINANT term rather than one inferred signal among several.
// ---------------------------------------------------------------------
// cfbJobAttractiveness reads a live roster-quality cohort off ctx; the
// fixture above has none, so add one shaped like the real spread.
ctx.cfbTeamOvrSorted = [60, 64, 68, 71, 74, 77, 80, 84];

const hotSeatMarquee = {
  teamName: 'Nebraska', teamPrestige: 8, teamOvr: 80, position: 'HeadCoach', vacant: false,
  incumbentName: 'M. Rhule', incumbentLevel: 30,
  incumbentJobSecurityPct: 16, incumbentJobSecurityStatus: 'HotSeat', incumbentYearsRemaining: 1,
};
const safeMarquee = {
  teamName: 'Georgia', teamPrestige: 9, teamOvr: 84, position: 'HeadCoach', vacant: false,
  incumbentName: 'K. Smart', incumbentLevel: 86,
  incumbentJobSecurityPct: 100, incumbentJobSecurityStatus: 'Safe', incumbentYearsRemaining: 5,
};
const hotSeatSmall = {
  teamName: 'UTEP', teamPrestige: 1, teamOvr: 60, position: 'HeadCoach', vacant: false,
  incumbentName: 'D. Lehan', incumbentLevel: 20,
  incumbentJobSecurityPct: 14, incumbentJobSecurityStatus: 'HotSeat', incumbentYearsRemaining: 1,
};

const hotJob = scoreCfbJobVulnerability(hotSeatMarquee, ctx);
const safeJob = scoreCfbJobVulnerability(safeMarquee, ctx);
const smallJob = scoreCfbJobVulnerability(hotSeatSmall, ctx);

check('a hot-seat coach is a vulnerable CFB job', hotJob.score > 0.7);
check('a 100%-secure coach on a long deal is not', safeJob.score < 0.15);
check('the hot seat is named in the reasoning', hotJob.reasons.some((r) => /hot seat/.test(r)));
check('the expiring contract is named', hotJob.reasons.some((r) => /expiring/.test(r)));
check('a prestige-8 school reads as a marquee job', hotJob.attractiveness > 0.75);
check('the marquee hot seat outranks the same hot seat at a small school',
  hotJob.openingScore > smallJob.openingScore);
check('a safe coach at a great school is still a poor OPENING despite being a great job',
  safeJob.openingScore < smallJob.openingScore);

// The user-stated model, asserted directly: low job security x high prestige
// is what makes an opening.
const lowSecurityHighPrestige = scoreCfbJobVulnerability(
  { ...hotSeatMarquee, incumbentJobSecurityPct: 0, incumbentJobSecurityStatus: 'HotSeat' }, ctx);
check('0% job security at a prestige-8 school is the strongest possible non-vacant opening',
  lowSecurityHighPrestige.openingScore > hotJob.openingScore);

// A literally vacant slot short-circuits to maximum vulnerability.
const vacant = scoreCfbJobVulnerability(
  { teamName: 'Ole Miss', teamPrestige: 8, teamOvr: 80, position: 'DefensiveCoordinator', vacant: true }, ctx);
checkEq('a vacant slot is maximally vulnerable', vacant.score, 1);
check('a vacant slot says so in the reasoning', vacant.reasons.some((r) => /no DefensiveCoordinator at all/.test(r)));

// CurrentJobSecurityStatus must NOT be the primary signal -- it is a 4-way
// banding of the percentage, so two coaches sharing a status but differing
// sharply in percentage must not score identically.
const hotSeat0 = scoreCfbJobVulnerability({ ...hotSeatSmall, incumbentJobSecurityPct: 0 }, ctx);
const hotSeat49 = scoreCfbJobVulnerability({ ...hotSeatSmall, incumbentJobSecurityPct: 49 }, ctx);
check('within one status band, the raw percentage still separates jobs',
  hotSeat0.score > hotSeat49.score);

// ---------------------------------------------------------------------
// CANDIDATE READING -- blank filler shells must never be proposed.
//
// A Madden Coach table carries rows that are not `isEmpty` but hold no
// coach: empty name, Level 0, no career, ContractStatus FreeAgent. The real
// sample save has exactly one (row 109).
//
// readCfbCandidates had always skipped these; readNflCandidates did not, and
// the omission was invisible because a blank shell SCORES WELL -- the
// willingness model rewards a coach with no losses and no history, so an
// empty row looks like an unblemished free agent. On a real batch it was
// proposed and committed: a nameless level-0 coach was hired at Maryland and
// Scott Satterfield fired to make room. The job-security rank transferred
// correctly, so nothing downstream complained; the dynasty just quietly
// gained an empty-named coach.
// ---------------------------------------------------------------------
async function testCandidateFiltering() {
  const { readNflCandidates, readCfbCandidates } = require('../lib/carousel/movement');

  const rec = (index, fields) => {
    const r = { index, isEmpty: false, ...fields };
    r.getValueByKey = function (k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined; };
    r.getReferenceDataByKey = () => null;
    return r;
  };
  const fileWith = (records) => ({
    getAllTablesByName: (n) => (n === 'Coach' ? [{
      name: 'Coach', header: { tableId: 1, recordCapacity: records.length },
      records, readRecords: async () => {},
    }] : []),
  });
  const fixtureCtx = { madTeams: new Map(), cfbTeams: new Map() };

  const real = { Position: 'HeadCoach', Name: 'R. Coach', Level: 20, Age: 50, TeamIndex: 32, ContractStatus: 'FreeAgent', CareerWins: 40, CareerLosses: 30 };
  const blank = { Position: 'HeadCoach', Name: '', FirstName: '', LastName: '', Level: 0, Age: 0, TeamIndex: 0, ContractStatus: 'FreeAgent', CareerWins: 0, CareerLosses: 0 };

  const nfl = await readNflCandidates(fileWith([rec(0, real), rec(1, blank)]), fixtureCtx);
  checkEq('the real NFL coach is a candidate', nfl.length, 1);
  checkEq('and it is the named one, not the shell', nfl[0].sourceRow, 0);

  // A level-0 row is the shell signature regardless of what else it carries;
  // a genuine coach always has a level.
  const nflAllBlank = await readNflCandidates(fileWith([rec(0, blank)]), fixtureCtx);
  checkEq('a table of only shells yields no NFL candidates', nflAllBlank.length, 0);

  // The CFB side must keep behaving exactly as it always has.
  const cfb = await readCfbCandidates(fileWith([
    rec(0, { Position: 'HeadCoach', Name: 'C. Coach', Level: 30, TeamIndex: 5 }),
    rec(1, { Position: 'HeadCoach', Name: '', Level: 0, TeamIndex: 255 }),
  ]), fixtureCtx);
  checkEq('CFB candidate reading is unchanged: shell excluded', cfb.length, 1);
  checkEq('and keeps the real coach', cfb[0].sourceRow, 0);
}

testCandidateFiltering().then(() => {
  console.log(`\n  Carousel movement spec: ${passed} assertions passed.`);
}).catch((e) => { console.error(e.stack); process.exit(1); });
