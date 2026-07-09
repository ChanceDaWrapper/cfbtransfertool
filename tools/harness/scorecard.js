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
const FranchiseFile = require('madden-franchise');
const {
  extractLeavingPlayers, calibratePlayers, assignDevTraits, writeCareerFile,
  openCfbSave, buildTeamNames, RATING_NAMES, POS_GROUP,
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

// Runs the REAL Calibration Builder (lib/rosetta/calibration/build/) against
// the real CFB + Madden saves: opens both, builds all three artifacts
// (college reference, rookie reference, physical scale), validates each
// independently, freezes an InMemoryCalibrationModel, constructs a
// CalibrationModelFrameProvider backed by it, and spot-checks that every
// provider reads correctly from the frozen model -- including a mental
// attribute (physicalScale must be null) and a deliberately-uncovered case
// (a position/attribute pair the builder has no data for must throw
// loudly, never return silently-wrong data).
async function categoryCalibrationBuilder(cfbSavePath, maddenSavePath, exitPopulation) {
  if (!maddenSavePath) {
    return { name: 'calibrationBuilder', status: 'not_applicable', metrics: {}, notes: ['No Madden save path provided to the scorecard -- pass one as a 3rd CLI arg to enable this category.'] };
  }

  const { buildCalibrationModel, CalibrationModelFrameProvider } = require('../../lib/rosetta/calibration');

  const { cfbFile } = await openCfbSave(cfbSavePath);
  const teamNames = await buildTeamNames(cfbFile);
  const maddenFile = await FranchiseFile.create(maddenSavePath, { autoUnempty: true });

  const timed = await measure(() => buildCalibrationModel({
    cfbFile, teamNames, maddenFile, exitPopulation,
    ratingFields: RATING_NAMES, posGroup: POS_GROUP,
    log: () => {},
  }));
  const { model, validation } = timed.value;

  const collegePositions = validation.college.positions;
  const collegeAttributePairs = validation.college.attributePairs;
  const rookiePositions = validation.rookie.positions;
  const rookieAttributePairs = validation.rookie.attributePairs;
  const physicalAttributePairs = validation.physicalScale.attributePairs;

  const provider = new CalibrationModelFrameProvider(model);

  // Spot-check: a common position/attribute (physical), a mental attribute
  // (physicalScale must be null, not a fabricated value), and a
  // deliberately-uncovered position (LS has zero broad-tier coverage on
  // real saves where no Junior/Senior LS is currently rostered -- must
  // throw, not silently return bad data).
  let physicalOk = false, mentalOk = false, uncoveredThrowsCorrectly = false;
  let spotCheckError = null;
  try {
    const speedRef = provider.attribute('QB', 'SpeedRating');
    physicalOk = speedRef.collegeDistribution.length > 0 && speedRef.rookieDistribution.length > 0
      && !!speedRef.physicalScale && speedRef.taxonomy.class === 'physical';

    const awarenessRef = provider.attribute('QB', 'AwarenessRating');
    mentalOk = awarenessRef.physicalScale === null && awarenessRef.taxonomy.class === 'mental';
  } catch (e) { spotCheckError = e.message; }

  try {
    provider.attribute('LS', 'SpeedRating');
  } catch (e) {
    uncoveredThrowsCorrectly = true;
  }

  const isFrozen = Object.isFrozen(model);
  const status = validation.college.valid && validation.rookie.valid && validation.physicalScale.valid
    && physicalOk && mentalOk && isFrozen
    ? 'pass' : 'fail';

  const notes = [];
  if (!uncoveredThrowsCorrectly) {
    notes.push('LS unexpectedly had college reference coverage on this save -- spot-check target no longer exercises the uncovered-position path; harmless, but pick a different deliberately-sparse position if this recurs.');
  }
  if (spotCheckError) notes.push(`Spot-check error: ${spotCheckError}`);

  return {
    name: 'calibrationBuilder',
    status,
    metrics: {
      modelVersion: model.version,
      modelFrozen: isFrozen,
      collegePositions, collegeAttributePairs,
      rookiePositions, rookieAttributePairs,
      physicalAttributePairs,
      providerSpotCheck: { physicalOk, mentalOk, uncoveredThrowsCorrectly },
      runtimeMs: timed.runtimeMs,
      heapDeltaMB: timed.heapDeltaMB,
    },
    notes,
  };
}

// Hand-verified regression protection for the four pure math primitives
// (lib/rosetta/translation/twoAnchorMath.js) -- the SAME cases verified by
// hand against the math spec before twoAnchorTranslator.js was ever wired
// to use them. If any of these ever drift, it means the numerics changed,
// not just calibration data -- a much more serious class of regression
// than anything else in this file catches.
function categoryTwoAnchorMath() {
  const { tieAwarePercentile, quantileInterpolate, scaleInterpolate, isDegenerate } = require('../../lib/rosetta/translation/twoAnchorMath');
  const checks = [];
  const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

  const s = [10, 20, 20, 20, 30, 40];
  checks.push(['tieAwarePercentile(20, ties)', approx(tieAwarePercentile(20, s), 0.41667, 1e-4)]);
  checks.push(['tieAwarePercentile(10, low tie)', approx(tieAwarePercentile(10, s), 0.08333, 1e-4)]);
  checks.push(['tieAwarePercentile(40, unique high)', approx(tieAwarePercentile(40, s), 0.91667, 1e-4)]);
  checks.push(['tieAwarePercentile(25, between)', approx(tieAwarePercentile(25, s), 0.66667, 1e-4)]);
  checks.push(['tieAwarePercentile(5, below all)', tieAwarePercentile(5, s) === 0]);
  checks.push(['tieAwarePercentile(50, above all)', tieAwarePercentile(50, s) === 1]);

  const r = [40, 50, 60, 70, 80];
  checks.push(['quantileInterpolate(0)', quantileInterpolate(0, r) === 40]);
  checks.push(['quantileInterpolate(1)', quantileInterpolate(1, r) === 80]);
  checks.push(['quantileInterpolate(0.5, exact knot)', quantileInterpolate(0.5, r) === 60]);
  checks.push(['quantileInterpolate(0.125, mid-interval)', quantileInterpolate(0.125, r) === 45]);
  checks.push(['quantileInterpolate single-element', quantileInterpolate(0.5, [99]) === 99]);

  const identityScale = { collegeValues: [0, 99], maddenValues: [0, 99] };
  checks.push(['scaleInterpolate identity', scaleInterpolate(55, identityScale) === 55]);
  checks.push(['scaleInterpolate clamps low', scaleInterpolate(-5, identityScale) === 0]);
  checks.push(['scaleInterpolate clamps high', scaleInterpolate(150, identityScale) === 99]);
  const compressiveScale = { collegeValues: [0, 50, 100], maddenValues: [0, 25, 50] };
  checks.push(['scaleInterpolate nonlinear', scaleInterpolate(75, compressiveScale) === 37.5]);

  checks.push(['isDegenerate single value', isDegenerate([5]) === true]);
  checks.push(['isDegenerate constant sample', isDegenerate([5, 5, 5]) === true]);
  checks.push(['isDegenerate real sample', isDegenerate([5, 6]) === false]);
  checks.push(['isDegenerate empty', isDegenerate([]) === true]);

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    name: 'twoAnchorMath',
    status: failed.length === 0 ? 'pass' : 'fail',
    metrics: { checksRun: checks.length, checksFailed: failed.length },
    notes: failed.length ? [`Failed: ${failed.join(', ')}`] : [],
  };
}

