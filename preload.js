const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // files
  pickFile: (opts) => ipcRenderer.invoke('pick-file', opts),
  pickSaveLocation: (opts) => ipcRenderer.invoke('pick-save-location', opts),
  defaultDirs: () => ipcRenderer.invoke('default-dirs'),
  // config
  configGet: () => ipcRenderer.invoke('config-get'),
  configGetForLeague: (league) => ipcRenderer.invoke('config-get-for-league', league),
  configSet: (config) => ipcRenderer.invoke('config-set', config),
  configResetProfile: (league) => ipcRenderer.invoke('config-reset-profile', league),
  configExport: (config) => ipcRenderer.invoke('config-export', config),
  configImport: () => ipcRenderer.invoke('config-import'),
  configExportProfile: (flatConfig, league) => ipcRenderer.invoke('config-export-profile', { flatConfig, league }),
  configImportProfile: () => ipcRenderer.invoke('config-import-profile'),
  configApplyImportedProfile: (targetLeague, profile) => ipcRenderer.invoke('config-apply-imported-profile', { targetLeague, profile }),
  // pipeline
  extractPool: (opts) => ipcRenderer.invoke('extract-pool', opts),
  poolStatus: () => ipcRenderer.invoke('pool-status'),
  generateClass: (config) => ipcRenderer.invoke('generate-class', config),
  customPlayerCheck: (spec) => ipcRenderer.invoke('custom-player-check', spec),
  writeCareer: (opts) => ipcRenderer.invoke('write-career', opts),
  exportDraftClassFile: (target) => ipcRenderer.invoke('export-draft-class-file', { target }),
  exportDraftClassDirect: (target) => ipcRenderer.invoke('export-draft-class-direct', { target }),
  exportTargets: () => ipcRenderer.invoke('export-targets'),
  exportResults: (opts) => ipcRenderer.invoke('export-results', opts),
  // coach carousel
  coachScan: (cfbPath) => ipcRenderer.invoke('coach-scan', cfbPath),
  coachScanMadden: (maddenPath) => ipcRenderer.invoke('coach-scan-madden', maddenPath),
  coachPropose: (opts) => ipcRenderer.invoke('coach-propose', opts),
  coachCommit: (opts) => ipcRenderer.invoke('coach-commit', opts),
  coachSetTone: (opts) => ipcRenderer.invoke('coach-set-tone', opts),
  // log stream
  onLog: (cb) => ipcRenderer.on('app-log', (_e, msg) => cb(msg)),
});
