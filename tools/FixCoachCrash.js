// Standalone repair tool -- drag a CFB dynasty save onto this .exe and it
// fixes the "crashes on advance after a Madden transfer" bug in place (well,
// not literally in place -- it always writes a new file next to the
// original; your original save is never touched or overwritten).
//
// Bundled as a single .exe via `pkg` (see package.json's `pkg` config and
// the `build:fixtool` script) so it runs on a machine with no Node.js
// installed -- this is meant to be handed to a user directly, not run from
// a checkout.
//
// Reuses the exact same detection/repair logic as tools/repairTransferredCoaches.js
// and the engine itself (lib/carousel/cfbEmploymentRecords.js,
// lib/carousel/cfbNormalize.js, lib/carousel/cfbContractOffers.js) -- this is
// a friendlier front end, not a separate implementation.
//
// Usage: drag a CFB dynasty save file onto FixCoachCrash.exe. A console
// window opens, reports what it found, and (if there was damage) writes
// "<your save>-FIXED" next to the original.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');
const { attachCfbEmploymentRecords } = require('../lib/carousel/cfbEmploymentRecords');
const {
  findDamagedCoaches, employedPeersByPosition, buildEmploymentProfile, applyEmploymentProfile,
} = require('../lib/carousel/cfbNormalize');
const { fixStaleContractOffers } = require('../lib/carousel/cfbContractOffers');
const { findRankProblems, repairJobSecurityRanks } = require('../lib/carousel/cfbJobSecurityRank');
const { inspectCfbSave, formatRefusal } = require('../lib/carousel/preflight');
const { saveAs } = require('../lib/carousel/write');

// Holds the window open just long enough to read the result, then closes it
// on its own -- no keypress needed. An earlier version waited for Enter via
// `cmd /c pause`, which worked but meant the window sat there forever until
// someone dismissed it; auto-closing is what was actually wanted. A visible
// countdown (not a silent sleep) still gives a moment to read the outcome,
// and to Ctrl+C out if you want the window to stay for some reason.
function autoClose(seconds = 6) {
  return new Promise((resolve) => {
    let remaining = seconds;
    process.stdout.write(`\nClosing in ${remaining}...`);
    const tick = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        process.stdout.write(`\rClosing in ${remaining}...   `);
      } else {
        clearInterval(tick);
        process.stdout.write('\r' + ' '.repeat(20) + '\r');
        resolve();
      }
    }, 1000);
  });
}

// The whole repair (open a ~10MB save, scan it, write a new one) finishes in
// well under a second -- faster than the console window even finishes
// rendering. Without these pauses every line prints before the window is
// visible, so all you ever see is the tail end (the closing countdown),
// looking like the tool "already finished when it's opening." These delays
// exist purely so the progress lines are readable, not for correctness.
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Most people just double-click a .exe rather than dragging a file onto its
// icon, so a plain double-click needs to lead somewhere other than "read two
// lines of instructions and close" -- it asks for the path instead.
function promptForPath(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().replace(/^"(.*)"$/, '$1'));
    });
  });
}

function uniqueOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  let candidate = path.join(dir, `${base}-FIXED`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-FIXED-${n}`);
    n++;
  }
  return candidate;
}

async function main() {
  console.log('='.repeat(64));
  console.log('  Coach Transfer Crash Fixer');
  console.log('='.repeat(64));

  let savePath = process.argv[2];
  if (!savePath) {
    console.log('\nThis tool fixes CFB 27 dynasty saves that crash when advancing');
    console.log('past bowl week after transferring a coach in from Madden.');
    console.log('\n(Tip: dragging your save file onto this .exe icon skips this step.)');
    console.log('The file is usually in Documents\\EA SPORTS College Football 27\\saves.');
    savePath = await promptForPath('\nPaste the path to your save file (or press Enter to quit): ');
    if (!savePath) {
      await autoClose();
      return;
    }
  }

  if (!fs.existsSync(savePath)) {
    console.log(`\nCould not find that file:\n  ${savePath}`);
    await autoClose();
    return;
  }

  console.log(`\nSave: ${savePath}`);
  console.log('Opening...');
  await pause(500);

  let cfbFile;
  try {
    ({ cfbFile } = await openCfbSave(savePath));
  } catch (e) {
    console.log(`\nCould not open this as a CFB 27 dynasty save:\n  ${e.message}`);
    await autoClose();
    return;
  }

  // Structural pre-flight before touching anything. This tool exists to RESCUE
  // a broken dynasty, so the one thing it must never do is damage one further
  // by repairing against a save whose shape it doesn't recognise.
  const structure = inspectCfbSave(cfbFile);
  if (!structure.ok) {
    console.log('');
    console.log(formatRefusal(structure, { what: 'this save' }).replace(/^Cannot safely transfer coaches into/, 'Cannot safely repair'));
    await autoClose(12);
    return;
  }
  for (const w of structure.warnings) console.log(`  NOTE: ${w}`);

  const coachT = biggestTableByName(cfbFile, 'Coach');
  const teamT = biggestTableByName(cfbFile, 'Team');
  await coachT.readRecords();
  await teamT.readRecords();

  // TWO independent faults, either of which alone breaks a save. They are
  // checked separately because they do NOT travel together: the save that would
  // not load had a perfectly clean contract-expectation check and was broken
  // purely by the ranking. An earlier version of this tool bailed out the moment
  // the first check came back empty, which is exactly why it reported "no
  // damaged coaches found" on a dynasty that was plainly damaged.
  const damaged = findDamagedCoaches(coachT.records);
  const rankProblems = findRankProblems(coachT.records);

  if (!damaged.length && rankProblems.ok) {
    console.log('\nGood news -- this save passes both checks:');
    console.log('  - no coach is carrying a free-agent contract goal while employed');
    console.log('  - the league job-security ranking is complete and unique');
    console.log('\nIf it still crashes or will not load, the cause is something else');
    console.log('and this tool cannot help.');
    await autoClose();
    return;
  }

  if (damaged.length) {
    console.log(`\nFound ${damaged.length} coach(es) carrying a free-agent contract goal while employed:`);
    for (const r of damaged) {
      const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
      console.log(`  - ${safe(r, 'Name')} (${safe(r, 'Position')}, ${team ? safe(team, 'DisplayName') : '?'})`);
      await pause(200);
    }
  }

  if (!rankProblems.ok) {
    console.log(`\nThe league job-security ranking is broken -- this is what makes a dynasty`);
    console.log('load forever instead of crashing:');
    console.log(`  - ${rankProblems.offenders.length} coach(es) hold a rank outside 1-${rankProblems.n}, or share one`);
    console.log(`  - ${rankProblems.missing.length} rank(s) belong to nobody: ${rankProblems.missing.slice(0, 12).join(', ')}${rankProblems.missing.length > 12 ? ', ...' : ''}`);
    for (const r of rankProblems.offenders.slice(0, 8)) {
      const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
      console.log(`      ${safe(r, 'Name')} (${safe(r, 'Position')}, ${team ? safe(team, 'DisplayName') : '?'}) has rank ${safe(r, 'CurrentJobSecurityPercentageRank')}`);
    }
    await pause(400);
  }

  await pause(500);
  console.log('\nRepairing...');
  await pause(400);
  const damagedRows = damaged.map((d) => d.index);
  const byPos = employedPeersByPosition(coachT.records, { excludeRows: damagedRows });
  const profiles = new Map();
  for (const [pos, peers] of byPos) profiles.set(pos, buildEmploymentProfile(peers));

  let repaired = 0;
  const failed = [];
  for (const r of damaged) {
    const team = teamT.records.find((x) => !x.isEmpty && safe(x, 'TeamIndex') === safe(r, 'TeamIndex'));
    try {
      await attachCfbEmploymentRecords(cfbFile, r, {
        teamRecord: team || null,
        incumbent: null,
        excludeRows: damagedRows.filter((i) => i !== r.index),
      });
      applyEmploymentProfile(r, profiles.get(safe(r, 'Position')));
      console.log(`  fixed: ${safe(r, 'Name')}`);
      repaired++;
    } catch (e) {
      console.log(`  COULD NOT FIX ${safe(r, 'Name')}: ${e.message}`);
      failed.push(safe(r, 'Name'));
    }
    await pause(250);
  }

  const offerFixes = await fixStaleContractOffers(cfbFile, { coachRows: damagedRows });
  if (offerFixes.length) console.log(`  fixed ${offerFixes.length} leftover contract offer(s)`);

  // The ranking repair runs LAST, after any coach above has been put back into
  // a proper employed state -- findRankProblems counts who is employed, so
  // repairing employment first is what makes the rank arithmetic correct.
  if (!rankProblems.ok) {
    const rankFix = await repairJobSecurityRanks(cfbFile, { coachRecords: coachT.records });
    for (const f of rankFix.repaired) console.log(`  job-security rank: ${f.name} ${f.from} -> ${f.to}`);
    if (rankFix.cleared.length) console.log(`  cleared ${rankFix.cleared.length} departed coach(es) off a rank that now belongs to someone else`);
    repaired += rankFix.repaired.length;
    if (rankFix.shortfall > 0) {
      console.log(`  WARNING: ${rankFix.shortfall} coach(es) still hold an invalid rank (no free rank left to give them)`);
      failed.push(`${rankFix.shortfall} unresolved rank(s)`);
    }
    await pause(400);
  }

  if (!repaired) {
    console.log('\nNothing could be repaired -- no file was written.');
    await autoClose();
    return;
  }

  // Refuse to write a HALF-repaired save. Writing one and calling it "Done"
  // would hand back a file in a state neither the original damage nor a clean
  // repair produces, and the user would reasonably believe it was fixed.
  if (failed.length) {
    console.log(`\nSTOPPING -- ${failed.length} problem(s) could not be repaired:`);
    for (const f of failed) console.log(`   - ${f}`);
    console.log('\nNO FILE WAS WRITTEN. Your original save is untouched. A partly-repaired');
    console.log('save would look fixed and still fail, so this tool will not produce one.');
    console.log('Please send this save to the developer -- it has a fault the tool does not know.');
    await autoClose(10);
    return;
  }

  await pause(400);
  console.log('\nWriting repaired save...');
  const outPath = uniqueOutputPath(savePath);
  await saveAs(cfbFile, outPath);
  await pause(400);
  console.log(`\nDone. Repaired save written to:\n  ${outPath}`);
  console.log('\nYour original save was NOT changed. Load the new file in CFB 27 and');
  console.log('try advancing again.');
  await pause(1500);
  await autoClose();
}

main().catch(async (e) => {
  console.log(`\nSomething went wrong: ${e.stack || e.message}`);
  await autoClose();
  process.exitCode = 1;
});
