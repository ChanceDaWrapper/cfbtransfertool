// Persists the user's generation config as JSON in Electron's per-user data
// directory, so settings survive app restarts and rebuilds. Always merged
// over DEFAULT_CONFIG on load so partial/old files never break anything.

const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG, mergeConfig, enforceMinClassSize } = require('./defaults');

class ConfigStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'generation-config.json');
  }

  load() {
    try {
      return enforceMinClassSize(mergeConfig(JSON.parse(fs.readFileSync(this.file, 'utf-8'))));
    } catch (e) {
      return enforceMinClassSize(mergeConfig(null)); // fresh copy of defaults
    }
  }

  save(config) {
    const merged = enforceMinClassSize(mergeConfig(config));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(merged, null, 2));
    return merged;
  }

  reset() {
    try { fs.unlinkSync(this.file); } catch (e) { /* already gone */ }
    return enforceMinClassSize(mergeConfig(null));
  }
}

module.exports = { ConfigStore, DEFAULT_CONFIG };
