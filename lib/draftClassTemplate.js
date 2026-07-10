'use strict';

// Loads the app's BUNDLED draft-class template (data/draftClassTemplate.bin.gz)
// and returns it as a fresh parsed model. This is what lets the exporter build a
// draft-class file entirely from within the app -- no user file dialog, no
// "export your own first" step (FACES_AND_DRAFT_ROADMAP.md Phase 5, decision #2).
//
// The template is a real, byte-perfect-round-tripping export captured via
// tools/bakeDraftClassTemplate.js. Only its structure and non-fillable sections
// (gear loadouts, face blends, header) are ever used from it; every fillable
// field is overwritten per generated player, so the baked-in players never
// surface in real output. Re-bake against a fresh export if the bundled
// template ever needs to match a different Madden build's schema tag.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseDraftClassFile } = require('./draftClassFile');

const TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'draftClassTemplate.bin.gz');

// Cache only the inflated bytes, never the parsed model -- callers mutate the
// model when patching in player data, so each loadTemplateModel() must hand back
// a freshly parsed copy that shares no mutable state with earlier calls.
let cachedBuffer = null;

function loadTemplateBuffer() {
  if (!cachedBuffer) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(
        `Bundled draft-class template not found at ${TEMPLATE_PATH}. `
        + 'Generate it with: node tools/bakeDraftClassTemplate.js <a real exported draft-class file>'
      );
    }
    cachedBuffer = zlib.gunzipSync(fs.readFileSync(TEMPLATE_PATH));
  }
  return cachedBuffer;
}

function loadTemplateModel() {
  return parseDraftClassFile(loadTemplateBuffer());
}

module.exports = {
  TEMPLATE_PATH,
  loadTemplateBuffer,
  loadTemplateModel,
};
