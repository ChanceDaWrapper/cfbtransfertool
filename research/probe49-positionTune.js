// READ-ONLY. Per-POSITION view of what Dice Roll does, in rating-point space.
//
// probe48 answers "how much does the class as a whole move"; this answers
// "which positions move too far". Same join (generated Madden_* fields back to
// the source pool's college ratings), but bucketed by position rather than
// pooled, because the complaints that prompted it were position-shaped: HB and
// QB technical landing too low, safety technical too high, and the physical
// cuts biting harder than intended on some groups.
//
// Two numbers per position:
//   CHANGE -- average rating-point delta vs the college rating, split into the
//             four buckets the engine actually distinguishes.
//   LEVEL  -- average of that position's POSITION_KEY_ATTRIBUTES after
//             conversion. This is the "is this player any good" proxy;
//             averaging every rating buries it under 40 irrelevant ones.
//
// Run: node research/probe49-positionTune.js [seeds]
'use strict';

const path = require('path');
const { extractLeavingPlayers, generateClass } = require('../lib/pipeline');
const { mergeConfig, activeConfig, POSITION_KEY_ATTRIBUTES } = require('../lib/defaults');
const { CATEGORY_OF } = require('../lib/rosetta/translation/powerCurveCategories');
const { TIERED_RATINGS } = require('../lib/rosetta/translation/diceRoll');

const HOME = require('os').homedir();
const CFB = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-DRAFTSTAGE');

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const BUCKETS = ['physical', 'speed/agi', 'technical', 'mental'];

function bucketOf(name) {
  const c = CATEGORY_OF[name];
  if (!c) return null;
  if (c === 'mental') return 'mental';
  if (TIERED_RATINGS.has(name)) return 'speed/agi';
  if (c === 'physical') return 'physical';
  return 'technical';
}

// Positions worth reporting individually, in depth-chart order. Anything else
// still gets measured, it just lands in the trailing "other" rows.
const ORDER = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT',
  'LE', 'DT', 'RE', 'LOLB', 'MLB', 'ROLB', 'CB', 'FS', 'SS', 'K', 'P'];

(async () => {
  const pool = await extractLeavingPlayers(CFB, () => {});
  const seeds = Number(process.argv[2] || 4);
  const byPos = {}; // pos -> { bucket -> [] , level: [] }

  for (let s = 0; s < seeds; s++) {
    const cfg = activeConfig(mergeConfig(null), 'nfl');
    cfg.translation.strategy = 'diceroll';
    cfg.general.seed = `tune${s}`;
    const cls = generateClass(pool, cfg);
    const src = new Map(pool.map((r) => [`${r.FirstName}|${r.LastName}|${r.Position}`, r]));

    for (const p of cls) {
      const origin = src.get(`${p.FirstName}|${p.LastName}|${p.CFB_Position}`);
      if (!origin) continue;
      const pos = p.CFB_Position;
      const rec = byPos[pos] || (byPos[pos] = { level: [] });
      const keyOf = POSITION_KEY_ATTRIBUTES[pos] || [];
      const converted = [];
      for (const k of Object.keys(p)) {
        if (!k.startsWith('Madden_')) continue;
        const name = k.slice(7);
        const before = Number(origin[name]);
        const after = Number(p[k]);
        if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) continue;
        const b = bucketOf(name);
        if (b) (rec[b] = rec[b] || []).push(after - before);
        if (keyOf.includes(name)) converted.push(after);
      }
      if (converted.length) rec.level.push(avg(converted));
    }
  }

  console.log(`save: ${CFB}   pool: ${pool.length}   seeds: ${seeds}\n`);
  console.log('pos      n   phys   spd/agi   tech   mental   KEY LEVEL');
  const seen = new Set();
  const row = (pos) => {
    const r = byPos[pos];
    if (!r || !r.level.length) return;
    seen.add(pos);
    const cell = (b) => (r[b] && r[b].length ? avg(r[b]).toFixed(1) : '--').padStart(6);
    console.log(`${pos.padEnd(5)} ${String(r.level.length).padStart(3)}  ${cell('physical')}   ${cell('speed/agi')}  ${cell('technical')}  ${cell('mental')}     ${avg(r.level).toFixed(1).padStart(5)}`);
  };
  for (const pos of ORDER) row(pos);
  for (const pos of Object.keys(byPos).sort()) if (!seen.has(pos)) row(pos);

  console.log('\n(phys/spd/tech/mental = average rating-point CHANGE vs college.');
  console.log(' KEY LEVEL = average of this position\'s key attributes after conversion.)');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
