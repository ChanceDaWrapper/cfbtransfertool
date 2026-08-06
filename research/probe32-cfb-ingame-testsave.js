// Builds the in-game verification save for the Madden -> CFB direction --
// the reverse-direction equivalent of the Freeman/Anthony/Aranda/Archer
// screenshots that validated CFB -> Madden.
//
// WRITES to a NEW save (DYNASTY-COACHTEST) built from DYNASTY-DATATESTYEAR1-TEST.
// The base save is never modified, and the Madden save is read-only throughout.
//
// DESIGNED FOR AN UNAMBIGUOUS TONE CHECK. The three sources were picked for
// their MEASURED tones (data/coachHeadTones.json), deliberately spread as far
// apart as the Madden save allows, so a human looking at the result can tell
// instantly whether tone matching worked:
//
//   T. Peters   tone 8  (darkest available; independently confirmed
//                        "observed clearly dark in-game" during the forward
//                        direction's own head-catalog work, asset 0097)
//   D. Menard   tone 6  (mid-dark)
//   E. Ortega   tone 1  (lightest available, asset 0111)
//
// If tone matching works, Florida's new HC should read clearly dark and
// Clemson's clearly light. If every coach comes out looking the same, tone
// matching is broken regardless of what the field data says.
//
// The head-coach timing gate is deliberately NOT overridden: DATATESTYEAR1-TEST
// sits in CFB's real carousel window (IsCarouselPeriodActive), so this also
// exercises the corrected timing.js end to end on a live save.

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName, openMaddenSave } = require('../lib/saveIO');
const { buildCarouselModels } = require('../lib/carousel/map');
const { moveCoachMaddenToCfbTeam } = require('../lib/carousel');
const { loadToneMap, headNumber, cfbSkinTone } = require('../lib/carousel/appearance');
const timing = require('../lib/carousel/timing');

const CFB_DIR = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves';
const BASE = `${CFB_DIR}/DYNASTY-DATATESTYEAR1-TEST`;
const OUT = `${CFB_DIR}/DYNASTY-COACHTEST`;
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const SCHEMA = path.join(__dirname, '..', 'data', 'schemas', 'CFB27_809_0.gz');

// Chosen for tone spread, at the highest-scoring openings available.
const CASES = [
  { coach: 'T. Peters', school: 'Florida', expectTone: 8, note: 'darkest' },
  { coach: 'D. Menard', school: 'Kentucky', expectTone: 6, note: 'mid-dark' },
  { coach: 'E. Ortega', school: 'Clemson', expectTone: 1, note: 'lightest' },
];

const openCfb = async (p) => {
  const f = await FranchiseFile.create(p, {
    schemaOverride: { major: 809, minor: 0, gameYear: 27, path: SCHEMA }, gameYearOverride: 27, autoUnempty: true,
  });
  await new Promise((res, rej) => { if (f.isLoaded) res(); else { f.on('ready', res); f.on('error', rej); } });
  return f;
};

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

(async () => {
  try { fs.rmSync(OUT); } catch (e) { /* fine */ }

  console.log('=== timing gate (NOT overridden -- this save should be in the window) ===');
  const probe = await openCfb(BASE);
  const si = await timing.readSeasonInfo(probe);
  console.log(`  ${si.currentStage} wk${si.currentWeek} / ${si.currentWeekType}, carousel active: ${si.isCarouselPeriodActive}`);
  check('CFB carousel window is open, so HC hires are legitimately allowed', timing.isCoachHiringWindow(si));
  console.log(`  describeWindow: ${timing.describeWindow(si)}`);

  const toneMap = loadToneMap();
  const { maddenFile: madProbe } = await openMaddenSave(MADDEN);
  const mt = biggestTableByName(madProbe, 'Coach');
  await mt.readRecords();
  const rowOf = {};
  for (const r of mt.records) {
    if (r.isEmpty) continue;
    const n = safe(r, 'Name');
    if (CASES.some((c) => c.coach === n)) {
      rowOf[n] = { row: r.index, head: safe(r, 'GenericHeadAssetName'), level: safe(r, 'Level') };
    }
  }

  console.log('\n=== placing ===');
  let src = BASE;
  const placed = [];
  for (const c of CASES) {
    const info = rowOf[c.coach];
    if (!info) { check(`found ${c.coach} in the Madden save`, false); continue; }
    const srcTone = toneMap.get(headNumber(info.head));

    const cfbFile = await openCfb(src);
    const { maddenFile } = await openMaddenSave(MADDEN);
    const res = await moveCoachMaddenToCfbTeam({
      cfbFile, maddenFile, maddenCoachRowIndex: info.row,
      teamName: c.school, outputPath: OUT,
      config: {}, // NO allowOffWindowHeadCoachHire -- the real window is open
      log: () => {},
    });
    const cfbHead = res.appearanceReport.head;
    const landedTone = cfbSkinTone(cfbHead);
    console.log(`  ${c.coach} (Madden ${info.head}, tone ${srcTone}) -> ${c.school}`);
    console.log(`      CFB head ${cfbHead} -> encoded tone ${landedTone}   [${res.appearanceReport.selection}]`);
    console.log(`      displaced ${res.displacedIncumbent ? res.displacedIncumbent.name : '(vacant)'}, dest row ${res.destRow}`);
    check(`${c.coach}: landed tone matches the Madden source tone (${srcTone})`, landedTone === srcTone);
    placed.push({ ...c, destRow: res.destRow, teamIndex: res.teamIndex, cfbHead, landedTone, srcTone });
    src = OUT;
  }

  console.log('\n=== verifying the written save ===');
  const out = await openCfb(OUT);
  const ct = biggestTableByName(out, 'Coach'); await ct.readRecords();
  const tt = biggestTableByName(out, 'Team'); await tt.readRecords();
  for (const p of placed) {
    const rec = ct.records[p.destRow];
    check(`${p.coach}: name+position survived the full chain`,
      safe(rec, 'Name') === p.coach && safe(rec, 'Position') === 'HeadCoach');
    const team = tt.records.find((t) => !t.isEmpty && safe(t, 'TeamIndex') === p.teamIndex);
    const ref = team.getReferenceDataByKey('HeadCoach');
    check(`${p.coach}: ${p.school}'s HeadCoach slot points at row ${p.destRow}`, ref && ref.rowNumber === p.destRow);
  }
  check('all three landed on distinct rows', new Set(placed.map((p) => p.destRow)).size === placed.length);

  console.log(`\n${'='.repeat(66)}`);
  console.log(failures === 0 ? 'ALL ENGINE CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  console.log(`\nSave written: ${OUT}`);
  console.log('\nWHAT TO LOOK AT IN CFB 27 (expect a clear light-to-dark spread):');
  for (const p of placed) {
    console.log(`  ${p.school.padEnd(10)} head coach = ${p.coach.padEnd(11)} -- expect tone ${p.landedTone}/8 (${p.note})`);
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });
