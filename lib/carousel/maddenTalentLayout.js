// Where a Madden save keeps a coach's talent categories -- discovered from
// the save itself rather than assumed from a version number.
//
// WHY THIS EXISTS. Madden 26 hangs the three talent categories directly off
// the Coach record:
//
//   Coach.GamedayTalents     -> Talent[] -> GamedayTalent   -> Tiers -> ...
//   Coach.PlaysheetTalents   -> Talent[] -> PlaysheetTalent -> Tiers -> ...
//   Coach.WearAndTearTalents -> Talent[] -> ...
//
// Madden 27 replaced those three fields with a single `StaffTalents`
// reference pointing at a per-coach holder row that carries the categories
// instead -- one extra hop, two categories rather than three:
//
//   Coach.StaffTalents -> CoachingTalents { GamedayTalents, PlaysheetTalents }
//                                            -> Talent[] -> GamedayTalent -> ...
//
// Everything below that hop is unchanged, which is why talentTree.js's clone
// chain needed no rework -- only a way to find where the chain starts.
//
// DETECTED, NOT VERSIONED. This reads the live Coach schema and the live
// holder table instead of branching on gameYear, for three reasons: the
// holder field is typed `AbstractTalentList` (an abstract base -- coaches
// point at CoachingTalents, trainers at TrainerTalents, and a future staff
// type could add a third), so the concrete table is only knowable at runtime;
// a title update can change shape without changing the year; and a save whose
// shape we have never seen either matches one of these two layouts or gets a
// clear refusal, rather than a null dereference deep in the clone.

const { safe, biggestTableByName } = require('../saveIO');

const refOf = (rec, key) => {
  try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; }
  catch (e) { return null; }
};

// A category counts as REQUIRED for donor selection if this share of the
// league's coaches actually have it populated.
//
// This replaces a hardcoded "Gameday AND Playsheet, but not WearAndTear"
// rule that was correct for Madden 26 and only for Madden 26. The rule was
// right for a reason worth preserving: WearAndTear is populated for 0 of 136
// real M26 coaches, so requiring it would disqualify every possible donor,
// while Gameday (99%) and Playsheet (85%) are genuinely expected and a donor
// missing one yields a visibly incomplete tree. Deriving the same conclusion
// from the save's own numbers reproduces M26's behavior exactly, extends to
// M27 (Gameday 99%, Playsheet 99%) without a second hardcoded list, and
// follows the pattern this module's neighbors already use -- unlockIndexFor-
// Level derives its ratio from the live save rather than a constant.
const REQUIRED_SHARE = 0.5;

// The Coach field that holds a category reference, per layout.
const HOLDER_FIELD = 'StaffTalents';

// Category fields are exactly the reference fields whose declared type is a
// talent array -- true of Coach in M26 and of the holder row in M27.
function talentArrayFieldNames(schema) {
  if (!schema) return [];
  return schema.attributes.filter((a) => a.type === 'Talent[]').map((a) => a.name);
}

// The record that actually carries the category references for `coachRecord`:
// the coach itself under the M26 layout, or the row its holder field points
// at under M27. Returns null when a coach has no holder row -- a real state
// (1 of 106 M27 coaches), not an error.
async function resolveHolder(maddenFile, coachRecord, layout) {
  if (layout.kind === 'coachDirect') return coachRecord;
  const ref = refOf(coachRecord, layout.holderField);
  if (!ref) return null;
  const t = maddenFile.getTableById(ref.tableId);
  if (!t) return null;
  await t.readRecords();
  const rec = t.records[ref.rowNumber];
  return rec && !rec.isEmpty ? rec : null;
}

// Whether one category on an already-resolved holder is a REAL tree rather
// than a reference that merely exists -- a ref can point at an unallocated,
// arraySize-0 row, which clones to an empty tree.
async function categoryIsPopulated(maddenFile, holder, category) {
  if (!holder) return false;
  const ref = refOf(holder, category);
  if (!ref) return false;
  const t = maddenFile.getTableById(ref.tableId);
  if (!t) return false;
  await t.readRecords();
  const rec = t.records[ref.rowNumber];
  return !!(rec && !rec.isEmpty && (rec.arraySize || 0) > 0);
}

// Reads the save and reports which layout it uses, which categories exist,
// and which of those a donor must have populated to qualify.
async function describeTalentLayout(maddenFile) {
  const coachSchema = maddenFile.schemaList.getSchema('Coach');
  if (!coachSchema) throw new Error('maddenTalentLayout: this save has no Coach schema.');
  const coachAttrs = new Set(coachSchema.attributes.map((a) => a.name));

  const direct = talentArrayFieldNames(coachSchema);
  let layout;
  if (direct.length) {
    layout = { kind: 'coachDirect', holderField: null, holderTableId: null, categories: direct };
  } else if (coachAttrs.has(HOLDER_FIELD)) {
    layout = { kind: 'staffStruct', holderField: HOLDER_FIELD, holderTableId: null, categories: [] };
  } else {
    throw new Error('maddenTalentLayout: this Madden save\'s Coach table has neither direct talent '
      + `categories nor a "${HOLDER_FIELD}" reference, so a transferred coach cannot be given a `
      + 'talent tree. This is a Madden save shape Pipeline has not seen before -- the coach transfer '
      + 'would produce a Level 1 coach with no abilities. Turn on "Skip talent tree" in Coach '
      + 'Settings to transfer anyway.');
  }

  // Walk the league once: resolve every coach's holder, discover the category
  // fields from the holder's own schema (M27 -- the concrete holder table is
  // only knowable from a live reference), and count how many coaches have
  // each category actually populated.
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();

  const counts = new Map();
  let live = 0;
  for (const r of t.records) {
    if (r.isEmpty) continue;
    if (!safe(r, 'FirstName') && !safe(r, 'LastName')) continue;
    live++;

    const holder = await resolveHolder(maddenFile, r, layout);
    if (!holder) continue;

    if (layout.kind === 'staffStruct' && !layout.categories.length) {
      const ref = refOf(r, layout.holderField);
      const ht = ref && maddenFile.getTableById(ref.tableId);
      if (ht) {
        layout.holderTableId = ht.header.tableId;
        layout.holderTableName = ht.name;
        layout.categories = talentArrayFieldNames(ht.schema);
      }
    }
    for (const c of layout.categories) {
      if (await categoryIsPopulated(maddenFile, holder, c)) counts.set(c, (counts.get(c) || 0) + 1);
    }
  }

  if (!layout.categories.length) {
    throw new Error('maddenTalentLayout: no coach in this Madden save has a usable talent-category '
      + 'reference, so there is no tree to copy from. Turn on "Skip talent tree" in Coach Settings '
      + 'to transfer anyway.');
  }

  const rates = {};
  for (const c of layout.categories) rates[c] = { populated: counts.get(c) || 0, live };
  const required = layout.categories.filter((c) => live > 0 && (counts.get(c) || 0) / live >= REQUIRED_SHARE);

  return { ...layout, requiredCategories: required, rates, liveCoaches: live };
}

module.exports = {
  describeTalentLayout, resolveHolder, categoryIsPopulated,
  talentArrayFieldNames, refOf, REQUIRED_SHARE, HOLDER_FIELD,
};