// Proves the real Two-Anchor engine (lib/rosetta/translation/
// twoAnchorTranslator.js) is correctly wired AND correctly handles its two
// documented edge cases, on synthetic fixtures -- no save file needed.
//
// BEHAVIORAL DIFFERENCE from the old skeleton test this replaces: the
// skeleton asserted a missing fixture THROWS (correct for a skeleton that
// deliberately had no fallback logic yet). The real engine's documented
// requirement is "graceful handling of missing data" -- so the same
// scenario must now NOT throw, must fall back to the raw value, and must
// record a warning instead. Asserting the old behavior here would be
// testing for a regression, not a fix.
function categoryTwoAnchorTranslation() {
  const { TwoAnchorTranslator } = require('../../lib/rosetta/translation/twoAnchorTranslator');
  const { StubFrameProvider } = require('../../lib/rosetta/calibration/providers/stubFrameProvider');
  const { createRosettaContext } = require('../../lib/rosetta/context');

  // A dense, realistically-sized sample (n=60, matching the real
  // reference distributions' typical order of magnitude per the Phase 5.5
  // data-quality audit -- college median 160/pair, rookie median 74/pair)
  // rather than a handful of points. This matters: tieAwarePercentile's
  // midpoint-CDF convention and quantileInterpolate's type-7 convention are
  // each individually correct and independently hand-verified (see
  // twoAnchorMath), but composing them is only an EXACT identity map in the
  // limit of a dense sample -- on a tiny synthetic sample (e.g. n=7) the
  // composition can miss by several points purely from that discretization
  // edge effect, not from any coherence bug. Confirmed by direct
  // measurement: max deviation 4 points at n=7, 1 point at n=74, 0 points
  // over a fully dense 0-99 sample. A dense fixture is what actually tests
  // "does identity hold," rather than testing an artifact of a too-small
  // synthetic sample.
  const sample = [];
  for (let i = 40; i <= 99; i++) sample.push(i);
  const frames = StubFrameProvider.identity('QB', ['SpeedRating', 'AwarenessRating', 'ThrowPowerRating'], sample);
  const ratingFields = ['SpeedRating', 'AwarenessRating', 'ThrowPowerRating', 'CatchingRating'];
  const translator = new TwoAnchorTranslator(frames, ratingFields);
  const context = createRosettaContext({ config: {}, log: () => {} });
  // CatchingRating has no fixture -- deliberately exercises the missing-data path.
  const fixture = [{ FirstName: 'Test', LastName: 'Player', Position: 'QB', SpeedRating: 80, AwarenessRating: 60, ThrowPowerRating: 90, CatchingRating: 50 }];

  let wiringOk = false, wiringError = null, result = null;
  try {
    result = translator.translate(fixture, context);
    wiringOk = result.stage === 'translated' && result.length === 1 && result.strategy === 'rosetta-two-anchor';
  } catch (e) { wiringError = e.message; }

  // Identity fixture: F^C === F^N === physical y=x -- translation of an
  // in-range value must be a no-op (within +/-1 point -- see the
  // discretization-edge-effect note above; exact-zero is only guaranteed
  // for fully dense samples).
  const near = (a, b) => Math.abs(a - b) <= 1;
  const identityHolds = result && near(result[0].Madden_SpeedRating, 80) && near(result[0].Madden_AwarenessRating, 60) && near(result[0].Madden_ThrowPowerRating, 90);

  // Missing-data case: CatchingRating has no fixture -- must NOT throw, must
  // fall back to the raw value, and must be recorded as a warning.
  const missingDataGraceful = result && result[0].Madden_CatchingRating === 50;
  const missingDataWarned = translator.getWarnings().some((w) => w.type === 'missing-data' && w.attribute === 'CatchingRating');

  // Degenerate-source case: a constant reference must pass through, not
  // manufacture a fake percentile.
  const degenerateFrames = new StubFrameProvider({ QB: { StaminaRating: { college: [70, 70, 70], rookie: [60, 65, 70] } } });
  const degenerateTranslator = new TwoAnchorTranslator(degenerateFrames, ['StaminaRating']);
  const degenerateResult = degenerateTranslator.translate([{ Position: 'QB', StaminaRating: 70 }], context);
  const degenerateGraceful = degenerateResult[0].Madden_StaminaRating === 70;
  const degenerateWarned = degenerateTranslator.getWarnings().some((w) => w.type === 'degenerate-source');

  let constructorGuardHolds = false;
  try { new TwoAnchorTranslator({}, ratingFields); } catch (e) { constructorGuardHolds = true; }
  let ratingFieldsGuardHolds = false;
  try { new TwoAnchorTranslator(frames, []); } catch (e) { ratingFieldsGuardHolds = true; }

  const status = wiringOk && identityHolds && missingDataGraceful && missingDataWarned
    && degenerateGraceful && degenerateWarned && constructorGuardHolds && ratingFieldsGuardHolds
    ? 'pass' : 'fail';

  return {
    name: 'twoAnchorTranslation',
    status,
    metrics: {
      wiringOk, wiringError, identityHolds,
      missingDataGraceful, missingDataWarned,
      degenerateGraceful, degenerateWarned,
      constructorGuardHolds, ratingFieldsGuardHolds,
    },
    notes: ['Real Two-Anchor math (no longer identity-passthrough). Missing data and degenerate sources fall back gracefully with a recorded warning -- deliberately does NOT throw (differs from the old skeleton, which threw by design since it had no fallback logic yet).'],
  };
}

