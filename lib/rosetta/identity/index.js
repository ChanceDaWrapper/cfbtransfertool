// Canonical player identity for Rosetta.
//
// Verified against the save format: the Player table row index is the ONLY
// reliable identity a CFB save exposes. PresentationId recycles across
// players, asset names aren't stable identifiers, and Player rows are never
// deleted -- so row index is both unique and permanent for a given save.
// Every Rosetta subsystem keys on this, never on name/position/overall (the
// legacy playerRatingSeed's key, which can collide -- two players sharing
// First|Last|Position|OverallRating produce identical RNG draws under it).

function canonicalId(playerRecord) {
  return playerRecord.index;
}

// Deterministic per-subsystem seed string, keyed on the canonical row index.
// Kept as a pure string, not an RNG instance -- callers turn it into one via
// rosetta/rng's makeSeededRng. Blank globalSeed -> '' -> caller falls back to
// Math.random, the same convention the legacy seed function used.
function deriveSeedString(globalSeed, subsystemTag, rowIndex) {
  if (globalSeed === '' || globalSeed === undefined || globalSeed === null) return '';
  return `${globalSeed}:${subsystemTag}:${rowIndex}`;
}

module.exports = { canonicalId, deriveSeedString };
