// Scheme lookup -- COACH_CAROUSEL_ROADMAP.md section 3.3.
//
// Coach.OffensiveScheme/DefensiveScheme are REFERENCE pointers into asset
// tables that do not exist inside the save file (verified: CFB tableIds
// 16433/16456/16482, Madden 16384 all resolve to "(no table)" via
// getTableById). getValueByKey() on these fields returns a raw, unusable
// bitstring copy of the pointer -- NOT the resolved name.
//
// The only readable name for a scheme lives on Team.CurrentOffensiveScheme /
// DefaultOffensiveScheme (a BaseScheme enum). So this module does two
// things, both re-derived from whichever save is actually open (never
// hardcoded -- see ROADMAP Q9/R2, the pointer values are save/patch-specific):
//
//   1. buildSchemeIndex(file): joins every Team's readable BaseScheme name
//      against its HeadCoach's raw OffensiveScheme/DefensiveScheme bitstring,
//      giving {name -> writable raw value} FOR THAT SAVE. This is what you
//      copy from when WRITING a scheme -- there is no other way to construct
//      a valid scheme reference than borrowing an existing coach's raw value
//      (research/probe07's exact join, packaged as reusable code).
//   2. crossSchemeName(name, direction): the static CFB<->Madden name
//      mapping from ROADMAP section 3.3 (7 of 20 BaseScheme slots share a
//      name outright; the rest is a football-concept judgement call, marked
//      `verified: false` below for anything flagged needing an in-game look).

const { safe, biggestTableByName } = require('../../saveIO');

// CFB name -> Madden name. `verified` mirrors the roadmap's `†` marks --
// name-identical rows are `true`; football-judgement rows are `false` and
// should be treated as provisional until V5 (an in-game look) confirms them.
const CFB_TO_MADDEN = {
  offensive: {
    OFF_AIR_RAID: { name: 'AirRaid', verified: true },
    OFF_SPREAD: { name: 'Spread', verified: true },
    OFF_RUN_AND_SHOOT: { name: 'RunAndShoot', verified: true },
    OFF_PISTOL: { name: 'Pistol', verified: true },
    OFF_WEST_COAST_ZONE_RUN: { name: 'WestCoastZoneRun', verified: true },
    OFF_POWER_SPREAD: { name: 'WestCoastSpread', verified: false },
    OFF_SPREAD_OPTION: { name: 'Spread', verified: false },
    OFF_VEER_AND_SHOOT: { name: 'VerticalZoneRun', verified: false },
    OFF_OPTION: { name: 'MultiplePowerRun', verified: false },
    OFF_MULTIPLE_OFFENSE: { name: 'MultipleZoneRun', verified: false },
    OFF_PRO_STYLE: { name: 'VerticalPowerRun', verified: false },
  },
  defensive: {
    DEF_BASE4_3: { name: 'Base4_3', verified: true },
    DEF_BASE3_4: { name: 'Base3_4', verified: true },
    DEF_4_2_5: { name: 'Quarters4_3', verified: false },
    DEF_3_3_5: { name: 'Under3_4', verified: false },
    DEF_3_3_5_TITE: { name: 'Storm3_4', verified: false },
    DEF_3_2_6: { name: 'Cover3_4_3', verified: false },
    DEF_4_3_MULTIPLE: { name: 'Under4_3', verified: false },
    DEF_3_4_MULTIPLE: { name: 'Disguise3_4', verified: false },
    DEF_MULTIPLE_DEFENSE: { name: 'Tampa2', verified: false },
  },
};

// Madden name -> CFB name. Not simply CFB_TO_MADDEN inverted: several Madden
// names have no CFB row on the CFB_TO_MADDEN side but do appear as a target
// (MultiplePowerRun, WestCoastPowerRun) or vice versa -- kept as its own
// explicit table, exactly as the roadmap's 4-column layout does.
const MADDEN_TO_CFB = {
  offensive: {
    AirRaid: { name: 'OFF_AIR_RAID', verified: true },
    Spread: { name: 'OFF_SPREAD', verified: true },
    RunAndShoot: { name: 'OFF_RUN_AND_SHOOT', verified: true },
    Pistol: { name: 'OFF_PISTOL', verified: true },
    WestCoastZoneRun: { name: 'OFF_WEST_COAST_ZONE_RUN', verified: true },
    WestCoastSpread: { name: 'OFF_POWER_SPREAD', verified: false },
    MultipleZoneRun: { name: 'OFF_MULTIPLE_OFFENSE', verified: false },
    MultiplePowerRun: { name: 'OFF_MULTIPLE_OFFENSE', verified: false },
    VerticalZoneRun: { name: 'OFF_VEER_AND_SHOOT', verified: false },
    VerticalPowerRun: { name: 'OFF_PRO_STYLE', verified: false },
    WestCoastPowerRun: { name: 'OFF_PRO_STYLE', verified: false },
  },
  defensive: {
    Base4_3: { name: 'DEF_BASE4_3', verified: true },
    Base3_4: { name: 'DEF_BASE3_4', verified: true },
    Under4_3: { name: 'DEF_4_3_MULTIPLE', verified: false },
    Under3_4: { name: 'DEF_3_3_5', verified: false },
    Tampa2: { name: 'DEF_MULTIPLE_DEFENSE', verified: false },
    Quarters4_3: { name: 'DEF_4_2_5', verified: false },
    Disguise3_4: { name: 'DEF_3_4_MULTIPLE', verified: false },
    Storm3_4: { name: 'DEF_3_3_5_TITE', verified: false },
    Cover3_4_3: { name: 'DEF_3_2_6', verified: false },
    Defense_46: { name: 'DEF_BASE4_3', verified: false },
  },
};

// Cross a BaseScheme name across games. side: 'offensive'|'defensive'.
// direction: 'cfbToMadden'|'maddenToCfb'. Returns { name, verified } --
// callers decide whether to warn/log on an unverified (`†`) mapping.
function crossSchemeName(sourceName, side, direction) {
  const table = direction === 'cfbToMadden' ? CFB_TO_MADDEN : MADDEN_TO_CFB;
  const entry = table[side] && table[side][sourceName];
  if (!entry) {
    throw new Error(`crossSchemeName: no ${direction} mapping for ${side} scheme "${sourceName}" `
      + `(known: ${Object.keys(table[side] || {}).join(', ')}).`);
  }
  return entry;
}

// Joins Team.CurrentOffensiveScheme/DefaultOffensiveScheme (readable
// BaseScheme name) against the same team's HeadCoach's raw
// OffensiveScheme/DefensiveScheme bitstring, for whichever save is open.
// Ports research/probe07-scheme-crossref.js's exact join as reusable code.
async function buildSchemeIndex(file) {
  const teamTable = biggestTableByName(file, 'Team');
  const coachTable = biggestTableByName(file, 'Coach');
  if (!teamTable || !coachTable) throw new Error('buildSchemeIndex: this save is missing a Team or Coach table.');
  await teamTable.readRecords();
  await coachTable.readRecords();

  const coachTableIds = new Set((file.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  const coachByRow = new Map();
  for (const r of coachTable.records) if (!r.isEmpty) coachByRow.set(r.index, r);

  // votes[side] : Map(rawBitstring -> { [BaseSchemeName]: count })
  const votes = { offensive: new Map(), defensive: new Map() };
  const vote = (side, raw, name) => {
    if (!raw || !name) return;
    if (!votes[side].has(raw)) votes[side].set(raw, {});
    votes[side].get(raw)[name] = (votes[side].get(raw)[name] || 0) + 1;
  };

  for (const tr of teamTable.records) {
    if (tr.isEmpty || !safe(tr, 'DisplayName')) continue;
    const offName = safe(tr, 'CurrentOffensiveScheme') ?? safe(tr, 'DefaultOffensiveScheme');
    const defName = safe(tr, 'CurrentDefensiveScheme') ?? safe(tr, 'DefaultDefensiveScheme');
    let ref; try { ref = tr.getReferenceDataByKey('HeadCoach'); } catch (e) { ref = null; }
    if (!ref || !coachTableIds.has(ref.tableId)) continue;
    const cr = coachByRow.get(ref.rowNumber);
    if (!cr) continue;
    vote('offensive', safe(cr, 'OffensiveScheme'), offName);
    vote('defensive', safe(cr, 'DefensiveScheme'), defName);
  }

  // Invert: for each BaseScheme name, pick the raw value with the most votes
  // (handles a "MIXED" pointer -- one raw bitstring observed under more than
  // one enum name, e.g. a team whose coach's scheme hasn't caught up with a
  // philosophy change -- by majority rather than first-seen).
  const index = { offensive: new Map(), defensive: new Map() };
  for (const side of ['offensive', 'defensive']) {
    const byName = new Map();
    for (const [raw, counts] of votes[side]) {
      for (const [name, count] of Object.entries(counts)) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ raw, count });
      }
    }
    for (const [name, entries] of byName) {
      entries.sort((a, b) => b.count - a.count);
      index[side].set(name, entries[0].raw);
    }
  }
  return index;
}

// Reverse lookup: given a SOURCE coach's own raw scheme value (read directly
// off their live record via safe() -- NOT the {tableId,rowNumber} object
// coachFacet.js's `refs` bag holds, which is useless for this), find which
// BaseScheme name that raw value corresponds to in THIS save's index.
// Returns null (not a throw) if unresolvable -- a coach whose team wasn't
// walked by buildSchemeIndex (no DisplayName, no HeadCoach reference, etc.)
// is a normal, expected case, and callers decide how to handle "unknown".
function resolveSchemeNameForCoach(schemeIndex, side, rawValue) {
  if (!rawValue) return null;
  for (const [name, raw] of schemeIndex[side]) if (raw === rawValue) return name;
  return null;
}

// Looks up the writable raw value for a BaseScheme name in a previously
// built index. Throws (rather than returning undefined) if this save simply
// doesn't have any team currently running that scheme -- callers need to
// know a scheme couldn't be resolved, not silently write nothing.
function lookupSchemeValue(schemeIndex, side, name) {
  const raw = schemeIndex[side] && schemeIndex[side].get(name);
  if (!raw) {
    throw new Error(`lookupSchemeValue: no team in this save currently runs "${name}" (${side}) -- `
      + `can't borrow a raw reference value for it. Known ${side} schemes: `
      + `${[...(schemeIndex[side] ? schemeIndex[side].keys() : [])].join(', ')}.`);
  }
  return raw;
}

module.exports = { CFB_TO_MADDEN, MADDEN_TO_CFB, crossSchemeName, buildSchemeIndex, lookupSchemeValue, resolveSchemeNameForCoach };
