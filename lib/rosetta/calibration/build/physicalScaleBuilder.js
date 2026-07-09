// Physical/health measurement-scale map builder -- the artifact behind the
// Two-Anchor model's absolute anchor.
//
// KNOWN LIMITATION, disclosed rather than papered over: we do not have
// verified paired college-to-Madden combine data (the same real athlete
// measured in both games) to fit a genuine S^C/S^M correspondence from --
// the calibration strategy doc's own acknowledgment is that this is "the
// one genuinely uncertain parameter... refine only if paired data becomes
// collectible." Per the "evidence before correction" guardrail (no
// normalization without demonstrated evidence of an artifact), this does
// NOT invent a correction: it defaults to an IDENTITY map
// (collegeValues === maddenValues) over the range actually observed in the
// college/rookie reference data already built. This is exactly the
// mathematically correct behavior the Two-Anchor spec predicts when
// S^C ~= S^M (a shared scale -> the absolute anchor is identity) -- a
// documented placeholder pending real paired data, not a statistical fit.

const { attributeClass } = require('../../attributeTaxonomy');

function buildPhysicalScales({ collegeReferences, rookieReferences, ratingFields, log = () => {} }) {
  const result = {};
  let attributesCovered = 0;

  const positions = new Set([...Object.keys(collegeReferences), ...Object.keys(rookieReferences)]);
  for (const position of positions) {
    for (const attribute of ratingFields) {
      const cls = attributeClass(attribute);
      if (cls !== 'physical' && cls !== 'health') continue;

      const college = collegeReferences[position]?.[attribute] ?? [];
      const rookie = rookieReferences[position]?.[attribute] ?? [];
      const all = [...college, ...rookie];
      if (all.length === 0) continue;

      const min = Math.min(...all);
      const max = Math.max(...all);
      const range = min === max ? [min] : [min, max];
      (result[position] ??= {})[attribute] = { collegeValues: range, maddenValues: range };
      attributesCovered++;
    }
  }

  log(`Physical scale (identity placeholder -- no paired college/Madden combine data yet): ${attributesCovered} (position,attribute) pairs.`);
  return result;
}

module.exports = { buildPhysicalScales };
