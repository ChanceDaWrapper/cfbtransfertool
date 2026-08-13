'use strict';

// Converts an already-exported draft-class file from one Madden to the other.
//
// WHY THIS EXISTS. buildDraftClassFile can emit either game's format, but only
// from a GENERATED class -- it needs the CFB-side fields (FormerTeam's school
// name, the player's college loadouts) that only exist while a dynasty is
// still in hand. A file someone exported months ago, or that another user
// shared, has none of that: it holds the already-written Madden values. So
// converting a file is a different job from building one, and this does it by
// transferring field-by-field between two parsed files rather than
// re-deriving anything.
//
// WHAT THE TWO FORMATS ACTUALLY DIFFER BY (measured against a real export of
// each, not assumed):
//
//   - slot count      402 (M26) vs 389 (M27)
//   - binary record   200 bytes vs 244
//   - field shift     M27's FirstName is 21 bytes rather than 17, pushing
//                     every following field +4
//   - visuals JSON    M26 carries an explicit `skinTone`; M27 dropped it,
//                     because the head asset's own leading digit already
//                     encodes tone (verified 402/402 against M26's field)
//   - head vocabulary 166 distinct heads in the M26 sample, 188 in M27, only
//                     115 shared -- so a third of M26's heads do not exist in
//                     M27 and cannot be copied across
//   - M27-only tail   five ability/trait slots at record offsets 202..210 plus
//                     a byte at 242, which M26 has no equivalent for
//
// Everything else -- position, height, weight, age, jersey, archetype, dev
// trait, projected round/pick, all 55 ratings, and the college index -- means
// the same thing in both games and transfers directly. The college index in
// particular was checked rather than assumed: decoding M27's own export
// through the M26-derived index yields real, position-plausible schools
// (West Virginia, Georgia, Texas, Virginia Tech), so the enum is shared.
//
// HOW THE GAPS ARE FILLED. The destination is the bundled template for the
// target game -- a real, unmodified export of it. Anything the source cannot
// supply comes from a POSITION-MATCHED donor within that template, picked by
// the arriving player's OWN position via the same buildDonorIndex/
// makeDonorPicker machinery buildDraftClassFile already uses for gear -- not
// from whatever the destination's numeric slot happened to hold, which was
// this file's first version and measured at 93% mismatched (4 of 25 QB slots
// keeping QB gear/traits) before this existed:
//
//   - the M27 ability block is copied wholesale from the donor -- there is no
//     M26 source for it at all, so the donor's real values ARE the answer
//   - equipment starts as the donor's whole loadout, then individual items
//     are overwritten with the source player's OWN gear wherever that asset
//     is known to exist in the target game (the identical two-step
//     donor-then-personalize approach buildDraftClassFile uses for a CFB
//     player's gear, just fed a Madden player's own loadout instead)
//   - heads and portraits are re-assigned from the TARGET template's own
//     catalog, matched on the source player's skin tone
//
// SLOT COUNT. Converting M26 -> M27 has 402 players competing for 389 slots.
// Players are ordered by projected draft position and the tail is dropped, so
// what is lost is the bottom of the UDFA pile rather than an arbitrary 13.
// The count is always reported; it is never silent.

const fs = require('fs');
const path = require('path');

const dcf = require('./draftClassFile');
const { loadTemplateModel, availableTargets } = require('./draftClassTemplate');
const { catalogFromTemplate, createAppearanceAssigner } = require('./appearanceCatalog');
const { buildDonorIndex, makeDonorPicker } = require('./draftClassExporter');
const { translateGearText, loadValidAssets, validAssetsFromTemplate } = require('./gearTranslation');

const {
  parseDraftClassFile, serializeDraftClassFile,
  getPosition, setPosition, getHeight, setHeight, getWeight, setWeight,
  getAge, setAge, getJersey, setJersey, getArchetype, setArchetype,
  getDevTrait, setDevTrait, getDraftRound, setDraftRound,
  getDraftPick, setDraftPick, getRatings, setRatings,
  getCollegeIndex, setCollegeIndex, getCharacterBuild,
  getGenericHead, setGenericHead, setSkinTone, setFaceId, getFaceId,
  setBinaryName, setBinaryBytes, setVisualsText,
  getAbilityBlock, setAbilityBlock,
  CHARACTER_BUILD_OFFSET, UNDRAFTED_ROUND,
} = dcf;

