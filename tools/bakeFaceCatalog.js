// Bakes the app's shipped face-ID catalog (data/faceCatalog.json) from the
// BUNDLED draft-class template. Run once (or to refresh). NOT part of the shipped
// app -- a dev/maintenance tool, like bakeDraftClassTemplate.js.
//
// Model (FACES_AND_DRAFT_ROADMAP.md Phase 5c, after correction): a draft-class
// player's rendered face is chosen by the 16-bit face-ID at binary offset 146-147.
// Two things we verified in-game AND in data:
//   * The JSON head/skin are INERT at import -- only the face-ID drives the face.
//   * A face-ID's SKIN TONE is reliable: 94% self-consistent per ID, 93% stable
//     across builds. Its generic-head string is NOT a reliable descriptor of the
//     actual face (head-skin agrees with the real skin only 34% of the time), and
//     the face-ID number does not encode skin (corr -0.18). So we can reliably
//     match SKIN TONE, but not facial features.
// Therefore the catalog maps skin tone -> the render-band face-IDs known to
// produce that tone. The exporter picks a face-ID from the CFB player's skin-tone
// bucket (spreading to limit cloning). Result: every player gets a real,
// correct-skin-tone Madden-generated face.
//
// Source = the bundled template specifically (not the other exports), because
// face-IDs are build-relative INDICES: an ID only reliably renders with the file
// it came from. The bundled template is exactly what we ship and patch, so its
// face-IDs are guaranteed to render in whatever build accepts it.
//
// Usage: node tools/bakeFaceCatalog.js

const fs = require('fs');
const path = require('path');
const { getFaceId } = require('../lib/draftClassFile');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'faceCatalog.json');
const RENDER_B147_MIN = 13;
const RENDER_B147_MAX = 16;

function main() {
  const model = loadTemplateModel();

  // face-ID -> counts of each observed skinTone, so we can take the mode (the
  // reliable label) and drop the rare self-inconsistent occurrences.
  const toneCounts = {};
  let renderBand = 0, minFid = Infinity, maxFid = -Infinity;
  for (const p of model.players) {
    const b147 = p.binary.raw[147];
    if (b147 < RENDER_B147_MIN || b147 > RENDER_B147_MAX) continue;
    const st = p.json.visuals.skinTone;
    if (st == null) continue;
    const fid = getFaceId(p);
    renderBand++; minFid = Math.min(minFid, fid); maxFid = Math.max(maxFid, fid);
    (toneCounts[fid] = toneCounts[fid] || {});
    toneCounts[fid][st] = (toneCounts[fid][st] || 0) + 1;
  }

  const bySkinTone = {};
  for (const [fid, counts] of Object.entries(toneCounts)) {
    const mode = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
    (bySkinTone[mode] = bySkinTone[mode] || []).push(Number(fid));
  }
  for (const k of Object.keys(bySkinTone)) bySkinTone[k].sort((a, b) => a - b);

  const catalog = {
    version: 2,
    builtAt: new Date().toISOString(),
    source: `bundled template (${model.header.schemaTag})`,
    note: 'face-ID -> skin tone. Keyed by skinTone (reliable ~94%). Head/features intentionally not used (unreliable at import).',
    renderBand: { min: minFid, max: maxFid, b147Min: RENDER_B147_MIN, b147Max: RENDER_B147_MAX },
    bySkinTone,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 0));

  const distinct = new Set(Object.values(bySkinTone).flat()).size;
  console.log(`Baked face catalog from ${catalog.source}`);
  console.log(`  render-band players harvested: ${renderBand} | distinct face-IDs: ${distinct} | render band ${minFid}..${maxFid}`);
  console.log(`  face-IDs per skin tone: ${Object.keys(bySkinTone).sort().map((k) => `${k}:${bySkinTone[k].length}`).join('  ')}`);
  console.log(`  -> ${OUTPUT_PATH} (${fs.statSync(OUTPUT_PATH).size} bytes)`);
}

main();
