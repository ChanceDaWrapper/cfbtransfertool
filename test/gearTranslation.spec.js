// Regression test for lib/gearTranslation.js and the equipment path in
// lib/draftClassExporter.js.
//
// THE BUG THIS PINS DOWN. The exporter never wrote equipment at all -- gear came
// from whichever template slot a player's draft rank landed on, position-blind.
// Measured on a real class: 91% of players wore another position's gear, and 43
// of 48 quarterbacks came out in gloves (the template is 90.5% gloved, while 25
// of its 26 real QB slots correctly wear none). The invariants below are the
// ones that, if broken again, bring that back.
//
// Run with: node test/gearTranslation.spec.js (or npm test).

const assert = require('assert');
const {
  slotKeyFor, cfbGearBySlot, findPlayerOnFieldSpan, replaceNthAssetName,
  translateGearText, NON_GEAR_SLOTS,
} = require('../lib/gearTranslation');
const { setVisualsText, parseDraftClassFile } = require('../lib/draftClassFile');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A blob shaped like the real thing: a Base container that must never be
// touched, and a PlayerOnField container that carries the gear. Includes a
// float literal, which is the formatting JSON.stringify would silently destroy.
const DONOR = '{"bodyType":"Heavy","genericHeadName":"gen_6_B_G_03",'
  + '"loadouts":[{"loadoutCategory":"Base","loadoutElements":['
  + '{"itemAssetName":"Heavy_BodyType","slotType":"CharacterBodyType"}]},'
  + '{"loadoutType":"PlayerOnField","loadoutElements":['
  + '{"itemAssetName":"GearHand_glove_NikeDTack_White","slotType":"LeftHandWear"},'
  + '{"itemAssetName":"GearHand_glove_NikeDTack_White","slotType":"RightHandWear"},'
  + '{"blends":[{"baseBlend":1.0}],"itemAssetName":"Backplate_Standard","slotType":"BackPlate"},'
  + '{"itemAssetName":"GearFaceMask_SpeedflexFullcage"},'
  + '{"itemAssetName":"GearVisor_None","slotType":"Visor"}]}],"skinTone":3}';

const TARGET = '{"bodyType":"Thin","genericHeadName":"gen_2_A_A_01",'
  + '"loadouts":[{"loadoutCategory":"Base","loadoutElements":['
  + '{"itemAssetName":"Thin_BodyType","slotType":"CharacterBodyType"}]},'
  + '{"loadoutType":"PlayerOnField","loadoutElements":['
  + '{"itemAssetName":"GearHand_glove_OLD","slotType":"LeftHandWear"}]}],"skinTone":1}';

const CFB_LOADOUTS = [{
  loadoutType: 'PlayerOnField',
  loadoutElements: [
    { itemAssetName: 'GearHand_None', slotType: 'LeftHandWear' },
    { itemAssetName: 'GearFaceMask_Speedflex2Bar', slotType: 'FaceMask' },
    { itemAssetName: 'GearVisor_visorClear', slotType: 'Visor' },
    { itemAssetName: 'GearFaceMask_MadeUpDoesNotExist', slotType: 'FaceMask2' },
    { itemAssetName: 'SomeCollegeHair', slotType: 'Hair' }, // non-gear, must be ignored
  ],
}];
const VALID = new Set(['GearHand_None', 'GearFaceMask_Speedflex2Bar', 'GearVisor_visorClear']);

// --------------------------------------------------------------------
// 1. Slot identification -- the facemask is the trap.
// --------------------------------------------------------------------
{
  check('slotType is used when present',
    slotKeyFor({ itemAssetName: 'X', slotType: 'LeftHandWear' }), 'LeftHandWear');
  // Exactly 402 of the template's elements carry no slotType and ALL are
  // facemasks. Matching on slotType alone silently skips the single most
  // position-revealing item on the player.
  check('an untagged GearFaceMask_ falls back to its prefix',
    slotKeyFor({ itemAssetName: 'GearFaceMask_SpeedflexFullcage' }), 'FaceMask');
  check('an untagged unknown asset yields no slot',
    slotKeyFor({ itemAssetName: 'Mystery_Thing' }), null);
  check('an element with no asset yields no slot', slotKeyFor({ slotType: 'Visor' }), null);
}

// --------------------------------------------------------------------
// 2. College gear is read per slot, and face/hair is never gear.
// --------------------------------------------------------------------
{
  const bySlot = cfbGearBySlot(CFB_LOADOUTS);
  check('reads the college glove', bySlot.get('LeftHandWear'), 'GearHand_None');
  check('reads the college facemask', bySlot.get('FaceMask'), 'GearFaceMask_Speedflex2Bar');
  check('hair is not equipment and is skipped', bySlot.has('Hair'), false);
  check('Hair is on the non-gear list', NON_GEAR_SLOTS.has('Hair'), true);
  check('body type is on the non-gear list', NON_GEAR_SLOTS.has('CharacterBodyType'), true);
  check('a null loadout yields nothing', cfbGearBySlot(null).size, 0);
}

// --------------------------------------------------------------------
// 3. Only the PlayerOnField container is located/replaced.
// --------------------------------------------------------------------
{
  const span = findPlayerOnFieldSpan(DONOR);
  const slice = DONOR.slice(span.start, span.end);
  check('the span starts at the container brace', slice.startsWith('{"loadoutType":"PlayerOnField"'), true);
  check('the span is balanced', slice.endsWith(']}'), true);
  check('the span excludes the Base container', slice.includes('CharacterBodyType'), false);
  check('a blob with no PlayerOnField yields null', findPlayerOnFieldSpan('{"a":1}'), null);
}

