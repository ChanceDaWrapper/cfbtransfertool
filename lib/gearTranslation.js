'use strict';

// Carries a college player's real equipment into their Madden draft-class slot.
//
// THE BUG THIS FIXES. draftClassExporter's applyPlayer writes name, position,
// ratings, body type, face, head and college onto a template slot -- but never
// gear, which draftClassTemplate.js's header states outright ("only its
// structure and non-fillable sections (gear loadouts, face blends, header) are
// ever used"). Slots are then filled by draft rank, position-blind, so a
// generated player inherits whatever the real player who happened to occupy
// that slot was wearing. Measured on a real 402-man class: 91% of players got
// gear from a different position, and 43 of 48 quarterbacks came out wearing
// gloves -- because the template is 90.5% gloved overall while 25 of its 26 real
// QB slots correctly wear none. Facemasks are position-specific hardware, so the
// mismatch reads as badly as it sounds: linebacker cages on quarterbacks,
// receiver two-bars on tackles.
//
// THE APPROACH, and why it is shaped this way:
//
//   1. Start from a POSITION-MATCHED donor. The bundled template is itself a
//      real Madden 26 export -- 402 correctly-equipped players across 21
//      positions -- so a slot whose original position matches the generated
//      player is already wearing something plausible, in a structure Madden
//      certainly accepts. This alone fixes the reported symptoms.
//
//   2. Then overwrite individual items with the player's OWN college gear,
//      but only where the asset is known to exist in Madden (see
//      data/maddenGearAssets.json). The two games share a gear namespace but
//      not all of it: ~69% of a dynasty's distinct assets carry over, and much
//      better on what reads visually (facemask 90%, gloves 91%, sleeves 94%,
//      elbow 100%) than on college-specific kit (inner pants 0%, jersey style
//      21%). Anything not on the list keeps the donor's item rather than being
//      written blind.
//
//   3. Never touch face, hair or tattoos. They live in the same loadout
//      structure but are not equipment, and the exporter already assigns heads
//      and skin coherently (lib/appearanceCatalog.js). Overwriting them from
//      the college save would fight that and desync the portrait from the model.
//
// Everything here is pure: no I/O beyond lazily reading the baked asset list,
// no file writing. The actual byte-level write lives in draftClassFile.js.

const fs = require('fs');
const path = require('path');

// Not equipment -- see note 3 above. Kept in one place so the bake tool and the
// translator cannot drift apart.
const NON_GEAR_SLOTS = new Set([
  'Face', 'FacialHair', 'Hair', 'Mouth', 'Eyes', 'Eyebrow', 'Nose', 'Jaw', 'Chin',
  'Cheek', 'Ears', 'CustomHead', 'PlusHead', 'CharacterBodyType',
  'RightArmTattoo', 'LeftArmTattoo', 'TorsoTattoo', 'NeckTattoo',
]);

// The facemask is the one element Madden's draft-class format leaves untagged:
// across the 402-slot template, exactly 402 elements carry no slotType and all
// 402 are GearFaceMask_*. Matching on slotType alone would therefore skip the
// single most position-revealing item on the player, so fall back to the asset
// name's own prefix.
const PREFIX_SLOTS = [
  ['GearFaceMask', 'FaceMask'],
];

function slotKeyFor(element) {
  if (!element || !element.itemAssetName) return null;
  if (element.slotType) return element.slotType;
  for (const [prefix, slot] of PREFIX_SLOTS) {
    if (element.itemAssetName.startsWith(`${prefix}_`)) return slot;
  }
  return null;
}

let VALID_ASSETS = null;
function loadValidAssets() {
  if (VALID_ASSETS) return VALID_ASSETS;
  const p = path.join(__dirname, '..', 'data', 'maddenGearAssets.json');
  try {
    VALID_ASSETS = new Set(JSON.parse(fs.readFileSync(p, 'utf-8')).assets);
  } catch (e) {
    // Missing/corrupt list is not fatal: an empty set simply means nothing is
    // translated and every player keeps their position-matched donor's gear,
    // which is still strictly better than the rank-indexed inheritance this
    // module replaces.
    VALID_ASSETS = new Set();
  }
  return VALID_ASSETS;
}

