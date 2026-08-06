// CarouselContext -- services and environment ONLY. It does not carry
// in-flight coach data of any kind. Mirrors lib/rosetta/context.js's own
// rule (see its header for the full reasoning): population/coach data is
// TRANSFORMING state that moves through an explicit stage chain (see
// lifecycle.js's Pool -> Selection -> Mapped -> Staged -> Written) and
// belongs in function arguments/return values, not sitting on a shared
// object multiple stages could reach into.
//
// A carousel move is inherently two-save: it always has a source game's open
// file AND a destination game's open file, unlike Rosetta's single-save
// context. Both live on the same context object rather than threading two
// separate contexts through every stage, since every carousel stage needs
// both ends of the move.

function createCarouselContext({
  cfbFile = null, cfbSavePath = null,
  maddenFile = null, maddenSavePath = null,
  config = {}, log = () => {},
} = {}) {
  return {
    cfbFile,
    cfbSavePath,
    maddenFile,
    maddenSavePath,
    // Merged app config for this carousel run -- synthesis constants
    // (job-security default, prestige percentile, level-map W/WINSOR, etc.
    // per ROADMAP section 3.4/3.1) live here, not hardcoded in map/ modules.
    config,
    log,
  };
}

module.exports = { createCarouselContext };