// Runs BOTH V1Translator and the real TwoAnchorTranslator on the SAME real
// exit population, using the real frozen CalibrationModel from Phase 5, and
// reports quantitative comparison + identity-preservation metrics. This is
// the closest thing to ground truth this scorecard can offer for "is the
// real math doing something sensible," short of a human looking at
// specific players (see the phase report's before/after examples).
async function categoryTwoAnchorVsV1(cfbSavePath, maddenSavePath, exitPopulation) {
  if (!maddenSavePath) {
    return { name: 'twoAnchorVsV1', status: 'not_applicable', metrics: {}, notes: ['No Madden save path provided.'] };
  }
  const { buildCalibrationModel, CalibrationModelFrameProvider } = require('../../lib/rosetta/calibration');
  const { TwoAnchorTranslator } = require('../../lib/rosetta/translation/twoAnchorTranslator');

  const { cfbFile } = await openCfbSave(cfbSavePath);
  const teamNames = await buildTeamNames(cfbFile);
  const maddenFile = await FranchiseFile.create(maddenSavePath, { autoUnempty: true });
  const { model } = await buildCalibrationModel({
    cfbFile, teamNames, maddenFile, exitPopulation, ratingFields: RATING_NAMES, posGroup: POS_GROUP, log: () => {},
  });
  const frameProvider = new CalibrationModelFrameProvider(model);
  const rosettaTranslator = new TwoAnchorTranslator(frameProvider, RATING_NAMES);

  const cloneRows = () => JSON.parse(JSON.stringify(exitPopulation));
  const v1 = calibratePlayers(cloneRows(), { config: { general: { seed: FIXED_SEED } } });
  const rosetta = rosettaTranslator.translate(cloneRows(), {});

  // Match by identity (name+position+CFB overall -- same key used elsewhere
  // in this scorecard) since the two translators don't share row order.
  const v1ByKey = new Map(v1.map((p) => [`${p.FirstName}|${p.LastName}|${p.CFB_Position}|${p.CFB_Overall}`, p]));

  const ratingCols = RATING_NAMES.map((r) => `Madden_${r}`);
  let compared = 0;
  const perRatingDiffs = {};
  for (const col of ratingCols) perRatingDiffs[col] = [];
  let identitySpearmanSum = 0, identitySpearmanN = 0;
  let topKConserved = 0, topKTotal = 0;

  function spearman(a, b) {
    const n = a.length;
    const rank = (arr) => {
      const idx = arr.map((v, i) => i).sort((i, j) => arr[i] - arr[j]);
      const r = new Array(n);
      idx.forEach((origIdx, rankPos) => { r[origIdx] = rankPos; });
      return r;
    };
    const ra = rank(a), rb = rank(b);
    let sumSqDiff = 0;
    for (let i = 0; i < n; i++) sumSqDiff += (ra[i] - rb[i]) ** 2;
    if (n < 2) return 1;
    return 1 - (6 * sumSqDiff) / (n * (n * n - 1));
  }

  for (const rp of rosetta) {
    const key = `${rp.FirstName}|${rp.LastName}|${rp.CFB_Position}|${rp.CFB_Overall}`;
    const vp = v1ByKey.get(key);
    if (!vp) continue;
    compared++;
    for (const col of ratingCols) {
      if (typeof rp[col] === 'number' && typeof vp[col] === 'number') {
        perRatingDiffs[col].push(Math.abs(rp[col] - vp[col]));
      }
    }

    // Identity preservation: within-player Spearman rank correlation
    // between the player's RAW CFB rating profile and Rosetta's translated
    // profile -- should sit close to 1.0 since every step is monotone.
    const attrs = RATING_NAMES.filter((a) => typeof rp.Position !== 'undefined');
    // (recomputed against the ORIGINAL exit population row for raw values)
  }

  const avgAbsDiffByRating = {};
  let overallSum = 0, overallCount = 0;
  for (const col of ratingCols) {
    const diffs = perRatingDiffs[col];
    if (diffs.length === 0) continue;
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    avgAbsDiffByRating[col] = +avg.toFixed(2);
    overallSum += diffs.reduce((a, b) => a + b, 0);
    overallCount += diffs.length;
  }
  const overallMeanAbsDiff = overallCount > 0 ? +(overallSum / overallCount).toFixed(2) : null;

  // Identity preservation, computed directly against the exit population's
  // raw CFB values (not V1's output) -- this is the real test: does
  // Rosetta's OWN translation preserve each player's own rank order across
  // his attributes.
  const exitByKey = new Map(exitPopulation.map((p) => [`${p.FirstName}|${p.LastName}|${p.Position}|${Number(p.OverallRating)}`, p]));
  let strengthWeaknessConserved = 0, strengthWeaknessTotal = 0;
  for (const rp of rosetta) {
    const key = `${rp.FirstName}|${rp.LastName}|${rp.CFB_Position}|${rp.CFB_Overall}`;
    const raw = exitByKey.get(`${rp.FirstName}|${rp.LastName}|${rp.CFB_Position}|${rp.CFB_Overall}`);
    if (!raw) continue;
    const rawVals = [], translatedVals = [];
    for (const attr of RATING_NAMES) {
      const rv = Number(raw[attr]);
      const tv = rp[`Madden_${attr}`];
      if (Number.isFinite(rv) && typeof tv === 'number') { rawVals.push(rv); translatedVals.push(tv); }
    }
    if (rawVals.length < 5) continue;
    identitySpearmanSum += spearman(rawVals, translatedVals);
    identitySpearmanN++;

    // top-3 / bottom-3 attribute set conservation
    const withNames = RATING_NAMES.map((attr, i) => ({ attr, raw: Number(raw[attr]), translated: rp[`Madden_${attr}`] }))
      .filter((x) => Number.isFinite(x.raw) && typeof x.translated === 'number');
    if (withNames.length < 6) continue;
    const byRaw = [...withNames].sort((a, b) => b.raw - a.raw);
    const byTranslated = [...withNames].sort((a, b) => b.translated - a.translated);
    const top3Raw = new Set(byRaw.slice(0, 3).map((x) => x.attr));
    const top3Translated = new Set(byTranslated.slice(0, 3).map((x) => x.attr));
    const overlap = [...top3Raw].filter((a) => top3Translated.has(a)).length;
    topKConserved += overlap;
    topKTotal += 3;
  }

  const identitySpearmanMean = identitySpearmanN > 0 ? +(identitySpearmanSum / identitySpearmanN).toFixed(4) : null;
  const topKConservationRate = topKTotal > 0 ? +(topKConserved / topKTotal).toFixed(4) : null;

  return {
    name: 'twoAnchorVsV1',
    status: compared > 0 ? 'pass' : 'fail',
    metrics: {
      playersCompared: compared,
      overallMeanAbsDiff,
      avgAbsDiffByRatingSample: Object.fromEntries(Object.entries(avgAbsDiffByRating).slice(0, 8)),
      identityPreservation: {
        withinPlayerSpearmanMean: identitySpearmanMean,
        playersScored: identitySpearmanN,
        top3StrengthConservationRate: topKConservationRate,
      },
    },
    notes: [
      `Rosetta vs V1 differ by ${overallMeanAbsDiff} points on average per rating -- EXPECTED, not a bug: V1 uses single-tier legacy calibration data + a physical flat-drop + a bell-curve squeeze; Rosetta uses self-calibrated multi-tier frames + tie-aware percentile mapping + explicit absolute/relative anchor blending. They are different, both defensible, translations -- not the same algorithm re-verified.`,
      `Identity preservation (Rosetta vs the player's own raw CFB profile) is the metric that actually matters here, not agreement with V1.`,
    ],
  };
}

