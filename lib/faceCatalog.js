'use strict';

// Assigns Madden draft-class face-IDs to players by SKIN TONE. See
// FACES_AND_DRAFT_ROADMAP.md Phase 5c and tools/bakeFaceCatalog.js for the model:
// the rendered face is chosen by the 16-bit face-ID at binary offset 146-147, the
// JSON head/skin are inert at import, and a face-ID's skin tone is the only
// reliable thing we can match (its features are not). data/faceCatalog.json maps
// skin tone -> render-band face-IDs known to produce that tone.
//
// The exporter calls createFaceAssigner() once per generated class, then
// assign(skinTone) per player. The assigner spreads picks across each tone's pool
// (least-used first) so a class doesn't collapse onto a few repeated faces, and
// is deterministic given the call order (the exporter processes players in a
// fixed order, so output is reproducible).

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'faceCatalog.json');

let cached = null;
function loadCatalog() {
  if (!cached) {
    if (!fs.existsSync(CATALOG_PATH)) {
      throw new Error(
        `Face catalog not found at ${CATALOG_PATH}. Generate it with: node tools/bakeFaceCatalog.js`
      );
    }
    cached = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  }
  return cached;
}

// Returns the pool of face-IDs for a skin tone, falling back outward to the
// nearest tone that has any (e.g. a tone with no catalog entries borrows from
// tone±1). Clamps the requested tone to the catalog's real range first.
function poolForTone(catalog, skinTone) {
  const tones = Object.keys(catalog.bySkinTone).map(Number).sort((a, b) => a - b);
  if (!tones.length) throw new Error('Face catalog has no skin-tone buckets');
  let want = Number(skinTone);
  if (!Number.isFinite(want)) want = tones[0];
  for (let radius = 0; radius <= 10; radius++) {
    for (const cand of [want - radius, want + radius]) {
      const pool = catalog.bySkinTone[cand];
      if (pool && pool.length) return { tone: cand, pool };
    }
  }
  // last resort: any non-empty bucket
  for (const t of tones) if (catalog.bySkinTone[t].length) return { tone: t, pool: catalog.bySkinTone[t] };
  throw new Error('Face catalog is empty');
}

// Creates a stateful assigner that spreads face-IDs within each tone to limit
// cloning. assign(skinTone) -> { faceId, tone, exact } where exact is whether the
// requested tone had its own pool (vs a nearest-tone fallback).
function createFaceAssigner(catalogOverride) {
  const catalog = catalogOverride || loadCatalog();
  const usage = new Map(); // faceId -> times assigned

  function assign(skinTone) {
    const { tone, pool } = poolForTone(catalog, skinTone);
    // pick the least-used face-ID in this pool; tie-break by smallest id for determinism
    let best = pool[0];
    let bestUse = usage.get(best) || 0;
    for (const fid of pool) {
      const u = usage.get(fid) || 0;
      if (u < bestUse) { best = fid; bestUse = u; }
    }
    usage.set(best, bestUse + 1);
    return { faceId: best, tone, exact: tone === Number(skinTone) };
  }

  function stats() {
    const counts = [...usage.values()].sort((a, b) => b - a);
    return { distinctUsed: usage.size, maxReuse: counts[0] || 0, assigned: counts.reduce((a, b) => a + b, 0) };
  }

  return { assign, stats, catalog };
}

module.exports = {
  CATALOG_PATH,
  loadCatalog,
  poolForTone,
  createFaceAssigner,
};
