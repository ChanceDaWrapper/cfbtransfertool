// Rosetta validation scorecard -- the single, permanent validation framework
// for this migration. Every future phase EXTENDS this file (adds a category,
// or fills in a placeholder) instead of writing a new one-off verification
// script. Supersedes goldenMaster.js's ad hoc capture/verify pair -- its
// byte-identical legacy check is now the `legacyInvariance` category here.
//
// Every category returns quantitative metrics, not a bare pass/fail --
// population counts, position counts, runtime, memory (best-effort; Node's
// GC makes exact heap accounting approximate, so treat as directional),
// distribution summaries, and determinism checks. Categories not yet
// implementable (they depend on a subsystem a later phase builds) are
// explicit placeholders with status 'not_applicable' and a note on what
// they'll check and which phase unlocks them -- never silently omitted.
//
// Usage:
//   node tools/harness/scorecard.js run <cfbSavePath>       -- run + print, no persistence
//   node tools/harness/scorecard.js capture <cfbSavePath>   -- run + save as the baseline
//   node tools/harness/scorecard.js verify <cfbSavePath>    -- run + diff against the baseline

const fs = require('fs');
const path = require('path');
const {
  extractLeavingPlayers, calibratePlayers, assignDevTraits, writeCareerFile,
} = require('../../lib/pipeline');

const BASELINE_PATH = path.join(__dirname, 'scorecard-baseline.json');
const FIXED_SEED = 'rosetta-scorecard-fixed-seed';

// ---------------------------------------------------------------------------
// Shared metric helpers
// ---------------------------------------------------------------------------

function summarize(values) {
  if (!values.length) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { n, min: Math.min(...values), max: Math.max(...values), mean: +mean.toFixed(2), stddev: +Math.sqrt(variance).toFixed(2) };
}

function positionCounts(rows) {
  const counts = {};
  for (const r of rows) { const pos = r.Position || r.CFB_Position; counts[pos] = (counts[pos] || 0) + 1; }
  return counts;
}

function positionDistribution(rows, field) {
  const byPos = {};
  for (const r of rows) {
    const pos = r.Position || r.CFB_Position;
    const v = Number(r[field]);
    if (!Number.isFinite(v)) continue;
    (byPos[pos] ??= []).push(v);
  }
  const out = {};
  for (const [pos, vals] of Object.entries(byPos)) out[pos] = summarize(vals);
  return out;
}

