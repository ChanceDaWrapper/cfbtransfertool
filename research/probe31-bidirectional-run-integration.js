// Integration check for the direction-aware lib/carousel/run.js -- both
// scanCoaches/scanMaddenCoaches and proposeMoves/commitMoves in both
// directions, against real saves. WRITES throwaway saves only, cleaned up
// at the end. Never touches the source saves in place.

const fs = require('fs');
const {
  scanCoaches, scanMaddenCoaches, proposeMoves, commitMoves,
} = require('../lib/carousel/run');

const CFB = require('../research/_saves').CFB_PATH;
const MADDEN = require('../research/_saves').MAD_PATH;
const OUT_MADDEN = MADDEN + '-BIDIR-TEST';
const OUT_CFB = CFB + '-BIDIR-TEST';

let failures = 0;
function check(label, cond) { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`); if (!cond) failures++; }

(async () => {
  console.log('=== scanMaddenCoaches ===');
  const madScan = await scanMaddenCoaches(MADDEN);
  check('found Madden coaches', madScan.coaches.length > 0);
  check('counts add up', madScan.counts.HeadCoach + madScan.counts.OffensiveCoordinator + madScan.counts.DefensiveCoordinator === madScan.coaches.length);
  check('tone accounting adds up', madScan.counts.toneKnown + madScan.counts.toneGuessed === madScan.coaches.length);
  console.log(`  ${madScan.coaches.length} coaches, ${madScan.counts.toneKnown} known tone, ${madScan.counts.toneGuessed} guessed`);
  const maddenHC = madScan.coaches.find((c) => c.position === 'HeadCoach' && c.level > 20);

  console.log('\n=== proposeMoves direction:maddenToCfb, AUTO mode ===');
  // This used to throw ("auto-propose not built for this direction"). It now
  // works: movement.js's scoreCfbJobVulnerability reads CFB's own
  // CurrentJobSecurityPercentage to find the jobs most likely to open, and
  // proposeCarousel pairs available NFL coaches to them.
  const autoPlan = await proposeMoves({
    direction: 'maddenToCfb', cfbPath: CFB, maddenPath: MADDEN,
    config: { allowOffWindowHeadCoachHire: true, maxProposalsPerDirection: 6 }, log: () => {},
  });
  check('auto mode produced a plan', Array.isArray(autoPlan.plan) && autoPlan.plan.length > 0);
  check('auto-proposed rows carry a real destination school', autoPlan.plan.every((r) => !!r.toTeam));
  check('auto-proposed rows carry the movement engine\'s reasoning (not "manually selected")',
    autoPlan.plan.every((r) => r.why && r.why !== 'manually selected'));
  check('summary counts add up', autoPlan.summary.included + autoPlan.summary.blocked === autoPlan.summary.total);
  console.log(`  ${autoPlan.summary.total} proposed, ${autoPlan.summary.included} ready, ${autoPlan.summary.blocked} blocked`);
  for (const r of autoPlan.plan.slice(0, 3)) console.log(`    ${r.coach} -> ${r.toTeam} ${r.position}`);

  console.log('\n=== proposeMoves direction:maddenToCfb, manual mode ===');
  const maddenPlan = await proposeMoves({
    direction: 'maddenToCfb', cfbPath: CFB, maddenPath: MADDEN,
    config: { mode: 'manual', moves: [{ sourceRow: maddenHC.row, teamName: 'Wisconsin' }], allowOffWindowHeadCoachHire: true },
    log: () => {},
  });
  check('plan has exactly one row', maddenPlan.plan.length === 1);
  check('direction echoed back', maddenPlan.direction === 'maddenToCfb');
  const mRow = maddenPlan.plan[0];
  check('not blocked', !mRow.blocked);
  check('resolved to Wisconsin', mRow.toTeam === 'Wisconsin');
  console.log(`  ${mRow.coach} -> ${mRow.toTeam} ${mRow.position}, displaces ${mRow.displaces ? mRow.displaces.name : '(vacant)'}, tone=${mRow.tone}${mRow.toneWasGuessed ? '(guessed)' : ''}`);

  console.log('\n=== commitMoves direction:maddenToCfb ===');
  try { fs.rmSync(OUT_CFB); } catch (e) { /* fine */ }
  const maddenCommit = await commitMoves({
    direction: 'maddenToCfb', plan: maddenPlan.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: OUT_CFB,
    config: { allowOffWindowHeadCoachHire: true }, log: () => {},
  });
  check('wrote one coach', maddenCommit.written === 1);
  check('output CFB save created', fs.existsSync(OUT_CFB));
  check('appearance report present', !!maddenCommit.results[0].appearanceReport);
  console.log(`  wrote ${maddenCommit.written} coach(es) -> ${maddenCommit.outputPath}`);
  fs.rmSync(OUT_CFB);

  console.log('\n=== scanCoaches (forward direction, unchanged) ===');
  const cfbScan = await scanCoaches(CFB);
  check('found CFB coaches', cfbScan.coaches.length > 0);
  const freeman = cfbScan.coaches.find((c) => c.head === 'Unique_C_FreemanMarcus_659');

  console.log('\n=== proposeMoves direction:cfbToMadden, manual mode (field renamed cfbRow -> sourceRow) ===');
  const cfbPlan = await proposeMoves({
    direction: 'cfbToMadden', cfbPath: CFB, maddenPath: MADDEN,
    config: { mode: 'manual', moves: [{ sourceRow: freeman.row, teamName: 'Giants' }], allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: () => {},
  });
  check('plan has exactly one row', cfbPlan.plan.length === 1);
  check('direction echoed back', cfbPlan.direction === 'cfbToMadden');
  check('uses sourceRow field (not cfbRow)', typeof cfbPlan.plan[0].sourceRow === 'number' && cfbPlan.plan[0].cfbRow === undefined);
  check('resolved to Giants', cfbPlan.plan[0].toTeam === 'Giants');

  console.log('\n=== commitMoves direction:cfbToMadden (default, backward compatible) ===');
  try { fs.rmSync(OUT_MADDEN); } catch (e) { /* fine */ }
  const cfbCommit = await commitMoves({
    plan: cfbPlan.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: OUT_MADDEN, // direction omitted -- defaults to cfbToMadden
    config: { allowOffWindowHeadCoachHire: true, coachSkinTone: 7 }, log: () => {},
  });
  check('wrote one coach (default direction)', cfbCommit.written === 1);
  check('output Madden save created', fs.existsSync(OUT_MADDEN));
  fs.rmSync(OUT_MADDEN);

  console.log(`\n${'='.repeat(60)}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });
