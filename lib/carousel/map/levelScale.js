// Quality/Level conversion -- COACH_CAROUSEL_ROADMAP.md section 3.1/3.1a.
//
// The model settled by research (research/probe10-balanced-table.js): a
// position-conditioned PURE percentile map (no linear anchor -- a blend
// weight was tried and made coordinator mapping worse), with the
// destination pool winsorized at p95 so one outlier can't define the
// ceiling. Everything here is derived from the two LIVE open saves at call
// time, never from a baked table -- the illustrative numbers in the roadmap
// came from one save pair and will differ on another.
//
// ExperiencePoints is never copied (the two games use the field for
// different things entirely -- see person.js's sibling finding in
// FINDINGS.md section "Q10"): Madden's is cumulative career XP, a clean
// quadratic function of Level (R^2=0.9972 on the sample save); CFB's is
// spendable talent-tree currency with no real relationship to Level
// (R^2=0.4998). So Madden XP is fit from the live destination save; CFB XP
// is a flat configured starting pool.

const { safe, biggestTableByName } = require('../../saveIO');

const POSITIONS = ['HeadCoach', 'OffensiveCoordinator', 'DefensiveCoordinator'];
const DEFAULT_WINSOR = 0.95;
const DEFAULT_CFB_STARTING_XP = 0;

// Percentile of v within sorted array a, in [0,1]. Midpoint convention for
// ties (matches research/probe10's method exactly).
function pctOf(a, v) {
  if (!a.length) return 0;
  let lo = 0, hi = 0;
  for (const x of a) { if (x < v) lo++; if (x <= v) hi++; }
  return ((lo + hi) / 2) / a.length;
}
function valueAt(a, p) {
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}
function winsorize(a, q) {
  if (!a.length || q >= 1) return a;
  const cap = a[Math.min(a.length - 1, Math.round(q * (a.length - 1)))];
  return a.map((v) => Math.min(v, cap));
}

// Reads every non-zero Level for the given table/position, live. Level==0
// rows are the two saves' blank-shell coaches (CFB free-agent fillers,
// Madden's never-hired slots) -- not real coaches, and they'd drag every
// percentile toward zero if included (verified: CFB has 68, Madden has 16
// in the sample save).
async function readLevelsByPosition(file, table = 'Coach') {
  const t = biggestTableByName(file, table);
  if (!t) throw new Error(`levelScale: no "${table}" table in this save.`);
  await t.readRecords();
  const byPos = {};
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const pos = safe(r, 'Position');
    if (!POSITIONS.includes(pos)) continue;
    const level = safe(r, 'Level');
    if (typeof level === 'number' && level > 0) (byPos[pos] = byPos[pos] || []).push(level);
  }
  for (const pos of POSITIONS) byPos[pos] = (byPos[pos] || []).slice().sort((a, b) => a - b);
  return byPos;
}

function levelRange(file, table = 'Coach') {
  const schema = file.schemaList.getSchema(table);
  const attr = schema && schema.attributes.find((a) => a.name === 'Level');
  if (!attr) throw new Error(`levelScale: no Level field on ${table} in this save.`);
  return { min: Number(attr.minValue), max: Number(attr.maxValue) };
}

// Builds the position-conditioned percentile model between two LIVE saves.
// Call once per carousel run (not per coach) -- it reads both Coach tables.
async function buildLevelModel({ sourceFile, destFile, winsor = DEFAULT_WINSOR }) {
  const [sourceLevels, destLevels] = await Promise.all([
    readLevelsByPosition(sourceFile),
    readLevelsByPosition(destFile),
  ]);
  const model = { winsor, destRange: levelRange(destFile), byPosition: {} };
  for (const pos of POSITIONS) {
    model.byPosition[pos] = {
      source: sourceLevels[pos],
      dest: winsorize(destLevels[pos], winsor),
    };
  }
  return model;
}

// Maps one coach's Level. Percentile-in / value-at-percentile-out is
// non-decreasing by construction (both pctOf and valueAt are monotonic in
// their inputs), so a higher source Level can only produce an equal or
// higher destination Level for the SAME position model -- no separate
// monotonicity pass needed.
function mapLevel(model, position, sourceLevel) {
  const bucket = model.byPosition[position];
  if (!bucket) throw new Error(`levelScale: no Level model for position "${position}" (expected one of ${POSITIONS.join(', ')}).`);
  const p = pctOf(bucket.source, sourceLevel);
  const raw = valueAt(bucket.dest, p);
  return Math.max(model.destRange.min, Math.min(model.destRange.max, raw));
}

// Fits Madden's live (Level, ExperiencePoints) relationship: XP = a*L^2 + b*L
// (least squares through the origin), refit from whichever Madden save is
// actually open -- the coefficients in research/out are from one save and
// must not be hardcoded here.
async function fitMaddenXpCurve(maddenFile) {
  const t = biggestTableByName(maddenFile, 'Coach');
  await t.readRecords();
  const byLevel = new Map();
  for (const r of t.records) {
    if (r.isEmpty) continue;
    const lvl = safe(r, 'Level'), xp = safe(r, 'ExperiencePoints');
    if (typeof lvl === 'number' && lvl > 0 && typeof xp === 'number') {
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(xp);
    }
  }
  // Fit against each level's median XP, not every raw sample -- keeps a
  // level with many coaches from dominating a level with few (matches
  // research/probe09's approach).
  const points = [...byLevel.entries()]
    .map(([lvl, xs]) => { const s = xs.slice().sort((x, y) => x - y); return { lvl, med: s[Math.floor(s.length / 2)] }; });
  if (points.length < 3) return { a: 0, b: 2000 }; // degenerate save (too few coaches) -- flat fallback slope
  let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
  for (const { lvl, med } of points) {
    const L2 = lvl * lvl;
    s11 += L2 * L2; s12 += L2 * lvl; s22 += lvl * lvl; y1 += L2 * med; y2 += lvl * med;
  }
  const det = s11 * s22 - s12 * s12;
  if (det === 0) return { a: 0, b: 2000 };
  const a = (y1 * s22 - y2 * s12) / det;
  const b = (s11 * y2 - s12 * y1) / det;
  return { a, b };
}

function xpForMaddenLevel({ a, b }, level) {
  return Math.max(0, Math.round(a * level * level + b * level));
}

// Derives ExperiencePoints for a coach arriving at `destLevel` in `destGame`.
// Madden: fit from the live destination save. CFB: a flat starting pool
// (config constant, default 0 -- an arriving coach starts with an empty
// talent tree and spends their way up, matching CoachPoints=0).
async function synthesizeExperiencePoints({ destGame, destFile, destLevel, cfbStartingXp = DEFAULT_CFB_STARTING_XP }) {
  if (destGame === 'madden') {
    const curve = await fitMaddenXpCurve(destFile);
    return xpForMaddenLevel(curve, destLevel);
  }
  if (destGame === 'cfb') return cfbStartingXp;
  throw new Error(`synthesizeExperiencePoints: destGame must be 'cfb' or 'madden', got ${JSON.stringify(destGame)}`);
}

module.exports = {
  POSITIONS,
  DEFAULT_WINSOR,
  DEFAULT_CFB_STARTING_XP,
  readLevelsByPosition,
  levelRange,
  buildLevelModel,
  mapLevel,
  fitMaddenXpCurve,
  xpForMaddenLevel,
  synthesizeExperiencePoints,
  // exposed for unit testing the math without an open save
  pctOf,
  valueAt,
  winsorize,
};
