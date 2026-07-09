// Pure, stateless math for the Two-Anchor translation model. No I/O, no
// randomness, no dependency on anything outside this file -- every function
// here is independently hand-verifiable against the math spec. This is
// where "Translation owns all translation mathematics" actually lives;
// twoAnchorTranslator.js only orchestrates calls into this module.

// Tie-corrected mid-distribution CDF (percentile lookup):
//   F(v) = [ #{s < v} + 0.5 * #{s == v} ] / n
// A plain ECDF is wrong for integer ratings, which produce heavy ties --
// the 0.5-weight on equals is what makes this correct. Binary search twice
// (first index >= v, first index > v) rather than a linear scan, since
// reference samples can run into the hundreds.
function tieAwarePercentile(value, sortedSample) {
  const n = sortedSample.length;
  if (n === 0) return 0.5; // callers should already have checked for this via isDegenerate/coverage
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedSample[mid] < value) lo = mid + 1; else hi = mid; }
  const firstGE = lo;
  lo = 0; hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedSample[mid] <= value) lo = mid + 1; else hi = mid; }
  const firstGT = lo;
  const countLess = firstGE;
  const countEqual = firstGT - firstGE;
  return (countLess + 0.5 * countEqual) / n;
}

// Piecewise-linear quantile interpolation over a sorted reference sample --
// the standard non-parametric quantile estimator (equivalent to numpy's
// default "linear" method): index the sorted sample by percentile*(n-1)
// and interpolate between the two bracketing observations. Monotone by
// construction (linear between non-decreasing points), which is what
// guarantees peer-standing preservation (Theorem A) survives this step.
function quantileInterpolate(percentile, sortedSample) {
  const m = sortedSample.length;
  if (m === 0) return NaN; // callers must guard -- see isDegenerate
  if (m === 1) return sortedSample[0];
  const p = Math.max(0, Math.min(1, percentile));
  const idx = p * (m - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(m - 1, lo + 1);
  const frac = idx - lo;
  return sortedSample[lo] * (1 - frac) + sortedSample[hi] * frac;
}

// Physical-scale interpolation: given a raw college value, find its
// Madden-equivalent via the (collegeValues, maddenValues) parallel-array
// map from AttributeReference.physicalScale. Values outside the observed
// range clamp to the nearest endpoint rather than extrapolate. Currently
// near-identity in practice (Phase 5's physicalScaleBuilder documents this
// is a placeholder pending real paired college/Madden combine data), but
// this function treats it as a genuine, possibly-nonlinear monotone map --
// if a future calibration pass fits a real S^C/S^M correspondence, this
// code needs no changes.
function scaleInterpolate(value, physicalScale) {
  const { collegeValues, maddenValues } = physicalScale;
  const n = collegeValues.length;
  if (n === 0) return value;
  if (n === 1) return maddenValues[0];
  if (value <= collegeValues[0]) return maddenValues[0];
  if (value >= collegeValues[n - 1]) return maddenValues[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (collegeValues[mid] <= value) lo = mid; else hi = mid;
  }
  const x0 = collegeValues[lo], x1 = collegeValues[hi];
  const y0 = maddenValues[lo], y1 = maddenValues[hi];
  if (x1 === x0) return y0;
  const frac = (value - x0) / (x1 - x0);
  return y0 + frac * (y1 - y0);
}

// Degenerate-source check (math spec Sec 1.3, case 1): fewer than 2
// distinct values carries no percentile information -- forcing a
// percentile lookup against a constant sample would be meaningless, not
// merely imprecise.
function isDegenerate(sortedSample) {
  if (!sortedSample || sortedSample.length < 2) return true;
  return sortedSample[0] === sortedSample[sortedSample.length - 1];
}

module.exports = { tieAwarePercentile, quantileInterpolate, scaleInterpolate, isDegenerate };
