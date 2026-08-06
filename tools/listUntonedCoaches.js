// Lists CFB coaches whose skin tone cannot be read from their head asset, so
// data/cfbCoachTones.json can be filled in where it actually matters.
//
// Ranked by how likely you are to transfer someone: head coaches first, then
// by level. Nobody needs all 230 -- the top 20 covers the coaches anyone
// actually moves.
//
// Usage:
//   node tools/listUntonedCoaches.js "<cfb save path>" [--limit N] [--all] [--json]

const fs = require('fs');
const path = require('path');
const FranchiseFile = require('madden-franchise');
const { safe, biggestTableByName } = require('../lib/saveIO');
const { cfbSkinTone, loadCfbTones, CFB_TONE_PATH } = require('../lib/carousel/appearance');

const args = process.argv.slice(2);
const savePath = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const showAll = args.includes('--all');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 25;

if (!savePath) {
  console.error('usage: node tools/listUntonedCoaches.js "<cfb save path>" [--limit N] [--all] [--json]');
  process.exit(1);
}

const POSITION_RANK = { HeadCoach: 0, OffensiveCoordinator: 1, DefensiveCoordinator: 2 };

(async () => {
  const file = await FranchiseFile.create(savePath, { autoUnempty: true });
  const t = biggestTableByName(file, 'Coach');
  await t.readRecords();

  const { overrides } = loadCfbTones();
  const untoned = [];
  let total = 0, readable = 0, overridden = 0;

  for (let i = 0; i < t.records.length; i++) {
    const r = t.records[i];
    if (!r || r.isEmpty) continue;
    const name = safe(r, 'Name');
    if (!name) continue;
    total++;
    const head = String(safe(r, 'GenericHeadAssetName') || '');
    if (overrides.has(head)) { overridden++; readable++; continue; }
    if (cfbSkinTone(head) !== null) { readable++; continue; }
    untoned.push({
      row: i,
      name,
      position: safe(r, 'Position'),
      level: safe(r, 'Level') ?? 0,
      team: safe(r, 'TeamIndex'),
      head,
      // The Unique_ name is LastNameFirstName -- worth surfacing, it is how
      // you identify who to look up in-game.
      person: (head.match(/^Unique_C_(.+?)_\d+$/) || [])[1] || '',
    });
  }

  untoned.sort((a, b) => (POSITION_RANK[a.position] ?? 9) - (POSITION_RANK[b.position] ?? 9) || b.level - a.level);

  if (asJson) {
    console.log(JSON.stringify(untoned, null, 2));
    return;
  }

  console.log(`\n${path.basename(savePath)}`);
  console.log(`  ${total} coaches: ${readable} with a known tone `
    + `(${readable - overridden} read from the head name, ${overridden} from overrides), `
    + `${untoned.length} unknown.\n`);

  if (!untoned.length) { console.log('  Nothing to fill in.\n'); return; }

  const shown = showAll ? untoned : untoned.slice(0, limit);
  console.log('  lvl  pos   coach                  person (from head asset)');
  console.log('  ---  ----  ---------------------  ------------------------');
  for (const c of shown) {
    const pos = { HeadCoach: 'HC', OffensiveCoordinator: 'OC', DefensiveCoordinator: 'DC' }[c.position] || c.position;
    console.log(`  ${String(c.level).padStart(3)}  ${String(pos).padEnd(4)}  ${String(c.name).padEnd(21)}  ${c.person}`);
  }
  if (!showAll && untoned.length > shown.length) {
    console.log(`\n  ... and ${untoned.length - shown.length} more (--all to see them).`);
  }

  console.log(`\n  To fix any of these, add to "overrides" in`);
  console.log(`  ${CFB_TONE_PATH}`);
  console.log('  keyed by the exact head asset name, value 1 (lightest) to 8 (darkest):\n');
  for (const c of shown.slice(0, 3)) console.log(`    "${c.head}": 5,`);
  console.log('\n  Unmapped coaches still transfer -- they get a tone sampled from the CFB');
  console.log('  distribution, which is a plausible guess rather than a match.\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
