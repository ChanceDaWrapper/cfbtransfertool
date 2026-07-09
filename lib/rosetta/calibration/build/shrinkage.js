// Empirical-Bayes shrinkage for reference DISTRIBUTIONS (not point
// estimates), per the calibration strategy: a thin, position-exact sample
// should lean on a broader fallback sample proportionally to how thin it
// is, converging to "trust the exact sample fully" as it grows.
//
//   weight_primary = n_primary / (n_primary + kappa)
//
// Rather than requiring WEIGHTED samples (which would mean FrameProvider's
// distributions couldn't stay plain sorted arrays -- an interface change
// this phase is not authorized to make), this blends via SAMPLE COUNT:
// keep every primary observation, and add exactly `kappa` REPRESENTATIVE
// observations from the fallback tier (evenly spaced across its sorted
// range, preserving its shape without per-observation weights). The
// combined sample's raw counts alone reproduce the target weight exactly:
//
//   kappa / (n_primary + kappa) = 1 - n_primary/(n_primary + kappa)
//
// which is precisely the fallback tier's intended share. This is what lets
// every artifact stay a plain, unweighted, sorted array all the way
// through to FrameProvider -- the shrinkage math lives entirely here, at
// build time, and the frozen CalibrationModel never has to represent a
// weight.

const KAPPA = 40;

function sorted(sample) {
  return [...sample].sort((a, b) => a - b);
}

// Evenly-spaced subsample of size n from a sample, preserving its shape.
// Returns the whole (sorted) sample unchanged if it's already <= n.
function representativeSubsample(sample, n) {
  const s = sorted(sample);
  if (s.length <= n) return s;
  if (n <= 1) return [s[Math.floor(s.length / 2)]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(s.length - 1, Math.round((i / (n - 1)) * (s.length - 1)));
    out.push(s[idx]);
  }
  return out;
}

// Blends a primary tier's sample with a fallback tier's sample. Returns a
// plain sorted array -- see header comment for why count, not weight.
function blendTiers(primarySample, fallbackSample, kappa = KAPPA) {
  const primary = primarySample || [];
  const fallback = fallbackSample || [];
  if (fallback.length === 0) return sorted(primary);
  if (primary.length === 0) return representativeSubsample(fallback, kappa);
  return sorted([...primary, ...representativeSubsample(fallback, kappa)]);
}

module.exports = { KAPPA, blendTiers, representativeSubsample };