// Skin tone lives in the head asset's leading digit in BOTH games
// ("gen_6_M_G_01" -> 6). M26 also stores it explicitly, but the digit is the
// portable one, so it is what this reads.
function toneOf(player) {
  const head = player.json && player.json.visuals && player.json.visuals.genericHeadName;
  const m = /^gen_(\d+)_/.exec(String(head || ''));
  if (m) return Number(m[1]);
  const explicit = player.json && player.json.visuals && player.json.visuals.skinTone;
  return typeof explicit === 'number' ? explicit : null;
}

// Draft order, so that when the target has fewer slots the players who lose
// them are the last ones off the board rather than whoever happened to sit at
// the end of the array. Undrafted sorts last, then by pick.
function draftOrder(a, b) {
  const ra = getDraftRound(a) ?? UNDRAFTED_ROUND;
  const rb = getDraftRound(b) ?? UNDRAFTED_ROUND;
  if (ra !== rb) return ra - rb;
  return (getDraftPick(a) || 0) - (getDraftPick(b) || 0);
}

// Names are fixed-allocation per slot; shrink until one fits rather than
// failing the whole conversion over a long name. Same posture the exporter
// takes for the identical constraint.
function setNameSafe(player, field, value, warn) {
  try {
    return setBinaryName(player, field, value);
  } catch (e) {
    for (let len = value.length - 1; len >= 1; len--) {
      try {
        const out = setBinaryName(player, field, value.slice(0, len));
        warn(`Truncated ${field} "${value}" -> "${value.slice(0, len)}" (slot allocation too small)`);
        return out;
      } catch (e2) { /* keep shrinking */ }
    }
    throw e;
  }
}

