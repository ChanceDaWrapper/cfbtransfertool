// Regression test for MULTI-TARGET draft-class export (Madden 26 / Madden 27).
//
// The exporter builds every class by patching a bundled template, and the two
// games' files are not interchangeable: M27 widened the per-player binary record
// (200 -> 244) and the FirstName field (17 -> 21, shifting every later field by
// +4), carries its own schema tag, and has a different slot count. A file built
// from the wrong template is not a near-miss -- it is the wrong shape and the
// wrong tag, and the only place that would surface is a failed in-game import.
//
// So the properties worth locking are:
//   1. each target emits its OWN format, tag and slot count;
//   2. the generated players actually land (names/position/ratings read back);
//   3. M27's per-player ability block (record offsets 202..211) survives -- it
//      has no M26 equivalent and is never synthesized, only carried from the
//      position-matched donor, so a zeroed block would be a silent regression;
//   4. faces and gear written into a target are assets THAT GAME ships, checked
//      against that game's own template rather than Madden 26's baked lists.
//
// Uses the real bundled templates (this is an integration check -- the point is
// that the shipped assets are right), but a synthetic class, so it needs no save.
// Run: node test/draftClassTargets.spec.js
'use strict';

const assert = require('assert');
const { buildDraftClassFile } = require('../lib/draftClassExporter');
const { loadTemplateModel, availableTargets, hasTemplate } = require('../lib/draftClassTemplate');
const { loadCatalog, catalogFromTemplate } = require('../lib/appearanceCatalog');
const {
  parseDraftClassFile, getPosition, getAge, getHeight, getWeight, getRatings, getDraftRound,
  getFaceId,
} = require('../lib/draftClassFile');
const { RATING_NAMES } = require('../lib/pipeline');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

const POSITIONS = ['QB', 'HB', 'WR', 'TE', 'LT', 'DT', 'CB', 'FS', 'MLB', 'K'];
function makeClass(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = {
      FirstName: `First${i}`, LastName: `Last${i}`, CFB_Position: POSITIONS[i % POSITIONS.length],
      DraftRank: i + 1, ProjectRound: Math.min(7, Math.floor(i / 32) + 1), DraftPick: (i % 32) + 1,
      Age: 22, Height: 73, Weight: 210, JerseyNum: (i % 99) + 1, DevTrait: 'Normal',
      FormerTeam: 'Alabama', Archetype: 0, SkinTone: (i % 7) + 1,
    };
    for (const r of RATING_NAMES) p[`Madden_${r}`] = 60 + (i % 35);
    out.push(p);
  }
  return out;
}

// Everything a given game's real export actually contains -- the only honest
// authority for "will this asset render in that game".
function groundTruth(model) {
  const heads = new Set();
  const gear = new Set();
  for (const p of model.players) {
    const v = (p.json && p.json.visuals) || {};
    if (v.genericHeadName) heads.add(v.genericHeadName);
    for (const lo of (v.loadouts || [])) {
      for (const el of (lo.loadoutElements || [])) {
        if (el.itemAssetName && el.itemAssetName.trim()) gear.add(el.itemAssetName);
      }
    }
  }
  return { heads, gear };
}

const EXPECTED = {
  m26: { tagPrefix: 'Madden-26-', binaryRecordLen: 200, fieldShift: 0 },
  m27: { tagPrefix: 'Madden-27-', binaryRecordLen: 244, fieldShift: 4 },
};

check('both targets are bundled', availableTargets().map((t) => t.key).sort(), ['m26', 'm27']);

