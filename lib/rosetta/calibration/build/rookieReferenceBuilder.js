// NFL-rookie reference distribution builder -- the Madden side of
// FrameProvider's artifacts. Built from EA-generated Madden rookie classes
// (YearsPro === 0) in a real Madden save. Two-tier shrinkage: exact
// position leans on its position group as fallback (no third tier here --
// unlike the college side, there's no "broad roster" analogue on the
// Madden side; every Madden player at a position already IS at that
// position, there's no upperclassman/departed distinction). See
// build/shrinkage.js for the blending math.

const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

async function buildRookieReferences({ maddenFile, ratingFields, posGroup, blendTiers, log = () => {} }) {
  const playerTable = maddenFile.getTableByName('Player');
  await playerTable.readRecords();

  const byPosition = {};
  const byGroup = {};
  let rookieCount = 0;

  for (const prec of playerTable.records) {
    if (prec.isEmpty) continue;
    // Same name guard used everywhere else in this app -- an allocated-but-
    // unnamed slot has near-zero ratings across the board and would drag
    // the reference distribution toward a spurious floor. Verified on a
    // real save: a blank-name YearsPro=0 "QB" with Speed=0/Awareness=0/
    // Overall=12 was otherwise being counted as a real rookie.
    if (!safe(prec, 'FirstName') && !safe(prec, 'LastName')) continue;
    const yearsPro = safe(prec, 'YearsPro');
    if (yearsPro !== 0) continue;
    const position = safe(prec, 'Position');
    if (!position) continue;
    rookieCount++;
    const group = posGroup[position] ?? position;
    const posAttrs = (byPosition[position] ??= {});
    const groupAttrs = (byGroup[group] ??= {});
    for (const attribute of ratingFields) {
      const v = safe(prec, attribute);
      if (typeof v !== 'number') continue;
      (posAttrs[attribute] ??= []).push(v);
      (groupAttrs[attribute] ??= []).push(v);
    }
  }

  const result = {};
  let positionsCovered = 0, attributesCovered = 0;
  for (const position of Object.keys(byPosition)) {
    const group = posGroup[position] ?? position;
    result[position] = {};
    positionsCovered++;
    for (const attribute of ratingFields) {
      const pos = byPosition[position]?.[attribute] ?? [];
      const grp = byGroup[group]?.[attribute] ?? [];
      if (pos.length === 0 && grp.length === 0) continue;
      result[position][attribute] = blendTiers(pos, grp);
      attributesCovered++;
    }
  }

  log(`NFL-rookie reference: ${rookieCount} rookies, ${positionsCovered} positions, ${attributesCovered} (position,attribute) pairs.`);
  return result;
}

module.exports = { buildRookieReferences };
