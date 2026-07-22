const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  extractLeavingPlayers, generateClass, writeCareerFile,
  loadDepartedCsv, toCsv,
  defaultCfbSavesDir, defaultMaddenSavesDir,
} = require('./lib/pipeline');
const { buildDraftClassFile, TEMPLATE_SLOT_COUNT } = require('./lib/draftClassExporter');
const { ConfigStore } = require('./lib/configStore');
const {
  DEFAULT_CONFIG, DESCRIPTIONS, POSITIONS, POSITION_LABELS,
  PHYSICAL_RATINGS, RATING_LABELS, ALL_RATING_COLUMNS,
  PHYSICAL_HIGHLIGHT_ATTRIBUTES, PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION,
  POSITION_KEY_ATTRIBUTES, POWER_CURVE_CATEGORY_META, mergeConfig, enforceMinClassSize,
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

ipcMain.handle('config-get', () => ({
  config: configStore.load(),
  defaults: DEFAULT_CONFIG,
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
}));

ipcMain.handle('config-set', (_e, config) => configStore.save(config));
ipcMain.handle('config-reset', () => configStore.reset());

ipcMain.handle('config-export', async (_e, config) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export configuration preset',
    defaultPath: 'draft-config-preset.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, JSON.stringify(mergeConfig(config), null, 2));
  return result.filePath;
});

ipcMain.handle('config-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import configuration preset',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    return configStore.save(parsed);
  } catch (e) {
    throw new Error(`Could not read preset: ${e.message}`);
  }
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
    const players = generateClass(cachedPool, enforceMinClassSize(mergeConfig(config)), sendLog);
    lastGenerated = players;
    return { ok: true, players };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('write-career', async (_e, { maddenPath, outputPath, config }) => {
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