for (const target of ['m26', 'm27']) {
  check(`${target} template present`, hasTemplate(target), true);
  const template = loadTemplateModel(target);
  const slots = template.players.length;
  const truth = groundTruth(template);
  const exp = EXPECTED[target];

  const buf = buildDraftClassFile(makeClass(400), { target });
  const model = parseDraftClassFile(buf);

  // 1. the right format came out
  check(`${target} emits its own format`, model.format.key, target);
  check(`${target} emits its own schema tag`, model.header.schemaTag.startsWith(exp.tagPrefix), true);
  check(`${target} record length`, model.format.binaryRecordLen, exp.binaryRecordLen);
  check(`${target} field shift`, model.format.fieldShift, exp.fieldShift);
  check(`${target} slot count matches its template`, model.players.length, slots);

  // 2. the generated players actually landed
  const p0 = model.players[0];
  check(`${target} slot0 name written`, [p0.binary.firstName, p0.binary.lastName], ['First0', 'Last0']);
  check(`${target} slot0 position`, getPosition(p0), 'QB');
  check(`${target} slot0 bio`, [getAge(p0), getHeight(p0), getWeight(p0)], [22, 73, 210]);
  check(`${target} slot0 round`, getDraftRound(p0), 1);
  let ratingsSane = 0;
  for (const p of model.players) {
    if (Object.values(getRatings(p)).every((v) => v <= 99)) ratingsSane++;
  }
  check(`${target} every player's ratings are in range`, ratingsSane, model.players.length);

  // 4. faces and gear are valid FOR THIS GAME
  const outHeads = new Set();
  const outGear = new Set();
  for (const p of model.players) {
    const v = (p.json && p.json.visuals) || {};
    if (v.genericHeadName) outHeads.add(v.genericHeadName);
    for (const lo of (v.loadouts || [])) {
      for (const el of (lo.loadoutElements || [])) {
        if (el.itemAssetName && el.itemAssetName.trim()) outGear.add(el.itemAssetName);
      }
    }
  }
  check(`${target} writes no gear the game doesn't ship`,
    [...outGear].filter((g) => !truth.gear.has(g)), []);

  // Heads: M26 legitimately draws from a catalog baked across FOUR auto-draft
  // files, so it can use real heads absent from the single bundled template --
  // only M27 (whose catalog is derived from its own template) can be held to
  // template-exact head usage.
  if (target === 'm27') {
    check('m27 writes no head the game doesn\'t ship',
      [...outHeads].filter((h) => !truth.heads.has(h)), []);
    // skin tone is the head name's leading digit -- M27 dropped the redundant
    // explicit field, so the head IS the tone and must track what was asked for
    let coherent = 0;
    model.players.forEach((p, i) => {
      const m = /^gen_(\d+)_/.exec((p.json.visuals || {}).genericHeadName || '');
      if (m && Number(m[1]) === ((i % 7) + 1)) coherent++;
    });
    check('m27 head skin digit matches the requested tone for every player',
      coherent, model.players.length);

    // M27_FIELD_FIXES_ROADMAP.md Phase 3. The head-digit check above is not
    // enough on its own: it only proves the 3D head has the right skin, and
    // the reported bug was that the 2D PORTRAIT beside it belonged to someone
    // else entirely. M27 keeps the portrait ID at offset 148 (not the
    // uniformly-shifted 150), and pairs each head with exactly one portrait --
    // 188 heads, 188 portraits, a strict bijection in the real export. So the
    // portrait written for a player must be the one EA ships with the head
    // written for that same player.
    //
    // Sabotage-verified: pointing FACE_ID_OFFSET_BY_FORMAT.m27 back at 150
    // fails this check (389 -> 354 on THIS fixture). The fixture understates
    // the damage badly -- it cycles only 10 positions and 7 tones, so many
    // slots coincidentally keep the head they already had. On a real class the
    // same regression scores 2/224 (0.9%). The blunt range check below is the
    // reliable guard; this one is the readable statement of intent.
    const eaPairing = new Map();
    for (const p of template.players) {
      const h = (p.json.visuals || {}).genericHeadName;
      if (h) eaPairing.set(h, getFaceId(p));
    }
    let portraitMatches = 0;
    for (const p of model.players) {
      const h = (p.json.visuals || {}).genericHeadName;
      if (h && eaPairing.get(h) === getFaceId(p)) portraitMatches++;
    }
    check('m27 portrait is the one EA pairs with that player\'s head',
      portraitMatches, model.players.length);

    // Guards the actual root cause directly: reading the portrait from the
    // uniformly-shifted offset yields a 0..13 enum, never a real portrait ID.
    const portraits = model.players.map(getFaceId);
    check('m27 portraits are real portrait IDs, not the 0..13 enum at offset 150',
      portraits.every((v) => v >= 3347), true);
  }
}

// 3. THE M27-ONLY PROPERTY: the ability block survives the whole build.
{
  const template = loadTemplateModel('m27');
  const readAbilities = (p) => [0, 1, 2, 3, 4].map((i) => p.binary.raw.readUInt16LE(202 + i * 2));
  const templateHasAbilities = template.players.every((p) => readAbilities(p).some((v) => v !== 0));
  check('m27 template itself carries an ability block for every player', templateHasAbilities, true);

  const cls = makeClass(400);
  const model = parseDraftClassFile(buildDraftClassFile(cls, { target: 'm27' }));
  const zeroed = model.players.filter((p) => readAbilities(p).every((v) => v === 0)).length;
  check('no exported m27 player has a zeroed ability block', zeroed, 0);
  check('exported m27 records are still 244 bytes',
    model.players.every((p) => p.binary.raw.length === 244), true);

  // M27_FIELD_FIXES_ROADMAP.md Phase 1. "Not zeroed" alone (the two checks
  // above) is too weak to have caught the real bug: a block inherited from
  // the WRONG position is still nonzero. The block has to trace back to a
  // donor who actually played the position it was written under -- checked
  // here against the real bundled template as ground truth, by mapping every
  // block value in the PRISTINE template to the set of positions it's known
  // to appear under, then confirming every exported player's block resolves
  // to a set that contains the position it was actually written with.
  //
  // Sabotage-verified: skipping the setAbilityBlock call in
  // draftClassExporter.js's applyPlayer (reverting to slot-inherited) drops
  // this from 100% to single digits on this same fixture -- see the roadmap's
  // Phase 1 measurement (204/224 mismatched on a real class).
  const blockOwners = new Map(); // hex block -> Set<position> seen under it in the pristine template
  template.players.forEach((p) => {
    const key = readAbilities(p).join(',');
    if (!blockOwners.has(key)) blockOwners.set(key, new Set());
    blockOwners.get(key).add(getPosition(p));
  });
  // A 400-player class into a 389-slot file fills every slot -- fillCount is
  // the file's own size here, not the class size. Checking against cls.length
  // would demand more matches than there are slots to hold them.
  const fillCount = Math.min(cls.length, model.players.length);
  let positionMatched = 0;
  for (const p of model.players.slice(0, fillCount)) {
    const owners = blockOwners.get(readAbilities(p).join(','));
    if (owners && owners.has(getPosition(p))) positionMatched++;
  }
  check('every exported player\'s ability block traces to a donor of the SAME position',
    positionMatched, fillCount);
}

