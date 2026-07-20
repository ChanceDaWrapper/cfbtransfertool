'use strict';

// Dresses a generated player in a skin-coherent appearance, drawing from
// data/appearanceCatalog.json (baked by tools/bakeAppearanceCatalog.js from EA's
// own auto-draft files). Madden renders a prospect from three INDEPENDENT
// systems (FACES_AND_DRAFT_ROADMAP.md "appearance model"):
//   - the 2D portrait     -> faceId at binary offset 146 (carries an inherent skin)
//   - the 3D head & body   -> genericHeadName (its leading digit is the skin)
//   - the build            -> a byte at offset 141
// Portrait and head are separate assets with no link stored in the draft file --
// Madden's live editor regenerates a portrait from a head on an in-game edit,
// but that generator never runs on import, and EA's own auto-drafts show
// head->portrait is NOT a stable function (the same head ships with dozens of
// different portraits). So instead of picking a portrait and a head
// independently, this module reuses EA's own SHIPPED (faceId, head) PAIRS --
// whatever coherence exists between a prospect's portrait and its head is
// already baked into that pairing, which beats picking the two blind.
//
// createAppearanceAssigner() is called once per class, then assign(skinTone) per
// player. It spreads picks across each tone's pair pool (least-used first) so a
// class doesn't collapse onto a few repeated identities, and is deterministic
// given the call order (the exporter processes players in a fixed order).

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'appearanceCatalog.json');

let cached = null;
function loadCatalog() {
  if (!cached) {
    if (!fs.existsSync(CATALOG_PATH)) {
      throw new Error(
        `Appearance catalog not found at ${CATALOG_PATH}. Generate it with: `
        + `node tools/bakeAppearanceCatalog.js "<dir with CAREERDRAFT-* files>"`
      );
    }
    cached = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  }
  return cached;
}

// Returns { tone, pairs } for a requested skin tone, falling back outward to the
// nearest tone with any pairs (so tones the catalog under-covers -- e.g. the
// very rare skin 8, or the thin skin-3 pool -- borrow from tone +/-1, +/-2, ...).
function poolForTone(catalog, skinTone) {
  const tones = Object.keys(catalog.bySkin).map(Number).sort((a, b) => a - b);
  if (!tones.length) throw new Error('Appearance catalog has no skin buckets');
  let want = Number(skinTone);
  if (!Number.isFinite(want)) want = tones[0];
  for (let radius = 0; radius <= 10; radius++) {
    for (const cand of [want - radius, want + radius]) {
      const b = catalog.bySkin[cand];
      if (b && b.pairs.length) return { tone: cand, pairs: b.pairs };
    }
  }
  // last resort: any bucket with pairs
  for (const t of tones) if (catalog.bySkin[t].pairs.length) return { tone: t, pairs: catalog.bySkin[t].pairs };
  throw new Error('Appearance catalog has no usable skin bucket');
}

function createAppearanceAssigner(catalogOverride) {
  const catalog = catalogOverride || loadCatalog();
  const pairUse = new Map(); // "faceId|head" -> times used

  function assign(skinTone) {
    const { tone, pairs } = poolForTone(catalog, skinTone);
    // pick the least-used pair in this tone's pool; tie-break by array order
    let best = pairs[0];
    let bestKey = `${best.faceId}|${best.head}`;
    let bestU = pairUse.get(bestKey) || 0;
    for (const p of pairs) {
      const key = `${p.faceId}|${p.head}`;
      const u = pairUse.get(key) || 0;
      if (u < bestU) { best = p; bestKey = key; bestU = u; }
    }
    pairUse.set(bestKey, bestU + 1);
    return { faceId: best.faceId, head: best.head, tone, exact: tone === Number(skinTone) };
  }

  function stats() {
    const counts = [...pairUse.values()];
    return { distinctPairs: pairUse.size, maxReuse: Math.max(0, ...counts) };
  }

  return { assign, stats, catalog };
}

module.exports = {
  CATALOG_PATH,
  loadCatalog,
  poolForTone,
  createAppearanceAssigner,
};