// --------------------------------------------------------------------
// 4. Positional replacement -- the same asset legitimately appears twice
//    (both gloves, both shoes) and only the targeted element may move.
// --------------------------------------------------------------------
{
  const two = '[{"itemAssetName":"SAME"},{"itemAssetName":"SAME"}]';
  check('replaces only the first when index 0',
    replaceNthAssetName(two, 0, 'NEW'), '[{"itemAssetName":"NEW"},{"itemAssetName":"SAME"}]');
  check('replaces only the second when index 1',
    replaceNthAssetName(two, 1, 'NEW'), '[{"itemAssetName":"SAME"},{"itemAssetName":"NEW"}]');
  check('an out-of-range index changes nothing', replaceNthAssetName(two, 9, 'NEW'), two);
}

// --------------------------------------------------------------------
// 5. The translation itself.
// --------------------------------------------------------------------
{
  const res = translateGearText(TARGET, DONOR, JSON.parse(DONOR), CFB_LOADOUTS, VALID);
  const out = JSON.parse(res.text);
  const onField = out.loadouts.find((l) => l.loadoutType === 'PlayerOnField');
  const bySlot = new Map();
  for (const el of onField.loadoutElements) bySlot.set(slotKeyFor(el), el.itemAssetName);

  check('the college glove is carried across', bySlot.get('LeftHandWear'), 'GearHand_None');
  check('both hands come from the donor structure', bySlot.has('RightHandWear'), true);
  check('the college facemask is carried across', bySlot.get('FaceMask'), 'GearFaceMask_Speedflex2Bar');
  check('the college visor is carried across', bySlot.get('Visor'), 'GearVisor_visorClear');

  // An asset Madden does not have must NEVER be written -- that is the whole
  // reason data/maddenGearAssets.json exists.
  check('an asset absent from Madden is not written', res.text.includes('MadeUpDoesNotExist'), false);
  check('the donor item is kept instead', bySlot.get('BackPlate'), 'Backplate_Standard');

  // The target's own identity must survive: this replaces gear, not the player.
  check("the target's body type is untouched", out.bodyType, 'Thin');
  check("the target's head is untouched", out.genericHeadName, 'gen_2_A_A_01');
  check("the target's skin tone is untouched", out.skinTone, 1);
  const base = out.loadouts.find((l) => l.loadoutCategory === 'Base');
  check("the target's Base container is untouched", base.loadoutElements[0].itemAssetName, 'Thin_BodyType');

  // Float formatting must survive: JSON.parse -> JSON.stringify turns 1.0 into
  // 1, which silently changes bytes in 29 of the template's 402 real blobs.
  check('a float literal in the donor survives verbatim', res.text.includes('"baseBlend":1.0'), true);

  check('it reports what it carried over', res.translated.length, 3);
  check('it reports what Madden could not take', res.skipped.length, 0); // FaceMask2 is not a donor slot
}

// --------------------------------------------------------------------
// 6. Missing college gear degrades to the donor's, never to nothing.
// --------------------------------------------------------------------
{
  const res = translateGearText(TARGET, DONOR, JSON.parse(DONOR), null, VALID);
  const onField = JSON.parse(res.text).loadouts.find((l) => l.loadoutType === 'PlayerOnField');
  check('with no college gear, the donor loadout is adopted whole', onField.loadoutElements.length, 5);
  check('nothing is reported as translated', res.translated.length, 0);
  check('the player still ends up fully equipped',
    onField.loadoutElements.every((e) => !!e.itemAssetName), true);
}

// --------------------------------------------------------------------
// 7. setVisualsText keeps the slot's byte budget -- the invariant that stops
//    a gear write from shifting every later player in the file.
// --------------------------------------------------------------------
{
  const player = {
    json: { raw: Buffer.from(TARGET, 'utf8'), visuals: JSON.parse(TARGET) },
    gap: { raw: Buffer.alloc(500, 0) },
    binary: { raw: Buffer.alloc(200, 0) },
  };
  const slot = player.json.raw.length + player.gap.raw.length;
  const longer = TARGET.replace('"skinTone":1', '"skinTone":11');
  const out = setVisualsText(player, longer);
  check('json+gap is unchanged after a longer write', out.json.raw.length + out.gap.raw.length, slot);
  check('the padding is all zeros', out.gap.raw.every((b) => b === 0), true);
  check('the parsed visuals reflect the new text', out.json.visuals.skinTone, 11);

  assert.throws(() => setVisualsText(player, `${'{"x":"'}${'y'.repeat(slot)}"}`),
    /over the \d+-byte slot/, 'must refuse a replacement that would overflow the slot');
  passed++;
  assert.throws(() => setVisualsText(player, '{not json}'), /not valid JSON/,
    'must refuse a replacement that is not JSON');
  passed++;
  // A raw NUL would terminate the blob early and swallow the zero-padding run the
  // parser uses to find the next record. It is refused -- as invalid JSON first
  // (a bare control character is not legal inside a JSON string), with the
  // explicit NUL check behind it as defence in depth.
  assert.throws(() => setVisualsText(player, ['{"a":"b', 'c"}'].join(String.fromCharCode(0))),
    /not valid JSON|NUL byte/,
    'must refuse a NUL, which would truncate the blob and swallow the padding run');
  passed++;
}

console.log(`\n  Gear translation spec: ${passed} assertions passed.`);
