'use strict';

// Phase 5d -- full-class emit (FACES_AND_DRAFT_ROADMAP.md "PHASE 5 RESTRUCTURE").
// Builds a complete Madden 26 "Import Draft Class" file from a generated CFB
// class, by patching the bundled template's 402 slots with every field the
// import->read-roster loop confirmed (name, position, archetype, age, jersey,
// height/weight, dev trait, draft round/pick, all ratings, body type, face).
//
// Every field write below uses the loop-confirmed setters in lib/draftClassFile.js
// -- nothing here is a guess. See the roadmap's field-mapping table for how each
// one was ground-truthed.

const {
  serializeDraftClassFile, setBinaryName, setPosition, setArchetype, setAge, setJersey,
  setHeight, setWeight, setDevTrait, setDraftRound, setDraftPick, setRatings, setBodyType,
  setFaceId, setGenericHead, setSkinTone, setCharacterBuild, setCollegeIndex, RATING_OFFSETS,
  setVisualsText, getPosition,
} = require('./draftClassFile');
const { loadTemplateModel } = require('./draftClassTemplate');
const { createAppearanceAssigner } = require('./appearanceCatalog');
const { collegeIndexForRef } = require('./collegeIndex');
const { buildCollegeMatcher } = require('./pipeline');
const { DRAFTED_PICKS } = require('./draftBoard');
const { translateGearText, loadValidAssets } = require('./gearTranslation');

const TEMPLATE_SLOT_COUNT = 402;

// Indexes the template's slots by the position each originally held, so a
// generated player can inherit gear from someone who actually played their
// position. Without this the exporter fills slots by draft rank alone, and gear
// (which it never rewrites) comes from whoever happened to be there -- measured
// at 91% position-mismatched, including 43 of 48 quarterbacks in gloves.
//
// A donor is only a source of ITEMS; nothing is copied from it structurally, and
// the same donor serving several players is fine and expected (gear is not
// unique). Positions with no slot of their own fall back to the whole pool,
// which is no worse than the rank-indexed behaviour this replaces.
function buildDonorIndex(templatePlayers) {
  const byPosition = new Map();
  templatePlayers.forEach((p, i) => {
    const pos = getPosition(p);
    if (!pos) return;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(i);
  });
  return byPosition;
}

// Picks a donor slot for `position`, rotating through the available ones so a
// class doesn't put every quarterback in identical gear. Deterministic in
// draft-rank order -- no RNG, so an unchanged class exports byte-identically.
function makeDonorPicker(donorIndex, templatePlayers) {
  const cursors = new Map();
  const allIndexes = templatePlayers.map((_, i) => i);
  return function pickDonor(position) {
    const pool = donorIndex.get(position) || allIndexes;
    if (!pool.length) return null;
    const n = cursors.get(position) || 0;
    cursors.set(position, n + 1);
    return templatePlayers[pool[n % pool.length]];
  };
}

// Strips the "Madden_" prefix pipeline.js uses on rating field names down to the
// bare names lib/draftClassFile.js's RATING_OFFSETS is keyed by, dropping any
// rating the struct doesn't have a confirmed offset for (setRatings also ignores
// unknown keys, but filtering here keeps the intent explicit).
function extractRatings(generatedPlayer) {
  const out = {};
  for (const key of Object.keys(generatedPlayer)) {
    if (!key.startsWith('Madden_')) continue;
    const bare = key.slice('Madden_'.length);
    if (bare in RATING_OFFSETS) {
      const v = Math.max(0, Math.min(99, Math.round(Number(generatedPlayer[key]) || 0)));
      out[bare] = v;
    }
  }
  return out;
}

// ProjectRound/DraftPick come through as '' (not null) when absent (pipeline.js's
// `?? ''` default) -- normalize to what setDraftRound/setDraftPick expect.
function asIntOrNull(v) { return Number.isInteger(v) ? v : null; }
function asIntOr(v, fallback) { return Number.isInteger(v) ? v : fallback; }

