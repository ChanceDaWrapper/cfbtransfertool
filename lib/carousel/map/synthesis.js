// Field synthesis rules -- COACH_CAROUSEL_ROADMAP.md section 3.4.
// Everything here either applies a locked constant or derives a value from
// a LIVE destination-save distribution -- never a hardcoded number, per the
// roadmap's explicit rule for CoachPrestigeScore ("read the live
// distribution... do NOT hardcode a number, since prestige scales vary").

const { safe, biggestTableByName } = require('../../saveIO');

const JOB_SECURITY_PERCENTAGE_DEFAULT = 80; // locked decision
const COACH_POINTS_DEFAULT = 0; // locked decision
const CFB_STARTING_XP_DEFAULT = 0; // Q10 -- Madden->CFB has no XP curve to derive from

const LETTER_GRADES_HIGH_TO_LOW = ['Aplus', 'A', 'Aminus', 'Bplus', 'B', 'Bminus', 'Cplus', 'C', 'Cminus', 'Dplus', 'D', 'Dminus', 'F'];

// The score was deliberately drawn AT percentile `p` of the live
// distribution (see synthesizeCoachPrestige below) -- so the letter grade is
// a straight percentile-bucket lookup, not a re-derivation from the score.
function letterGradeForPercentile(p) {
  const idx = Math.min(LETTER_GRADES_HIGH_TO_LOW.length - 1, Math.max(0, Math.floor((1 - p) * LETTER_GRADES_HIGH_TO_LOW.length)));
  return LETTER_GRADES_HIGH_TO_LOW[idx];
}

function percentileOfSorted(sortedArr, p) {
  if (!sortedArr.length) return 0;
  return sortedArr[Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))))];
}

// Live, non-zero CoachPrestigeScore for one position in the open CFB save --
// zeros are the save's blank filler-shell coaches (see FINDINGS: CFB
// free-agent coaches are Level=0/Prestige=Dminus shells, not real data).
async function readPrestigeDistribution(cfbFile, position) {
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const scores = [];
  for (const r of t.records) {
    if (r.isEmpty) continue;
    if (position && safe(r, 'Position') !== position) continue;
    const score = safe(r, 'CoachPrestigeScore');
    if (typeof score === 'number' && score > 0) scores.push(score);
  }
  return scores.sort((a, b) => a - b);
}

// CoachPrestigeScore + CoachPrestige (letter). fromNfl=true centres on P70 of
// the position-matched cohort (a proven NFL coach starts above a from-scratch
// college hire); fromNfl=false centres on a lower P40 (locked decision:
// "normal/lower prestige" for a coach starting/staying in college).
//
// `levelPercentile` SPREADS the draw around that centre by how good the coach
// actually is. Without it every arrival drew the exact same percentile and so
// came out with an identical prestige AND an identical letter grade --
// confirmed in-game, where three separately-transferred coaches all read
// "B+" while a real coach beside them read "C+". A band of +/- HALF the
// centre keeps the locked decision intact (the average arrival still lands on
// the original percentile) while letting a weak coach read materially worse
// than a strong one. Omit levelPercentile to get the original fixed draw.
const PRESTIGE_SPREAD = 0.5; // fraction of the centre percentile the band covers, each way
async function synthesizeCoachPrestige({ cfbFile, position, fromNfl, levelPercentile = null }) {
  const dist = await readPrestigeDistribution(cfbFile, position);
  const centre = fromNfl ? 0.70 : 0.40;
  const p = typeof levelPercentile === 'number'
    ? Math.max(0, Math.min(1, centre * (1 - PRESTIGE_SPREAD) + centre * PRESTIGE_SPREAD * 2 * levelPercentile))
    : centre;
  const score = percentileOfSorted(dist, p);
  return { CoachPrestigeScore: score, CoachPrestige: letterGradeForPercentile(p) };
}

// Live, non-zero LegacyScore for one position in the open destination save.
async function readLegacyScoreDistribution(destFile, position) {
  const t = biggestTableByName(destFile, 'Coach');
  await t.readRecords();
  const scores = [];
  for (const r of t.records) {
    if (r.isEmpty) continue;
    if (position && safe(r, 'Position') !== position) continue;
    const v = safe(r, 'LegacyScore');
    if (typeof v === 'number' && v > 0) scores.push(v);
  }
  return scores.sort((a, b) => a - b);
}

// LegacyScore (CFB->Madden only -- CFB's own LegacyScore is 0 for all 497
// coaches in the sample save, no signal to carry). Drawn at the SAME
// percentile as the coach's mapped Level within this position's live
// LegacyScore distribution -- ties the two quality signals together
// coherently (a coach better than X% of peers on Level should read as
// roughly that percentile on LegacyScore too) rather than an arbitrary
// formula. `levelPercentile` is the value levelScale.js already computed
// when mapping Level -- passed in, not re-derived, so the two stay in sync.
async function synthesizeLegacyScore({ destFile, position, levelPercentile }) {
  const dist = await readLegacyScoreDistribution(destFile, position);
  return percentileOfSorted(dist, levelPercentile);
}

