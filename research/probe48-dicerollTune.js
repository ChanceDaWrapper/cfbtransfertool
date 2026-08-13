// READ-ONLY. Measures Dice Roll in ATTRIBUTE space -- how many rating points a
// generated class actually loses off its college ratings, and where the strong
// players end up on the draft board.
//
// Two questions, matching the two complaints this was written for:
//   1. LEVEL -- how far do attributes / mental ratings drop?
//   2. SHAPE -- do strong players concentrate early, or survive late?
//
// Note on the SHAPE metric: the obvious one (average rating DROP by band) is
// confounded and was misleading at first. `delta` scales with the player's own
// overall, so a round-1 pick has more rating to lose and drops more points even
// when its roll is kinder -- the drop can't show whether strength is landing
// early. What matters is the LEVEL players end up at, so that is what is
// reported. The average bust/gem modifier by band is shown alongside it to
// isolate the roll itself from that scaling.
//
// Run: node research/probe48-dicerollTune.js [seeds]
'use strict';

const path = require('path');
const { extractLeavingPlayers, generateClass } = require('../lib/pipeline');
const { mergeConfig, activeConfig } = require('../lib/defaults');
const { CATEGORY_OF } = require('../lib/rosetta/translation/powerCurveCategories');
const { POSITION_KEY_ATTRIBUTES } = require('../lib/defaults');
const { TIERED_RATINGS } = require('../lib/rosetta/translation/diceRoll');

const HOME = require('os').homedir();
const CFB = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-DRAFTSTAGE');

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const BANDS = ['R1 (1-32)', 'R2-3 (33-96)', 'R4-7 (97-224)', 'UDFA (225+)'];
const bandOf = (pick) => (pick <= 32 ? BANDS[0] : pick <= 96 ? BANDS[1] : pick <= 224 ? BANDS[2] : BANDS[3]);

// Report buckets that mirror how the engine actually treats a rating.
function bucketOf(name) {
  const c = CATEGORY_OF[name];
  if (!c) return null;
  if (c === 'mental') return 'mental';
  if (TIERED_RATINGS.has(name)) return 'speed/agi (tiered)';
  if (c === 'physical') return 'physical';
  return 'technical';
}

(async () => {
  const pool = await extractLeavingPlayers(CFB, () => {});
  const seeds = Number(process.argv[2] || 4);
  const byBucket = {};
  const bandLevel = {};
  let scored = 0;

  for (let s = 0; s < seeds; s++) {
    const cfg = activeConfig(mergeConfig(null), 'nfl');
    cfg.translation.strategy = 'diceroll';
    cfg.general.seed = `tune${s}`;
    const cls = generateClass(pool, cfg);
    // The converted class carries only Madden_* ratings; college values stay on
    // the source pool row, so join them to diff the two.
    const src = new Map(pool.map((r) => [`${r.FirstName}|${r.LastName}|${r.Position}`, r]));

    cls.forEach((p, i) => {
      const origin = src.get(`${p.FirstName}|${p.LastName}|${p.CFB_Position}`);
      if (!origin) return;
      scored++;
      const band = bandOf(i + 1);
      // Only the ratings that actually define this position -- averaging ALL
      // of them buries the signal, since most are irrelevant to a given player
      // (a tackle's throw accuracy sits near 20 and never moves the needle).
      const keyOf = POSITION_KEY_ATTRIBUTES[p.CFB_Position] || [];
      const converted = [];
      for (const k of Object.keys(p)) {
        if (!k.startsWith('Madden_')) continue;
        const name = k.slice(7);
        const before = Number(origin[name]);
        const after = Number(p[k]);
        if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) continue;
        const b = bucketOf(name);
        if (b) (byBucket[b] = byBucket[b] || []).push(after - before);
        if (keyOf.includes(name)) converted.push(after);
      }
      if (converted.length) (bandLevel[band] = bandLevel[band] || []).push(avg(converted));
    });
  }

  console.log(`save: ${CFB}`);
  console.log(`pool: ${pool.length}   seeds: ${seeds}   players scored: ${scored}\n`);

  console.log('===== 1. LEVEL: average rating-point change vs the college rating =====');
  for (const b of ['physical', 'speed/agi (tiered)', 'technical', 'mental']) {
    const v = byBucket[b];
    if (!v || !v.length) continue;
    console.log(`  ${b.padEnd(20)} ${avg(v).toFixed(2).padStart(7)} pts   (median ${med(v).toFixed(1)}, n=${v.length})`);
  }

  console.log('\n===== 2. SHAPE: where the strong players end up =====');
  console.log('  average of each position KEY rating set -- later bands should sit clearly lower');
  for (const b of BANDS) {
    const v = bandLevel[b];
    if (!v || !v.length) continue;
    const strong = v.filter((x) => x >= 68).length;
    console.log(`  ${b.padEnd(14)} level ${avg(v).toFixed(1).padStart(5)}   players averaging 68+: ${String(strong).padStart(3)}/${v.length}`);
  }
  const lv = (b) => avg(bandLevel[b] || [0]);
  console.log(`\n  R1 minus R4-7 level gap: ${(lv(BANDS[0]) - lv(BANDS[2])).toFixed(2)} pts (bigger = strength concentrated early)`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
