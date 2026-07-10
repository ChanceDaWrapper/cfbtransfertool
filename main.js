const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  extractLeavingPlayers, generateClass, writeCareerFile,
  loadDepartedCsv, toCsv,
  defaultCfbSavesDir, defaultMaddenSavesDir,
} = require('./lib/pipeline');
const { ConfigStore } = require('./lib/configStore');
const {
  DEFAULT_CONFIG, DESCRIPTIONS, POSITIONS, POSITION_LABELS,
  PHYSICAL_RATINGS, RATING_LABELS, ALL_RATING_COLUMNS,
  PHYSICAL_HIGHLIGHT_ATTRIBUTES, PHYSICAL_HIGHLIGHT_EXTRA_BY_POSITION,
  POSITION_KEY_ATTRIBUTES, POWER_CURVE_CATEGORY_META, mergeConfig,
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
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
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
      // populationMode isn't user-facing yet -- read from the persisted
      // config so it's settable via an imported preset for validation, per
      // the Rosetta migration's feature-flag rule (defaults to 'legacy').
      const populationMode = configStore.load().population?.mode || 'legacy';
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
    const players = generateClass(cachedPool, config, sendLog);
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
