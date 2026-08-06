// CFB talent trees for the REVERSE direction (Madden -> CFB).
//
// Genuinely simpler than talentTree.js's Madden-side clone, because of one
// verified structural fact: EVERY CFB Coach row -- including the blank
// Level-0/TeamIndex-255 filler shells this lands on -- already owns a fully
// private, pre-allocated chain:
//
//   Coach.ActiveTalentTree -> ActiveTalentTree row
//     -> TalentSubTreeStatusList -> TalentSubTreeStatus[] row (13 slots, 11 used)
//        -> TalentSubTreeStatus row x11, each privately owned
//           (CoachPointsSpent:int, TalentStatus0..32:TalentStatus enum)
//
// Verified across 478 sampled coaches: only one incidental pair shares a row
// (out of 478 distinct refs), and every blank shell has its OWN full chain,
// not a null/shared placeholder. So "granting a tree" here is never row
// allocation -- it's copying VALUES from a donor's chain into the
// destination's OWN already-existing chain, matching row-for-row by index
// (both have exactly 11 populated subtree slots).
//
// Verified live that Level correlates with real signal here: TalentStatus's
// enum is {NotOwned, Purchasable, Owned, Locked, Invalid}, and a coach's
// Owned count + CoachPointsSpent both trend up with Level across a sample
// spanning Level 17 to 48 (20->86 Owned, 425->1905 spent) -- noisy, but a
// real trend, not flat. Unlike Madden (where the display mechanism was
// directly verified in-game), CFB's Coach Central equivalent has NOT been
// screenshotted with this data -- this ships the same defensible choice
// Madden's talent tree shipped with before its own in-game verification:
// mirror a REAL donor coach's exact structure rather than invent one,
// because that is correct regardless of what the exact display semantics
// turn out to be.

const { safe, biggestTableByName } = require('../saveIO');

const SUBTREE_SLOTS = 11; // verified: every real chain populates exactly TalentSubTreeStatus0..10 (11, 12 are null)
const STATUS_FIELDS_PER_SUBTREE = 33; // TalentStatus0..32

function refOf(rec, key) {
  try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; }
}

// Reads a coach's own already-allocated chain of 11 TalentSubTreeStatus
// row references (NOT their values -- just where they live), so the caller
// can copy field-by-field between two coaches' chains without allocating
// anything.
async function readOwnTalentChain(cfbFile, coachRecord) {
  const attRef = refOf(coachRecord, 'ActiveTalentTree');
  if (!attRef) return null;
  const att = cfbFile.getTableById(attRef.tableId);
  await att.readRecords();
  const attRec = att.records[attRef.rowNumber];
  if (!attRec || attRec.isEmpty) return null;

  const subRef = refOf(attRec, 'TalentSubTreeStatusList');
  if (!subRef) return null;
  const subTable = cfbFile.getTableById(subRef.tableId);
  await subTable.readRecords();
  const subRec = subTable.records[subRef.rowNumber];
  if (!subRec || subRec.isEmpty) return null;

  const leaves = [];
  let leafTable = null;
  for (let i = 0; i < SUBTREE_SLOTS; i++) {
    const lref = refOf(subRec, `TalentSubTreeStatus${i}`);
    if (!lref) { leaves.push(null); continue; }
    if (!leafTable) { leafTable = cfbFile.getTableById(lref.tableId); await leafTable.readRecords(); }
    leaves.push(leafTable.records[lref.rowNumber] || null);
  }
  // attTable/attRec/subTable/subRec are exposed alongside the leaves purely so
  // allocateCfbTalentChain can learn the three table ids from a real donor
  // rather than hardcoding them -- same "derive it from the live save" rule
  // schemeLookup.js and levelScale.js already follow.
  return { leaves, leafTable, attTable: att, attRec, subTable, subRec };
}

// ---------------------------------------------------------------------
// WHY THERE IS NO allocateCfbTalentChain HERE (tried, measured, rejected --
// research/probe43). Building a chain for a genuinely empty Coach row looks
// like the obvious way to unlock the ~135 empty rows every CFB save carries,
// and it is exactly what talentTree.js does on the Madden side. It does not
// work the same way here, for a reason that lives in the file format:
//
// Empty rows are not free space -- they are a LINKED FREE-LIST. Each empty
// record's first four bytes point at the next empty record, and the library
// derives `isEmpty` by walking that list from `header.nextRecordToUse`.
// Claiming a row by simply picking one with `isEmpty === true` and writing
// fields into it therefore:
//   - never unlinks it from the free list, so it still reads `isEmpty` after a
//     save/reopen (and the game is free to hand it out again), and
//   - writes the first field straight over the free-list pointer, which
//     corrupts it. probe43 wrote a real coach this way and read the name back
//     as "Generic_0151_C_T01" -- the head asset name bleeding through a
//     mangled first field.
//
// Doing this properly means re-linking the free list and advancing
// nextRecordToUse through the library's own internals, which is a much larger
// and riskier change than this problem warrants -- especially since the real
// pool turned out to be reachable safely (see findDisposableCfbSlot's tier 2b:
// 41 already-allocated free agents in the same save, rejected only by an
// over-strict Level test).
//
// NOTE for future work: talentTree.js's Madden-side allocator claims rows the
// same naive way. It was verified in-game for faces/abilities, but its effect
// on free-list integrity has never been checked. Worth auditing separately.
// ---------------------------------------------------------------------

