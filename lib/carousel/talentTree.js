// Coach talent trees -- the thing that actually makes a transferred coach
// render correctly in Madden.
//
// THE FINDING THAT MOTIVATES THIS FILE (verified in-game): Madden's Coach
// Central UI derives a coach's displayed Level, Archetype and abilities from
// their TALENT TREE, not from Coach.Level / Coach.Archetype. A coach written
// into a blank shell -- Coach.Level=48, Coach.Archetype=DevelopmentWizard,
// but null talent references -- loaded fine and showed "Level 1 / DUMMY
// ARCHETYPE / no abilities". The scalar fields are backing data; the tree is
// what the game reads.
//
// Every coach owns PRIVATE talent instance rows (no sharing between coaches
// -- verified: McVay's gameday talents are rows 781-796, Flohr's are
// 912-923). So a transferred coach needs a tree of their own, deep-cloned
// from a donor of the right archetype and level.
//
// The clone chain is four levels deep:
//   Coach.{Playsheet,Gameday,WearAndTear}Talents
//     -> Talent[]        (table 5603)   one array row per category
//        -> Talent       (4235/4112/4110)  one row per talent
//           -> Tiers     TalentTier[] (5605)
//              -> TalentTier (4097)     one row per tier
//
// What is CLONED vs SHARED: a reference whose first bit is 1 points at a
// static asset table that does not exist inside the save (TalentInfo,
// CurrentGoal, CurrentKnockoutCondition) -- those are shared definitions and
// the reference is copied as-is. A reference whose first bit is 0 points at
// an in-save table (Tiers) and MUST be deep-cloned, or the new coach and the
// donor would share mutable state.

const { safe, biggestTableByName } = require('../saveIO');
const { resolveHolder, categoryIsPopulated } = require('./maddenTalentLayout');
const { enumAliasMap, canonicalEnumName } = require('./enumAlias');

const TALENT_ARRAY_TABLE = 5603;  // Talent[]
const TIER_ARRAY_TABLE = 5605;    // TalentTier[]
const TIER_TABLE = 4097;          // TalentTier
const TALENT_CATEGORIES = ['PlaysheetTalents', 'GamedayTalents', 'WearAndTearTalents'];

// The Madden 26 shape, as a layout object -- categories hang directly off the
// Coach record, and a donor must have Gameday + Playsheet populated (not
// WearAndTear, which no real M26 coach has; see maddenTalentLayout.js).
//
// Used as the DEFAULT when a caller supplies no layout, so every pre-existing
// call site keeps its exact behavior. Production callers pass a layout
// derived from the live save via describeTalentLayout(), which is what makes
// Madden 27's one-hop-deeper shape work; this constant is the floor they fall
// back to, not a version check.
const LEGACY_LAYOUT = {
  kind: 'coachDirect',
  holderField: null,
  holderTableId: null,
  categories: TALENT_CATEGORIES,
  requiredCategories: ['GamedayTalents', 'PlaysheetTalents'],
};

const isStaticAssetRef = (bits) => typeof bits === 'string' && bits.startsWith('1');
const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

// Hands out empty rows, remembering what it already gave away within one
// clone operation -- without this, every lookup would return the same first
// empty row and the tree would collapse onto itself.
function createRowAllocator(file) {
  const claimed = new Map(); // tableId -> Set(rowIndex)
  const tables = new Map();
  return {
    async table(tableId) {
      if (!tables.has(tableId)) {
        const t = file.getTableById(tableId);
        if (!t) throw new Error(`talentTree: table ${tableId} is not present in this save.`);
        await t.readRecords();
        tables.set(tableId, t);
      }
      return tables.get(tableId);
    },
    async claim(tableId) {
      const t = await this.table(tableId);
      if (!claimed.has(tableId)) claimed.set(tableId, new Set());
      const taken = claimed.get(tableId);
      for (const r of t.records) {
        if (r.isEmpty && !taken.has(r.index)) { taken.add(r.index); return r; }
      }
      throw new Error(`talentTree: no free rows left in table ${tableId} ("${t.name}") -- `
        + `capacity ${t.header.recordCapacity}. Cannot clone a talent tree.`);
    },
    stats() {
      return Object.fromEntries([...claimed.entries()].map(([id, s]) => [id, s.size]));
    },
  };
}

