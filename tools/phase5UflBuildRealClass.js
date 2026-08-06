// UFL_ROADMAP.md Phase 5 -- light validation. NOT shipped -- a manual tool to
// produce real UFL CAREERDRAFT-* files from an actual CFB save, for import
// into Madden/the UFL mod so real in-game recomputed Overalls can be read
// back and compared against this app's own estimate (EstMaddenOverall).
//
// Builds one file per engine variant so both real UFL candidates can be
// checked in-game: Dice Roll (the roadmap's recommended default -- reaches
// 60s/70s natively) and Power Curve, both with and without the optional
// Phase 4 top-up. Every config value here matches this app's own shipped
// defaults (lib/defaults.js) -- nothing tuned specially for this probe.
//
// Usage: node tools/phase5UflBuildRealClass.js [path-to-a-real-CFB27-dynasty-save]
// (defaults to the project's usual verification save if omitted)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractLeavingPlayers, generateClass } = require('../lib/pipeline');
const { buildDraftClassFile } = require('../lib/draftClassExporter');

const DEFAULT_SAVE = 'C:/Users/tripl/Desktop/Chance/Modding File Saves/DYNASTY-DRAFTSTAGE';

// Both engines at their SHIPPED defaults (the UFL overall boost is on by
// default now, for both), plus one unboosted build so the readback can show
// how much of the final band is the boost versus the base conversion.
const VARIANTS = [
  { label: 'diceroll', strategy: 'diceroll', ufl: {} },
  { label: 'powercurve', strategy: 'powercurve', ufl: {} },
  { label: 'diceroll-unboosted', strategy: 'diceroll', ufl: { overallBoostEnabled: false } },
];

function band(rows) {
  const ovrs = rows.map((r) => Number(r.EstMaddenOverall)).sort((a, b) => a - b);
  const pct = (p) => ovrs[Math.min(ovrs.length - 1, Math.floor(ovrs.length * p))];
  const ge60 = ovrs.filter((v) => v >= 60).length;
  return { min: ovrs[0], med: pct(0.5), max: ovrs[ovrs.length - 1], pctGe60: ((ge60 / ovrs.length) * 100).toFixed(0) + '%' };
}

async function main() {
  const cfbPath = process.argv[2] || DEFAULT_SAVE;
  console.log(`Extracting departed players from: ${cfbPath}`);
  const departed = await extractLeavingPlayers(cfbPath, () => {}, { populationMode: 'exit' });
  console.log(`  ${departed.length} departed players found.\n`);

  const outDir = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.tmpdir();

  for (const variant of VARIANTS) {
    const config = {
      general: { seed: 'phase5-ufl-real-class', classSize: 402 },
      translation: { strategy: variant.strategy },
      league: 'ufl',
      ufl: variant.ufl,
    };
    const generated = generateClass(departed.map((r) => ({ ...r })), config, () => {});
    console.log(`[${variant.label}] generated ${generated.length} players -- app-estimated band:`, band(generated));

    const warnings = [];
    const buf = buildDraftClassFile(generated, { log: (m) => warnings.push(m) });
    if (warnings.length) {
      console.log(`  ${warnings.length} warning(s): ${warnings.slice(0, 5).join(' | ')}${warnings.length > 5 ? ' ...' : ''}`);
    }

    const outputPath = path.join(outDir, `CAREERDRAFT-ufl-${variant.label}`);
    fs.writeFileSync(outputPath, buf);
    console.log(`  wrote ${outputPath} (${buf.length} bytes)\n`);
  }

  console.log('Next: import ONE of these at a time into Madden (or the UFL mod\'s import slot),');
  console.log('advance far enough for Madden to recompute Overall, then read back the actual');
  console.log('in-game Overalls for a sample of the imported players -- report back the real');
  console.log('min/median/max so the UFL debuff/globalStrength/top-up can be nudged if the app\'s');
  console.log('own estimate above turns out to be off from what Madden actually computes.');
}

main().catch((e) => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
