// The complete Coach field-mapping table -- COACH_CAROUSEL_ROADMAP.md
// section 2, as data. Every one of the 156 fields (102 shared + 35 CFB-only
// + 19 Madden-only) appears exactly once, transcribed from the roadmap's
// markdown table (grouped rows like "COACH_QB COACH_RB ..." expanded to one
// entry per field). A self-check at the bottom of this file throws at
// require time if that ever stops being true -- a duplicate or missing row
// (the roadmap itself had one: `PrevPosition` was listed in both section 2.2
// and 2.9 before this file was written) fails loudly, not silently.
//
// Action key (matches the roadmap):
//   COPY   verbatim
//   NAME   cross by enum member name (map/enumBridge.js)
//   LOOKUP through a derived table (map/levelScale.js, map/schemeLookup.js,
//          or a face/portrait catalog -- section 3.5, not yet built)
//   SYNTH  compute a target value (map/synthesis.js, map/archetypeMap.js)
//   ZERO   write 0/false
//   DROP   do not write (leave the target's default/existing)
//   RESOLVE re-point a reference at the target save's own object
//
// `presence`: 'both' | 'cfb' | 'madden'. For a 'cfb'-only field, cfbToMadden
// is what happens on the way OUT (almost always DROP) and maddenToCfb is
// what happens on the way IN (almost always SYNTH); symmetric for 'madden'.

