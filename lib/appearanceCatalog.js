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

// head name -> the faceId the catalog pairs it with. Lets the exporter honour a
// player's OWN head when the destination game ships it, instead of always
// substituting a stranger's from the tone bucket (see assignExact below).
function headIndex(catalog) {
  const idx = new Map();
  for (const bucket of Object.values(catalog.bySkin || {})) {
    for (const p of bucket.pairs || []) if (!idx.has(p.head)) idx.set(p.head, p.faceId);
  }
  return idx;
}

function createAppearanceAssigner(catalogOverride) {
  const catalog = catalogOverride || loadCatalog();
  const pairUse = new Map(); // "faceId|head" -> times used
  const byHead = headIndex(catalog);

  // CFB stores a player's head as "<skin>_<facialHairCombo>_<hairstyle>_<variant>"
  // (e.g. "5_B_MS_02"); Madden stores the SAME taxonomy with a "gen_" prefix
  // ("gen_5_B_MS_02"). pipeline.js already relies on this for the franchise-save
  // write path -- this brings the draft-class exporter in line with it.
  //
  // Why this matters beyond fidelity: substituting a same-tone head is NOT
  // skin-neutral in practice. A real report had a skin-5 CFB tackle come out
  // pale in Madden 27 because the tone-5 head he was given
  // (gen_5_B_S_003 -> portrait 3356) renders lighter than his own
  // (gen_5_B_MS_02 -> portrait 3955). Using the player's real head sidesteps
  // the whole question: it is the face CFB already gave him.
  //
  // Returns null when the destination doesn't ship that head, and the caller
  // falls back to assign(skinTone).
  function assignExact(cfbHead) {
    if (!cfbHead || typeof cfbHead !== 'string') return null;
    const name = `gen_${cfbHead}`;
    if (!byHead.has(name)) return null;
    const faceId = byHead.get(name);
    const key = `${faceId}|${name}`;
    pairUse.set(key, (pairUse.get(key) || 0) + 1);
    const m = /^gen_(\d+)_/.exec(name);
    return { faceId, head: name, tone: m ? Number(m[1]) : null, exact: true, ownHead: true };
  }

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

  return { assign, assignExact, stats, catalog };
}

// Derives an appearance catalog from a TEMPLATE MODEL rather than the baked
// M26 file. This is how a non-M26 target gets faces: every head name in a real
// export of that game is, by construction, a head that game ships -- so the
// template is ground truth for what will actually render, with no separate
// baked asset to keep in sync.
//
// Skin tone comes from the head name's leading digit. NOTE: that digit is the
// HEAD's own skin, which is not the same thing as M26's explicit `skinTone`
// field -- on the M26 template the two agree on only 249 of 402 players (62%),
// so an earlier version of this comment claiming "verified 402/402" was simply
// wrong. It does not matter here: Madden 27 has no skinTone field at all (its
// visuals JSON carries only bodyType, genericHeadName and loadouts), so the
// head digit is the only skin signal that exists, and it is the one attached to
// the asset that actually renders.
//
// The portrait is read through `faceIdOf` (the exporter passes getFaceId, which
// knows M27 keeps it at offset 148 rather than the uniformly-shifted 150). In
// M27 the head and portrait are a strict 1:1 bijection -- 188 heads, 188
// portrait values, no head with two portraits and no portrait on two heads --
// so taking both from the SAME template player reproduces EA's own pairing
// exactly, which is the whole premise of this module.
//
// No render-band filter here, deliberately. M26's baker drops pairs outside
// 3347-4287 because that file mixes real portraits with a blank band in the
// 15800s; M27's portraits run 3350-10354 with no blank band at all, so the same
// filter would discard two thirds of the catalog for no reason.
function catalogFromTemplate(model, { faceIdOf } = {}) {
  const bySkin = {};
  let pairs = 0;
  for (const p of model.players) {
    const head = p.json && p.json.visuals && p.json.visuals.genericHeadName;
    if (!head) continue;
    const m = /^gen_(\d+)_/.exec(head);
    if (!m) continue;
    const tone = Number(m[1]);
    const faceId = faceIdOf ? faceIdOf(p) : 0;
    if (!bySkin[tone]) bySkin[tone] = { pairs: [] };
    if (!bySkin[tone].pairs.some((x) => x.head === head && x.faceId === faceId)) {
      bySkin[tone].pairs.push({ faceId, head });
      pairs++;
    }
  }
  return {
    meta: { source: ['template'], derived: true, coherentPairs: pairs },
    bySkin,
  };
}

module.exports = {
  catalogFromTemplate,
  headIndex,
  CATALOG_PATH,
  loadCatalog,
  poolForTone,
  createAppearanceAssigner,
};
