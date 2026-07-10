// Pure, stateless math for the Power-Curve translation model (the CFB->Madden
// rookie-rating spec). No I/O, no randomness, no dependency on anything
// outside this file -- every function here is independently hand-verifiable
// against the model spec's worked examples (Sec 9). This is where all
// power-curve translation mathematics actually lives; powerCurveTranslator.js
// only orchestrates calls into this module (which category a rating is, which
// position strength to use, how to clamp).
//
// The core transform, per spec Sec 4:
//
//   base = a * x^p                          # the "full-compression" NFL value
//   out  = round( clamp( x - s*(x - base), lo, hi ) )
//
//   a, p : the category power-curve constants (derived from two anchor points)
//   s    : the position x category compression strength
//            s = 1.0  -> output == base (full compression)
//            s < 1.0  -> pulled toward raw x (LESS compression, higher rating)
//            s > 1.0  -> pushed below base (MORE compression, lower rating)
//
// Anchors, not constants, are the source of truth: a two-point (x->y) anchor
// pair fully determines (a, p), and moving an anchor is how the whole curve is
// re-tuned. deriveCurve() does that inversion once; callers cache the result.

// Given two anchor points (x1->y1, x2->y2) on the power curve y = a*x^p, solve
// for (a, p). Two points, two unknowns:
//   p = ln(y1/y2) / ln(x1/x2)
//   a = y1 / x1^p
// Guarded against the degenerate inputs that would make the logs blow up
// (equal x's, non-positive values) -- those can't describe a real curve, so we
// surface them as an error rather than silently returning NaN downstream.
function deriveCurve(anchors) {
  const { x1, y1, x2, y2 } = anchors;
  for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`deriveCurve: anchor ${k}=${v} must be a positive finite number.`);
    }
  }
  if (x1 === x2) throw new Error('deriveCurve: the two anchor x-values must differ.');
  const p = Math.log(y1 / y2) / Math.log(x1 / x2);
  const a = y1 / Math.pow(x1, p);
  return { a, p };
}

// The full-compression base value for a raw college rating x under a curve.
// Accepts either a pre-derived { a, p } or a raw anchor set (derives on the
// fly) so callers that don't cache still get a correct answer.
function curveBase(x, curve) {
  const { a, p } = ('a' in curve && 'p' in curve) ? curve : deriveCurve(curve);
  return a * Math.pow(x, p);
}

// The complete per-attribute transform. `strength` (s) is the position x
// category compression strength; physical/arm-leg categories always pass
// s = 1.0. `clamp` defaults to the spec's 1..99 floor/ceiling but is a
// parameter so it stays user-configurable (spec Sec 10).
function transform(x, curve, strength, clamp = { lo: 1, hi: 99 }) {
  const base = curveBase(x, curve);
  const out = x - strength * (x - base);
  return clampRound(out, clamp.lo, clamp.hi);
}

function clampRound(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

module.exports = { deriveCurve, curveBase, transform, clampRound };