// Picks the donor whose chain best represents targetLevel for `position`.
// No archetype-matching pass (unlike Madden's talentTree.js) -- CFB's
// DominantArchetype was found to have essentially no correlation with talent
// spread (see archetypeMap.js's own header: "In CFB, DominantArchetype
// predicts side NOT AT ALL"), so nearest-level is the whole signal.
async function pickCfbDonorCoach(cfbFile, { position, targetLevel, excludeRows = [] }) {
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const exclude = new Set(excludeRows);

  const candidates = [];
  for (const r of t.records) {
    if (r.isEmpty || exclude.has(r.index)) continue;
    if (safe(r, 'Position') !== position) continue;
    const lvl = safe(r, 'Level');
    if (!lvl) continue;
    if (!refOf(r, 'ActiveTalentTree')) continue;
    candidates.push({ record: r, level: lvl, name: safe(r, 'Name') });
  }
  if (!candidates.length) throw new Error(`cfbTalentTree: no donor coach with a talent tree found for position ${position}.`);

  candidates.sort((a, b) => Math.abs(a.level - targetLevel) - Math.abs(b.level - targetLevel));
  return candidates[0];
}

// Gives `destCoach` a talent state matching a real donor at `targetLevel` --
// copies CoachPointsSpent + all 33 TalentStatus values, per subtree, into
// the destination's OWN already-existing rows. Never allocates a row; never
// touches ActiveTalentTree/TalentSubTreeStatusList references at all (they
// already correctly point at destCoach's own private chain).
//
// findDisposableCfbSlot filters for a usable chain before ever selecting a
// row, so a missing destination chain should not happen in practice -- but
// if it ever does (a genuinely empty, never-populated Coach row has no chain
// to write into by construction), this degrades to a no-op report rather
// than throwing and aborting the whole coach's placement over one field.
async function grantCfbTalentTree(cfbFile, destCoach, { position, targetLevel, excludeRows = [] }) {
  const donor = await pickCfbDonorCoach(cfbFile, { position, targetLevel, excludeRows });
  const donorChain = await readOwnTalentChain(cfbFile, donor.record);
  const destChain = await readOwnTalentChain(cfbFile, destCoach);

  if (!donorChain) throw new Error(`cfbTalentTree: donor ${donor.name} (row ${donor.record.index}) has no readable talent chain.`);
  if (!destChain) {
    return {
      donor: { row: donor.record.index, name: donor.name, level: donor.level },
      subtreesCopied: 0, statusesCopied: 0, totalSpent: 0,
      skipped: `destination row ${destCoach.index} has no talent chain of its own (a genuinely empty, `
        + 'never-populated Coach row) -- nothing to write into. See this module\'s header for why one '
        + 'cannot simply be allocated.',
    };
  }

  let subtreesCopied = 0;
  let statusesCopied = 0;
  let totalSpent = 0;
  for (let i = 0; i < SUBTREE_SLOTS; i++) {
    const donorLeaf = donorChain.leaves[i];
    const destLeaf = destChain.leaves[i];
    if (!donorLeaf || donorLeaf.isEmpty || !destLeaf || destLeaf.isEmpty) continue;

    const spent = safe(donorLeaf, 'CoachPointsSpent') || 0;
    destLeaf.CoachPointsSpent = spent;
    totalSpent += spent;
    for (let j = 0; j < STATUS_FIELDS_PER_SUBTREE; j++) {
      const field = `TalentStatus${j}`;
      const v = safe(donorLeaf, field);
      if (v === undefined) continue;
      destLeaf[field] = v;
      statusesCopied++;
    }
    subtreesCopied++;
  }

  return {
    donor: { row: donor.record.index, name: donor.name, level: donor.level },
    subtreesCopied, statusesCopied, totalSpent,
  };
}

module.exports = {
  grantCfbTalentTree, pickCfbDonorCoach, readOwnTalentChain,
  SUBTREE_SLOTS, STATUS_FIELDS_PER_SUBTREE,
};