// Writes one generated player's fields onto a cloned template player record.
// Truncates an over-long name to the slot's existing allocation (logged, not
// thrown) rather than failing the whole export over one long name -- the only
// hard error this module raises is the <402-class-size check in
// buildDraftClassFile itself.
function applyPlayer(templatePlayer, generatedPlayer, appearanceAssigner, matchCollege, warn, gear) {
  let p = templatePlayer;

  const setNameSafe = (field, value) => {
    try {
      return setBinaryName(p, field, value);
    } catch (e) {
      // Truncate progressively until it fits this slot's allocation.
      for (let len = value.length - 1; len >= 1; len--) {
        try {
          const truncated = value.slice(0, len);
          const result = setBinaryName(p, field, truncated);
          warn(`Truncated ${field} "${value}" -> "${truncated}" (slot allocation too small)`);
          return result;
        } catch (e2) { /* keep shrinking */ }
      }
      throw e; // could not fit even a 1-character name -- surface the original error
    }
  };

  p = setNameSafe('firstName', String(generatedPlayer.FirstName || ''));
  p = setNameSafe('lastName', String(generatedPlayer.LastName || ''));
  p = setPosition(p, generatedPlayer.CFB_Position);
  if (generatedPlayer.PlayerType) p = setArchetype(p, generatedPlayer.PlayerType);
  p = setAge(p, asIntOr(generatedPlayer.Age, 21));
  p = setJersey(p, asIntOr(generatedPlayer.Jersey, 0));
  p = setHeight(p, asIntOr(generatedPlayer.Height, 72));
  p = setWeight(p, asIntOr(generatedPlayer.Weight, 200));
  if (generatedPlayer.TraitDevelopment) p = setDevTrait(p, generatedPlayer.TraitDevelopment);
  p = setDraftRound(p, asIntOrNull(generatedPlayer.ProjectRound));
  p = setDraftPick(p, asIntOr(generatedPlayer.DraftPick, 0));
  p = setRatings(p, extractRatings(generatedPlayer));
  const who = `${generatedPlayer.FirstName} ${generatedPlayer.LastName}`;
  if (generatedPlayer.CharacterBodyType) {
    // Set BOTH the loadout token (the readable CharacterBodyType attribute) and
    // the offset-141 byte (the frame the 3D model actually renders) -- they are
    // separate and both must agree, per the appearance-model investigation.
    try { p = setBodyType(p, generatedPlayer.CharacterBodyType); }
    catch (e) { warn(`Could not set body type for ${who}: ${e.message}`); }
    try { p = setCharacterBuild(p, generatedPlayer.CharacterBodyType); }
    catch (e) { warn(`Could not set character build for ${who}: ${e.message}`); }
  }

  // Skin-coherent appearance: a portrait faceId and a 3D head of the same skin
  // tone, plus the matching skinTone label, so the draft-board portrait and the
  // in-game model agree on skin (their exact face/hair can still differ -- see
  // lib/appearanceCatalog.js).
  const look = appearanceAssigner.assign(generatedPlayer.SkinTone);
  p = setFaceId(p, look.faceId);
  try { p = setGenericHead(p, look.head); }
  catch (e) { warn(`Could not set head for ${who}: ${e.message}`); }
  try { p = setSkinTone(p, look.tone); }
  catch (e) { /* a few slots have no skinTone field; the faceId + head already carry the tone */ }

  if (generatedPlayer.FormerTeam) {
    const ref = matchCollege(generatedPlayer.FormerTeam);
    const collegeIndex = collegeIndexForRef(ref);
    // Schools outside the baked catalog (~2% of drafted players) keep
    // whichever college the template slot already carried -- wrong, but no
    // worse than before this fix existed, and only ever affects that slot.
    if (collegeIndex != null) p = setCollegeIndex(p, collegeIndex);
  }

  // Equipment, LAST -- it rewrites the visuals blob wholesale, so it must run
  // after every other visuals write (head, skin tone, body type) has landed.
  // It only replaces the PlayerOnField container, leaving those alone, but
  // doing it last means it operates on the final text rather than racing it.
  //
  // Cosmetic by nature, so a failure warns and keeps the donor slot's existing
  // gear rather than failing the export -- the same posture the head/skin
  // writes above take, and the same reasoning the coach-transfer path uses for
  // appearance. A player in the wrong gloves is a blemish; a class that won't
  // export is a broken feature.
  if (gear && gear.donor) {
    try {
      const res = translateGearText(
        p.json.raw.toString('utf8'),
        gear.donor.json.raw.toString('utf8'),
        gear.donor.json.visuals,
        generatedPlayer.CfbLoadouts,
      );
      p = setVisualsText(p, res.text);
      if (gear.stats) {
        gear.stats.translated += res.translated.length;
        gear.stats.kept += res.kept.length;
        gear.stats.skipped += res.skipped.length;
        if (res.translated.length) gear.stats.playersWithRealGear++;
      }
    } catch (e) {
      warn(`Could not set equipment for ${who}: ${e.message}`);
      if (gear.stats) gear.stats.failed++;
    }
  }

  return p;
}

