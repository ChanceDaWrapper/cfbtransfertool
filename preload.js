const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // files
  pickFile: (opts) => ipcRenderer.invoke('pick-file', opts),
  pickSaveLocation: (opts) => ipcRenderer.invoke('pick-save-location', opts),
  defaultDirs: () => ipcRenderer.invoke('default-dirs'),
  // config
  configGet: () => ipcRenderer.invoke('config-get'),
  configSet: (config) => ipcRenderer.invoke('config-set', config),
  configReset: () => ipcRenderer.invoke('config-reset'),
  configExport: (config) => ipcRenderer.invoke('config-export', config),
  configImport: () => ipcRenderer.invoke('config-import'),
  // pipeline
  extractPool: (opts) => ipcRenderer.invoke('extract-pool', opts),
  poolStatus: () => ipcRenderer.invoke('pool-status'),
  generateClass: (config) => ipcRenderer.invoke('generate-class', config),
  writeCareer: (opts) => ipcRenderer.invoke('write-career', opts),
  exportDraftClassFile: () => ipcRenderer.invoke('export-draft-class-file'),
  exportResults: (opts) => ipcRenderer.invoke('export-results', opts),
  // log stream
  onLog: (cb) => ipcRenderer.on('app-log', (_e, msg) => cb(msg)),
});
