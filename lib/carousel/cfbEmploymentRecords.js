// The records a CFB coach must own once they actually HOLD A JOB.
//
// THE BUG THIS EXISTS TO FIX (diagnosed from a real user's crashing save,
// research/probe43+44): Madden->CFB placement lands an arriving coach on a
// disposable free-agent shell. Those shells are blank by nature -- most carry
// NO CareerStats, NO SeasonStats and NO CharacterVisuals, and point
// TeamPhilosophy at a different asset table than employed coaches use. We
// wrote the coach's identity and job onto the shell but never brought those
// structures up to "employed coach" shape, so the save contained an employed
// head coach with null season/career records. The game loaded and looked
// perfect -- until the user advanced past bowl week, which is exactly when
// CFB closes out a season and walks every employed coach's records. It
// crashed there every time.
//
// Measured in that save, and the numbers are absolute:
//
//   field              genuine employed        free-agent shells    ours
//   CareerStats        408/408 set (t4235)     72/83 NULL           6/6 NULL
//   SeasonStats        408/408 set (t4131)     72/83 NULL           6/6 NULL
//   CharacterVisuals   408/408 set (t4226)     62/83 NULL           6/6 NULL
//   TeamPhilosophy     408/408 -> 16453        58/83 -> 16433       6/6 -> 16433
//
// Every table id here is DERIVED from a real coach's own references rather
// than hardcoded -- ids differ between saves (this user's visuals table is
// 4226; other saves differ), so hardcoding would silently target the wrong
// table.
//
// Only the CFB side needs this. Madden coaches carry NULL CareerStats and
// SeasonStats whether employed or not (verified: 82/82 employed, 45/45 free
// agents), and Madden's free-agent shells already own a CharacterVisuals row
// -- so the forward direction was never affected.

const { safe, biggestTableByName } = require('../saveIO');

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

// A coach who genuinely holds a job and owns every structure we need to copy.
// Excludes the destination itself and the coach we just displaced.
function findEmploymentDonor(coachRecords, { excludeRows = [] } = {}) {
  const exclude = new Set(excludeRows);
  for (const r of coachRecords) {
    if (r.isEmpty || exclude.has(r.index)) continue;
    if (safe(r, 'TeamIndex') === 255 || safe(r, 'TeamIndex') === undefined) continue;
    if (!safe(r, 'Level')) continue;
    if (!refOf(r, 'CareerStats') || !refOf(r, 'SeasonStats')) continue;
    if (!refOf(r, 'CharacterVisuals')) continue;
    return r;
  }
  return null;
}

function claimEmptyRow(table) {
  for (const r of table.records) if (r.isEmpty) return r;
  return null;
}

// What value should each field of a BRAND NEW stats row start at?
//
// Most fields are accumulators (wins, losses, bowl wins, draft picks) and a
// fresh hire starts them at 0. But not all of them are: RecentYearNCWon
// carries -2 for a coach who has never won a national championship, and a
// real year number for one who has. Zeroing it would assert the coach won a
// title in year 0 -- a value no real coach in either sample save holds.
//
// The rule, derived rather than assumed: take the MODE of the field across
// real employed coaches; if that mode is NEGATIVE, it is a "none / never"
// marker (a count cannot be negative) so start there; otherwise start at 0.
//
// Verified against both sample saves. RecentYearNCWon: mode -2 (385 of 414
// in one save, 408 of 408 in the other) -> -2. Wins/Losses/DraftPicks/every
// other field: mode >= 0 -> 0. An earlier "copy anything that never varies"
// version of this rule got RecentYearNCWon wrong the moment a save contained
// a coach who HAD won one, which is exactly why it is mode-based now.
function freshStatsFieldValues(statsTable, donorRows) {
  const starts = new Map();
  if (!statsTable.schema) return starts;
  for (const attr of statsTable.schema.attributes) {
    const counts = new Map();
    for (const row of donorRows) {
      const v = safe(row, attr.name);
      if (typeof v !== 'number') continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!counts.size) continue;
    let mode = null;
    let best = -1;
    for (const [v, n] of counts) if (n > best) { best = n; mode = v; }
    starts.set(attr.name, mode < 0 ? mode : 0);
  }
  return starts;
}