// The player's college equipment, keyed by slot, filtered to real gear.
function cfbGearBySlot(cfbLoadouts) {
  const bySlot = new Map();
  if (!Array.isArray(cfbLoadouts)) return bySlot;
  for (const lo of cfbLoadouts) {
    // Only on-field kit. CFB blobs also carry a Base container (tattoos, body
    // type) which note 3 excludes wholesale.
    if (lo && lo.loadoutType && lo.loadoutType !== 'PlayerOnField') continue;
    for (const el of (lo && lo.loadoutElements) || []) {
      const slot = slotKeyFor(el);
      if (!slot || NON_GEAR_SLOTS.has(slot)) continue;
      if (!bySlot.has(slot)) bySlot.set(slot, el.itemAssetName);
    }
  }
  return bySlot;
}

// Locates the PlayerOnField container's exact text span inside a raw visuals
// JSON string, by brace-matching from its own key.
//
// Text, not the parsed object, because this file's blobs cannot survive a
// JSON.parse -> JSON.stringify round trip: 29 of the template's 402 carry float
// literals ("baseBlend":1.0) that stringify collapses to 1, silently changing
// bytes Madden may care about. Everything here therefore edits the original
// characters in place and leaves untouched regions byte-identical.
function findPlayerOnFieldSpan(jsonText) {
  const marker = '"loadoutType":"PlayerOnField"';
  const at = jsonText.indexOf(marker);
  if (at === -1) return null;
  // Walk back to the '{' that opens this container.
  let start = jsonText.lastIndexOf('{', at);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < jsonText.length; i++) {
    const c = jsonText[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

// Replaces the k-th "itemAssetName":"..." value inside `text`. Positional rather
// than search-and-replace by name because the same asset legitimately appears
// more than once in a loadout (left and right shoe, both gloves) and only the
// element actually being translated should move.
function replaceNthAssetName(text, n, newName) {
  const re = /("itemAssetName"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
  let i = 0, out = null, m;
  while ((m = re.exec(text)) !== null) {
    if (i === n) {
      out = text.slice(0, m.index) + m[1] + newName + m[3] + text.slice(m.index + m[0].length);
      break;
    }
    i++;
  }
  return out === null ? text : out;
}

// Produces `targetText` with its PlayerOnField container replaced by the DONOR's
// -- itself first rewritten so that every slot where the college player wore
// something Madden also has carries the college item.
//
// Only that one container moves. The target slot's own head, skin tone and body
// type were already written by draftClassExporter's applyPlayer and live either
// at the blob's top level or in the separate Base container; adopting the
// donor's whole blob would silently undo all three.
//
// `donorVisuals` is the PARSED donor blob, used only to enumerate element order;
// `donorText`/`targetText` are the raw characters, which is what actually gets
// spliced. Returns the new full text plus a per-slot account for the caller to
// report.
function translateGearText(targetText, donorText, donorVisuals, cfbLoadouts, validAssets = loadValidAssets()) {
  const empty = { text: targetText, translated: [], kept: [], skipped: [] };
  const donorSpan = findPlayerOnFieldSpan(donorText);
  const targetSpan = findPlayerOnFieldSpan(targetText);
  const onField = ((donorVisuals && donorVisuals.loadouts) || []).find((l) => l.loadoutType === 'PlayerOnField');
  if (!donorSpan || !targetSpan || !onField) return empty;

  const cfb = cfbGearBySlot(cfbLoadouts);
  let containerText = donorText.slice(donorSpan.start, donorSpan.end);
  const translated = [], kept = [], skipped = [];

  // Element order in the text matches element order in the parsed array, so a
  // positional index is a safe bridge between the two.
  const elements = onField.loadoutElements || [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || !el.itemAssetName) continue;
    const slot = slotKeyFor(el);
    if (!slot || NON_GEAR_SLOTS.has(slot)) continue;

    const want = cfb.get(slot);
    if (!want || want === el.itemAssetName) { kept.push(slot); continue; }
    if (!validAssets.has(want)) { skipped.push({ slot, asset: want }); continue; }

    containerText = replaceNthAssetName(containerText, i, want);
    translated.push({ slot, from: el.itemAssetName, to: want });
  }

  const text = targetText.slice(0, targetSpan.start) + containerText + targetText.slice(targetSpan.end);
  return { text, translated, kept, skipped };
}

module.exports = {
  NON_GEAR_SLOTS,
  slotKeyFor,
  loadValidAssets,
  cfbGearBySlot,
  findPlayerOnFieldSpan,
  replaceNthAssetName,
  translateGearText,
};
