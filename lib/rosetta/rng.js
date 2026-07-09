// Seedable mulberry32 PRNG -- same seed always produces the same sequence
// (reproducible classes), blank seed falls back to Math.random (genuinely
// fresh every call, which is what makes regenerating produce variation).
//
// Moved here unchanged from lib/pipeline.js so Rosetta subsystems (and
// pipeline.js itself) share one implementation instead of two drifting
// copies. Pure function, no dependencies -- safe for every Rosetta module
// to require without risking a circular import back into pipeline.js.
function makeSeededRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  let a = 0;
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { makeSeededRng };