// Deep-clones one Talent row (and its Tiers array) into freshly claimed rows.
async function cloneTalentRow(alloc, donorTableId, donorRowIndex) {
  const donorTable = await alloc.table(donorTableId);
  const donor = donorTable.records[donorRowIndex];
  if (!donor || donor.isEmpty) return null;

  const dest = await alloc.claim(donorTableId);

  // Scalars + shared static-asset references copy straight across.
  const schema = donorTable.schema ? donorTable.schema.attributes : [];
  for (const attr of schema) {
    if (attr.name === 'Tiers') continue; // deep-cloned below
    const v = safe(donor, attr.name);
    if (v === undefined) continue;
    // An in-save reference other than Tiers would need cloning too; none
    // exist on these tables today, so refuse loudly rather than silently
    // sharing mutable state if a patch ever adds one.
    if (typeof v === 'string' && /^[01]{32}$/.test(v) && v !== '0'.repeat(32) && !isStaticAssetRef(v)) {
      throw new Error(`talentTree: ${donorTable.name}.${attr.name} is an in-save reference `
        + `(${v}) that would be shared with the donor. Cloning must be extended to cover it.`);
    }
    try { dest[attr.name] = v; } catch (e) { /* read-only/derived field -- skip */ }
  }

  // Tiers: TalentTier[] -> TalentTier rows, both cloned.
  const tiersRef = refOf(donor, 'Tiers');
  if (tiersRef) {
    const donorTierArrTable = await alloc.table(tiersRef.tableId);
    const donorTierArr = donorTierArrTable.records[tiersRef.rowNumber];
    if (donorTierArr && !donorTierArr.isEmpty) {
      const newTierArr = await alloc.claim(tiersRef.tableId);
      const n = donorTierArr.arraySize || 0;
      newTierArr.arraySize = n;
      for (let i = 0; i < n; i++) {
        const tRef = refOf(donorTierArr, `TalentTier${i}`);
        if (!tRef) continue;
        const tierTable = await alloc.table(tRef.tableId);
        const donorTier = tierTable.records[tRef.rowNumber];
        const newTier = await alloc.claim(tRef.tableId);
        if (donorTier && tierTable.schema) {
          for (const a of tierTable.schema.attributes) {
            const v = safe(donorTier, a.name);
            if (v !== undefined) { try { newTier[a.name] = v; } catch (e) { /* skip */ } }
          }
        }
        newTierArr[`TalentTier${i}`] = tierTable.getBinaryReferenceToRecord(newTier.index);
      }
      dest.Tiers = donorTierArrTable.getBinaryReferenceToRecord(newTierArr.index);
    }
  }

  return dest;
}

// Clones one whole category (e.g. GamedayTalents) from donor to dest coach.
async function cloneTalentCategory(alloc, donorCoach, destCoach, category) {
  const donorRef = refOf(donorCoach, category);
  if (!donorRef) return { category, cloned: 0, note: 'donor has no tree for this category' };

  const donorArrTable = await alloc.table(donorRef.tableId);
  const donorArr = donorArrTable.records[donorRef.rowNumber];
  if (!donorArr || donorArr.isEmpty) return { category, cloned: 0, note: 'donor array row is empty' };

  // An arraySize-0 donor category has nothing to clone, and claiming a row for
  // it is actively destructive -- THIS IS THE MULTI-COACH CORRUPTION BUG.
  //
  // WearAndTearTalents is the case that matters: every real Madden 26 donor
  // carries a reference to a NON-empty array row whose arraySize is 0 (0 of
  // 136 coaches have a populated one). The `isEmpty` test above therefore
  // passes, so the old code claimed a fresh row, wrote `arraySize = 0` into a
  // row that was already all zeros, cloned nothing, and pointed the coach at
  // it. The row stayed byte-identical to an empty one -- so it still reported
  // isEmpty === true.
  //
  // Batches chain through the file (commitMoves re-opens the previous output
  // for each coach), so the NEXT coach's allocator scanned, found that row
  // still "empty", claimed it for PlaysheetTalents, and wrote a real tree into
  // it. The result: coach N's WearAndTearTalents and coach N+1's
  // PlaysheetTalents point at the same array row -- shared mutable state
  // between coaches, which this module's header says must never happen.
  //
  // Measured on a real 6-coach batch: 66 talent rows shared across coaches,
  // every one traceable to this. A single-coach transfer was unaffected, which
  // is why it only ever showed up on real batches.
  //
  // Skipping matches what the code already intended -- leave an unclonable
  // category alone rather than fabricate one, so the coach ends up with the
  // same "no WearAndTear tree" state as the rest of the league.
  if (!(donorArr.arraySize > 0)) {
    return { category, cloned: 0, arraySize: 0, note: 'donor category is empty (arraySize 0) -- nothing cloned' };
  }

  const newArr = await alloc.claim(donorRef.tableId);
  const n = donorArr.arraySize || 0;
  newArr.arraySize = n;

  let cloned = 0;
  for (let i = 0; i < n; i++) {
    const tRef = refOf(donorArr, `Talent${i}`);
    if (!tRef) continue;
    const newTalent = await cloneTalentRow(alloc, tRef.tableId, tRef.rowNumber);
    if (!newTalent) continue;
    const talentTable = await alloc.table(tRef.tableId);
    newArr[`Talent${i}`] = talentTable.getBinaryReferenceToRecord(newTalent.index);
    cloned++;
  }

  destCoach[category] = donorArrTable.getBinaryReferenceToRecord(newArr.index);
  return { category, cloned, arraySize: n };
}