// Copies one source player onto one destination template slot. `donor` is a
// TARGET-template player whose ORIGINAL position matches the source player's
// -- picked by the caller via pickDonor(pos) BEFORE any slot is overwritten,
// the same rule buildDraftClassFile's own gear donors follow, and for the
// same reason: picking one afterwards would index the converted class
// against itself.
function transferPlayer(dest, src, assigner, warn, { donor, validAssets, gearStats } = {}) {
  let p = dest;
  const who = `${src.binary.firstName} ${src.binary.lastName}`.trim();

  p = setNameSafe(p, 'firstName', String(src.binary.firstName || ''), warn);
  p = setNameSafe(p, 'lastName', String(src.binary.lastName || ''), warn);

  const pos = getPosition(src);
  if (pos) { try { p = setPosition(p, pos); } catch (e) { warn(`${who}: position -- ${e.message}`); } }

  const arch = getArchetype(src);
  if (arch && Number.isInteger(arch.value)) {
    try { p = setArchetype(p, arch.value); } catch (e) { warn(`${who}: archetype -- ${e.message}`); }
  }
  const dev = getDevTrait(src);
  if (dev && Number.isInteger(dev.value)) {
    try { p = setDevTrait(p, dev.value); } catch (e) { warn(`${who}: dev trait -- ${e.message}`); }
  }

  try { p = setAge(p, getAge(src)); } catch (e) { warn(`${who}: age -- ${e.message}`); }
  try { p = setJersey(p, getJersey(src)); } catch (e) { warn(`${who}: jersey -- ${e.message}`); }
  try { p = setHeight(p, getHeight(src)); } catch (e) { warn(`${who}: height -- ${e.message}`); }
  try { p = setWeight(p, getWeight(src)); } catch (e) { warn(`${who}: weight -- ${e.message}`); }

  const round = getDraftRound(src);
  try { p = setDraftRound(p, round == null || round >= UNDRAFTED_ROUND ? null : round); }
  catch (e) { warn(`${who}: draft round -- ${e.message}`); }
  try { p = setDraftPick(p, getDraftPick(src) || 0); } catch (e) { warn(`${who}: draft pick -- ${e.message}`); }

  try { p = setRatings(p, getRatings(src)); } catch (e) { warn(`${who}: ratings -- ${e.message}`); }

  // Shared enum between the two games -- verified by decoding a real M27
  // export through the M26-derived index and getting real schools back.
  try { p = setCollegeIndex(p, getCollegeIndex(src)); } catch (e) { warn(`${who}: college -- ${e.message}`); }

  // The frame the 3D model renders. Copied as a raw byte because it is the
  // same one-byte build index in both games; the readable bodyType token in
  // the visuals blob is left as the template's, since the two must agree and
  // the template's pair already does.
  try {
    p = setBinaryBytes(p, [{ offset: CHARACTER_BUILD_OFFSET + (p.binary.fieldShift || 0), value: getCharacterBuild(src) }]);
  } catch (e) { warn(`${who}: character build -- ${e.message}`); }

  // Appearance comes from the TARGET's own catalog, matched on the source
  // player's skin tone. Copying the head name across would break for the third
  // of M26 heads Madden 27 does not ship.
  const look = assigner.assign(toneOf(src));
  try { p = setGenericHead(p, look.head); } catch (e) { warn(`${who}: head -- ${e.message}`); }
  try { p = setFaceId(p, look.faceId); } catch (e) { /* M27 leaves faceId 0 for most prospects */ }
  try { p = setSkinTone(p, look.tone); } catch (e) { /* M27 has no skinTone field at all */ }

  // Gear, LAST, same reason applyPlayer's own comment gives -- it rewrites the
  // visuals blob wholesale, so every other visuals write above must land first.
  //
  // Without a donor, the destination slot's gear is simply whatever the
  // TARGET template originally had there -- draft-rank-indexed, not
  // position-matched, which measured at 93% mismatched (4/25 QB slots kept
  // QB gear) before this existed. With one, the position-matched donor's
  // whole loadout is adopted, then individually overwritten wherever the
  // SOURCE player's own gear is an asset the target game is known to have --
  // exactly buildDraftClassFile's own two-step approach (donor first, then
  // overwrite with real gear), just fed the source's own Madden loadout
  // instead of a CFB one. cfbGearBySlot has no CFB-specific behavior; a
  // Madden player's own visuals.loadouts is already that same shape.
  if (donor) {
    try {
      const res = translateGearText(
        p.json.raw.toString('utf8'),
        donor.json.raw.toString('utf8'),
        donor.json.visuals,
        (src.json.visuals && src.json.visuals.loadouts) || [],
        validAssets,
      );
      p = setVisualsText(p, res.text);
      if (gearStats) {
        gearStats.translated += res.translated.length;
        gearStats.kept += res.kept.length;
        gearStats.skipped += res.skipped.length;
        if (res.translated.length) gearStats.playersWithRealGear++;
      }
    } catch (e) {
      warn(`${who}: gear -- ${e.message}`);
      if (gearStats) gearStats.failed++;
    }

    // The M27-only ability block. No M26 source exists for it at all (this
    // player's OWN game never had these bytes), so there is nothing to
    // "overwrite with the real thing" the way gear gets refined -- the
    // position-matched donor's values ARE the whole answer.
    //
    // Uses the same getAbilityBlock/setAbilityBlock pair the draft-class
    // EXPORTER uses. This file previously copied its own hand-listed byte
    // offsets ([202, 204, 206, 208, 210, 242]) instead, which made two
    // implementations of one concept that disagreed about that concept's
    // shape: the exporter treats the block as the whole record tail from 202,
    // this treated it as six specific bytes.
    //
    // Measured before changing it, across three real M27 exports (389 players
    // each) and 388 donor/target pairs: the two produced BYTE-IDENTICAL
    // records every time, so this is not a bug fix. They agreed only because
    // of what the data happens to look like today -- the five values at
    // 202-210 are all <= 63 with a high byte of 0 (so copying just the low
    // byte loses nothing), and every tail byte except 242 is identical across
    // all players (so copying the whole tail moves nothing extra). Either of
    // those could stop being true in a game patch, and then the two paths
    // would silently diverge. One implementation cannot.
    try {
      const donorBlock = getAbilityBlock(donor);
      if (donorBlock) p = setAbilityBlock(p, donorBlock);
    } catch (e) { warn(`${who}: ability block -- ${e.message}`); }
  }

  return p;
}

