// WRITES a save (to CAREER-HEADTEST -- never in place). Everything else in
// research/ is read-only; this one has to write, because the question it
// answers can only be answered by the game rendering the result.
//
// Question: probe19 found the generic coach-head catalog is assets 1..200, but
// only 83 of those were ever observed on a live coach. The other 117 asset
// NAMES are inferred from the portrait art. If an inferred name is wrong, the
// coach renders as a silhouette. This places three coaches wearing three
// unobserved heads (tones 8/7/6) so one look in Coach Central settles all 117.

const FranchiseFile = require('madden-franchise');
const { moveCoachCfbToMaddenTeam } = require('../lib/carousel');
const { safe, biggestTableByName } = require('../lib/saveIO');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-HEADTEST';

const open = (p) => FranchiseFile.create(p, { autoUnempty: true });

// Resolve by name only -- the real TeamIndex differs per save and passing a
// stale one used to silently place on the wrong team (fixed in findMaddenTeam).
const CASES = [
  { head: 'coachhead_M_0039_HS', tone: 8, team: 'Giants' },
  { head: 'coachhead_M_0110_HS', tone: 7, team: 'Bears' },
  { head: 'coachhead_M_0084_HS', tone: 6, team: 'Jets' },
];

(async () => {
  const cfbFile = await open(CFB);
  const cfbCoach = biggestTableByName(cfbFile, 'Coach');
  await cfbCoach.readRecords();

  const hcs = [];
  for (let i = 0; i < cfbCoach.records.length && hcs.length < CASES.length; i++) {
    const r = cfbCoach.records[i];
    if (!r || r.isEmpty) continue;
    if (safe(r, 'Position') !== 'HeadCoach' || !safe(r, 'Name')) continue;
    hcs.push({ row: i, name: safe(r, 'Name') });
  }
  if (hcs.length < CASES.length) throw new Error(`only found ${hcs.length} CFB head coaches`);

  let src = MADDEN;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const maddenFile = await open(src);
    const res = await moveCoachCfbToMaddenTeam({
      cfbFile,
      maddenFile,
      cfbCoachRowIndex: hcs[i].row,
      teamName: c.team,
      outputPath: OUT,
      config: { allowOffWindowHeadCoachHire: true, coachHeadAsset: c.head },
      log: () => {},
    });
    const a = res.appearanceReport;
    const inc = res.displacedIncumbent;
    const incDesc = inc ? `${inc.name} (row ${inc.row})` : '(vacant)';
    console.log(`${c.team.padEnd(7)} <- ${hcs[i].name.padEnd(20)} ${c.head}  tone ${c.tone}  `
      + `portrait ${a.portrait}  confirmedInSave=${a.headConfirmedInSave}`);
    console.log(`        catalog=${a.catalogSize} (in-save ${a.inSaveHeads}) pool=${a.poolSize}  `
      + `displaced ${incDesc}  destRow ${res.destRow}`);
    src = OUT; // chain so all three land in one save
  }
  console.log(`\nwrote ${OUT}`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