// Whether a coach has a REAL, non-empty tree for one category -- not just a
// reference. A reference can exist yet point at an unallocated, arraySize-0
// row (cloneTalentCategory already handles this on the DONOR side via its
// own "donor array row is empty" check) -- pickDonorCoach needs the same
// strength of check on the SELECTION side, or it can hand out a donor whose
// reference merely exists but whose tree is empty.
//
// `layout` says where the category reference lives: on the coach record
// itself (Madden 26) or on a holder row the coach points at (Madden 27).
async function hasPopulatedTalentCategory(maddenFile, coachRecord, category, layout = LEGACY_LAYOUT) {
  const holder = await resolveHolder(maddenFile, coachRecord, layout);
  return categoryIsPopulated(maddenFile, holder, category);
}

// Picks the donor whose tree best represents `targetLevel` for `archetype`.
// Prefers an exact archetype match at the closest level; falls back to any
// archetype at the closest level (a tree is better than no tree, and the
// level is what the UI leans on most visibly).
//
// Requires GamedayTalents AND PlaysheetTalents to be populated -- verified
// live (research/probe41-headtest-diagnostics.js) that these are NOT
// equally reliable: PlaysheetTalents is populated for 104/111 real coaches
// (94%) but the OLD version of this filter only checked GamedayTalents,
// which is why an early real transfer (S. Archer, CAREER-HEADTEST) silently
// landed with a donor missing a category -- an incomplete tree, not a
// crash, so it went unnoticed until this check existed.
//
// WearAndTearTalents is deliberately NOT required here: verified live that
// it is populated for 0 of 111 real coaches in the sample save -- a
// universal absence, not a per-coach gap. Requiring it would mean no donor
// ever qualifies. cloneTalentCategory already leaves an unclonable category
// alone rather than fabricating one, so every transferred coach correctly
// ends up with the same "no WearAndTear tree" state as the rest of the
// league -- in-distribution, not a defect (same reasoning this project
// already applies to CFB's near-zero `ContractSalary`).
async function pickDonorCoach(maddenFile, { position, archetype, targetLevel, excludeRows = [], layout = LEGACY_LAYOUT }) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();
  const exclude = new Set(excludeRows);
  const aliases = enumAliasMap(maddenFile, { table: 'Coach', field: 'Archetype' });

  const candidates = [];
  for (const r of t.records) {
    if (r.isEmpty || exclude.has(r.index)) continue;
    if (safe(r, 'Position') !== position) continue;
    const lvl = safe(r, 'Level');
    if (!lvl) continue;
    // Resolved once per candidate and carried forward -- grantTalentTree
    // clones FROM this holder, and re-deriving it there would walk the
    // reference a second time for no reason.
    const holder = await resolveHolder(maddenFile, r, layout);
    if (!holder) continue;
    let qualifies = true;
    for (const c of layout.requiredCategories) {
      if (!(await categoryIsPopulated(maddenFile, holder, c))) { qualifies = false; break; }
    }
    if (!qualifies) continue;
    candidates.push({
      record: r,
      holder,
      level: lvl,
      // Canonicalized so the exact-archetype preference below actually fires
      // on Madden 27, where every OffensiveGuru donor reads back as the alias
      // "First" and would otherwise never match an OffensiveGuru target.
      archetype: canonicalEnumName(aliases, safe(r, 'Archetype')),
      name: safe(r, 'Name'),
    });
  }
  if (!candidates.length) throw new Error(`talentTree: no donor coach with a talent tree found for position ${position}.`);

  const wanted = canonicalEnumName(aliases, archetype);
  const sameArchetype = candidates.filter((c) => c.archetype === wanted);
  const pool = sameArchetype.length ? sameArchetype : candidates;
  pool.sort((a, b) => Math.abs(a.level - targetLevel) - Math.abs(b.level - targetLevel));
  return { ...pool[0], exactArchetype: sameArchetype.length > 0 };
}

