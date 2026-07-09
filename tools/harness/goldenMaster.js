// Rosetta migration safety harness. Not a production feature.
//
// capture: runs the full legacy pipeline (extract -> calibrate -> dev
//   traits) on a fixed save + fixed seed and freezes the result as the
//   regression baseline every future phase diffs against.
// verify:  re-runs the SAME legacy path and asserts byte-identical output --
//   proves a phase hasn't perturbed the legacy engine at all.
// diagnose: runs population-only in BOTH modes ('legacy' and 'exit') and
//   prints a side-by-side summary -- the tool for eyeballing Phase 1's
//   effect (transfer exclusion, senior counts, regime detected) on a real
//   save without touching a Madden file.
//
// Usage:
//   node tools/harness/goldenMaster.js capture <cfbSavePath>
//   node tools/harness/goldenMaster.js verify <cfbSavePath>
//   node tools/harness/goldenMaster.js diagnose <cfbSavePath>

const fs = require('fs');
const path = require('path');
const { extractLeavingPlayers, calibratePlayers, assignDevTraits } = require('../../lib/pipeline');

const BASELINE_PATH = path.join(__dirname, 'golden-master.json');
const FIXED_SEED = 'rosetta-harness-fixed-seed';

async function runLegacy(cfbSavePath) {
  const rows = await extractLeavingPlayers(cfbSavePath, () => {}, { populationMode: 'legacy' });
  const players = calibratePlayers(rows, { config: { general: { seed: FIXED_SEED } } });
  const dev = assignDevTraits(players, { general: { seed: FIXED_SEED } });
  for (const p of players) p.DevTrait = dev.get(p);
  return players;
}

function stableStringify(players) {
  // CareerStats/Combine are plain objects with a fixed key order per row
  // already (built the same way every time), so JSON.stringify is
  // deterministic here without needing a custom key-sorter.
  return JSON.stringify(players);
}

async function capture(cfbSavePath) {
  const players = await runLegacy(cfbSavePath);
  fs.writeFileSync(BASELINE_PATH, stableStringify(players));
  console.log(`Captured golden master: ${players.length} players -> ${BASELINE_PATH}`);
}

async function verify(cfbSavePath) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('No golden master captured yet. Run `capture` first.');
    process.exit(1);
  }
  const baseline = fs.readFileSync(BASELINE_PATH, 'utf-8');
  const players = await runLegacy(cfbSavePath);
  const current = stableStringify(players);
  if (current === baseline) {
    console.log(`PASS -- legacy output unchanged (${players.length} players, byte-identical).`);
  } else {
    console.error('FAIL -- legacy output diverged from the golden master.');
    const base = JSON.parse(baseline);
    const cur = JSON.parse(current);
    if (base.length !== cur.length) {
      console.error(`  player count differs: baseline=${base.length} current=${cur.length}`);
    } else {
      let diffs = 0;
      for (let i = 0; i < base.length; i++) {
        const a = JSON.stringify(base[i]), b = JSON.stringify(cur[i]);
        if (a !== b) { diffs++; if (diffs <= 5) console.error(`  row ${i} (${base[i].FirstName} ${base[i].LastName}) differs`); }
      }
      console.error(`  ${diffs} of ${base.length} rows differ.`);
    }
    process.exit(1);
  }
}

async function diagnose(cfbSavePath) {
  console.log('--- legacy mode ---');
  const legacyRows = await extractLeavingPlayers(cfbSavePath, (m) => console.log('  ' + m), { populationMode: 'legacy' });
  console.log(`  legacy: ${legacyRows.length} players, source=${legacyRows.source}`);

  console.log('--- exit mode ---');
  const exitRows = await extractLeavingPlayers(cfbSavePath, (m) => console.log('  ' + m), { populationMode: 'exit' });
  console.log(`  exit: ${exitRows.length} players, source=${exitRows.source}`);

  const legacyIds = new Set(legacyRows.map((r) => r.rowIndex));
  const exitIds = new Set(exitRows.map((r) => r.rowIndex));
  const onlyLegacy = [...legacyIds].filter((id) => !exitIds.has(id));
  const onlyExit = [...exitIds].filter((id) => !legacyIds.has(id));
  console.log(`--- diff --- only-in-legacy: ${onlyLegacy.length} | only-in-exit: ${onlyExit.length} | shared: ${[...legacyIds].filter((id) => exitIds.has(id)).length}`);
}

const [, , cmd, cfbSavePath] = process.argv;
if (!cmd || !cfbSavePath) {
  console.error('Usage: node tools/harness/goldenMaster.js <capture|verify|diagnose> <cfbSavePath>');
  process.exit(1);
}
const fn = { capture, verify, diagnose }[cmd];
if (!fn) { console.error(`Unknown command: ${cmd}`); process.exit(1); }
fn(cfbSavePath).catch((e) => { console.error('FAILED:', e); process.exit(1); });
