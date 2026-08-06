// READ-ONLY diagnosis. In CAREER-HEADTEST the Giants and Bears got their new
// coaches, but the Jets still show Aaron Glenn (the real incumbent) instead of
// S. Archer, who we placed at teamIndex 25.
//
// Questions:
//   1. What team does teamIndex 25 actually resolve to? (is 25 the Jets?)
//   2. Where did S. Archer (the row we wrote) land, and what TeamIndex does
//      that coach row carry?
//   3. What does the Jets Team row's HeadCoach pointer point at -- Archer, or
//      still Aaron Glenn?
//   4. Same question for Giants/Bears, which DID work, so we can see the
//      difference.

const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-HEADTEST';

(async () => {
  const file = await FranchiseFile.create(SAVE, { autoUnempty: true });
  const coachT = biggestTableByName(file, 'Coach');
  const teamT = biggestTableByName(file, 'Team');
  await coachT.readRecords();
  await teamT.readRecords();

  // --- map every Team row: index, name, and who it points at as HeadCoach ---
  console.log('=== Team rows for Giants / Bears / Jets ===');
  const wanted = /giant|bear|jet/i;
  const coachRefToRow = (ref) => (ref && typeof ref.rowNumber === 'number') ? ref.rowNumber : null;

  for (let i = 0; i < teamT.records.length; i++) {
    const r = teamT.records[i];
    if (!r || r.isEmpty) continue;
    const name = safe(r, 'DisplayName') || safe(r, 'LongName') || safe(r, 'ShortName') || safe(r, 'Name');
    if (!name || !wanted.test(String(name))) continue;
    const teamIndex = safe(r, 'TeamIndex');
    let hcRow = null, hcName = null;
    try {
      const ref = r.getReferenceDataByKey('HeadCoach');
      hcRow = coachRefToRow(ref);
      if (hcRow !== null && coachT.records[hcRow] && !coachT.records[hcRow].isEmpty) hcName = safe(coachT.records[hcRow], 'Name');
    } catch (e) { hcName = `(no HeadCoach key: ${e.message})`; }
    console.log(`  Team row ${String(i).padStart(3)}  TeamIndex ${String(teamIndex).padStart(3)}  ${String(name).padEnd(24)} -> HeadCoach row ${hcRow} = ${hcName}`);
  }

  // --- find our three placed coaches and Aaron Glenn ------------------------
  console.log('\n=== relevant Coach rows ===');
  const names = /archer|aranda|anthony|glenn/i;
  for (let i = 0; i < coachT.records.length; i++) {
    const r = coachT.records[i];
    if (!r || r.isEmpty) continue;
    const nm = safe(r, 'Name');
    if (!nm || !names.test(String(nm))) continue;
    console.log(`  Coach row ${String(i).padStart(3)}  ${String(nm).padEnd(16)} pos=${String(safe(r, 'Position')).padEnd(18)} `
      + `TeamIndex=${String(safe(r, 'TeamIndex')).padStart(3)}  head=${safe(r, 'GenericHeadAssetName')}`);
  }

  // --- what is teamIndex 24 vs 25? -----------------------------------------
  console.log('\n=== what TeamIndex 24 and 25 resolve to ===');
  for (const idx of [24, 25]) {
    for (let i = 0; i < teamT.records.length; i++) {
      const r = teamT.records[i];
      if (!r || r.isEmpty) continue;
      if (safe(r, 'TeamIndex') !== idx) continue;
      const name = safe(r, 'DisplayName') || safe(r, 'LongName') || safe(r, 'ShortName');
      console.log(`  TeamIndex ${idx} = ${name} (Team row ${i})`);
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