// The row that will RECEIVE cloned categories for `destCoach`.
//
// Madden 26: the coach record itself, so this is a no-op passthrough.
//
// Madden 27: the holder row the coach's StaffTalents points at. The
// destination is a disposable shell being overwritten, and holder rows are
// private 1:1 with coaches in every save observed (105 coaches, 105
// CoachingTalents rows), so reusing the shell's own row is both safe and
// tidier than claiming a fresh one and orphaning the old. A shell with no
// usable holder gets a freshly claimed row instead -- the holder table is
// taken from the donor's own reference, since the concrete table for this
// staff type is only knowable from a live pointer (the schema declares the
// abstract base).
async function ensureDestHolder(maddenFile, destCoach, donorHolder, layout, alloc) {
  if (layout.kind === 'coachDirect') return destCoach;

  const existing = await resolveHolder(maddenFile, destCoach, layout);
  if (existing) return existing;

  const holderTableId = layout.holderTableId ?? donorHolder?.__tableId;
  if (holderTableId == null) {
    throw new Error('talentTree: cannot determine which table holds this save\'s coach talent '
      + 'categories, so a tree cannot be granted. Turn on "Skip talent tree" in Coach Settings '
      + 'to transfer anyway.');
  }
  const fresh = await alloc.claim(holderTableId);
  const holderTable = await alloc.table(holderTableId);
  destCoach[layout.holderField] = holderTable.getBinaryReferenceToRecord(fresh.index);
  return fresh;
}

// Derives IndexInUnlockList for a target level from the live save's own
// coaches, rather than a hardcoded ratio -- the relationship is tight but
// save-specific (observed mean ratio ~0.85 of Level).
async function unlockIndexForLevel(maddenFile, position, targetLevel) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();
  const pts = [];
  for (const r of t.records) {
    if (r.isEmpty || safe(r, 'Position') !== position) continue;
    const lvl = safe(r, 'Level'); const idx = safe(r, 'IndexInUnlockList');
    if (lvl > 0 && typeof idx === 'number') pts.push({ lvl, idx });
  }
  if (!pts.length) return 0;
  pts.sort((a, b) => Math.abs(a.lvl - targetLevel) - Math.abs(b.lvl - targetLevel));
  const near = pts.slice(0, Math.max(3, Math.ceil(pts.length * 0.15)));
  const ratios = near.map((p) => p.idx / p.lvl).sort((a, b) => a - b);
  const medianRatio = ratios[Math.floor(ratios.length / 2)];
  return Math.max(0, Math.round(targetLevel * medianRatio));
}

// Gives `destCoach` a complete, private talent tree appropriate to
// `targetLevel`. Returns a report describing what was cloned.
async function grantTalentTree(maddenFile, destCoach, { position, archetype, targetLevel, excludeRows = [], layout = LEGACY_LAYOUT }) {
  const donor = await pickDonorCoach(maddenFile, { position, archetype, targetLevel, excludeRows, layout });
  const alloc = createRowAllocator(maddenFile);

  // Under the Madden 26 layout both of these ARE the coach records, so the
  // clone loop below is unchanged from when it took coaches directly.
  const donorHolder = donor.holder || donor.record;
  const destHolder = await ensureDestHolder(maddenFile, destCoach, donorHolder, layout, alloc);

  const categories = [];
  for (const c of layout.categories) {
    categories.push(await cloneTalentCategory(alloc, donorHolder, destHolder, c));
  }

  const unlockIndex = await unlockIndexForLevel(maddenFile, position, targetLevel);
  destCoach.IndexInUnlockList = unlockIndex;

  return {
    donor: { row: donor.record.index, name: donor.name, level: donor.level, archetype: donor.archetype, exactArchetype: donor.exactArchetype },
    categories,
    unlockIndex,
    rowsAllocated: alloc.stats(),
  };
}

module.exports = {
  grantTalentTree, pickDonorCoach, unlockIndexForLevel, hasPopulatedTalentCategory,
  createRowAllocator, cloneTalentCategory, cloneTalentRow, ensureDestHolder,
  TALENT_CATEGORIES, TALENT_ARRAY_TABLE, TIER_ARRAY_TABLE, TIER_TABLE, LEGACY_LAYOUT,
};