// Gives `destCoach` its own private CareerStats + SeasonStats rows, its own
// CharacterVisuals row, and a TeamPhilosophy that matches what employed
// coaches in this save actually use.
//
// Every row allocated is PRIVATE -- verified that real coaches never share
// these (408 distinct career rows, 408 distinct season rows and 408 distinct
// visuals rows across 408 coaches, zero sharing). Sharing one would couple
// two coaches' records together.
//
// Anything already present on the destination row is left alone: a few
// disposable shells do already own valid structures, and reusing theirs is
// both correct and cheaper than allocating another.
async function attachCfbEmploymentRecords(cfbFile, destCoach, { teamRecord = null, incumbent = null, excludeRows = [] } = {}) {
  const coachTable = biggestTableByName(cfbFile, 'Coach');
  await coachTable.readRecords();

  const donor = findEmploymentDonor(coachTable.records, { excludeRows: [destCoach.index, ...excludeRows] });
  if (!donor) {
    throw new Error('attachCfbEmploymentRecords: no employed coach in this save owns a complete set of '
      + 'CareerStats/SeasonStats/CharacterVisuals to model a new hire on.');
  }

  const report = { donorRow: donor.index, attached: [], reused: [], philosophy: null };

  // ---- Career + season stats -------------------------------------------
  // Employed coaches are the population the game iterates at season rollover,
  // so they are the only sensible reference for what a row should look like.
  const employed = coachTable.records.filter((r) => !r.isEmpty
    && safe(r, 'TeamIndex') !== 255 && safe(r, 'TeamIndex') !== undefined && safe(r, 'Level') > 0);

  for (const field of ['CareerStats', 'SeasonStats']) {
    if (refOf(destCoach, field)) { report.reused.push(field); continue; }

    const donorRef = refOf(donor, field);
    const statsTable = cfbFile.getTableById(donorRef.tableId);
    if (!statsTable) throw new Error(`attachCfbEmploymentRecords: ${field} table ${donorRef.tableId} is not in this save.`);
    await statsTable.readRecords();

    const fresh = claimEmptyRow(statsTable);
    if (!fresh) {
      throw new Error(`attachCfbEmploymentRecords: no free rows left in ${field} `
        + `("${statsTable.name}", capacity ${statsTable.header.recordCapacity}) -- cannot give this coach the `
        + 'season records an employed CFB coach must have. Refusing to write a coach that would crash the game on advance.');
    }

    const donorRows = employed
      .map((r) => { const ref = refOf(r, field); return ref ? statsTable.records[ref.rowNumber] : null; })
      .filter((r) => r && !r.isEmpty);
    const starts = freshStatsFieldValues(statsTable, donorRows);

    for (const attr of (statsTable.schema ? statsTable.schema.attributes : [])) {
      const v = starts.has(attr.name) ? starts.get(attr.name) : 0;
      try { fresh[attr.name] = v; } catch (e) { /* read-only/derived -- skip */ }
    }
    destCoach[field] = statsTable.getBinaryReferenceToRecord(fresh.index);
    report.attached.push(`${field}=${donorRef.tableId}:${fresh.index}`);
  }

  // ---- CharacterVisuals -------------------------------------------------
  // CFB coach blobs carry apparel only -- no head loadout at all (the head
  // lives in GenericHeadAssetName), so a donor's blob is copied verbatim
  // with nothing to swap. Same borrow-real-apparel posture the Madden side
  // already uses; never invent item names.
  if (refOf(destCoach, 'CharacterVisuals')) {
    report.reused.push('CharacterVisuals');
  } else {
    const donorRef = refOf(donor, 'CharacterVisuals');
    const visTable = cfbFile.getTableById(donorRef.tableId);
    if (!visTable) throw new Error(`attachCfbEmploymentRecords: CharacterVisuals table ${donorRef.tableId} is not in this save.`);
    await visTable.readRecords();

    let raw;
    try { raw = visTable.records[donorRef.rowNumber].getValueByKey('RawData'); } catch (e) {
      throw new Error(`attachCfbEmploymentRecords: could not read a donor CharacterVisuals blob (${e.message}).`);
    }
    if (typeof raw === 'string') {
      const fresh = claimEmptyRow(visTable);
      if (!fresh) {
        throw new Error(`attachCfbEmploymentRecords: no free rows left in CharacterVisuals `
          + `(capacity ${visTable.header.recordCapacity}).`);
      }
      fresh.RawData = raw;
      destCoach.CharacterVisuals = visTable.getBinaryReferenceToRecord(fresh.index);
      report.attached.push(`CharacterVisuals=${donorRef.tableId}:${fresh.index}`);
    }
  }

  // ---- TeamPhilosophy / DefaultTeamPhilosophy ---------------------------
  // These are per-COACH asset references, not per-team (130 distinct targets
  // across 408 coaches). A blank shell's value points at a different asset
  // table entirely than any employed coach uses, so it must be replaced.
  //
  // Inherited from a real coach rather than invented -- the displaced
  // incumbent first, then a staff peer, then whatever employed coaches in
  // this save most commonly use. Exactly the order derivePipeline already
  // uses, and for the same reason.
  // skipRows matters: when REPAIRING a save the coach is already installed in
  // the team slot, so an unguarded peer walk finds the coach themselves and
  // "inherits" the very value being repaired. Caught exactly that on two head
  // coaches during the first repair run.
  const philosophySource = await pickPhilosophySource(cfbFile, coachTable, employed, teamRecord, incumbent, [destCoach.index, ...excludeRows]);
  if (philosophySource) {
    for (const field of ['TeamPhilosophy', 'DefaultTeamPhilosophy']) {
      const ref = refOf(philosophySource.record, field);
      if (!ref) continue;
      const tbl = cfbFile.getTableById(ref.tableId);
      // A static-asset reference (table not inside the save) is copied as the
      // raw bitstring; an in-save one is rebuilt through the table's own API.
      const rawBits = safe(philosophySource.record, field);
      if (typeof rawBits === 'string' && /^[01]{32}$/.test(rawBits)) destCoach[field] = rawBits;
      else if (tbl) destCoach[field] = tbl.getBinaryReferenceToRecord(ref.rowNumber);
    }
    report.philosophy = philosophySource.why;
  }

  return report;
}

