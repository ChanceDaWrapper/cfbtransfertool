// READ-ONLY. The REPAIRED save still crashes instantly on advance, so the
// missing season/career records were not the (only) cause. This re-audits
// from scratch, dismissing nothing.
//
// Ranked by what the game actually DOES when you advance past bowl week:
// it closes out the season, evaluates every coach's contract expectation and
// job security, then runs the coaching carousel. So enum SENTINELS and
// out-of-range indices on those specific fields matter far more than a
// cosmetic difference in name or head asset.
//
// Compares each transferred coach against peers AT THE SAME POSITION, since
// several fields are position-partitioned in CFB.

const { openCfbSave, safe, biggestTableByName } = require('../lib/saveIO');

const SAVE = process.argv[2] || 'C:/Users/tripl/Downloads/DYNASTY-AZSTATEOFFICIAL-REPAIRED';
const XFER = [118, 446, 450, 461, 471, 490];

// Enum members that are structurally terminators/placeholders rather than
// real gameplay values. If one of these is live on a coach the game evaluates
// at season rollover, that is a crash candidate.
const SENTINEL_RE = /^(Count_|Max_|Invalid_|First_|None|NumCollegeCoaches)$/;

(async () => {
  const { cfbFile } = await openCfbSave(SAVE);
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const attrs = t.schema ? t.schema.attributes : [];
  const xferSet = new Set(XFER);

  const employed = t.records.filter((r) => !r.isEmpty && safe(r, 'TeamIndex') !== 255
    && safe(r, 'TeamIndex') !== undefined && safe(r, 'Level') > 0);
  const genuine = employed.filter((r) => !xferSet.has(r.index));

  // ---- 1. Sentinel enum values live on a transferred coach ----
  console.log('=== 1. SENTINEL enum values on transferred coaches (top crash suspects) ===');
  for (const i of XFER) {
    const c = t.records[i];
    const hits = [];
    for (const a of attrs) {
      const v = safe(c, a.name);
      if (typeof v !== 'string' || !SENTINEL_RE.test(v)) continue;
      const peersWith = genuine.filter((p) => safe(p, a.name) === v).length;
      hits.push(`${a.name}=${v} (${peersWith}/${genuine.length} genuine coaches also have it)`);
    }
    console.log(`\n  ${safe(c, 'Name')} (${safe(c, 'Position')}):`);
    for (const h of hits) console.log(`     ${h}`);
  }

  // ---- 2. Every field where NO genuine same-position coach shares our value ----
  console.log('\n\n=== 2. Values NO genuine same-position coach uses (excluding pure identity) ===');
  const IDENTITY = /^(Name|FirstName|LastName|AssetName|GenericHeadAssetName|Portrait|PresentationId|CharacterVisuals|CareerStats|SeasonStats|Age|Height|Weight|CharacterBodyType)$/;
  for (const i of XFER) {
    const c = t.records[i];
    const pos = safe(c, 'Position');
    const peers = genuine.filter((p) => safe(p, pos === 'HeadCoach' ? 'Position' : 'Position') === pos);
    const flags = [];
    for (const a of attrs) {
      if (IDENTITY.test(a.name)) continue;
      const v = safe(c, a.name);
      if (v === undefined) continue;
      if (typeof v === 'number') {
        const nums = peers.map((p) => safe(p, a.name)).filter((x) => typeof x === 'number');
        if (!nums.length) continue;
        const min = Math.min(...nums), max = Math.max(...nums);
        if (v < min || v > max) flags.push(`${a.name}=${v} outside [${min}..${max}]`);
      } else if (typeof v === 'string' || typeof v === 'boolean') {
        const vals = new Set(peers.map((p) => safe(p, a.name)));
        if (vals.size && !vals.has(v)) flags.push(`${a.name}=${JSON.stringify(v)} (never used by ${peers.length} genuine ${pos}s)`);
      }
    }
    console.log(`\n  ${safe(c, 'Name')} (${pos}, ${peers.length} peers):`);
    for (const f of flags) console.log(`     !! ${f}`);
    if (!flags.length) console.log('     (nothing)');
  }

  // ---- 3. The coaches DISPLACED by the transfers -- are they valid free agents? ----
  console.log('\n\n=== 3. Displaced incumbents: do they look like real CFB free agents? ===');
  const fa = t.records.filter((r) => !r.isEmpty && safe(r, 'TeamIndex') === 255);
  const recentlyFired = fa.filter((r) => safe(r, 'ContractStatus') === 'FreeAgent' && safe(r, 'Level') > 0
    && typeof safe(r, 'PrevTeamIndex') === 'number' && safe(r, 'PrevTeamIndex') !== 255);
  console.log(`  free agents: ${fa.length}; of those, "recently fired" shaped: ${recentlyFired.length}`);
  const statusTally = new Map();
  for (const r of fa) statusTally.set(safe(r, 'ContractStatus'), (statusTally.get(safe(r, 'ContractStatus')) || 0) + 1);
  console.log(`  free-agent ContractStatus values: ${[...statusTally].map(([k, n]) => `${k} x${n}`).join(', ')}`);
  for (const r of recentlyFired.slice(0, 10)) {
    console.log(`     ${String(safe(r, 'Name')).padEnd(16)} L${safe(r, 'Level')} prevTeam=${safe(r, 'PrevTeamIndex')} `
      + `expectation=${safe(r, 'CurrentContractExpectation')} jobSec=${safe(r, 'CurrentJobSecurityStatus')} rank=${safe(r, 'CurrentJobSecurityPercentageRank')}`);
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
