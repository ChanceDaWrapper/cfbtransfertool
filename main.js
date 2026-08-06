const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  extractLeavingPlayers, generateClass, writeCareerFile,
  loadDepartedCsv, toCsv,
  defaultCfbSavesDir, defaultMaddenSavesDir,
} = require('./lib/pipeline');
const { buildDraftClassFile, TEMPLATE_SLOT_COUNT } = require('./lib/draftClassExporter');
const coachRun = require('./lib/carousel/run');
const { setCfbToneOverridePath, setCoachToneOverride } = require('./lib/carousel/appearance');
const { ConfigStore } = require('./lib/configStore');
const {
  DEFAULT_CONFIG, DESCRIPTIONS, POSITIONS, POSITION_LABELS,
  PHYSICAL_RATINGS, RATING_LABELS, ALL_RATING_COLUMNS,
  PHYSICAL_HIGHLIGHT_ATTRIBUTES, PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION,
  POSITION_KEY_ATTRIBUTES, POWER_CURVE_CATEGORY_META, mergeConfig, enforceMinClassSize,
  activeConfig, foldIntoProfile, TUNING_KEYS, classifyConfigFile, CONFIG_SCHEMA_VERSION,
  isSchemaVersionCompatible, splitKnownTuningKeys,
} = require('./lib/defaults');
// Built-in rating -> category defaults (the structural map the per-rating
// category dropdowns show as each rating's baseline). Sourced from the engine's
// own category module so the UI and the converter can never disagree.
const { CATEGORY_OF } = require('./lib/rosetta/translation/powerCurveCategories');

let mainWindow;
let configStore;

// The extracted CFB player pool is cached here after a successful extract,
// so the user can tweak config and regenerate the class instantly without
// re-reading the (slow) save file each time.
let cachedPool = null;      // array of departed-player rows
let cachedPoolSource = null; // path it came from, shown in the UI
let lastGenerated = null;   // last generated class (for write / export)

// Coach Carousel state, same shape as the player-pipeline cache above.
// lastCoachPlan is the MAIN-PROCESS source of truth for what was actually
// proposed -- coach-commit re-derives which rows to include from it plus a
// renderer-supplied exclusion list, rather than trusting a full plan object
// sent back over IPC, so a commit is always exactly what was reviewed.
let lastCoachPlan = null;
let lastCoachDirection = 'cfbToMadden';
let lastCoachCfbPath = null;
let lastCoachMaddenPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    // Must live under renderer/ (which IS packaged). `build/` is
    // electron-builder's buildResources dir and is deliberately excluded from
    // app.asar, so pointing here at build/icon.ico resolved to a non-existent
    // file in a packaged build -- the window then had no icon and the taskbar
    // button rendered blank, even though the .exe's own embedded icon was fine.
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Windows groups taskbar buttons (and resolves their icon) by AppUserModelID.
  // Without this it defaults to a generic Electron identity, so the running
  // app doesn't match the installed shortcut and the taskbar icon can come out
  // blank/wrong. Must match `build.appId` in package.json.
  if (process.platform === 'win32') app.setAppUserModelId('com.chance.pipeline');
  configStore = new ConfigStore(app.getPath('userData'));
  // Coach tone overrides are USER data, so they can't live in the app bundle --
  // in a packaged build that's inside the read-only app.asar and every write
  // fails with ENOENT. Same userData dir the config already uses.
  setCfbToneOverridePath(path.join(app.getPath('userData'), 'coachToneOverrides.json'));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const sendLog = (msg) => { if (mainWindow) mainWindow.webContents.send('app-log', msg); };

// --- file pickers ------------------------------------------------------

