// Archetype mapping -- COACH_CAROUSEL_ROADMAP.md section 3.2.
//
// Madden's Archetype enum has 8 members (not 3, per the original briefing's
// error), CFB's DominantArchetype has 13 (the brief missed Rainmaker and
// Visionary). MasterMotivator exists in both -- a free 1:1 anchor.
//
// The empirical rule (FINDINGS section 8): in Madden, Archetype tracks
// COACH_SPECIALTY strongly (61/65 OffensiveGuru have an offensive specialty).
// In CFB, DominantArchetype predicts side NOT AT ALL -- every archetype
// splits ~evenly by specialty. So COACH_SPECIALTY/SpecialtyType determines
// the side; DominantArchetype only chooses between the side archetype and
// DevelopmentWizard.
//
// All variety rolls use rosetta/rng.makeSeededRng seeded via
// rosetta/identity.deriveSeedString -- same determinism contract as the
// player pipeline (same seed + same coach => same roll, every time).

const { makeSeededRng } = require('../../rosetta/rng');
const { deriveSeedString } = require('../../rosetta/identity');

const OFFENSE_SPECIALTIES = new Set(['Quarterbacks', 'RunningBacks', 'Receivers', 'OffensiveLine']);
const DEFENSE_SPECIALTIES = new Set(['DefensiveLine', 'Linebackers', 'Secondary']);

// side(coach) = SpecialtyType if present (CFB), else derived from
// COACH_SPECIALTY (shared, byte-identical enum in both games). SpecialTeams
// and anything unrecognized falls to 'Any'.
function deriveSide({ specialtyType, coachSpecialty }) {
  if (specialtyType === 'Offense' || specialtyType === 'Defense' || specialtyType === 'Any') return specialtyType;
  if (OFFENSE_SPECIALTIES.has(coachSpecialty)) return 'Offense';
  if (DEFENSE_SPECIALTIES.has(coachSpecialty)) return 'Defense';
  return 'Any';
}

function sideArchetype(side) {
  if (side === 'Offense') return 'OffensiveGuru';
  if (side === 'Defense') return 'DefensiveGenius';
  return 'DevelopmentWizard';
}

// { defaultsToWizard: true }  -> base = DevelopmentWizard, rollP chance of the side archetype
// { defaultsToWizard: false } -> base = side archetype,    rollP chance of DevelopmentWizard
const CFB_ARCHETYPE_RULES = {
  EliteRecruiter: { defaultsToWizard: true, rollP: 0.25 },
  Recruiter: { defaultsToWizard: true, rollP: 0.25 },
  ProgramBuilder: { defaultsToWizard: true, rollP: 0.25 },
  TalentDeveloper: { defaultsToWizard: true, rollP: 0.25 },
  Schemer: { defaultsToWizard: false, rollP: 0.15 },
  SchemeGuru: { defaultsToWizard: false, rollP: 0.15 },
  Strategist: { defaultsToWizard: false, rollP: 0.15 },
  Architect: { defaultsToWizard: false, rollP: 0.15 },
  Motivator: { defaultsToWizard: false, rollP: 0.20, rollTarget: 'MasterMotivator' },
  CEO: { defaultsToWizard: false, rollP: 0.25 },
  Rainmaker: { defaultsToWizard: true, rollP: 0.25 }, // unobserved in the sample save -- flavor inferred from the name, flagged for verification
  Visionary: { defaultsToWizard: false, rollP: 0.20 }, // unobserved in the sample save -- flagged for verification
};

// CFB DominantArchetype (13) + side -> Madden Archetype (8). `rng` defaults
// to Math.random (fresh every call); pass a seeded one for reproducible runs.
function mapArchetypeCfbToMadden({ dominantArchetype, side, rng = Math.random }) {
  if (dominantArchetype === 'MasterMotivator') return 'MasterMotivator';
  if (side === 'Any' || dominantArchetype === 'Invalid_') return 'DevelopmentWizard';

  const rule = CFB_ARCHETYPE_RULES[dominantArchetype];
  const s = sideArchetype(side);
  if (!rule) return s; // an archetype not in the table (shouldn't happen for a valid enum value) -- side archetype is the safe default

  const roll = rng();
  if (rule.rollTarget) return roll < rule.rollP ? rule.rollTarget : s;
  if (rule.defaultsToWizard) return roll < rule.rollP ? s : 'DevelopmentWizard';
  return roll < rule.rollP ? 'DevelopmentWizard' : s;
}