// Converts `inputBuffer` to `target` ('m26' | 'm27'). Returns the new file
// bytes plus a report of what happened.
function convertDraftClassBuffer(inputBuffer, { target, log = () => {} } = {}) {
  const source = parseDraftClassFile(inputBuffer);
  const sourceKey = source.format.key;

  const known = availableTargets().map((t) => t.key);
  const to = target || (sourceKey === 'm26' ? 'm27' : 'm26');
  if (!known.includes(to)) {
    throw new Error(`convertDraftClass: unknown target "${to}" (expected one of: ${known.join(', ')})`);
  }
  if (to === sourceKey) {
    throw new Error(`convertDraftClass: this file is already ${sourceKey.toUpperCase()} `
      + `(schema tag ${JSON.stringify(source.header.schemaTag)}) -- nothing to convert.`);
  }

  const model = loadTemplateModel(to);
  const slotCount = model.players.length;

  const warnings = [];
  const warn = (m) => { warnings.push(m); log(`  ${m}`); };

  const assigner = createAppearanceAssigner(catalogFromTemplate(model, { faceIdOf: getFaceId }));

  // Donors are indexed from the template BEFORE any slot is overwritten, and
  // picked by the ARRIVING player's own position -- not whichever position
  // used to sit in that numeric slot, which is what "converting" by draft
  // order alone would otherwise inherit. Same rule, same reason, as
  // buildDraftClassFile's own gear donors (see draftClassExporter.js).
  const pristine = model.players.slice();
  const pickDonor = makeDonorPicker(buildDonorIndex(pristine), pristine);

  // Same target-authority rule buildDraftClassFile uses: M26 has a large
  // hand-baked asset list; anything else trusts its own bundled template,
  // since a real export of that game is definitionally a list of assets it
  // ships.
  const validAssets = to === 'm26' ? loadValidAssets() : validAssetsFromTemplate(model);
  const gearStats = { translated: 0, kept: 0, skipped: 0, failed: 0, playersWithRealGear: 0 };

  const ordered = source.players.slice().sort(draftOrder);
  const fill = Math.min(ordered.length, slotCount);

  log(`Converting ${sourceKey.toUpperCase()} -> ${to.toUpperCase()}: `
    + `${source.players.length} players into ${slotCount} slots.`);

  for (let i = 0; i < fill; i++) {
    const donor = pickDonor(getPosition(ordered[i]));
    model.players[i] = transferPlayer(model.players[i], ordered[i], assigner, warn, { donor, validAssets, gearStats });
  }

  if (gearStats.translated || gearStats.failed) {
    log(`Equipment: ${gearStats.playersWithRealGear} of ${fill} players kept some of their own gear `
      + `(${gearStats.translated} items carried over, ${gearStats.skipped} not available in ${to.toUpperCase()}, `
      + `${gearStats.kept} taken from a position-matched ${to.toUpperCase()} player)`
      + (gearStats.failed ? ` -- ${gearStats.failed} could not be written` : ''));
  }

  const dropped = ordered.length - fill;
  if (dropped > 0) {
    const first = ordered[fill];
    log(`${dropped} player(s) did not fit and were dropped -- the last off the board, `
      + `starting with ${first.binary.firstName} ${first.binary.lastName}.`);
  }
  const leftover = slotCount - fill;
  if (leftover > 0) {
    log(`${leftover} slot(s) had no source player and keep the template's own prospects.`);
  }
  if (warnings.length) log(`${warnings.length} field warning(s) -- see above.`);

  return {
    buffer: serializeDraftClassFile(model),
    report: {
      from: sourceKey, to, sourcePlayers: source.players.length,
      slotCount, converted: fill, dropped, leftover, warnings, gearStats,
      sourceSchemaTag: source.header.schemaTag,
    },
  };
}

function convertDraftClassFile(inputPath, outputPath, opts = {}) {
  const { buffer, report } = convertDraftClassBuffer(fs.readFileSync(inputPath), opts);
  // Madden's Import Draft Class browser only lists files named CAREERDRAFT-*.
  let out = outputPath;
  const base = path.basename(out);
  if (!/^careerdraft-/i.test(base)) out = path.join(path.dirname(out), `CAREERDRAFT-${base}`);
  fs.writeFileSync(out, buffer);
  return { ...report, outputPath: out };
}

module.exports = { convertDraftClassBuffer, convertDraftClassFile, toneOf, draftOrder };
