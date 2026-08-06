// Integration check for lib/carousel/run.js against REAL saves -- the full
// orchestration path (scanCoaches -> proposeMoves -> commitMoves) that
// test/carouselRun.spec.js deliberately does NOT cover (see its own header:
// this project's test/*.spec.js are fixture-only; full-orchestration paths
// get validated against real saves here, same as planTeamPlacement's own
// history via probe21/26/27).
//
// WRITES a throwaway save (CAREER-RUNTEST), verifies it, then deletes it.
// Never touches the source saves in place.

const fs = require('fs');
const { scanCoaches, proposeMoves, commitMoves } = require('../lib/carousel/run');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-RUNTEST';

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

(async () => {
  console.log('=== scanCoaches ===');
  const scan = await scanCoaches(CFB);
  check('found coaches', scan.coaches.length > 0);
  check('counts add up (HC+OC+DC = total)',
    scan.counts.HeadCoach + scan.counts.OffensiveCoordinator + scan.counts.DefensiveCoordinator === scan.coaches.length);
  check('tone accounting adds up', scan.counts.toneKnown + scan.counts.toneGuessed === scan.coaches.length);
  const freeman = scan.coaches.find((c) => c.head === 'Unique_C_FreemanMarcus_659');
  check('Freeman is present and correctly flagged as tone-guessed (no override shipped)', !!freeman && freeman.toneWasGuessed === true);
  console.log(`  ${scan.coaches.length} coaches, ${scan.counts.toneKnown} known tone, ${scan.counts.toneGuessed} guessed`);

  console.log('\n=== proposeMoves (auto mode) ===');
  const autoLog = [];
  const auto = await proposeMoves({ cfbPath: CFB, maddenPath: MADDEN, config: {}, log: (m) => autoLog.push(m) });
  check('auto mode produced a plan', Array.isArray(auto.plan));
  check('summary counts add up', auto.summary.included + auto.summary.blocked === auto.summary.total);
  check('logged something', autoLog.length > 0);
  console.log(`  ${auto.summary.total} proposed, ${auto.summary.included} ready, ${auto.summary.blocked} blocked, `
    + `${auto.summary.toneGuessed} tone-guessed, visuals free=${auto.summary.visualsFree}`);
  for (const row of auto.plan.slice(0, 3)) {
    console.log(`    ${row.coach} (${row.fromSchool}) -> ${row.toTeam} ${row.position}`
      + (row.blocked ? `  BLOCKED: ${row.blocked}` : `  tone=${row.tone}${row.toneWasGuessed ? '(guessed)' : ''}`));
  }

  console.log('\n=== proposeMoves (manual mode) ===');
  // Manual mode: caller picks the coach and destination directly, bypassing
  // the movement engine. Move Freeman onto the Giants, exactly the scenario
  // COACH_FIDELITY_ROADMAP.md's face/tone work was built and verified around.
  const manualLog = [];
  const manual = await proposeMoves({
    cfbPath: CFB, maddenPath: MADDEN,
    // `sourceRow`, not `cfbRow` -- the plan/move shape was renamed when the
    // reverse direction landed, so one field name works for either direction
    // ("the row in whichever save the coach is coming FROM").
    config: { mode: 'manual', moves: [{ sourceRow: freeman.row, teamName: 'Giants' }], allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: (m) => manualLog.push(m),
  });
  check('manual mode produced exactly one plan row', manual.plan.length === 1);
  const freemanRow = manual.plan[0];
  check('resolved to the Giants', freemanRow.toTeam === 'Giants');
  check('not blocked (override lets HC hire bypass the timing gate)', !freemanRow.blocked);
  check('explicit coachSkinTone wins -- not marked guessed', freemanRow.tone === 7 && freemanRow.toneWasGuessed === false);
  console.log(`  ${freemanRow.coach} -> ${freemanRow.toTeam} ${freemanRow.position}, displaces `
    + `${freemanRow.displaces ? freemanRow.displaces.name : '(vacant)'}, tone=${freemanRow.tone}`);

  console.log('\n=== commitMoves ===');
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* fine if it didn't exist */ }
  const commitLog = [];
  const committed = await commitMoves({
    plan: manual.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: OUT,
    config: { allowOffWindowHeadCoachHire: true, coachSkinTone: 7 },
    log: (m) => commitLog.push(m),
  });
  check('wrote one coach', committed.written === 1);
  check('output path matches', committed.outputPath === OUT);
  check('output save was actually created', fs.existsSync(OUT));
  check('result reports an appearance (a head was granted)', !!committed.results[0].appearanceReport);
  check('result reports the granted head at tone 7 exactly', committed.results[0].appearanceReport.mappedTone === 7);
  console.log(`  wrote ${committed.written} coach(es) -> ${committed.outputPath}`);
  console.log(`  head: ${committed.results[0].appearanceReport.head} (${committed.results[0].appearanceReport.selection})`);

  console.log('\n=== commitMoves refuses in-place writes ===');
  let threw = false;
  try { await commitMoves({ plan: manual.plan, cfbPath: CFB, maddenPath: MADDEN, outputPath: null }); } catch (e) { threw = /outputPath is required/.test(e.message); }
  check('throws without an outputPath', threw);

  try { fs.rmSync(OUT, { recursive: true, force: true }); console.log('\ncleaned up CAREER-RUNTEST.'); } catch (e) { /* best effort */ }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