// Madden Archetype (8) + side + Level-vs-destination-P70 -> CFB
// DominantArchetype (13). `levelP70` is the destination CFB save's live P70
// Level threshold for this coach's mapped position (caller-supplied --
// levelScale.js computes it; archetypeMap.js doesn't read a save itself).
//
// POSITION-AWARE, and it has to be. CFB's DominantArchetype is strongly
// position-partitioned -- verified by tallying a real save's own coaches:
//
//                     HC    OC    DC
//   ProgramBuilder    22     0     0   <- HC only
//   CEO                4     0     0   <- HC only
//   Strategist        28     1     1   <- effectively HC only
//   Architect         27     4     4   <- mostly HC
//   Schemer            0    11    17   <- COORDINATOR ONLY
//   Recruiter          0    13    23   <- COORDINATOR ONLY
//   Motivator          0    13    20   <- COORDINATOR ONLY
//   SchemeGuru        15    40    48   <- both
//   MasterMotivator   15    34    43   <- both
//   EliteRecruiter    17    40    25   <- both
//   TalentDeveloper   10     2     1   <- both
//
// An earlier position-BLIND version mapped every sub-P70 OffensiveGuru/
// DefensiveGenius to `Schemer` regardless of landing position, so an
// arriving NFL *head coach* got an archetype that ZERO of the ~140 real CFB
// head coaches have. It rendered fine in-game, but writing a value outside
// the destination game's own distribution for that position is precisely the
// class of mistake that produced the original Madden corruption incident
// (see ROADMAP R4/R12), so it is fixed rather than left as "works anyway".
//
// Each entry is [aboveP70, belowP70] per position family.
const MADDEN_TO_CFB_TIERED = {
  OffensiveGuru: {
    HeadCoach: ['SchemeGuru', 'Strategist'],
    coordinator: ['SchemeGuru', 'Schemer'],
  },
  DefensiveGenius: {
    HeadCoach: ['SchemeGuru', 'Strategist'],
    coordinator: ['SchemeGuru', 'Schemer'],
  },
  DevelopmentWizard: {
    HeadCoach: ['TalentDeveloper', 'EliteRecruiter'],
    coordinator: ['TalentDeveloper', 'Recruiter'],
  },
  HeadScout: {
    HeadCoach: ['EliteRecruiter', 'EliteRecruiter'],
    coordinator: ['EliteRecruiter', 'Recruiter'],
  },
};
// PersonnelCzar -> CEO is HC-ONLY (4 HCs, 0 coordinators use CEO); a
// coordinator gets the nearest in-distribution equivalent instead.
const MADDEN_TO_CFB_FIXED = {
  MasterMotivator: { HeadCoach: 'MasterMotivator', coordinator: 'MasterMotivator' },
  MasterMotivator_JohnMadden: { HeadCoach: 'MasterMotivator', coordinator: 'MasterMotivator' },
  PersonnelCzar: { HeadCoach: 'CEO', coordinator: 'EliteRecruiter' },
  HeadTrainer: { HeadCoach: 'TalentDeveloper', coordinator: 'TalentDeveloper' },
};
// Only reachable via an explicit variety roll, never as a tiered default --
// the "not the recruiting-flavor ones" restriction from the roadmap. Split by
// position for the same distribution reason as everything above.
const VARIETY_ONLY = {
  HeadCoach: ['Architect', 'Strategist', 'ProgramBuilder', 'Rainmaker', 'Visionary'],
  coordinator: ['Architect', 'Strategist', 'Rainmaker', 'Visionary', 'Motivator'],
};
// Unrecognized Archetype fallback, also position-split -- 'Recruiter' is
// coordinator-only, so it can't be the universal default it used to be.
const UNRECOGNIZED_FALLBACK = { HeadCoach: 'EliteRecruiter', coordinator: 'Recruiter' };

const positionFamily = (position) => (position === 'HeadCoach' ? 'HeadCoach' : 'coordinator');

function mapArchetypeMaddenToCfb({
  archetype, level, levelP70, position = 'HeadCoach',
  allowVarietyRoll = false, rng = Math.random, varietyP = 0.15,
}) {
  const family = positionFamily(position);

  if (MADDEN_TO_CFB_FIXED[archetype]) return MADDEN_TO_CFB_FIXED[archetype][family];

  const tiered = MADDEN_TO_CFB_TIERED[archetype];
  if (!tiered) return UNRECOGNIZED_FALLBACK[family];
  const aboveP70 = typeof level === 'number' && typeof levelP70 === 'number' && level >= levelP70;
  const base = tiered[family][aboveP70 ? 0 : 1];

  if (allowVarietyRoll && rng() < varietyP) {
    const pool = VARIETY_ONLY[family];
    return pool[Math.floor(rng() * pool.length)];
  }
  return base;
}

// Convenience: builds a seeded RNG for one coach's archetype roll, per the
// same determinism contract rosetta uses (blank globalSeed -> Math.random).
function archetypeRng(globalSeed, sourceRow) {
  return makeSeededRng(deriveSeedString(globalSeed, 'carousel:archetype', sourceRow));
}

module.exports = {
  deriveSide,
  sideArchetype,
  mapArchetypeCfbToMadden,
  mapArchetypeMaddenToCfb,
  archetypeRng,
  CFB_ARCHETYPE_RULES,
  MADDEN_TO_CFB_TIERED,
  MADDEN_TO_CFB_FIXED,
  VARIETY_ONLY,
};