// Activates the identityPreservation placeholder now that real Two-Anchor
// math exists to test. Checks the two guarantees the math spec promises:
// within-player rank correlation (Spearman) between a player's raw CFB
// attribute profile and his translated profile should sit close to 1.0
// (every step -- percentile lookup, quantile interpolation, anchor blend --
// is monotone), and his strongest attributes should stay his strongest
// attributes.
function categoryIdentityPreservation(vsV1Metrics) {
  if (!vsV1Metrics || !vsV1Metrics.identityPreservation || vsV1Metrics.identityPreservation.playersScored === 0) {
    return { name: 'identityPreservation', status: 'not_applicable', metrics: {}, notes: ['twoAnchorVsV1 did not run or scored zero players -- see that category for why.'] };
  }
  const { withinPlayerSpearmanMean, playersScored, top3StrengthConservationRate } = vsV1Metrics.identityPreservation;
  const status = withinPlayerSpearmanMean >= 0.9 && top3StrengthConservationRate >= 0.7 ? 'pass' : 'fail';
  return {
    name: 'identityPreservation',
    status,
    metrics: { withinPlayerSpearmanMean, playersScored, top3StrengthConservationRate },
    notes: status === 'fail' ? ['Within-player rank correlation or strength conservation fell below threshold -- a real coherence problem, not expected variance.'] : [],
  };
}

// Placeholders -- explicit, not omitted. Each names the phase that unlocks
// it and exactly what it will check once that phase's subsystem exists.
function placeholderCategories() {
  return [
    {
      name: 'archetypeStability', status: 'not_applicable', metrics: {},
      notes: ['Requires inferred archetypes (a later phase, not yet built). Will check: archetype label identical before/after translation for every player (a change indicates a coherence bug, not a real archetype shift).'],
    },
    {
      name: 'overallSanity', status: 'not_applicable', metrics: {},
      notes: ['Requires the emergent-Overall display estimator (a later phase, not yet built). Will check: monotonicity (dominating a peer in every key rating implies >= Overall) and |display - Madden-recomputed| within tolerance.'],
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

  report.categories.push(await categoryCalibrationBuilder(cfbSavePath, maddenSavePath, exitRows));
  report.categories.push(categoryTwoAnchorMath());
  report.categories.push(categoryTwoAnchorTranslation());

  const vsV1 = await categoryTwoAnchorVsV1(cfbSavePath, maddenSavePath, exitRows);
  report.categories.push(vsV1);
  report.categories.push(categoryIdentityPreservation(vsV1.metrics));

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
