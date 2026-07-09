// College reference distribution builder -- the CFB side of FrameProvider's
// artifacts. Self-calibrating: built fresh from the CURRENT save every
// time, per the calibration strategy (a college frame built from THIS
// dynasty's own population computes each player's percentile against the
// exact population he actually competed against -- the most identity-
// faithful reference coordinate available, not a fallback).
//
// Three-tier shrinkage, nested exactly as specified:
//   F^C_{p,a} = blend( exit(p,a), blend( exit(group,a), broad(p,a) ) )
// -- exit-position (this exact position's departed players) leans on
// exit-group (the departed pool for the whole position group) as its
// fallback, which itself leans on broad (every upperclassman currently on
// an FBS roster at that position, hundreds-to-thousands strong and stable
// from a single save). See build/shrinkage.js for the blending math.

const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

function isFbsTeam(teamNames, teamIndex) {
  const name = teamNames[teamIndex];
  return !!name && !String(name).startsWith('FCS ');
}

// Every upperclassman (Junior/Senior) currently on an FBS roster, grouped
// by position/attribute -- the "broad" tier. Independent of departure
// status, so it's available and stable even on a save with few/no exits
// yet (early dynasty).
function collectBroadTier(playerTable, teamNames, ratingFields) {
  const byPosition = {};
  for (const prec of playerTable.records) {
    if (prec.isEmpty) continue;
    // Same name guard extractLeavingPlayers already applies during
    // hydration -- an allocated-but-unnamed slot (isEmpty===false but no
    // real player was ever assigned) has near-zero ratings across the
    // board and would drag reference distributions toward a spurious
    // floor. Not a new rule, just applied here too.
    if (!safe(prec, 'FirstName') && !safe(prec, 'LastName')) continue;
    const yr = safe(prec, 'SchoolYear');
    if (yr !== 'Junior' && yr !== 'Senior') continue;
    const teamIndex = safe(prec, 'TeamIndex');
    if (!isFbsTeam(teamNames, teamIndex)) continue;
    const position = safe(prec, 'Position');
    if (!position) continue;
    const byAttr = (byPosition[position] ??= {});
    for (const attribute of ratingFields) {
      const v = safe(prec, attribute);
      if (typeof v !== 'number') continue;
      (byAttr[attribute] ??= []).push(v);
    }
  }
  return byPosition;
}

// The exit population (already hydrated -- see lib/pipeline.js), grouped
// by exact position AND by position group -- the "exit" and "exit-group"
// tiers.
function collectExitTiers(exitPopulation, posGroup, ratingFields) {
  const byPosition = {};
  const byGroup = {};
  for (const row of exitPopulation) {
    const position = row.Position;
    if (!position) continue;
    const group = posGroup[position] ?? position;
    const posAttrs = (byPosition[position] ??= {});
    const groupAttrs = (byGroup[group] ??= {});
    for (const attribute of ratingFields) {
      const v = row[attribute];
      if (typeof v !== 'number') continue;
      (posAttrs[attribute] ??= []).push(v);
      (groupAttrs[attribute] ??= []).push(v);
    }
  }
  return { byPosition, byGroup };
}

// Builds { [position]: { [attribute]: sortedArray } } for every position
// that has ANY broad-tier coverage (i.e. every position present on the
// save's rosters) -- the broad tier is what guarantees full coverage per
// the CalibrationModel contract, since it's independent of how many (if
// any) players at that position actually departed this cycle.
async function buildCollegeReferences({ cfbFile, teamNames, exitPopulation, ratingFields, posGroup, blendTiers, log = () => {} }) {
  const playerTable = cfbFile.getTableByName('Player');
  await playerTable.readRecords();
  const broadByPosition = collectBroadTier(playerTable, teamNames, ratingFields);
  const { byPosition: exitByPosition, byGroup: exitByGroup } = collectExitTiers(exitPopulation, posGroup, ratingFields);

  const result = {};
  let positionsCovered = 0, attributesCovered = 0, exitOnlyCount = 0, broadOnlyCount = 0;

  for (const position of Object.keys(broadByPosition)) {
    const group = posGroup[position] ?? position;
    result[position] = {};
    positionsCovered++;
    for (const attribute of ratingFields) {
      const broad = broadByPosition[position]?.[attribute] ?? [];
      const exitGroup = exitByGroup[group]?.[attribute] ?? [];
      const exitPos = exitByPosition[position]?.[attribute] ?? [];
      if (broad.length === 0 && exitGroup.length === 0 && exitPos.length === 0) continue;

      const fallback = blendTiers(exitGroup, broad);
      const final = blendTiers(exitPos, fallback);
      result[position][attribute] = final;
      attributesCovered++;
      if (exitPos.length > 0 && broad.length === 0 && exitGroup.length === 0) exitOnlyCount++;
      if (exitPos.length === 0 && exitGroup.length === 0 && broad.length > 0) broadOnlyCount++;
    }
  }

  log(`College reference: ${positionsCovered} positions, ${attributesCovered} (position,attribute) pairs `
    + `(${exitOnlyCount} exit-only, ${broadOnlyCount} broad-only, rest blended).`);

  return result;
}

module.exports = { buildCollegeReferences, isFbsTeam };
