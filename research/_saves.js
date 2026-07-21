// READ-ONLY probe support. Opens the two sample saves the way the app does.
// NOTHING in research/ may ever call .save(). See COACH_CAROUSEL_ROADMAP.md.
const path = require('path');
const os = require('os');
const fs = require('fs');
const FranchiseFile = require('madden-franchise');

const PROJECT = path.join(__dirname, '..');
const CFB_SCHEMA_GZ = path.join(PROJECT, 'data', 'schemas', 'CFB27_809_0.gz');
const HOME = os.homedir();

const CFB_PATH = process.env.CFB_SAVE
  || path.join(HOME, 'Documents', 'EA SPORTS College Football 27', 'saves', 'DYNASTY-MAINDYNASTY');
const MAD_PATH = process.env.MAD_SAVE
  || path.join(HOME, 'Documents', 'Madden NFL 26', 'Saves', 'CAREER-JUL06-10h10m34a-AUTOSAVE');

function ready(f) {
  return new Promise((res, rej) => {
    if (f.isLoaded) return res(f);
    f.on('ready', () => res(f));
    f.on('error', rej);
  });
}

async function openCfb({ fullSchema = true } = {}) {
  if (!fs.existsSync(CFB_PATH)) throw new Error(`CFB save not found: ${CFB_PATH}`);
  const opts = fullSchema
    ? { schemaOverride: { major: 809, minor: 0, gameYear: 27, path: CFB_SCHEMA_GZ }, gameYearOverride: 27 }
    : { gameYearOverride: 27, gameTypeOverride: 'college' };
  const f = await FranchiseFile.create(CFB_PATH, opts);
  await ready(f);
  return f;
}

async function openMadden() {
  if (!fs.existsSync(MAD_PATH)) throw new Error(`Madden save not found: ${MAD_PATH}`);
  const f = await FranchiseFile.create(MAD_PATH, { gameYearOverride: 26 });
  await ready(f);
  return f;
}

const safe = (r, k) => { try { return r.getValueByKey(k); } catch (e) { return undefined; } };

function stats(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
  return {
    n: a.length, min: a[0], max: a[a.length - 1],
    mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2),
    p10: q(0.10), p25: q(0.25), p50: q(0.50), p70: q(0.70), p75: q(0.75), p90: q(0.90), p95: q(0.95),
    zeros: a.filter((v) => v === 0).length,
  };
}

module.exports = { openCfb, openMadden, CFB_PATH, MAD_PATH, safe, stats, PROJECT };
