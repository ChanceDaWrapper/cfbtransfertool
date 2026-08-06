// WRITES A SAVE (to a throwaway copy only -- never the original).
//
// The decisive test for the talent-chain allocation fix: can a coach ACTUALLY
// be placed into a CFB save that had ZERO usable landing slots?
//
// DYNASTY-COACHTEST measured 0 usable rows under the old rules (45 free agents,
// none qualifying; 132 empty Coach rows, 0 pre-wired with a talent chain), so
// every proposed move failed with "no disposable Coach row available". If the
// fix works, a coach lands on a freshly-built chain and survives a full
// close-and-reopen.
//
// Verifies, after reopening the OUTPUT file cold (no in-memory state):
//   1. the coach's identity fields are really there
//   2. they own an ActiveTalentTree chain that RESOLVES (not a dangling ref)
//   3. that chain carries real talent VALUES, not an allocated-but-empty shell
//      -- the silent failure mode this whole module exists to prevent
//   4. the school's own slot points back at the coach (both pointers agree)
//
// Run: node research/probe43-cfb-alloc-writetest.js

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');
const { moveCoachMaddenToCfbTeam } = require('../lib/carousel/index');
const { readOwnTalentChain } = require('../lib/carousel/cfbTalentTree');
const { countDisposableCfbSlots } = require('../lib/carousel/placeOnCfbTeam');

const HOME = require('os').homedir();
const CFB_SRC = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-COACHTEST');
const MAD = process.env.MAD_SAVE
  || path.join(HOME, 'Documents', 'Madden NFL 26', 'Saves', 'CAREER-JUL06-10h10m34a-AUTOSAVE');
const OUT = path.join(require('os').tmpdir(), 'DYNASTY-ALLOCTEST');
const SCHEMA = path.join(__dirname, '..', 'data', 'schemas', 'CFB27_809_0.gz');
const TARGET_SCHOOL = process.env.SCHOOL || 'Georgia';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!cond) failures++;
};

const openCfbAt = async (p) => {
  const f = await FranchiseFile.create(p, {
    schemaOverride: { major: 809, minor: 0, gameYear: 27, path: SCHEMA },
    gameYearOverride: 27,
  });
  await new Promise((res, rej) => { if (f.isLoaded) res(); else { f.on('ready', res); f.on('error', rej); } });
  return f;
};

(async () => {
  console.log(`source CFB save : ${CFB_SRC}`);
  console.log(`output (scratch): ${OUT}\n`);

  const cfbFile = await openCfbAt(CFB_SRC);
  const { maddenFile } = await openMaddenSave(MAD);

  // Confirm the premise: this save really is the 0-slot case under old rules.
  const withAlloc = await countDisposableCfbSlots(cfbFile);
  console.log('########## premise ##########');
  check('the widened tier gives this save real landing slots', withAlloc > 0, `slots=${withAlloc}`);

  // Pick a real Madden head coach to move.
  const mt = biggestTableByName(maddenFile, 'Coach');
  await mt.readRecords();
  const src = mt.records.find((r) => !r.isEmpty && safe(r, 'Position') === 'HeadCoach'
    && safe(r, 'Level') > 0 && safe(r, 'Name'));
  if (!src) { console.log('no Madden head coach found -- cannot run.'); process.exit(1); }
  console.log(`\n########## moving ${safe(src, 'Name')} (L${safe(src, 'Level')}) -> ${TARGET_SCHOOL} ##########`);

  const res = await moveCoachMaddenToCfbTeam({
    cfbFile, maddenFile, maddenCoachRowIndex: src.index,
    teamName: TARGET_SCHOOL, outputPath: OUT,
    config: { allowOffWindowHeadCoachHire: true }, // the window gate is a separate concern
    log: (m) => console.log(`    ${m}`),
  });
  const destRow = res.destRow;
  check('the move completed without throwing', true);
  check('a real talent tree was copied in (not skipped)',
    !!res.talentReport && !res.talentReport.skipped && res.talentReport.subtreesCopied > 0,
    res.talentReport ? `${res.talentReport.subtreesCopied} subtrees, ${res.talentReport.totalSpent} pts` : 'no report');

  // ===== reopen the OUTPUT cold and verify everything persisted =====
  console.log('\n########## reopening the written save cold ##########');
  const reopened = await openCfbAt(OUT);
  const rt = biggestTableByName(reopened, 'Coach');
  await rt.readRecords();
  const landed = rt.records[destRow];

  check('the destination row is a live, non-empty record', !!landed && !landed.isEmpty);
  check('name persisted', !!safe(landed, 'Name'), `Name=${safe(landed, 'Name')}`);
  check('level persisted', (safe(landed, 'Level') || 0) > 0, `Level=${safe(landed, 'Level')}`);
  check('position persisted', safe(landed, 'Position') === 'HeadCoach', `Position=${safe(landed, 'Position')}`);

  // The whole point: a real, resolvable, POPULATED chain.
  const chain = await readOwnTalentChain(reopened, landed);
  check('the allocated talent chain resolves after a cold reopen', !!chain);
  if (chain) {
    const populated = chain.leaves.filter(Boolean).length;
    check('the chain has subtree leaves wired up', populated > 0, `${populated} leaves`);
    let spent = 0, owned = 0;
    for (const leaf of chain.leaves) {
      if (!leaf) continue;
      spent += safe(leaf, 'CoachPointsSpent') || 0;
      for (let j = 0; j < 33; j++) if (safe(leaf, `TalentStatus${j}`) === 'Owned') owned++;
    }
    // An allocated-but-never-filled chain would show 0/0 here -- the exact
    // "Level 1 / no abilities" shell the guard exists to prevent.
    check('the chain carries REAL talent values, not an empty shell', spent > 0 || owned > 0,
      `CoachPointsSpent total=${spent}, Owned talents=${owned}`);
  }

  // Both pointers must agree (the Jets/Commanders lesson).
  const teamT = biggestTableByName(reopened, 'Team');
  await teamT.readRecords();
  const school = teamT.records.find((r) => !r.isEmpty && safe(r, 'DisplayName') === TARGET_SCHOOL);
  let slotRow = null;
  if (school) {
    try { const ref = school.getReferenceDataByKey('HeadCoach'); slotRow = ref ? ref.rowNumber : null; } catch (e) { slotRow = null; }
  }
  check('the school\'s HeadCoach slot points back at the new coach', slotRow === destRow,
    `slot=${slotRow} destRow=${destRow}`);
  check('and the coach points back at the school', safe(landed, 'TeamIndex') === res.teamIndex,
    `TeamIndex=${safe(landed, 'TeamIndex')}`);

  try { fs.unlinkSync(OUT); console.log('\n(scratch output deleted)'); } catch (e) { /* leave it */ }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