// Whose philosophy should a new hire adopt? The person whose job they took,
// then a colleague, then the league norm.
async function pickPhilosophySource(cfbFile, coachTable, employed, teamRecord, incumbent, skipRows = []) {
  const skip = new Set(skipRows);
  if (incumbent && !skip.has(incumbent.index) && refOf(incumbent, 'TeamPhilosophy')) {
    return { record: incumbent, why: `the outgoing coach (${safe(incumbent, 'Name')})` };
  }
  if (teamRecord) {
    const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
    for (const slot of ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator']) {
      const ref = refOf(teamRecord, slot);
      if (!ref || !coachTableIds.has(ref.tableId)) continue;
      if (skip.has(ref.rowNumber)) continue; // never inherit from ourselves, or another coach being repaired
      const peer = coachTable.records[ref.rowNumber];
      if (peer && !peer.isEmpty && refOf(peer, 'TeamPhilosophy')) {
        return { record: peer, why: `a staff peer (${safe(peer, 'Name')})` };
      }
    }
  }
  // League norm: the philosophy the most employed coaches actually carry.
  const tally = new Map();
  for (const r of employed) {
    if (skip.has(r.index)) continue;
    const ref = refOf(r, 'TeamPhilosophy');
    if (!ref) continue;
    const key = `${ref.tableId}:${ref.rowNumber}`;
    if (!tally.has(key)) tally.set(key, { record: r, n: 0 });
    tally.get(key).n++;
  }
  let best = null;
  for (const v of tally.values()) if (!best || v.n > best.n) best = v;
  return best ? { record: best.record, why: `the most common philosophy among employed coaches (${best.n} of them)` } : null;
}

module.exports = { attachCfbEmploymentRecords, findEmploymentDonor, freshStatsFieldValues };
