// Bakes data/maddenGearAssets.json -- the set of equipment asset names that are
// known to exist in Madden 26.
//
// Why an allowlist is needed at all: CFB 27 and Madden 26 share a gear asset
// namespace (both Frostbite EA football titles) but NOT the whole of it. Of the
// distinct gear assets on a real CFB dynasty's players, about 69% also appear in
// Madden -- higher on the slots that actually read visually (facemask 90%,
// gloves 91%, arm sleeves 94%, elbow 100%) and much lower on college-specific
// kit (inner pants 0%, jersey styles 21%, shoes 53%). Writing a name Madden
// doesn't have risks an invisible or broken item on that player, so
// lib/gearTranslation.js only carries a CFB asset across when it is in this set,
// and otherwise keeps whatever the position-matched Madden donor was wearing.
//
// Sources, unioned:
//   1. A Madden 26 CAREER save's CharacterVisuals -- thousands of real NFL
//      players with hand-curated equipment. This is the bulk of it.
//   2. The bundled draft-class template (data/draftClassTemplate.bin.gz), which
//      is itself a real Madden 26 export. Small, but it is the exact file the
//      exporter writes into, so anything in it is certainly writable.
//
// Usage:
//   node tools/bakeMaddenGearAssets.js "<path to a Madden 26 CAREER save>"
//
// Re-run against a newer save if Madden adds gear in a title update; the list is
// additive by nature, so a wider harvest only ever translates MORE college gear
// faithfully.

const fs = require('fs');
const path = require('path');
const { openMaddenSave, safe, biggestTableByName } = require('../lib/saveIO');
const { loadTemplateModel } = require('../lib/draftClassTemplate');

const OUT = path.join(__dirname, '..', 'data', 'maddenGearAssets.json');

// Face/body parts share the loadout structure with equipment but are NOT gear:
// the exporter assigns heads and skin separately (see lib/appearanceCatalog.js),
// and a college player's face has no business overwriting that. Collected for
// reporting, never emitted.
const NON_GEAR_SLOTS = new Set([
  'Face', 'FacialHair', 'Hair', 'Mouth', 'Eyes', 'Eyebrow', 'Nose', 'Jaw', 'Chin',
  'Cheek', 'Ears', 'CustomHead', 'PlusHead', 'CharacterBodyType',
  'RightArmTattoo', 'LeftArmTattoo', 'TorsoTattoo', 'NeckTattoo',
]);

async function collectFromSave(savePath) {
  const { maddenFile } = await openMaddenSave(savePath);
  const cv = biggestTableByName(maddenFile, 'CharacterVisuals');
  if (!cv) throw new Error('That Madden save has no CharacterVisuals table.');
  await cv.readRecords();
  const assets = new Set();
  let players = 0;
  for (const r of cv.records) {
    if (r.isEmpty) continue;
    let raw;
    try { raw = safe(r, 'RawData'); } catch (e) { continue; }
    if (typeof raw !== 'string' || raw[0] !== '{') continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { continue; }
    if (!Array.isArray(parsed.loadouts)) continue;
    players++;
    for (const lo of parsed.loadouts) {
      for (const el of (lo.loadoutElements || [])) {
        if (!el.itemAssetName) continue;
        if (el.slotType && NON_GEAR_SLOTS.has(el.slotType)) continue;
        assets.add(el.itemAssetName);
      }
    }
  }
  return { assets, players };
}

function collectFromTemplate() {
  const assets = new Set();
  for (const p of loadTemplateModel().players) {
    for (const lo of (p.json.visuals.loadouts || [])) {
      for (const el of (lo.loadoutElements || [])) {
        if (!el.itemAssetName) continue;
        if (el.slotType && NON_GEAR_SLOTS.has(el.slotType)) continue;
        assets.add(el.itemAssetName);
      }
    }
  }
  return assets;
}

async function main() {
  const savePath = process.argv[2];
  if (!savePath) {
    console.log('Usage: node tools/bakeMaddenGearAssets.js "<Madden 26 CAREER save>"');
    console.log('(a CAREER-* franchise save, not a ROSTER-* file -- those are a different format)');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(savePath)) {
    console.log(`No such file: ${savePath}`);
    process.exitCode = 1;
    return;
  }

  const fromSave = await collectFromSave(savePath);
  console.log(`Madden save   : ${fromSave.players} players, ${fromSave.assets.size} gear assets`);
  const fromTemplate = collectFromTemplate();
  console.log(`draft template: ${fromTemplate.size} gear assets`);

  const all = new Set([...fromSave.assets, ...fromTemplate]);
  const onlyInTemplate = [...fromTemplate].filter((a) => !fromSave.assets.has(a));
  console.log(`union         : ${all.size} (${onlyInTemplate.length} contributed only by the template)`);

  const payload = {
    _comment: 'Equipment asset names known to exist in Madden 26. Regenerate with tools/bakeMaddenGearAssets.js. See lib/gearTranslation.js for how it is used.',
    sourceSave: path.basename(savePath),
    playersSampled: fromSave.players,
    count: all.size,
    assets: [...all].sort(),
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
