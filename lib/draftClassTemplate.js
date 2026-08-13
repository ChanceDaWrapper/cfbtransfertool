'use strict';

// Loads the app's BUNDLED draft-class templates and returns them as freshly
// parsed models. This is what lets the exporter build a draft class entirely
// from within the app -- no user file dialog, no "export your own first" step
// (FACES_AND_DRAFT_ROADMAP.md Phase 5, decision #2).
//
// There is one template PER TARGET GAME, because a draft-class file's shape is
// game-specific: Madden 27 widened the per-player binary record (200 -> 244
// bytes) and the FirstName field (17 -> 21, shifting every later field by +4),
// and carries its own schema tag. A Madden 26 file handed to Madden 27 is not
// a near-miss -- it is the wrong shape and the wrong tag.
//
// Each template is a real, byte-perfect-round-tripping export captured via
// tools/bakeDraftClassTemplate.js, which picks its output slot from the file's
// own schema tag so one game's template can never overwrite the other's. Only
// each template's structure and non-fillable sections (gear loadouts, face
// blends, header, and -- on M27 -- the per-player ability block) are used from
// it; every fillable field is overwritten per generated player, so the baked-in
// players never surface in real output.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseDraftClassFile } = require('./draftClassFile');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Keyed by the format key draftClassFile.js's detectFormat() returns.
const TEMPLATE_PATHS = {
  m26: path.join(DATA_DIR, 'draftClassTemplate.bin.gz'),
  m27: path.join(DATA_DIR, 'draftClassTemplateM27.bin.gz'),
};

// Which target games the app can actually emit for right now -- i.e. which
// templates are present on disk. The UI reads this so it can only ever offer a
// target it can really build.
const TARGETS = {
  m26: { key: 'm26', label: 'Madden 26', schemaPrefix: 'Madden-26-' },
  m27: { key: 'm27', label: 'Madden 27', schemaPrefix: 'Madden-27-' },
};

const DEFAULT_TARGET = 'm26';

// Cache only the inflated bytes, never the parsed model -- callers mutate the
// model when patching in player data, so each loadTemplateModel() must hand back
// a freshly parsed copy that shares no mutable state with earlier calls.
const cachedBuffers = new Map();

function templatePathFor(target) {
  const p = TEMPLATE_PATHS[target];
  if (!p) throw new Error(`loadTemplate: unknown target game "${target}" (expected one of: ${Object.keys(TEMPLATE_PATHS).join(', ')})`);
  return p;
}

function hasTemplate(target) {
  return !!TEMPLATE_PATHS[target] && fs.existsSync(TEMPLATE_PATHS[target]);
}

// Targets the app can emit today, in a stable order, for the export UI.
function availableTargets() {
  return Object.values(TARGETS).filter((t) => hasTemplate(t.key));
}

function loadTemplateBuffer(target = DEFAULT_TARGET) {
  if (!cachedBuffers.has(target)) {
    const p = templatePathFor(target);
    if (!fs.existsSync(p)) {
      throw new Error(
        `Bundled ${TARGETS[target] ? TARGETS[target].label : target} draft-class template not found at ${p}. `
        + 'Generate it with: node tools/bakeDraftClassTemplate.js <a real exported draft-class file from that game>'
      );
    }
    cachedBuffers.set(target, zlib.gunzipSync(fs.readFileSync(p)));
  }
  return cachedBuffers.get(target);
}

function loadTemplateModel(target = DEFAULT_TARGET) {
  const model = parseDraftClassFile(loadTemplateBuffer(target));
  // A template baked from the wrong game would produce a file the target can't
  // import, and the failure would only show up in-game. Catch it here instead.
  if (model.format.key !== target) {
    throw new Error(
      `Bundled template for "${target}" actually parses as "${model.format.key}" `
      + `(schema tag ${model.header.schemaTag}). Re-bake it from a real ${target} export.`
    );
  }
  return model;
}

module.exports = {
  TEMPLATE_PATHS,
  TARGETS,
  DEFAULT_TARGET,
  hasTemplate,
  availableTargets,
  loadTemplateBuffer,
  loadTemplateModel,
  // Back-compat: the M26 path some older code/tests referenced by name.
  TEMPLATE_PATH: TEMPLATE_PATHS.m26,
};