// The CFB-only "program state" fields for an arriving/incoming coach --
// locked decisions (JobSecurity=80, CoachPoints=0) plus the prestige draw.
async function synthesizeCfbProgramFields({
  cfbFile, position, fromNfl, levelPercentile = null,
  jobSecurityPercentage = JOB_SECURITY_PERCENTAGE_DEFAULT,
}) {
  const prestige = await synthesizeCoachPrestige({ cfbFile, position, fromNfl, levelPercentile });
  return {
    CurrentJobSecurityPercentage: jobSecurityPercentage,
    CurrentJobSecurityStatus: 'Safe',
    SeasonStartJobSecurityStatus: 'Safe',
    CoachPoints: COACH_POINTS_DEFAULT,
    CoachPrestigeScore: prestige.CoachPrestigeScore,
    CoachPrestige: prestige.CoachPrestige,
    HatType: 'None', // CFB modal (337/497 in the sample save)
    COACH_NO_HUDDLE_TEMPO: 'Balanced', // CFB modal (245/497)
  };
}

// SpecialtyType (CFB-only, Offense/Defense/Any) derived from the shared,
// byte-identical COACH_SPECIALTY enum -- used on Madden->CFB, where the
// source coach has no SpecialtyType of its own to carry.
const OFFENSE_SPECIALTIES = new Set(['Quarterbacks', 'RunningBacks', 'Receivers', 'OffensiveLine']);
const DEFENSE_SPECIALTIES = new Set(['DefensiveLine', 'Linebackers', 'Secondary']);
function synthesizeSpecialtyType(coachSpecialty) {
  if (OFFENSE_SPECIALTIES.has(coachSpecialty)) return 'Offense';
  if (DEFENSE_SPECIALTIES.has(coachSpecialty)) return 'Defense';
  return 'Any'; // SpecialTeams or unrecognized
}

// TeamBuilding/TradingTendency -- both games share the enum, but CFB is
// 497/497 Balanced / 497/497 DoesNotTrade in the sample save: no real signal
// to carry either direction, so both directions synthesize the modal value
// rather than trusting a "shared field" to mean "safe to copy" (see R12).
function synthesizeTeamBuildingAndTrading() {
  return { TeamBuilding: 'Balanced', TradingTendency: 'DoesNotTrade' };
}

// A field that reads 0 in the source is CFB's near-universal "unset" value
// for several COACH_* tendency fields (COACH_DEFTENDENCYRUNPASS 496/497
// zero, COACH_RBTENDENCY 226/497 zero) -- but 0 is out of Madden's
// distribution (both have an observed p50 of 50 and a schema default of 50).
// Writing a literal 0 across would be as wrong as the all-zero COACH_*
// grades the roadmap already flags (R4) -- neutral (50) is the safe value.
function neutralIfZero(value, neutral = 50) {
  return (typeof value === 'number' && value === 0) ? neutral : value;
}

// CoachBackstory: CFB is 496/497 "Motivator" (no signal) but Madden uses the
// field for real (Strategist 59 / Motivator 44 / TeamBuilder 24 in the
// sample save) -- so CFB->Madden always synthesizes from the MAPPED Madden
// archetype, never copies the source value.
function synthesizeCoachBackstoryForMadden(maddenArchetype) {
  if (maddenArchetype === 'DevelopmentWizard') return 'TeamBuilder';
  if (maddenArchetype === 'MasterMotivator') return 'Motivator';
  return 'Strategist'; // OffensiveGuru / DefensiveGenius / anything else
}

// Madden->CFB: CFB's 9 position-flavored members ({HC,OC,DC} x
// {Motivator,Schemer,Salesman}) have no Madden equivalent, so this expands
// from the Madden backstory + the coach's MAPPED CFB position. Only
// Strategist->{prefix}Schemer is explicit in the roadmap's field table;
// TeamBuilder->{prefix}Salesman and Motivator->{prefix}Motivator complete
// the same collapse/expand pair symmetrically (TeamBuilder reads as
// program/staff-building, i.e. the "Salesman" flavor; Motivator maps to
// itself by name, and CFB even has bare HCMotivator/OCMotivator/DCMotivator
// members to receive it).
const BACKSTORY_PREFIX = { HeadCoach: 'HC', OffensiveCoordinator: 'OC', DefensiveCoordinator: 'DC' };
function synthesizeCoachBackstoryForCfb(maddenBackstory, cfbPosition) {
  const prefix = BACKSTORY_PREFIX[cfbPosition];
  if (!prefix) return 'Motivator'; // unrecognized position -- CFB's own overwhelming modal value
  if (maddenBackstory === 'Strategist') return `${prefix}Schemer`;
  if (maddenBackstory === 'TeamBuilder') return `${prefix}Salesman`;
  return `${prefix}Motivator`;
}

module.exports = {
  JOB_SECURITY_PERCENTAGE_DEFAULT,
  COACH_POINTS_DEFAULT,
  CFB_STARTING_XP_DEFAULT,
  LETTER_GRADES_HIGH_TO_LOW,
  letterGradeForPercentile,
  readPrestigeDistribution,
  synthesizeCoachPrestige,
  readLegacyScoreDistribution,
  synthesizeLegacyScore,
  synthesizeCfbProgramFields,
  synthesizeSpecialtyType,
  synthesizeTeamBuildingAndTrading,
  neutralIfZero,
  synthesizeCoachBackstoryForMadden,
  synthesizeCoachBackstoryForCfb,
};
