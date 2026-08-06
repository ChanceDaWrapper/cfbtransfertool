// Repairs the pending contract offers left pointing at a transferred coach.
//
// THE BUG, and why two earlier field-level fixes did not stop the crash.
// A Madden->CFB transfer overwrites a disposable FREE-AGENT shell. During the
// coaching carousel, other schools have already made that shell pending
// contract offers -- and those offers live in their own table
// (StaffPersonContractOffer), pointing back at the coach's row. Overwriting
// the coach does not touch them, so the save ends up with offers whose
// subject is now somebody else entirely, still carrying free-agent shape.
//
// The tell is exact, measured on the crashing save:
//
//   offers to genuine EMPLOYED coaches : StaffPersonTeam set on 160 of 160
//   offers to FREE AGENTS              : set on 2 of 166
//   offers to the transferred coaches  : set on 0 of 12   <-- employed, but shaped unemployed
//
// StaffPersonTeam is the school the offer is trying to poach FROM. An
// employed coach must have one; a free agent has none. Our coaches are
// employed and have none, so anything walking pending offers dereferences a
// null. The game walks them when it runs the carousel -- which is exactly
// what advancing past bowl week does, and exactly where these saves die.
//
// Concretely, in that save J. Brady is Iowa State's HEAD COACH while carrying
// six pending offers to become an OFFENSIVE COORDINATOR elsewhere, each with
// no source school attached.
//
// THE FIX is to give those offers the same shape the 160 valid ones have:
// point StaffPersonTeam at the coach's own current school. Offers are not
// deleted -- an employed coach carrying pending offers is completely normal
// mid-carousel (160 genuine ones do), so removing them would be a bigger
// change to the dynasty than repairing them.

const { safe, biggestTableByName } = require('../saveIO');

const refOf = (rec, key) => { try { const r = rec.getReferenceDataByKey(key); return r && (r.tableId || r.rowNumber) ? r : null; } catch (e) { return null; } };

// Finds pending offers whose subject is an EMPLOYED coach but which carry no
// source school. Optionally restricted to specific coach rows.
async function findStaleOffers(cfbFile, { coachRows = null } = {}) {
  const offerTable = biggestTableByName(cfbFile, 'StaffPersonContractOffer');
  if (!offerTable) return { offerTable: null, stale: [] };
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await Promise.all([offerTable.readRecords(), coachT.readRecords()]);
  const coachTableIds = new Set((cfbFile.getAllTablesByName('Coach') || []).map((t) => t.header.tableId));
  const only = coachRows ? new Set(coachRows) : null;

  const stale = [];
  for (const rec of offerTable.records) {
    if (rec.isEmpty) continue;
    const sp = refOf(rec, 'StaffPerson');
    if (!sp || !coachTableIds.has(sp.tableId)) continue;
    if (only && !only.has(sp.rowNumber)) continue;

    const coach = coachT.records[sp.rowNumber];
    if (!coach || coach.isEmpty) continue;
    const teamIndex = safe(coach, 'TeamIndex');
    if (teamIndex === undefined || teamIndex === 255) continue; // genuinely a free agent -- null is correct
    if (refOf(rec, 'StaffPersonTeam')) continue;                // already correct

    stale.push({ offer: rec, coach, teamIndex });
  }
  return { offerTable, stale };
}

// Points each stale offer's StaffPersonTeam at the coach's own school, which
// is what every valid employed-coach offer in the save does.
async function fixStaleContractOffers(cfbFile, { coachRows = null } = {}) {
  const { offerTable, stale } = await findStaleOffers(cfbFile, { coachRows });
  if (!offerTable || !stale.length) return [];

  const teamT = biggestTableByName(cfbFile, 'Team');
  await teamT.readRecords();
  const teamRowByIndex = new Map();
  for (const r of teamT.records) {
    if (r.isEmpty) continue;
    const ti = safe(r, 'TeamIndex');
    if (ti !== undefined && !teamRowByIndex.has(ti)) teamRowByIndex.set(ti, r.index);
  }

  const fixed = [];
  for (const s of stale) {
    const teamRow = teamRowByIndex.get(s.teamIndex);
    if (teamRow === undefined) continue;
    try {
      s.offer.StaffPersonTeam = teamT.getBinaryReferenceToRecord(teamRow);
      fixed.push({
        offerRow: s.offer.index,
        coach: safe(s.coach, 'Name'),
        coachRow: s.coach.index,
        teamIndex: s.teamIndex,
      });
    } catch (e) { /* read-only/derived -- skip */ }
  }
  return fixed;
}

module.exports = { fixStaleContractOffers, findStaleOffers };
