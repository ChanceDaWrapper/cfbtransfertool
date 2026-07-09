// Structural validation for a built artifact BEFORE it's frozen into
// CalibrationModel -- catches build-time bugs (non-finite values, unsorted
// samples, malformed entries) before they become a permanent, silent part
// of a frozen model. This checks STRUCTURE (is this data safe to freeze
// and query), not coverage quality (how much data exists is a metric to
// report, not a pass/fail gate here -- see the scorecard's calibrationBuilder
// category for coverage reporting).

function validateReferenceArtifact(name, data) {
  const errors = [];
  const positions = Object.keys(data);
  let attributePairs = 0;

  for (const position of positions) {
    for (const [attribute, sample] of Object.entries(data[position])) {
      attributePairs++;
      if (!Array.isArray(sample) || sample.length === 0) {
        errors.push(`${name}.${position}.${attribute}: empty or non-array sample.`);
        continue;
      }
      for (let i = 0; i < sample.length; i++) {
        if (!Number.isFinite(sample[i])) {
          errors.push(`${name}.${position}.${attribute}: non-finite value at index ${i}.`);
          break;
        }
        if (i > 0 && sample[i] < sample[i - 1]) {
          errors.push(`${name}.${position}.${attribute}: not sorted ascending at index ${i}.`);
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, positions: positions.length, attributePairs };
}

function validatePhysicalScaleArtifact(data) {
  const errors = [];
  const positions = Object.keys(data);
  let attributePairs = 0;

  for (const position of positions) {
    for (const [attribute, scale] of Object.entries(data[position])) {
      attributePairs++;
      if (!scale || !Array.isArray(scale.collegeValues) || !Array.isArray(scale.maddenValues)) {
        errors.push(`physicalScale.${position}.${attribute}: malformed scale entry.`);
        continue;
      }
      if (scale.collegeValues.length !== scale.maddenValues.length) {
        errors.push(`physicalScale.${position}.${attribute}: collegeValues/maddenValues length mismatch.`);
      }
      if (scale.collegeValues.some((v) => !Number.isFinite(v)) || scale.maddenValues.some((v) => !Number.isFinite(v))) {
        errors.push(`physicalScale.${position}.${attribute}: non-finite value in scale.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, positions: positions.length, attributePairs };
}

module.exports = { validateReferenceArtifact, validatePhysicalScaleArtifact };