const GROUPS = {
  // 2.1 Person core & identity (shared)
  personCore: [
    ['FirstName', 'COPY', 'COPY', ''],
    ['LastName', 'COPY', 'COPY', ''],
    ['Name', 'COPY', 'COPY', 'display name, e.g. "G. Altman"'],
    ['AssetName', 'DROP', 'DROP', 'source-game asset key; meaningless across games'],
    ['Age', 'COPY', 'COPY', 'CFB p50 47, MAD p50 47 -- same distribution'],
    ['Height', 'COPY', 'COPY', 'both p50 72'],
    ['Weight', 'COPY', 'DROP', 'offset-encoded (+160). Madden writes 10 for all 127 coaches -- no real data to carry back'],
    ['CharacterBodyType', 'COPY', 'COPY', 'enum byte-identical, verified'],
    ['Personality', 'COPY', 'COPY', 'identical enum; near-constant Unpredictable both sides'],
    ['PresentationId', 'DROP', 'DROP', 'CFB [0..1023], MAD [0..65535]; commentary id, game-specific'],
    ['SpeechId', 'DROP', 'DROP', 'game-specific VO bank'],
    ['IsCreated', 'ZERO', 'ZERO', ''],
    ['IsLegend', 'ZERO', 'ZERO', 'false for all 624 coaches in both saves'],
    ['IsUserControlled', 'ZERO', 'ZERO', 'never transfer user control'],
    ['Probation', 'ZERO', 'ZERO', 'false everywhere'],
    ['COACH_WASPLAYER', 'COPY', 'COPY', 'the Phase D hook. CFB 483/497 true, MAD 4/127'],
  ],
  // 2.2 Job assignment (shared)
  jobAssignment: [
    ['Position', 'NAME', 'NAME', 'CFB CoachPosition vs MAD StaffPosition. HC/OC/DC=0/1/2 in both. CFB NumCollegeCoaches=3 collides with SpecialTeams=3 -- reject anything not HC/OC/DC'],
    ['TeamIndex', 'RESOLVE', 'RESOLVE', 'CFB [0..255] 255=unassigned; MAD [0..32] 32=FA pool. Plus reciprocal Team.HeadCoach/OC/DC reference'],
    ['PrevTeamIndex', 'SYNTH', 'SYNTH', "destination-game unassigned sentinel; source index is meaningless"],
    ['SeasonsWithTeam', 'ZERO', 'ZERO', 'new hire'],
    ['COACH_LASTCONTRACTTEAM', 'ZERO', 'ZERO', ''],
    ['COACH_LASTTEAMFIRED', 'ZERO', 'ZERO', "MAD uses 1023 as none -- write destination's own sentinel"],
    ['COACH_LASTTEAMRESIGNED', 'ZERO', 'ZERO', 'same'],
    ['COACH_FIREREPORTED', 'DROP', 'DROP', 'reads true for EVERY coach in both games (schema default, never toggled) -- writing false produced the only false values in the file and is a suspect in a save Madden rejected as damaged. Leave alone'],
    ['COACH_RESIGNREPORTED', 'DROP', 'DROP', 'same -- true for every coach in both games'],
    ['COACH_CONSECTEAMCONTRACTS', 'ZERO', 'ZERO', 'zero in both saves'],
    ['PrevPosition', 'DROP', 'SYNTH', "CFB-only. Madden->CFB: set from the Madden coach's OriginalPosition"],
  ],
  // 2.3 Contract (shared)
  contract: [
    ['ContractStatus', 'NAME', 'NAME', 'must be name-mapped. CFB-only members (PendingNFL, PendingHire, ...) map to Signed/FreeAgent'],
    ['ContractLength', 'COPY', 'COPY', 'CFB p50 3, MAD p50 3'],
    ['ContractYearsRemaining', 'COPY', 'COPY', 'clamp <= ContractLength'],
    ['ContractSalary', 'SYNTH', 'DROP', 'CFB 496/497 = 0 (no salary model). Derive from destination peers by Level'],
  ],
  // 2.4 Quality, archetype, specialty
  quality: [
    ['Level', 'LOOKUP', 'LOOKUP', 'position-conditioned percentile map (map/levelScale.js)'],
    ['ExperiencePoints', 'SYNTH', 'SYNTH', "re-derived from the mapped Level -- Madden's XP curve, CFB's flat starting pool"],
    ['COACH_SPECIALTY', 'COPY', 'COPY', 'byte-identical enum, verified -- safe passthrough'],
    ['SpecialtyType', 'DROP', 'SYNTH', 'CFB-only. Derive from COACH_SPECIALTY: QB/RB/WR/OL->Offense, DL/LB/DB->Defense, ST->Any'],
    ['Archetype', 'SYNTH', 'DROP', 'Madden-only. map/archetypeMap.js'],
    ['DominantArchetype', 'DROP', 'SYNTH', 'CFB-only. map/archetypeMap.js'],
    ['CoachBackstory', 'SYNTH', 'NAME', 'CFB 496/497 Motivator -- no signal. Synthesize from mapped archetype. Madden->CFB expands by mapped position'],
    ['COACH_RATING', 'SYNTH', 'ZERO', 'Q2 -- CFB all-zero; Madden default/p50 is 50, ships as 50-flat pending in-game verification'],
    ['COACH_QB', 'SYNTH', 'ZERO', 'Q2 -- all zero in CFB. Madden p50 65'],
    ['COACH_RB', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 55'],
    ['COACH_WR', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 60'],
    ['COACH_OL', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 55'],
    ['COACH_DL', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 55'],
    ['COACH_LB', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 55'],
    ['COACH_DB', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 55'],
    ['COACH_S', 'SYNTH', 'ZERO', 'Q2 -- unpopulated in both'],
    ['COACH_K', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 50'],
    ['COACH_P', 'SYNTH', 'ZERO', 'Q2 -- Madden p50 50'],
    ['COACH_OFFENSE', 'SYNTH', 'ZERO', 'Q2 -- ditto'],
    ['COACH_DEFENSE', 'SYNTH', 'ZERO', 'Q2 -- ditto'],
    ['COACH_DEFENSETYPE', 'DROP', 'DROP', 'unpopulated in both'],
    ['COACH_PERFORMANCELEVEL', 'ZERO', 'ZERO', '126/127 zero in Madden'],
    ['COACH_RETIREYRSLEFT', 'ZERO', 'ZERO', 'zero in both'],
  ],
  // 2.5 Tendencies & philosophy (shared)
  tendencies: [
    ['COACH_ADAPTIVE_AI', 'COPY', 'COPY', 'identical enum verified'],
    ['COACH_DEMEANOR', 'COPY', 'COPY', 'identical'],
    ['COACH_STANCE', 'COPY', 'COPY', 'identical'],
    ['COACH_OFFTENDENCYRUNPASS', 'COPY', 'COPY', 'CFB p50 55, MAD p50 60 -- comparable'],
    ['COACH_OFFTENDENCYAGGRESSCONSERV', 'COPY', 'COPY', 'CFB p50 60, MAD p50 65'],
    ['COACH_DEFTENDENCYAGGRESSCONSERV', 'COPY', 'COPY', 'CFB p50 47, MAD p50 50'],
    ['COACH_DEFTENDENCYRUNPASS', 'SYNTH', 'COPY', 'CFB 496/497 = 0, out-of-distribution for Madden (p50 50) -- write the neutral (50)'],
    ['COACH_RBTENDENCY', 'COPY', 'COPY', 'CFB 226/497 = 0; pass 0->50 through the neutral rule'],
    ['COACH_NO_HUDDLE_TEMPO', 'DROP', 'SYNTH', 'CFB-only. Synthesize CFB modal value (Balanced)'],
    ['TeamBuilding', 'SYNTH', 'COPY', 'identical enum, CFB 497/497 Balanced -- no signal. Default Balanced'],
    ['TradingTendency', 'SYNTH', 'COPY', 'identical enum, CFB 497/497 DoesNotTrade -- default DoesNotTrade'],
    ['TeamPhilosophy', 'RESOLVE', 'RESOLVE', "points into per-game asset tables. Adopt the destination team's philosophy, don't carry"],
    ['DefaultTeamPhilosophy', 'RESOLVE', 'RESOLVE', 'same'],
    ['TraitExpertScout', 'COPY', 'COPY', 'false for all 624'],
    ['HasTrait', 'DROP', 'DROP', 'null for all 624'],
  ],
  // 2.6 Schemes & playbooks (shared, all references)
  schemes: [
    ['OffensiveScheme', 'LOOKUP', 'LOOKUP', "raw copy is invalid -- the target tableId doesn't exist in the other save (map/schemeLookup.js)"],
    ['DefensiveScheme', 'LOOKUP', 'LOOKUP', 'map/schemeLookup.js'],
    ['OffensivePlaybook', 'RESOLVE', 'RESOLVE', 'no cross-game correspondence -- adopt a destination playbook matching the mapped scheme'],
    ['DefensivePlaybook', 'RESOLVE', 'RESOLVE', 'CFB 30 distinct/2 tables; MAD 32'],
    ['OffenseAudibles', 'DROP', 'DROP', 'null for all 624 coaches in both saves'],
    ['DefenseAudibles', 'DROP', 'DROP', 'null for all 624'],
  ],
  // 2.7 Career ledger (shared)
  careerLedger: [
    ['CareerPointsFor', 'COPY', 'COPY', 'CFB max 5295, MAD max 2152 -- scale differs (12- vs 17-game seasons) but the field means the same'],
    ['CareerPointsAgainst', 'COPY', 'COPY', ''],
    ['CareerWinSeasons', 'COPY', 'COPY', 'CFB max 25, MAD max 22'],
    ['CareerPlayoffsMade', 'COPY', 'COPY', 'CFB = bowl/CFP appearances'],
    ['CareerLongWinStreak', 'COPY', 'COPY', ''],
    ['CareerTies', 'COPY', 'ZERO', 'CFB all-zero (no ties in modern CFB)'],
    ['CareerBigWinMargin', 'COPY', 'COPY', 'zero in both'],
    ['CareerBigLossMargin', 'COPY', 'COPY', 'zero in both'],
    ['AwardPoints', 'COPY', 'COPY', 'zero in both'],
    ['YearlyAwardCount', 'COPY', 'COPY', 'zero CFB; MAD max 2'],
    ['LegacyScore', 'SYNTH', 'DROP', 'CFB all-zero. Derive from mapped Level + career'],
    ['RegularWinStreak', 'ZERO', 'ZERO', 'a new hire has no streak'],
    ['SeasWinStreak', 'ZERO', 'ZERO', ''],
    ['WinSeasStreak', 'ZERO', 'ZERO', ''],
    ['ConfPlayoffWinStreak', 'ZERO', 'ZERO', ''],
    ['DivPlayoffWinStreak', 'ZERO', 'ZERO', ''],
    ['WCPlayoffWinStreak', 'ZERO', 'ZERO', ''],
    ['SuperbowlWinStreak', 'ZERO', 'ZERO', ''],
    ['SeasPointsFor', 'ZERO', 'ZERO', 'current-season state; a mid-carousel hire starts clean'],
    ['SeasPointsAgainst', 'ZERO', 'ZERO', ''],
    ['SeasTies', 'ZERO', 'ZERO', ''],
    ['SeasLongWinStreak', 'ZERO', 'ZERO', ''],
    ['SeasBigWinMargin', 'ZERO', 'ZERO', ''],
    ['SeasBigLossMargin', 'ZERO', 'ZERO', ''],
    ['OWNER_COMMENTID', 'ZERO', 'ZERO', 'zero in both'],
    ['OWNER_COMMENTTYPE', 'ZERO', 'ZERO', 'zero in both'],
    ['YearsCoaching', 'COPY', 'COPY', 'CFB max 43 today, but range allows 127 -- clamp to 63 going into Madden'],
  ],
  // 2.8 Appearance (shared)
  appearance: [
    ['CharacterVisuals', 'SYNTH', 'SYNTH', 'same JSON envelope, incompatible contents. CFB coach blobs carry no head loadout at all (section 3.5)'],
    ['GenericHeadAssetName', 'LOOKUP', 'LOOKUP', 'zero vocabulary overlap between the two head-asset namespaces'],
    ['Portrait', 'LOOKUP', 'LOOKUP', 'per-game portrait id; pair with the head, per appearanceCatalog.js'],
    ['Portrait_Force_Silhouette', 'ZERO', 'ZERO', 'false for all 624'],
    ['Portrait_Swappable_Library_Path', 'COPY', 'COPY', 'identical single-value enum'],
    ['FaceShape', 'SYNTH', 'DROP', "Madden-only. Live coaches carry the head in CharacterVisuals, not here -- synthesize Invalid_"],
    ['HatType', 'DROP', 'SYNTH', 'CFB-only. Synthesize CFB modal value (None)'],
  ],
  // 2.9 CFB-only -- drop on the way out, synthesize on the way in
  cfbOnly: [
    ['CoachPrestige', 'DROP', 'SYNTH', 'derive the letter from the synthesized CoachPrestigeScore percentile'],
    ['CoachPrestigeScore', 'DROP', 'SYNTH', 'read the LIVE distribution -- P70 of the position cohort if arriving from the NFL, else P40'],
    ['CoachPoints', 'DROP', 'SYNTH', 'locked decision: 0'],
    ['CurrentJobSecurityStatus', 'DROP', 'SYNTH', 'Safe -- consistent with 80%'],
    ['SeasonStartJobSecurityStatus', 'DROP', 'SYNTH', 'Safe'],
    ['CurrentJobSecurityPercentage', 'DROP', 'SYNTH', 'locked decision: 80'],
    ['CurrentJobSecurityPercentageRank', 'DROP', 'ZERO', 'recomputed by the game'],
    ['CurrentContractExpectation', 'DROP', 'SYNTH', 'from destination team prestige; modal Win5Games/Win4Games'],
    ['ContractExpectationProgress', 'DROP', 'ZERO', ''],
    ['EarnedContractPoints_ThisYear', 'DROP', 'ZERO', 'zero for all 497'],
    ['EarnedContractPoints_LastYear', 'DROP', 'ZERO', ''],
    ['EarnedContractPoints_TwoYearsAgo', 'DROP', 'ZERO', ''],
    ['CurrentStatRankPosition', 'DROP', 'ZERO', 'in-season'],
    ['CurrentWinStreak', 'DROP', 'ZERO', ''],
    ['DominantArchetype', 'DROP', 'SYNTH', 'duplicate entry point at the quality/archetype row above -- kept out of this group intentionally, see "quality"'],
    ['AlmaMater', 'DROP', 'SYNTH', 'Q4 -- verified a CFB TeamIndex (87->TCU, 107->Wake Forest)'],
    ['HomeState', 'DROP', 'SYNTH', 'Q4 -- 236/497 = Alabama, but all are TeamIndex=255 filler -- Alabama is the unset value here'],
    ['HomeTown', 'DROP', 'ZERO', '0:0 for every coach -- never populated'],
    ['PrimaryPipeline', 'DROP', 'SYNTH', 'Q6 -- real recruiting-territory data, genuinely varied'],
    ['IsNIL', 'DROP', 'SYNTH', 'Q6 -- 267 false / 230 true -- not a trivial default'],
    ['ActiveTalentTree', 'DROP', 'SYNTH', 'Q6 -- 477/497 populated, one row each; needs a fresh empty tree row, not a null reference'],
    ['ProgramPointsBudgetAllocationPosture', 'DROP', 'RESOLVE', '5 distinct values; adopt destination default'],
    ['SeasonStats', 'DROP', 'ZERO', "read for Q3 (CFB->Madden career-record synthesis); Madden->CFB doesn't need it"],
    ['CareerStats', 'DROP', 'ZERO', 'read for Q3'],
    ['ContractYearSummaries', 'DROP', 'ZERO', ''],
    ['SeasonalGoal', 'DROP', 'ZERO', 'null for all 497'],
    ['WeeklyGoals', 'DROP', 'ZERO', ''],
    ['PersuadeAttempts', 'DROP', 'ZERO', 'zero for all 497'],
    ['NumContractOffers', 'DROP', 'ZERO', 'zero for all 497'],
    ['PreOrderCurrentTitle', 'DROP', 'ZERO', 'entitlement flag'],
    ['PreOrderPartnerTitle', 'DROP', 'ZERO', 'entitlement flag'],
  ],
  // 2.10 Madden-only -- synthesize on the way in, drop on the way out
  maddenOnly: [
    ['CareerWins', 'SYNTH', 'DROP', 'Q3 -- MAD p50 45, max 464'],
    ['CareerLosses', 'SYNTH', 'DROP', 'Q3 -- p50 43'],
    ['CareerPlayoffWins', 'SYNTH', 'DROP', 'Q3 -- p50 1'],
    ['CareerPlayoffLosses', 'SYNTH', 'DROP', 'Q3 -- p50 2'],
    ['CareerSuperbowlWins', 'ZERO', 'DROP', '104/127 zero'],
    ['CareerSuperbowlLosses', 'ZERO', 'DROP', '107/127 zero'],
    ['CareerProBowlPlayers', 'ZERO', 'DROP', '88/127 zero'],
    ['SeasWins', 'ZERO', 'DROP', 'mid-season hire starts clean'],
    ['SeasLosses', 'ZERO', 'DROP', ''],
    ['CareerAssistant', 'SYNTH', 'DROP', 'true iff mapped Position != HeadCoach. MAD: 21/127 true'],
    ['IsMaxLevel', 'SYNTH', 'DROP', 'mappedLevel >= 50'],
    ['IndexInUnlockList', 'DROP', 'DROP', 'ability-unlock bookkeeping -- must stay consistent with the Playsheet/Gameday/WearAndTear talent references, which are never written. Zeroing it while leaving those desynchronizes the pair; suspect in a rejected save'],
    ['OriginalPosition', 'SYNTH', 'DROP', 'set equal to the mapped Position -- matches for all 127 in the sample save'],
    ['PlaysheetTalents', 'ZERO', 'DROP', 'locked decision: drop talent trees'],
    ['GamedayTalents', 'ZERO', 'DROP', ''],
    ['WearAndTearTalents', 'ZERO', 'DROP', ''],
    ['CurrentPurchasedTalentCosts', 'DROP', 'DROP', 'talent bookkeeping -- left alone as a set with IndexInUnlockList and the talent references'],
  ],
};

const PRESENCE_OF_GROUP = {
  personCore: 'both', jobAssignment: 'both', contract: 'both', quality: 'both',
  tendencies: 'both', schemes: 'both', careerLedger: 'both', appearance: 'both',
};
// Fields whose presence differs from their group's default (a handful of
// CFB-only / Madden-only fields live inside otherwise-shared thematic
// sections -- e.g. SpecialtyType sits in "quality" alongside shared fields
// but is itself CFB-only).
const PRESENCE_OVERRIDE = {
  SpecialtyType: 'cfb', Archetype: 'madden', DominantArchetype: 'cfb',
  COACH_NO_HUDDLE_TEMPO: 'cfb', HatType: 'cfb', FaceShape: 'madden',
  PrevPosition: 'cfb',
};

const COACH_FIELD_MAP = [];
for (const [groupName, rows] of Object.entries(GROUPS)) {
  const groupPresence = PRESENCE_OF_GROUP[groupName] || (groupName === 'cfbOnly' ? 'cfb' : 'madden');
  for (const [field, cfbToMadden, maddenToCfb, note] of rows) {
    // The "quality" group's DominantArchetype row is the authoritative one;
    // cfbOnly's row for the same field is a deliberate skip (see its note)
    // rather than a second entry -- filtered out here so the map stays
    // exactly one row per field.
    if (groupName === 'cfbOnly' && field === 'DominantArchetype') continue;
    COACH_FIELD_MAP.push({
      field,
      presence: PRESENCE_OVERRIDE[field] || groupPresence,
      cfbToMadden, maddenToCfb, note,
      group: groupName,
    });
  }
}

const BY_FIELD = new Map(COACH_FIELD_MAP.map((e) => [e.field, e]));

function getFieldMap(fieldName) {
  return BY_FIELD.get(fieldName) || null;
}

// Cross-checks this table's field list against the union of BOTH live
// schemas' Coach attributes -- the "R3: startup assertion" the roadmap's
// risk register promises, made real and callable rather than aspirational.
// Throws with the exact diff on mismatch (a patch adding/removing a Coach
// field should fail loudly here, not silently misroute during a write).
function assertMatchesLiveSchema(cfbFile, maddenFile) {
  const cfbAttrs = new Set(cfbFile.schemaList.getSchema('Coach').attributes.map((a) => a.name));
  const maddenAttrs = new Set(maddenFile.schemaList.getSchema('Coach').attributes.map((a) => a.name));
  const liveUnion = new Set([...cfbAttrs, ...maddenAttrs]);
  const mapped = new Set(BY_FIELD.keys());

  const missingFromMap = [...liveUnion].filter((f) => !mapped.has(f));
  const extraInMap = [...mapped].filter((f) => !liveUnion.has(f));
  if (missingFromMap.length || extraInMap.length) {
    throw new Error('coachFieldMap is out of sync with the live Coach schema.\n'
      + (missingFromMap.length ? `  In the save but not mapped: ${missingFromMap.join(', ')}\n` : '')
      + (extraInMap.length ? `  Mapped but not in either save: ${extraInMap.join(', ')}\n` : ''));
  }
}

// Self-check at require time: exactly 156 fields (102 shared + 35 CFB-only +
// 19 Madden-only), no duplicates. This is what would have caught the
// PrevPosition duplicate the roadmap's markdown table originally had.
(function selfCheck() {
  const names = COACH_FIELD_MAP.map((e) => e.field);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    const seen = new Set(), dupes = [];
    for (const n of names) { if (seen.has(n)) dupes.push(n); seen.add(n); }
    throw new Error(`coachFieldMap.js has duplicate field entries: ${dupes.join(', ')}`);
  }
  if (names.length !== 156) {
    throw new Error(`coachFieldMap.js has ${names.length} fields, expected exactly 156 `
      + '(102 shared + 35 CFB-only + 19 Madden-only per FINDINGS.md).');
  }
  const counts = { both: 0, cfb: 0, madden: 0 };
  for (const e of COACH_FIELD_MAP) counts[e.presence]++;
  if (counts.both !== 102 || counts.cfb !== 35 || counts.madden !== 19) {
    throw new Error(`coachFieldMap.js presence counts are wrong: got both=${counts.both} `
      + `cfb=${counts.cfb} madden=${counts.madden}, expected both=102 cfb=35 madden=19.`);
  }
}());

module.exports = { COACH_FIELD_MAP, getFieldMap, assertMatchesLiveSchema };