// Builds a full CAREERDRAFT-* file from a generated CFB class. The file is
// always structurally 402 players -- verified against four real Madden 26
// exports (two different game builds) and Madden's own importer requiring
// that exact count -- so it isn't something we can resize. What's tunable is
// how many of those 402 slots get YOUR generated players:
//   - class >= 402: the top 402 by DraftRank fill every slot (unchanged from
//     before -- this is also what a real, unmodified Madden export looks like).
//   - class < 402: only the top `class.length` slots are overwritten. The
//     remaining slots keep the bundled template's original, unconverted
//     prospects (not blank, not duplicated -- just whoever was really there).
// Only an empty/missing class is refused outright; there's nothing to build.
function buildDraftClassFile(generatedClass, options = {}) {
  const log = options.log || (() => {});
  if (!Array.isArray(generatedClass) || generatedClass.length < 1) {
    throw new Error('Draft class is empty -- generate a class before exporting.');
  }

  const sorted = generatedClass.slice().sort((a, b) => (a.DraftRank ?? Infinity) - (b.DraftRank ?? Infinity));
  const fillCount = Math.min(sorted.length, TEMPLATE_SLOT_COUNT);
  const top = sorted.slice(0, fillCount);

  const model = loadTemplateModel();
  const appearanceAssigner = createAppearanceAssigner();
  const matchCollege = buildCollegeMatcher();

  // Gear donors are chosen from the template BEFORE any slot is overwritten --
  // applyPlayer rewrites the position byte, so reading donors afterwards would
  // index the generated class against itself.
  const pristine = model.players.slice();
  const pickDonor = makeDonorPicker(buildDonorIndex(pristine), pristine);
  const gearStats = { translated: 0, kept: 0, skipped: 0, failed: 0, playersWithRealGear: 0 };

  for (let i = 0; i < fillCount; i++) {
    const donor = pickDonor(top[i].CFB_Position);
    model.players[i] = applyPlayer(
      model.players[i], top[i], appearanceAssigner, matchCollege, log,
      { donor, stats: gearStats },
    );
  }

  if (gearStats.translated || gearStats.failed) {
    log(`Equipment: ${gearStats.playersWithRealGear} of ${fillCount} players kept some of their real college gear `
      + `(${gearStats.translated} items carried over, ${gearStats.skipped} not available in Madden, `
      + `${gearStats.kept} taken from a position-matched pro)`
      + (gearStats.failed ? ` -- ${gearStats.failed} could not be written` : ''));
  }
  if (!loadValidAssets().size) {
    log('WARNING: data/maddenGearAssets.json is missing or unreadable -- players kept position-matched '
      + 'gear but none of their own college equipment was carried over.');
  }

  if (fillCount < TEMPLATE_SLOT_COUNT) {
    const leftover = TEMPLATE_SLOT_COUNT - fillCount;
    let msg = `Only ${fillCount} of the file's ${TEMPLATE_SLOT_COUNT} slots were filled with your generated `
      + `players -- the remaining ${leftover} keep the bundled template's original, unconverted prospects.`;
    if (fillCount < DRAFTED_PICKS) {
      const firstAffectedRound = Math.floor(fillCount / 32) + 1;
      msg += ` Your class is smaller than the ${DRAFTED_PICKS} drafted picks (7 rounds), so round `
        + `${firstAffectedRound} onward will ALSO include unconverted template prospects, not just the UDFA tail.`;
    }
    log(`WARNING: ${msg}`);
  }

  return serializeDraftClassFile(model);
}

module.exports = {
  TEMPLATE_SLOT_COUNT,
  buildDraftClassFile,
  extractRatings,
};