ipcMain.handle('pick-file', async (_e, { title, defaultDir, filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: defaultDir && fs.existsSync(defaultDir) ? defaultDir : undefined,
    properties: ['openFile'],
    filters: filters || undefined,
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle('pick-save-location', async (_e, { defaultPath, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save as',
    defaultPath,
    filters: filters || undefined,
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('default-dirs', async () => ({
  cfb: defaultCfbSavesDir(),
  madden: defaultMaddenSavesDir(),
}));

// --- config ------------------------------------------------------------

// The renderer works with a FLAT config (session keys + one league's tuning
// keys at the top level, exactly the shape this app used before per-league
// profiles existed -- see LEAGUE_PROFILES_ROADMAP.md). Persistence
// (ConfigStore) holds the CANONICAL shape (session + both profiles).
// activeConfig()/foldIntoProfile() are the two-way bridge: flatten on the
// way out to the renderer, fold back into the correct profile (and ONLY that
// profile -- the other league's saved values are never touched) on the way
// back in. This pairs a league's live (saved) values with ITS OWN defaults
// -- e.g. "Reset to defaults" while on UFL should reset to UFL's shipped
// defaults (globalStrength 0.5, boost on), not NFL's.
//
// CONFIG_HARDENING_ROADMAP.md Phase 3 invariant: never hand a flat config
// straight to mergeConfig() and rely on its legacy-flat fallback to sort it
// out -- mergeConfig sees no `profiles` key on a flat object and copies the
// ACTIVE league's values into BOTH profiles (found in generate-class, fixed
// there; see the comment at that handler). Convert explicitly with
// foldIntoProfile() on the way in, activeConfig() on the way out.
function flatConfigAndDefaults(canonical, league) {
  return {
    config: activeConfig(canonical, league),
    defaults: activeConfig(DEFAULT_CONFIG, league),
  };
}

// CONFIG_HARDENING_ROADMAP.md Phase 5. Provenance header stamped onto every
// exported preset (whole-app and per-league alike), so a file carries what
// wrote it and when. Spread onto the exported object's TOP level rather than
// nested -- classifyConfigFile() and the legacy-flat migration path both
// look for their recognized keys (profiles/profile/etc.) at the top level,
// and none of these four names collide with anything in SESSION_KEYS or
// TUNING_KEYS, so nesting would only complicate both without buying safety.
function presetHeader() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    app: 'Pipeline',
    appVersion: app.getVersion(),
    exportedAt: new Date().toISOString(),
  };
}

// Thin throw-on-incompatible wrapper around isSchemaVersionCompatible() (the
// actual decision logic lives in lib/defaults.js, unit tested there without
// needing an Electron context) -- called before classifyConfigFile, since a
// newer schema could in principle use a shape this build's classifier
// misreads.
function rejectIfNewerSchema(parsed) {
  if (isSchemaVersionCompatible(parsed)) return;
  throw new Error(`This file was saved by a newer version of Pipeline (schema ${parsed.schemaVersion}, this build understands up to ${CONFIG_SCHEMA_VERSION}) and can't be safely imported here. Update the app first.`);
}

ipcMain.handle('config-get', () => {
  const canonical = configStore.load();
  return {
    ...flatConfigAndDefaults(canonical, canonical.league),
    descriptions: DESCRIPTIONS,
    positions: POSITIONS,
    positionLabels: POSITION_LABELS,
    physicalRatings: PHYSICAL_RATINGS,
    ratingLabels: RATING_LABELS,
    allRatingColumns: ALL_RATING_COLUMNS,
    physicalHighlightAttributes: PHYSICAL_HIGHLIGHT_ATTRIBUTES,
    physicalHighlightExtraByPosition: PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION,
    positionKeyAttributes: POSITION_KEY_ATTRIBUTES,
    powerCurveCategoryMeta: POWER_CURVE_CATEGORY_META,
    ratingCategoryDefaults: CATEGORY_OF, // { [Rating]: category } -- every convertible rating has an entry
  };
});

// Fetches a SPECIFIC league's flat config + defaults fresh from disk,
// regardless of which one is currently active. Used when the renderer's
// league toggle flips (LEAGUE_PROFILES_ROADMAP.md Phase 2) -- the renderer
// flushes the outgoing league's edits via config-set FIRST, then calls this
// to load the incoming league's real saved values, so a switch can never
// bleed one league's tuning into the other's on-disk profile.
ipcMain.handle('config-get-for-league', (_e, league) => {
  return flatConfigAndDefaults(configStore.load(), league);
});

ipcMain.handle('config-set', (_e, flatConfig) => {
  const folded = foldIntoProfile(configStore.load(), flatConfig);
  const saved = configStore.save(folded);
  return activeConfig(saved, flatConfig.league);
});
// CONFIG_HARDENING_ROADMAP.md Phase 6, finding #9: the old config-reset was
// dead (never called from the renderer) AND league-unaware -- it wiped the
// ENTIRE saved file (both profiles + session settings, via
// ConfigStore.reset()'s unlinkSync) and always returned NFL's view
// regardless of which league was active. Repurposed rather than left dead:
// per-league profiles make "reset THIS league to defaults" a real, useful
// action, so this now resets ONLY the targeted profile.
//
// Deliberately does NOT go through foldIntoProfile() -- that also merges
// SESSION_KEYS from whatever flat config it's given, and
// activeConfig(DEFAULT_CONFIG, league) carries DEFAULT_CONFIG's session
// values (translation.strategy, general.seed/classSize, draftBoard...).
// Folding that in would silently reset the SHARED engine choice, seed,
// class size, and draft board settings too, on a button that's supposed to
// reset only one league's tuning. Replacing profiles[lg] directly touches
// only that.
ipcMain.handle('config-reset-profile', (_e, league) => {
  const lg = league === 'ufl' ? 'ufl' : 'nfl';
  const canonical = configStore.load();
  canonical.profiles[lg] = JSON.parse(JSON.stringify(DEFAULT_CONFIG.profiles[lg]));
  const saved = configStore.save(canonical);
  return flatConfigAndDefaults(saved, lg);
});

// Whole-app-state preset (both leagues' profiles + session settings) --
// superseded for the common case by per-league export/import
// (LEAGUE_PROFILES_ROADMAP.md Phase 4), kept as-is for now as a full backup/
// restore path.
ipcMain.handle('config-export', async (_e, config) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export configuration preset',
    defaultPath: 'draft-config-preset.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const canonical = foldIntoProfile(configStore.load(), config);
  fs.writeFileSync(result.filePath, JSON.stringify({ ...presetHeader(), ...mergeConfig(canonical) }, null, 2));
  return result.filePath;
});

ipcMain.handle('config-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import configuration preset',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
  } catch (e) {
    throw new Error(`Could not read preset: ${e.message}`);
  }
  rejectIfNewerSchema(parsed);
  // CONFIG_HARDENING_ROADMAP.md Phase 1: a single-league file handed straight
  // to configStore.save() used to hit mergeConfig's legacy-flat fallback (no
  // recognized top-level tuning keys -- they're nested under `profile`) and
  // silently reset every setting to defaults, with no error. Classify first.
  const kind = classifyConfigFile(parsed);
  if (kind === 'leagueProfile') {
    throw new Error('This is a single-league settings file. Use "Import League Settings" to apply it to your current league.');
  }
  if (kind === 'unknown') {
    throw new Error('This does not look like a Pipeline settings file.');
  }
  const saved = configStore.save(parsed);
  // The imported file may carry its own `league` -- return that league's
  // config AND matching defaults so the renderer can sync its toggle and
  // "differs from default" indicators, not just the flat config.
  return flatConfigAndDefaults(saved, saved.league);
});

// Per-league export/import (LEAGUE_PROFILES_ROADMAP.md Phase 4) -- ONE
// league's tuning per file, tagged with which league it came from, so a UFL
// setup can be shared without touching anyone's NFL settings (Decision 2:
// "one league per file"). Distinct from config-export/config-import above,
// which round-trip the WHOLE app (both leagues + session settings).
// `league` is the EXPLICIT export target, which may not be the league the
// renderer is currently showing -- both leagues have their own buttons, so
// either can be exported without switching to it first. `flatConfig` is
// still the renderer's live (active-league) config: folding it in first
// means exporting the ACTIVE league picks up edits still sitting in the
// autosave debounce, while exporting the OTHER league reads its saved
// profile, which is the only sensible reading of "export that league."
ipcMain.handle('config-export-profile', async (_e, { flatConfig, league }) => {
  const lg = league === 'ufl' ? 'ufl' : 'nfl';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${lg.toUpperCase()} settings`,
    defaultPath: `${lg}-draft-preset.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const canonical = foldIntoProfile(configStore.load(), flatConfig);
  const profile = {};
  for (const key of TUNING_KEYS) profile[key] = canonical.profiles[lg][key];
  fs.writeFileSync(result.filePath, JSON.stringify({ ...presetHeader(), league: lg, profile }, null, 2));
  return result.filePath;
});

// Split into two steps (LEAGUE_PROFILES_ROADMAP.md Phase 5): pick + read
// the file and hand it back to the renderer to PREVIEW, then a separate
// apply step only once the user confirms in-app. This replaces the earlier
// native dialog.showMessageBox mismatch warning -- the in-app preview shows
// the same mismatch (and every value that would actually change), which is
// strictly more informative than a native yes/no prompt, so the old warning
// dialog was removed rather than kept alongside it.
ipcMain.handle('config-import-profile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import league settings',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
  } catch (e) {
    throw new Error(`Could not read preset: ${e.message}`);
  }
  rejectIfNewerSchema(parsed);
  // Same classifier config-import uses above (CONFIG_HARDENING_ROADMAP.md
  // Phase 1) -- one rule for what each file shape means, on both import paths.
  const kind = classifyConfigFile(parsed);
  if (kind === 'canonical' || kind === 'legacyFlat') {
    throw new Error('This is a whole-app settings file (both leagues). Use "Import All Settings" instead.');
  }
  if (kind === 'unknown') {
    throw new Error('Not a valid league-settings file (expected a single-league export from this app).');
  }
  // CONFIG_HARDENING_ROADMAP.md Phase 5 (closes finding #6): strip anything
  // in the file that isn't a real tuning key -- a hand-edited or foreign
  // file could carry a stray/misspelled/future key that foldIntoProfile
  // would silently drop on apply anyway; stripping it HERE means the
  // preview's diff (built from what this returns) can't list a change that
  // was never actually going to apply. Reported back so the preview can say
  // what it dropped instead of just going quiet about it.
  const { profile, ignoredKeys } = splitKnownTuningKeys(parsed.profile);
  return { league: parsed.league || null, profile, ignoredKeys };
});