// Best-effort: Node's GC can run at any time, so heapDeltaMB is directional,
// not exact. Still useful for spotting a phase that suddenly balloons memory.
async function measure(fn) {
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const value = await fn();
  const runtimeMs = Date.now() - t0;
  const heapDeltaMB = +((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(2);
  return { value, runtimeMs, heapDeltaMB };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function categoryPopulation(cfbSavePath) {
  const legacy = await measure(() => extractLeavingPlayers(cfbSavePath, () => {}, { populationMode: 'legacy' }));
  const exit = await measure(() => extractLeavingPlayers(cfbSavePath, () => {}, { populationMode: 'exit' }));

  const legacyIds = new Set(legacy.value.map((r) => r.rowIndex));
  const exitIds = new Set(exit.value.map((r) => r.rowIndex));
  const onlyInLegacy = [...legacyIds].filter((id) => !exitIds.has(id)).length;
  const onlyInExit = [...exitIds].filter((id) => !legacyIds.has(id)).length;

  return {
    name: 'population',
    status: 'pass',
    metrics: {
      legacy: {
        count: legacy.value.length,
        source: legacy.value.source,
        uniqueRowIndexes: legacyIds.size,
        positionCounts: positionCounts(legacy.value),
        cfbOverallByPosition: positionDistribution(legacy.value, 'OverallRating'),
        runtimeMs: legacy.runtimeMs,
        heapDeltaMB: legacy.heapDeltaMB,
      },
      exit: {
        count: exit.value.length,
        source: exit.value.source,
        regime: exit.value.regime,
        uniqueRowIndexes: exitIds.size,
        positionCounts: positionCounts(exit.value),
        cfbOverallByPosition: positionDistribution(exit.value, 'OverallRating'),
        runtimeMs: exit.runtimeMs,
        heapDeltaMB: exit.heapDeltaMB,
      },
      diff: { onlyInLegacy, onlyInExit, shared: legacyIds.size - onlyInLegacy },
    },
    // Cached for other categories so they don't re-open the save.
    _rows: { legacy: legacy.value, exit: exit.value },
  };
}

async function categoryDeterminism(exitRows) {
  // calibratePlayers/projectDraftClass mutates its input row objects in
  // place (_draftScore, _rank, etc.), so each check below gets its own
  // deep-cloned rows -- otherwise a later run would start from an
  // already-mutated state and this test would conflate two different
  // questions. See the shared-reference check further down, which
  // deliberately does NOT clone, to measure that mutation's real impact.
  const cloneRows = () => JSON.parse(JSON.stringify(exitRows));

  const runFixed = (rows) => {
    const players = calibratePlayers(rows, { config: { general: { seed: FIXED_SEED } } });
    const dev = assignDevTraits(players, { general: { seed: FIXED_SEED } });
    for (const p of players) p.DevTrait = dev.get(p);
    return players;
  };

  // The real guarantee: a fixed seed on a FRESH (unmutated) population must
  // reproduce byte-identical output. This must always hold -- it's the
  // category's pass/fail gate.
  const a = await measure(() => runFixed(cloneRows()));
  const b = await measure(() => runFixed(cloneRows()));
  const fixedSeedIdenticalFreshInput = JSON.stringify(a.value) === JSON.stringify(b.value);

  // LEGACY BUG #001, pre-existing, out of Rosetta migration scope: calling
  // calibratePlayers twice on the SAME row-object references (exactly what
  // happens in production if a user clicks Regenerate without re-extracting
  // the pool) does NOT reproduce a fixed seed's output, because the first
  // call's in-place mutation (_draftScore/_rank/etc.) changes the starting
  // state for the second. Tracked as a metric so it's visible in the
  // permanent baseline, but does not gate this category -- fixing it means
  // touching legacy projectDraftClass, which stays untouched until a later
  // phase formally replaces it. Rosetta should eliminate this class of bug
  // structurally, not by patching it: translation becomes a pure function
  // over immutable player identity (population in, new translated
  // population out, nothing mutated in place), so there's no shared,
  // stateful reference left for a second call to trip over.
  const sharedRows = cloneRows();
  const c = runFixed(sharedRows);
  const d = runFixed(sharedRows);
  const fixedSeedIdenticalSharedReference = JSON.stringify(c) === JSON.stringify(d);

  const runBlank = (rows) => {
    const players = calibratePlayers(rows, { config: { general: { seed: '' } } });
    const dev = assignDevTraits(players, { general: { seed: '' } });
    for (const p of players) p.DevTrait = dev.get(p);
    return players;
  };
  const e = runBlank(cloneRows());
  const f = runBlank(cloneRows());
  const blankSeedVaries = JSON.stringify(e) !== JSON.stringify(f);

  const status = fixedSeedIdenticalFreshInput && blankSeedVaries ? 'pass' : 'fail';
  const notes = [];
  if (!fixedSeedIdenticalFreshInput || !blankSeedVaries) {
    notes.push('A fixed seed must reproduce byte-identical output on a fresh population; a blank seed must vary run to run. One of those invariants broke.');
  }
  if (!fixedSeedIdenticalSharedReference) {
    notes.push("LEGACY BUG #001 (pre-existing, out of Rosetta migration scope): calibratePlayers mutates its input row objects in place, so re-running it on the SAME reference (e.g. clicking Regenerate without re-extracting) does not reproduce a fixed seed's output. Tracked, not gating. Rosetta's pure-function, population-level translation naturally eliminates this once it's the live strategy.");
  }

  return {
    name: 'determinism',
    status,
    metrics: {
      fixedSeedIdenticalFreshInput,
      fixedSeedIdenticalSharedReference,
      blankSeedVaries,
      fixedSeedRuntimeMs: [a.runtimeMs, b.runtimeMs],
      playerCount: a.value.length,
    },
    notes,
  };
}

// The Phase 4 firewall: rating conversion must be provably independent of
// draft-board variance. Same rating seed, wildly different boardVariance --
// every Madden_* rating, EstMaddenOverall, and Age must be byte-identical;
// DraftRank is expected (not required) to differ.
async function categoryDraftIndependence(exitRows) {
  const baseCfg = { general: { seed: FIXED_SEED } };
  const low = calibratePlayers(exitRows, { config: { ...baseCfg, draftValue: { boardVariance: 0.1 } } });
  const high = calibratePlayers(exitRows, { config: { ...baseCfg, draftValue: { boardVariance: 12 } } });

  const byKey = (list) => new Map(list.map((p) => [`${p.FirstName}|${p.LastName}|${p.CFB_Position}|${p.CFB_Overall}`, p]));
  const lowMap = byKey(low), highMap = byKey(high);
  const ratingCols = Object.keys(low[0] || {}).filter((k) => k.startsWith('Madden_'));

  let ratingsIdentical = 0, ratingsDiffer = 0, rankDiffer = 0, compared = 0;
  for (const [key, lp] of lowMap) {
    const hp = highMap.get(key);
    if (!hp) continue;
    compared++;
    const sameRatings = ratingCols.every((c) => lp[c] === hp[c]) && lp.EstMaddenOverall === hp.EstMaddenOverall && lp.Age === hp.Age;
    if (sameRatings) ratingsIdentical++; else ratingsDiffer++;
    if (lp.DraftRank !== hp.DraftRank) rankDiffer++;
  }

  const status = compared > 0 && ratingsDiffer === 0 ? 'pass' : 'fail';
  return {
    name: 'draftIndependence',
    status,
    metrics: { compared, ratingsIdentical, ratingsDiffer, rankDiffer, ratingColumnsChecked: ratingCols.length },
    notes: status === 'fail' ? ['Ratings changed when only board variance changed -- the Phase 4 firewall is broken.'] : [],
  };
}

// Proves the Translator seam (lib/rosetta/translation/) is actually wired
// into the live public calibratePlayers() entry point, not just a disconnected
// abstraction -- 'v1' and 'rosetta' strategies must produce byte-identical
// output today, since RosettaTranslator currently just delegates to
// V1Translator. Each run gets its own clone (see Legacy Bug #001 above --
// otherwise this would conflate seam correctness with that mutation bug).
async function categoryTranslatorSeam(exitRows) {
  const cloneRows = () => JSON.parse(JSON.stringify(exitRows));
  const runWithStrategy = (strategy) => {
    const players = calibratePlayers(cloneRows(), { config: { general: { seed: FIXED_SEED }, translation: { strategy } } });
    const dev = assignDevTraits(players, { general: { seed: FIXED_SEED } });
    for (const p of players) p.DevTrait = dev.get(p);
    return players;
  };
  const v1 = await measure(() => runWithStrategy('v1'));
  const rosetta = await measure(() => runWithStrategy('rosetta'));
  const identical = JSON.stringify(v1.value) === JSON.stringify(rosetta.value);

  return {
    name: 'translatorSeam',
    status: identical ? 'pass' : 'fail',
    metrics: {
      v1RosettaIdentical: identical,
      playerCount: v1.value.length,
      v1RuntimeMs: v1.runtimeMs,
      rosettaRuntimeMs: rosetta.runtimeMs,
    },
    notes: identical ? [] : ["The 'v1' and 'rosetta' translation strategies diverged -- RosettaTranslator should currently be a pure delegate to V1Translator with no translation math built yet."],
  };
}

async function categoryCalibratedDistribution(exitRows) {
  const timed = await measure(() => {
    const players = calibratePlayers(exitRows, { config: { general: { seed: FIXED_SEED } } });
    const dev = assignDevTraits(players, { general: { seed: FIXED_SEED } });
    for (const p of players) p.DevTrait = dev.get(p);
    return players;
  });
  const players = timed.value;
  const devCounts = {};
  for (const p of players) devCounts[p.DevTrait] = (devCounts[p.DevTrait] || 0) + 1;

  return {
    name: 'calibratedDistribution',
    status: 'pass',
    metrics: {
      playerCount: players.length,
      estOverallByPosition: positionDistribution(players.map((p) => ({ CFB_Position: p.CFB_Position, EstMaddenOverall: p.EstMaddenOverall })), 'EstMaddenOverall'),
      devTraitCounts: devCounts,
      runtimeMs: timed.runtimeMs,
      heapDeltaMB: timed.heapDeltaMB,
    },
    _players: players,
  };
}

async function categoryLegacyInvariance(legacyRows) {
  const timed = await measure(() => {
    const players = calibratePlayers(legacyRows, { config: { general: { seed: FIXED_SEED } } });
    const dev = assignDevTraits(players, { general: { seed: FIXED_SEED } });
    for (const p of players) p.DevTrait = dev.get(p);
    return players;
  });
  return {
    name: 'legacyInvariance',
    status: 'pass', // comparison against the saved baseline happens in `verify`, not here
    metrics: { playerCount: timed.value.length, runtimeMs: timed.runtimeMs, heapDeltaMB: timed.heapDeltaMB },
    _snapshot: timed.value, // compared byte-for-byte by `verify`
  };
}

async function categoryWriteRoundTrip(maddenSourcePath, maddenScratchPath, calibratedPlayers) {
  if (!maddenSourcePath) {
    return { name: 'writeRoundTrip', status: 'not_applicable', metrics: {}, notes: ['No Madden save path provided to the scorecard -- pass one as a 3rd CLI arg to enable this category.'] };
  }
  fs.copyFileSync(maddenSourcePath, maddenScratchPath);
  const timed = await measure(() => writeCareerFile(maddenScratchPath, maddenScratchPath, calibratedPlayers, () => {}));
  try { fs.unlinkSync(maddenScratchPath); } catch (e) { /* best effort cleanup */ }
  for (const f of fs.readdirSync(path.dirname(maddenScratchPath))) {
    if (f.startsWith(path.basename(maddenScratchPath) + '.backup-')) {
      try { fs.unlinkSync(path.join(path.dirname(maddenScratchPath), f)); } catch (e) { /* best effort */ }
    }
  }
  const stats = timed.value;
  const status = stats.written > 0 && stats.missingCollege === 0 ? 'pass' : 'fail';
  return {
    name: 'writeRoundTrip',
    status,
    metrics: { ...stats, runtimeMs: timed.runtimeMs, heapDeltaMB: timed.heapDeltaMB },
  };
}

// Proves the Two-Anchor skeleton (lib/rosetta/translation/twoAnchorTranslator.js)
// is correctly wired to FrameProvider, entirely on synthetic fixtures -- no
// save file needed. This is deliberately NOT a test of real translation
// math (there isn't any yet): it verifies construction requires a real
// FrameProvider, that translate() reads the right artifacts for every
// attribute it processes, that a missing fixture fails loudly rather than
// silently passing through, and that the output is tagged correctly.
function categoryTwoAnchorSkeleton() {
  const { TwoAnchorTranslator } = require('../../lib/rosetta/translation/twoAnchorTranslator');
  const { StubFrameProvider } = require('../../lib/rosetta/calibration/providers/stubFrameProvider');
  const { createRosettaContext } = require('../../lib/rosetta/context');

  const sample = [40, 50, 60, 70, 80, 90, 99];
  const frames = StubFrameProvider.identity('QB', ['SpeedRating', 'AwarenessRating', 'ThrowPowerRating'], sample);
  const translator = new TwoAnchorTranslator(frames);
  const context = createRosettaContext({ config: {}, log: () => {} });
  const fixture = [{ FirstName: 'Test', LastName: 'Player', Position: 'QB', SpeedRating: 80, AwarenessRating: 60, ThrowPowerRating: 90 }];

  let wiringOk = false, wiringError = null;
  try {
    const result = translator.translate(fixture, context);
    wiringOk = result.stage === 'translated' && result.length === 1 && result.strategy === 'rosetta-two-anchor-skeleton';
  } catch (e) { wiringError = e.message; }

  let missingFixtureThrows = false;
  try { translator._translateAttribute('QB', 'CatchingRating', 50); }
  catch (e) { missingFixtureThrows = true; }

  let constructorGuardHolds = false;
  try { new TwoAnchorTranslator({}); }
  catch (e) { constructorGuardHolds = true; }

  const status = wiringOk && missingFixtureThrows && constructorGuardHolds ? 'pass' : 'fail';
  return {
    name: 'twoAnchorSkeleton',
    status,
    metrics: { wiringOk, wiringError, missingFixtureThrows, constructorGuardHolds },
    notes: ['Skeleton wiring only -- NOT real translation math (identity passthrough). See lib/rosetta/translation/twoAnchorTranslator.js.'],
  };
}

// Placeholders -- explicit, not omitted. Each names the phase that unlocks
// it and exactly what it will check once that phase's subsystem exists.
function placeholderCategories() {
  return [
    {
      name: 'identityPreservation', status: 'not_applicable', metrics: {},
      notes: ['Requires real Two-Anchor translation math (Phase 4 -- skeleton now wired, math not yet implemented). Will check: within-player attribute-rank Spearman correlation pre/post translation ~= 1; strength/weakness top-k/bottom-k set conservation.'],
    },
    {
      name: 'archetypeStability', status: 'not_applicable', metrics: {},
      notes: ['Requires inferred archetypes (Phase 6). Will check: archetype label identical before/after translation for every player (a change indicates a coherence bug, not a real archetype shift).'],
    },
    {
      name: 'overallSanity', status: 'not_applicable', metrics: {},
      notes: ['Requires the emergent-Overall display estimator (Phase 7). Will check: monotonicity (dominating a peer in every key rating implies >= Overall) and |display - Madden-recomputed| within tolerance.'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runScorecard(cfbSavePath, maddenSavePath) {
  const report = { timestamp: new Date().toISOString(), cfbSavePath, categories: [] };

  const pop = await categoryPopulation(cfbSavePath);
  const { legacy: legacyRows, exit: exitRows } = pop._rows;
  delete pop._rows;
  report.categories.push(pop);

  report.categories.push(await categoryDeterminism(exitRows));
  report.categories.push(await categoryDraftIndependence(exitRows));
  report.categories.push(await categoryTranslatorSeam(exitRows));

  const calibrated = await categoryCalibratedDistribution(exitRows);
  const calibratedPlayers = calibrated._players;
  delete calibrated._players;
  report.categories.push(calibrated);

  const legacyInv = await categoryLegacyInvariance(legacyRows);
  const legacySnapshot = legacyInv._snapshot;
  delete legacyInv._snapshot;
  report.categories.push(legacyInv);

  const scratchPath = maddenSavePath ? maddenSavePath + '-SCORECARD-SCRATCH' : null;
  report.categories.push(await categoryWriteRoundTrip(maddenSavePath, scratchPath, calibratedPlayers));

  report.categories.push(categoryTwoAnchorSkeleton());
  report.categories.push(...placeholderCategories());

  return { report, legacySnapshot };
}

function printSummary(report) {
  console.log(`\nRosetta scorecard -- ${report.timestamp}`);
  console.log(`Save: ${report.cfbSavePath}\n`);
  for (const cat of report.categories) {
    const badge = { pass: 'PASS', fail: 'FAIL', not_applicable: 'N/A ' }[cat.status] || cat.status;
    console.log(`[${badge}] ${cat.name}`);
    if (cat.notes && cat.notes.length) for (const n of cat.notes) console.log(`       ${n}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const [, , cmd, cfbSavePath, maddenSavePath] = process.argv;
  if (!cmd || !cfbSavePath) {
    console.error('Usage: node tools/harness/scorecard.js <run|capture|verify> <cfbSavePath> [maddenSavePath]');
    process.exit(1);
  }

  const { report, legacySnapshot } = await runScorecard(cfbSavePath, maddenSavePath);
  printSummary(report);

  if (cmd === 'capture') {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ report, legacySnapshot }, null, 2));
    console.log(`Captured baseline -> ${BASELINE_PATH}`);
    return;
  }

  if (cmd === 'verify') {
    if (!fs.existsSync(BASELINE_PATH)) {
      console.error('No baseline captured yet. Run `capture` first.');
      process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const legacyMatch = JSON.stringify(legacySnapshot) === JSON.stringify(baseline.legacySnapshot);
    console.log(`legacyInvariance vs baseline: ${legacyMatch ? 'PASS (byte-identical)' : 'FAIL (diverged)'}`);
    if (!legacyMatch) process.exit(1);
    return;
  }

  const failed = report.categories.filter((c) => c.status === 'fail');
  if (failed.length) {
    console.error(`${failed.length} categor${failed.length === 1 ? 'y' : 'ies'} failed: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
}

module.exports = { runScorecard };
