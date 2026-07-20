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
} = require('./draftClassFile');
const { loadTemplateModel } = require('./draftClassTemplate');
const { createAppearanceAssigner } = require('./appearanceCatalog');
const { collegeIndexForRef } = require('./collegeIndex');
const { buildCollegeMatcher } = require('./pipeline');

const TEMPLATE_SLOT_COUNT = 402;

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
function applyPlayer(templatePlayer, generatedPlayer, appearanceAssigner, matchCollege, warn) {
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

  return p;
}

// Builds a full CAREERDRAFT-* file from a generated CFB class. Throws (and
// produces nothing) if the class has fewer than 402 players -- the template's
// slot count is fixed, and a partial/duplicate-filled file is worse than no
// file (per user decision, 2026-07-10). Takes the top 402 players by
// `DraftRank` ascending if the class is larger, which is the normal case.
function buildDraftClassFile(generatedClass, options = {}) {
  const log = options.log || (() => {});
  if (!Array.isArray(generatedClass) || generatedClass.length < TEMPLATE_SLOT_COUNT) {
    throw new Error(
      `Draft class has ${Array.isArray(generatedClass) ? generatedClass.length : 0} players; `
      + `a Madden draft-class file needs exactly ${TEMPLATE_SLOT_COUNT}. Raise Class Size / widen `
      + `the source pool and regenerate before exporting.`
    );
  }

  const sorted = generatedClass.slice().sort((a, b) => (a.DraftRank ?? Infinity) - (b.DraftRank ?? Infinity));
  const top = sorted.slice(0, TEMPLATE_SLOT_COUNT);

  const model = loadTemplateModel();
  const appearanceAssigner = createAppearanceAssigner();
  const matchCollege = buildCollegeMatcher();
  for (let i = 0; i < TEMPLATE_SLOT_COUNT; i++) {
    model.players[i] = applyPlayer(model.players[i], top[i], appearanceAssigner, matchCollege, log);
  }

  return serializeDraftClassFile(model);
}

module.exports = {
  TEMPLATE_SLOT_COUNT,
  buildDraftClassFile,
  extractRatings,
};