// Commits a profile the renderer already previewed. Never called with
// anything the user hasn't explicitly confirmed applying.
ipcMain.handle('config-apply-imported-profile', (_e, { targetLeague, profile }) => {
  const league = targetLeague === 'ufl' ? 'ufl' : 'nfl';
  const folded = foldIntoProfile(configStore.load(), { league, ...profile });
  const saved = configStore.save(folded);
  return flatConfigAndDefaults(saved, league);
});

// --- pipeline ------------------------------------------------------------

ipcMain.handle('extract-pool', async (_e, { sourcePath, sourceType, forceSource }) => {
  try {
    if (sourceType === 'csv') {
      cachedPool = loadDepartedCsv(sourcePath, sendLog);
    } else {
      sendLog('Reading CFB dynasty save (this can take a moment)...');
      // Force EXIT population mode (Season Exit Population): all graduating
      // seniors + real EarlyNFL declarers (~2,500), not just the ~224 officially
      // drafted. Hardcoded rather than read from config on purpose -- a stale
      // 'legacy' left in a persisted config from before the default was flipped
      // was silently pinning users to 224 (the value can also get clobbered back
      // by the renderer's autosave), and legacy mode can't even fill a 402-player
      // draft-class file. Legacy has no UI. When the population/UFL source toggle
      // lands, read the chosen mode here instead of hardcoding.
      const populationMode = 'exit';
      cachedPool = await extractLeavingPlayers(sourcePath, sendLog, { forceSource: forceSource || null, populationMode });
    }
    cachedPoolSource = sourcePath;
    // detectedSource: 'leaving' (official EA declarations) | 'synthesized'
    // (predicted, pre-declaration dynasty) | null for CSV pools, which have no concept of this.
    return { ok: true, count: cachedPool.length, source: sourcePath, detectedSource: cachedPool.source || null };
  } catch (e) {
    cachedPool = null; cachedPoolSource = null;
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('pool-status', () => ({
  loaded: !!cachedPool,
  count: cachedPool ? cachedPool.length : 0,
  source: cachedPoolSource,
}));

ipcMain.handle('generate-class', async (_e, config) => {
  if (!cachedPool) return { ok: false, error: 'No player pool loaded. Load a CFB save or CSV first.' };
  try {
    // CONFIG_HARDENING_ROADMAP.md Phase 3: `config` here is the renderer's
    // FLAT config (one league, possibly with edits not yet autosaved). Fold
    // it into the on-disk CANONICAL shape explicitly rather than handing it
    // to mergeConfig() directly -- mergeConfig sees no `profiles` key on a
    // flat object and takes the legacy-flat migration path, which copies the
    // ACTIVE league's values into BOTH profiles. Harmless for generation
    // today (only the active league is ever read back out), but the
    // resulting object is wrong, and it's exactly the kind of intermediate
    // state a future change reading the OTHER profile off it would silently
    // get corrupted data from. foldIntoProfile uses disk only for context on
    // the inactive profile -- the active profile's values still come
    // entirely from the live (possibly unsaved) `config` passed in, so
    // unsaved edits are still reflected in generation exactly as before.
    const canonical = enforceMinClassSize(foldIntoProfile(configStore.load(), config));
    const players = generateClass(cachedPool, canonical, sendLog);
    lastGenerated = players;
    return { ok: true, players };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('write-career', async (_e, { maddenPath, outputPath }) => {
  if (!lastGenerated) return { ok: false, error: 'Generate a draft class first.' };
  try {
    const stats = await writeCareerFile(maddenPath, outputPath, lastGenerated, sendLog);
    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Draft-class file export (the "Import Draft Class" path). Builds a CAREERDRAFT-*
// file from the generated class by patching the bundled template -- no franchise
// save needed. The file is always 402 players (Madden's own fixed slot count);
// a class smaller than that fills fewer slots and leaves the rest as the
// bundled template's original prospects (see draftClassExporter.js). Only an
// empty class is refused.
ipcMain.handle('export-draft-class-file', async () => {
  if (!lastGenerated) return { ok: false, error: 'Generate a draft class first.' };
  let buffer;
  try {
    // Build first so any error surfaces before we prompt for a save location.
    buffer = buildDraftClassFile(lastGenerated, { log: sendLog });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const defaultDir = defaultMaddenSavesDir();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Madden draft-class file',
    defaultPath: path.join(defaultDir && fs.existsSync(defaultDir) ? defaultDir : '', 'CAREERDRAFT-CFBCLASS'),
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  // Madden's "Import Draft Class" browser only lists files whose name starts with
  // CAREERDRAFT- -- enforce it so the exported file actually shows up in-game, no
  // matter what the user typed in the save dialog (case-insensitive, so a
  // lowercase "careerdraft-" the user typed isn't double-prefixed).
  let outPath = result.filePath;
  const base = path.basename(outPath);
  if (!/^careerdraft-/i.test(base)) outPath = path.join(path.dirname(outPath), `CAREERDRAFT-${base}`);
  try {
    fs.writeFileSync(outPath, buffer);
  } catch (e) {
    return { ok: false, error: `Could not write file: ${e.message}` };
  }
  sendLog(`Exported draft-class file: ${outPath}`);
  return { ok: true, path: outPath, count: Math.min(lastGenerated.length, TEMPLATE_SLOT_COUNT) };
});

ipcMain.handle('export-results', async (_e, { format }) => {
  if (!lastGenerated) return { ok: false, error: 'Nothing to export yet.' };
  const ext = format === 'json' ? 'json' : 'csv';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export draft class',
    defaultPath: `generated-draft-class.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  const data = format === 'json'
    ? JSON.stringify(lastGenerated, null, 2)
    : toCsv(lastGenerated);
  fs.writeFileSync(result.filePath, data);
  return { ok: true, path: result.filePath };
});

// --- coach carousel ------------------------------------------------------
// PIPELINE_APP_INTEGRATION_SPEC.md Part C.2. Mirrors extract-pool /
// generate-class / write-career's shape exactly: {ok:true,...} / {ok:false,
// error} responses, sendLog for progress, and a main-process cache so a
// slow read doesn't have to repeat on every UI interaction.

ipcMain.handle('coach-scan', async (_e, cfbPath) => {
  try {
    const result = await coachRun.scanCoaches(cfbPath);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Madden-side counterpart of coach-scan -- feeds the Manual-mode coach
// picker when the direction is Madden -> CFB.
ipcMain.handle('coach-scan-madden', async (_e, maddenPath) => {
  try {
    const result = await coachRun.scanMaddenCoaches(maddenPath);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('coach-propose', async (_e, { direction, cfbPath, maddenPath, config }) => {
  try {
    sendLog('Proposing coach moves...');
    const { plan, summary } = await coachRun.proposeMoves({ direction, cfbPath, maddenPath, config: config || {}, log: sendLog });
    lastCoachPlan = plan;
    lastCoachDirection = direction || 'cfbToMadden';
    lastCoachCfbPath = cfbPath;
    lastCoachMaddenPath = maddenPath;
    return { ok: true, plan, summary };
  } catch (e) {
    lastCoachPlan = null;
    return { ok: false, error: e.message || String(e) };
  }
});

// excludedSourceRows: sourceRow numbers the reviewer unchecked in the plan
// table. Re-derived onto lastCoachPlan (not a plan the renderer sends back)
// so a commit can never write something other than what coach-propose
// actually computed and logged. direction is NOT accepted from the
// renderer here -- it rides along with lastCoachDirection from whichever
// coach-propose call built the cached plan, so a commit can never target a
// different direction than what was actually reviewed.
ipcMain.handle('coach-commit', async (_e, { outputPath, excludedSourceRows, config }) => {
  if (!lastCoachPlan) return { ok: false, error: 'Propose coach moves first.' };
  try {
    const excluded = new Set(excludedSourceRows || []);
    const plan = lastCoachPlan.map((row) => ({ ...row, included: !excluded.has(row.sourceRow) }));
    const result = await coachRun.commitMoves({
      direction: lastCoachDirection, plan, cfbPath: lastCoachCfbPath, maddenPath: lastCoachMaddenPath, outputPath,
      config: config || {}, log: sendLog,
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Skin Tones (Coach Settings): sets or clears ONE head's tone in the user's own
// overrides file under userData, leaving the shipped data/cfbCoachTones.json
// untouched as the read-only base. See setCoachToneOverride for why this can't
// write into the bundle.
ipcMain.handle('coach-set-tone', async (_e, { headAssetName, tone }) => {
  try {
    setCoachToneOverride(headAssetName, tone);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});