// A short class must not change the file's slot count for either target.
for (const target of ['m26', 'm27']) {
  const slots = loadTemplateModel(target).players.length;
  const model = parseDraftClassFile(buildDraftClassFile(makeClass(25), { target }));
  check(`${target} short class still emits a full file`, model.players.length, slots);
  check(`${target} short class wrote the players it had`,
    model.players[0].binary.firstName, 'First0');
}

// A CFB player's OWN head must survive into the export when the destination
// game ships it (M27_FIELD_FIXES_ROADMAP.md Phase 3). Madden's head names are
// CFB's with a "gen_" prefix, so a player carrying PLYR_GENERICHEAD "5_B_MS_02"
// must come out wearing "gen_5_B_MS_02" -- not a same-tone substitute.
//
// This is what caught the real bug: a skin-5 tackle was handed a different
// tone-5 head that renders pale. The tone check further up cannot see that,
// because the substitute has the right DIGIT -- only "did he keep his own face"
// distinguishes the two.
for (const target of ['m26', 'm27']) {
  const template = loadTemplateModel(target);
  // Heads sourced from the CATALOG THE EXPORTER ACTUALLY USES, not the raw
  // template. For M27 those are the same thing, but M26's baked catalog
  // deliberately drops template heads whose portrait is blank or whose skin
  // disagrees with the head -- so a template head is not necessarily one the
  // exporter can hand out, and testing against the template asserts something
  // the code never promised.
  const cat = target === 'm26'
    ? loadCatalog()
    : catalogFromTemplate(template, { faceIdOf: getFaceId });
  const realHeads = [];
  for (const bucket of Object.values(cat.bySkin)) {
    for (const pair of bucket.pairs) {
      if (/^gen_\d+_/.test(pair.head) && !realHeads.includes(pair.head)) realHeads.push(pair.head);
      if (realHeads.length >= 20) break;
    }
    if (realHeads.length >= 20) break;
  }
  const cls = makeClass(20);
  cls.forEach((p, i) => {
    // strip the "gen_" prefix -- that is the shape CFB stores
    p.PLYR_GENERICHEAD = realHeads[i].replace(/^gen_/, '');
    // Deliberately request a DIFFERENT tone than the head carries, so a pass
    // can only mean the own-head path ran (a tone-driven pick would land
    // somewhere else).
    p.SkinTone = 1;
  });
  const model = parseDraftClassFile(buildDraftClassFile(cls, { target }));
  let kept = 0;
  for (let i = 0; i < cls.length; i++) {
    if ((model.players[i].json.visuals || {}).genericHeadName === realHeads[i]) kept++;
  }
  check(`${target} keeps a player's own CFB head when the game ships it`, kept, cls.length);

  // ...and the portrait must be the one paired with THAT head, not the tone pick.
  const pairing = new Map();
  for (const bucket of Object.values(cat.bySkin)) {
    for (const pair of bucket.pairs) if (!pairing.has(pair.head)) pairing.set(pair.head, pair.faceId);
  }
  let portraitOk = 0;
  for (let i = 0; i < cls.length; i++) {
    if (getFaceId(model.players[i]) === pairing.get(realHeads[i])) portraitOk++;
  }
  check(`${target} pairs the own-head player with that head's own portrait`, portraitOk, cls.length);

  // A head the game does NOT ship must fall back to a tone-correct substitute
  // rather than writing a name that would render as nothing.
  const bogus = makeClass(5);
  bogus.forEach((p) => { p.PLYR_GENERICHEAD = '9_ZZ_ZZ_99'; p.SkinTone = 6; });
  const fb = parseDraftClassFile(buildDraftClassFile(bogus, { target }));
  const heads = fb.players.slice(0, 5).map((p) => (p.json.visuals || {}).genericHeadName);
  check(`${target} never writes an unknown head verbatim`,
    heads.filter((h) => h === 'gen_9_ZZ_ZZ_99'), []);
  check(`${target} falls back to a head the game actually ships`,
    heads.every((h) => truthHeads(template).has(h)), true);
}

function truthHeads(model) {
  const s = new Set();
  for (const p of model.players) {
    const h = (p.json.visuals || {}).genericHeadName;
    if (h) s.add(h);
  }
  return s;
}

console.log(`\n  Draft-class multi-target spec: ${passed} assertions passed.\n`);
