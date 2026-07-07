/* Renderer for the CFB Transfer draft-class studio.
 * State lives here; all heavy lifting happens in the main process over IPC.
 * Config edits autosave (debounced) and regenerate marks results stale. */

let META = null;        // { config, defaults, descriptions, positions, ... } from main
let cfg = null;         // live editable config
let players = [];       // last generated class
let sortKey = 'Rank', sortDir = 1;

// Columns hidden by the "Hide Adjusted Stats" toggle -- lets a user look at
// a class without seeing the direct payoff of whatever they just tuned.
const HIDDEN_WHEN_TOGGLED = new Set([
  'DevTrait', 'Madden_SpeedRating', 'Madden_StrengthRating', 'Madden_AgilityRating', 'Madden_AwarenessRating',
]);
let hideStats = localStorage.getItem('hideAdjustedStats') === 'true';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ---------------- toast + log ---------------- */
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function appendLog(msg) {
  const log = $('log');
  log.textContent += (log.textContent ? '\n' : '') + msg;
  log.scrollTop = log.scrollHeight;
}
window.api.onLog(appendLog);
$('clearLog').addEventListener('click', () => { $('log').textContent = ''; });

/* ---------------- navigation ---------------- */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $('page-' + btn.dataset.page).classList.add('active');
  });
});
function gotoPage(name) { document.querySelector(`.nav-item[data-page="${name}"]`).click(); }

/* ---------------- config autosave ---------------- */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.api.configSet(cfg);
    markResultsStale();
  }, 350);
}

let resultsStale = false;
function markResultsStale() {
  if (!players.length) return;
  resultsStale = true;
  $('resultsSummary').textContent =
    `${players.length} players — settings changed since generation. Hit Regenerate to apply.`;
}

/* ---------------- numeric knob helper ---------------- */
function numberInput(value, { step = 1, min, max, blankable = false } = {}, onChange) {
  const inp = el('input');
  inp.type = 'number';
  if (step !== null) inp.step = step;
  if (min !== undefined) inp.min = min;
  if (max !== undefined) inp.max = max;
  inp.value = value === null || value === undefined || value === '' ? '' : value;
  inp.addEventListener('input', () => {
    if (inp.value === '') {
      if (blankable) { onChange(null); scheduleSave(); }
      return;
    }
    const v = Number(inp.value);
    if (!Number.isFinite(v)) return;
    onChange(v);
    scheduleSave();
  });
  return inp;
}

function knob(labelText, desc, input) {
  const k = el('div', 'knob');
  const top = el('div', 'knob-top');
  top.appendChild(el('span', 'knob-label', labelText));
  top.appendChild(input);
  k.appendChild(top);
  if (desc) k.appendChild(el('span', 'knob-desc', desc));
  return k;
}

/* ---------------- page builders ---------------- */
function buildWeightsPage() {
  const tbody = $('weightsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const pos of META.positions) {
    const tr = el('tr');

    const tdCode = el('td'); tdCode.appendChild(el('span', 'pos-code', pos)); tr.appendChild(tdCode);
    tr.appendChild(el('td', 'pos-label', META.positionLabels[pos] || pos));

    const tdDrop = el('td');
    const dropInput = numberInput(cfg.positionExtraDrop[pos], { step: 0.5, min: -20, max: 30 }, (v) => {
      cfg.positionExtraDrop[pos] = v;
      dot.style.visibility = v !== META.defaults.positionExtraDrop[pos] ? 'visible' : 'hidden';
    });
    dropInput.title = META.descriptions.positionExtraDrop;
    tdDrop.appendChild(dropInput);
    tdDrop.appendChild(el('span', 'default-ref', `default ${META.defaults.positionExtraDrop[pos]}`));
    const dot = el('span', 'modified-dot', '●');
    dot.title = 'Modified from default';
    dot.style.visibility = cfg.positionExtraDrop[pos] !== META.defaults.positionExtraDrop[pos] ? 'visible' : 'hidden';
    tdDrop.appendChild(dot);
    tr.appendChild(tdDrop);

    const tdCap = el('td');
    const capInput = numberInput(cfg.positionCaps[pos] ?? '', { step: 1, min: 0, max: 99, blankable: true }, (v) => {
      if (v === null || v === 0) delete cfg.positionCaps[pos];
      else cfg.positionCaps[pos] = v;
    });
    capInput.placeholder = '—';
    capInput.title = META.descriptions.positionCaps;
    tdCap.appendChild(capInput);
    const defCap = META.defaults.positionCaps[pos];
    if (defCap) tdCap.appendChild(el('span', 'default-ref', `default ${defCap}`));
    tr.appendChild(tdCap);

    tbody.appendChild(tr);
  }
}

function buildPhysicalPage() {
  const g = $('physicalGlobals');
  g.innerHTML = '';
  const D = META.descriptions;
  g.appendChild(knob('Drop Leniency', D['general.dropLeniency'],
    numberInput(cfg.general.dropLeniency, { step: 0.05, min: 0, max: 2 }, (v) => { cfg.general.dropLeniency = v; })));
  g.appendChild(knob('Default Drop', D['general.defaultDrop'],
    numberInput(cfg.general.defaultDrop, { step: 1, min: 0, max: 40 }, (v) => { cfg.general.defaultDrop = v; })));
  g.appendChild(knob('Physical Jitter', D['general.calibrationJitter'],
    numberInput(cfg.general.calibrationJitter, { step: 0.5, min: 0, max: 15 }, (v) => { cfg.general.calibrationJitter = v; })));
  g.appendChild(knob('Skill Jitter', D['general.quantileJitter'],
    numberInput(cfg.general.quantileJitter, { step: 0.5, min: 0, max: 15 }, (v) => { cfg.general.quantileJitter = v; })));

  const tbody = $('ratingsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const rating of META.physicalRatings) {
    const adj = cfg.ratingAdjustments[rating];
    const def = META.defaults.ratingAdjustments[rating];
    const tr = el('tr');

    const tdName = el('td');
    tdName.appendChild(el('span', 'pos-code', META.ratingLabels[rating] || rating));
    tr.appendChild(tdName);

    const tdDrop = el('td');
    const dropIn = numberInput(adj.extraDrop, { step: 0.5, min: -20, max: 30 }, (v) => { adj.extraDrop = v; });
    dropIn.title = META.descriptions['ratingAdjustments.extraDrop'];
    tdDrop.appendChild(dropIn);
    tdDrop.appendChild(el('span', 'default-ref', `default ${def.extraDrop}`));
    tr.appendChild(tdDrop);

    const tdJit = el('td');
    const jitIn = numberInput(adj.jitter, { step: 0.5, min: 0, max: 15, blankable: true }, (v) => { adj.jitter = v; });
    jitIn.placeholder = 'global';
    jitIn.title = META.descriptions['ratingAdjustments.jitter'];
    tdJit.appendChild(jitIn);
    if (def.jitter !== null) tdJit.appendChild(el('span', 'default-ref', `default ${def.jitter}`));
    tr.appendChild(tdJit);

    const tdMax = el('td');
    const maxIn = numberInput(adj.maxDrop, { step: 1, min: 0, max: 50, blankable: true }, (v) => { adj.maxDrop = v; });
    maxIn.placeholder = 'none';
    maxIn.title = META.descriptions['ratingAdjustments.maxDrop'];
    tdMax.appendChild(maxIn);
    if (def.maxDrop !== null) tdMax.appendChild(el('span', 'default-ref', `default ${def.maxDrop}`));
    tr.appendChild(tdMax);

    tbody.appendChild(tr);
  }
}

function buildAdvancedPage() {
  const D = META.descriptions;

  const g = $('advGeneral');
  g.innerHTML = '';
  g.appendChild(knob('Class Size', D['general.classSize'],
    numberInput(cfg.general.classSize, { step: 10, min: 1, max: 1000 }, (v) => { cfg.general.classSize = v; })));
  const seedIn = el('input');
  seedIn.type = 'text';
  seedIn.placeholder = 'random';
  seedIn.value = cfg.general.seed || '';
  seedIn.addEventListener('input', () => { cfg.general.seed = seedIn.value.trim(); scheduleSave(); });
  g.appendChild(knob('Seed', D['general.seed'], seedIn));
  g.appendChild(knob('K/P Awareness Cap', D.kpAwarenessCap,
    numberInput(cfg.kpAwarenessCap, { step: 1, min: 0, max: 99 }, (v) => { cfg.kpAwarenessCap = v; })));

  const b = $('advBell');
  b.innerHTML = '';
  b.appendChild(knob('Peak Percentile', D['bell.peakPercentile'],
    numberInput(cfg.bell.peakPercentile, { step: 0.05, min: 0, max: 1 }, (v) => { cfg.bell.peakPercentile = v; })));
  b.appendChild(knob('Peak Extra Drop', D['bell.peakExtraDrop'],
    numberInput(cfg.bell.peakExtraDrop, { step: 1, min: 0, max: 40 }, (v) => { cfg.bell.peakExtraDrop = v; })));
  b.appendChild(knob('Spread Below Peak', D['bell.spreadBelow'],
    numberInput(cfg.bell.spreadBelow, { step: 0.01, min: 0.01, max: 1 }, (v) => { cfg.bell.spreadBelow = v; })));
  b.appendChild(knob('Spread Above Peak', D['bell.spreadAbove'],
    numberInput(cfg.bell.spreadAbove, { step: 0.01, min: 0.01, max: 1 }, (v) => { cfg.bell.spreadAbove = v; })));

  const d = $('advDev');
  d.innerHTML = '';
  d.appendChild(knob('X-Factor Min Overall', D['devTraits.xfactorMinOverall'],
    numberInput(cfg.devTraits.xfactorMinOverall, { step: 1, min: 50, max: 99 }, (v) => { cfg.devTraits.xfactorMinOverall = v; })));
  d.appendChild(knob('Superstar Count', D['devTraits.superstarCount'],
    numberInput(cfg.devTraits.superstarCount, { step: 1, min: 0, max: 50 }, (v) => { cfg.devTraits.superstarCount = v; })));
  d.appendChild(knob('Star Target %', D['devTraits.starPercentTarget'],
    numberInput(cfg.devTraits.starPercentTarget, { step: 1, min: 0, max: 100 }, (v) => { cfg.devTraits.starPercentTarget = v; })));
}

function rebuildAllPages() {
  buildWeightsPage();
  buildPhysicalPage();
  buildAdvancedPage();
}

/* ---------------- section resets ---------------- */
async function resetSection(mutate) {
  mutate();
  cfg = await window.api.configSet(cfg);
  rebuildAllPages();
  markResultsStale();
  toast('Reset to defaults');
}
$('resetWeights').addEventListener('click', () => resetSection(() => {
  cfg.positionExtraDrop = JSON.parse(JSON.stringify(META.defaults.positionExtraDrop));
  cfg.positionCaps = JSON.parse(JSON.stringify(META.defaults.positionCaps));
}));
$('resetPhysical').addEventListener('click', () => resetSection(() => {
  cfg.ratingAdjustments = JSON.parse(JSON.stringify(META.defaults.ratingAdjustments));
  cfg.general.dropLeniency = META.defaults.general.dropLeniency;
  cfg.general.defaultDrop = META.defaults.general.defaultDrop;
  cfg.general.calibrationJitter = META.defaults.general.calibrationJitter;
  cfg.general.quantileJitter = META.defaults.general.quantileJitter;
}));
$('resetAdvanced').addEventListener('click', () => resetSection(() => {
  cfg.bell = JSON.parse(JSON.stringify(META.defaults.bell));
  cfg.devTraits = JSON.parse(JSON.stringify(META.defaults.devTraits));
  cfg.general.classSize = META.defaults.general.classSize;
  cfg.general.seed = META.defaults.general.seed;
  cfg.kpAwarenessCap = META.defaults.kpAwarenessCap;
}));

/* ---------------- presets ---------------- */
$('presetExport').addEventListener('click', async () => {
  const p = await window.api.configExport(cfg);
  if (p) toast('Preset exported');
});
$('presetImport').addEventListener('click', async () => {
  try {
    const imported = await window.api.configImport();
    if (imported) {
      cfg = imported;
      rebuildAllPages();
      markResultsStale();
      toast('Preset imported');
    }
  } catch (e) {
    toast(e.message || 'Import failed', true);
  }
});

/* ---------------- dashboard: pool + generate + write ---------------- */
let defaultDirs = { cfb: null, madden: null };
let maddenPath = null, outputPath = null, outMode = 'edit';

function setPoolStatus(text, cls) {
  const c = $('poolStatus');
  c.textContent = text;
  c.className = 'status-chip ' + (cls || 'empty');
}
function setGenStatus(text, cls) {
  const c = $('genStatus');
  c.textContent = text;
  c.className = 'status-chip ' + (cls || 'empty');
}

async function loadPool(sourceType) {
  const file = await window.api.pickFile(sourceType === 'csv'
    ? { title: 'Select departed-players CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] }
    : { title: 'Select your CFB 27 dynasty save', defaultDir: defaultDirs.cfb });
  if (!file) return;
  setPoolStatus('Loading…', 'busy');
  const res = await window.api.extractPool({ sourcePath: file, sourceType });
  if (res.ok) {
    setPoolStatus(`${res.count} players loaded — ${res.source.split(/[\\/]/).pop()}`, 'ok');
    $('generateBtn').disabled = false;
    toast(`Pool loaded: ${res.count} players`);
  } else {
    setPoolStatus('Load failed', 'err');
    appendLog('ERROR: ' + res.error);
    toast(res.error, true);
  }
}
$('loadSave').addEventListener('click', () => loadPool('save'));
$('loadCsv').addEventListener('click', () => loadPool('csv'));

async function generate() {
  setGenStatus('Generating…', 'busy');
  const res = await window.api.generateClass(cfg);
  if (res.ok) {
    players = res.players;
    resultsStale = false;
    setGenStatus(`${players.length} players generated`, 'ok');
    $('viewResultsBtn').disabled = false;
    $('regenerateBtn').disabled = false;
    $('exportCsvBtn').disabled = false;
    $('exportJsonBtn').disabled = false;
    $('writeBtn').disabled = !maddenPath || (outMode === 'copy' && !outputPath);
    renderResults();
    toast(`Generated ${players.length}-player class`);
  } else {
    setGenStatus('Generation failed', 'err');
    appendLog('ERROR: ' + res.error);
    toast(res.error, true);
  }
}
$('generateBtn').addEventListener('click', generate);
$('regenerateBtn').addEventListener('click', generate);
$('viewResultsBtn').addEventListener('click', () => gotoPage('results'));

$('pickMadden').addEventListener('click', async () => {
  const file = await window.api.pickFile({ title: 'Select your Madden 26 franchise save', defaultDir: defaultDirs.madden });
  if (!file) return;
  maddenPath = file;
  $('maddenPathInput').value = file;
  if (outMode === 'edit') outputPath = file;
  updateWriteEnabled();
});

document.querySelectorAll('input[name="outMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    outMode = e.target.value;
    const showCopy = outMode === 'copy';
    $('pickOutput').style.display = showCopy ? '' : 'none';
    $('outputPathInput').style.display = showCopy ? '' : 'none';
    if (!showCopy) outputPath = maddenPath;
    else { outputPath = null; $('outputPathInput').value = ''; }
    updateWriteEnabled();
  });
});

$('pickOutput').addEventListener('click', async () => {
  if (!maddenPath) { toast('Pick the Madden save first', true); return; }
  const file = await window.api.pickSaveLocation({ defaultPath: maddenPath + '-CFB-GENERATED' });
  if (!file) return;
  outputPath = file;
  $('outputPathInput').value = file;
  updateWriteEnabled();
});

function updateWriteEnabled() {
  $('writeBtn').disabled = !(players.length && maddenPath && (outMode === 'edit' ? true : !!outputPath));
}

$('writeBtn').addEventListener('click', async () => {
  const st = $('writeStatus');
  if (outMode === 'edit') {
    const sure = confirm(`This will OVERWRITE the franchise file in place:\n\n${maddenPath}\n\nMake sure you have a backup. Continue?`);
    if (!sure) return;
  }
  st.textContent = 'Writing…'; st.className = 'inline-status';
  $('writeBtn').disabled = true;
  const res = await window.api.writeCareer({ maddenPath, outputPath: outputPath || maddenPath, config: cfg });
  if (res.ok) {
    st.textContent = `Done — ${res.stats.written} players written.`;
    st.className = 'inline-status ok';
    toast('Franchise file saved');
  } else {
    st.textContent = res.error;
    st.className = 'inline-status err';
    toast(res.error, true);
  }
  $('writeBtn').disabled = false;
});

/* ---------------- results table ---------------- */
const COLUMNS = [
  { key: 'Rank', label: '#', num: true },
  { key: 'FirstName', label: 'First' },
  { key: 'LastName', label: 'Last' },
  { key: 'CFB_Position', label: 'Pos' },
  { key: 'FormerTeam', label: 'College' },
  { key: 'ProjectRound', label: 'Rd', num: true },
  { key: 'CFB_Overall', label: 'CFB OVR', num: true },
  { key: 'DevTrait', label: 'Dev' },
  { key: 'Age', label: 'Age', num: true },
  { key: 'Height', label: 'Ht', num: true },
  { key: 'Weight', label: 'Wt', num: true },
  { key: 'Madden_SpeedRating', label: 'SPD', num: true },
  { key: 'Madden_StrengthRating', label: 'STR', num: true },
  { key: 'Madden_AgilityRating', label: 'AGI', num: true },
  { key: 'Madden_AwarenessRating', label: 'AWR', num: true },
];

function formatHeight(h) {
  const n = Number(h);
  if (!n) return '';
  return `${Math.floor(n / 12)}'${n % 12}"`;
}

function visibleColumns() {
  return hideStats ? COLUMNS.filter((c) => !HIDDEN_WHEN_TOGGLED.has(c.key)) : COLUMNS;
}

function buildResultsHeader() {
  const thead = $('resultsTable').querySelector('thead');
  thead.innerHTML = '';
  const tr = el('tr');
  for (const col of visibleColumns()) {
    const th = el('th');
    th.textContent = col.label;
    if (sortKey === col.key) {
      const arrow = el('span', 'sort-arrow', sortDir === 1 ? '▲' : '▼');
      th.appendChild(arrow);
    }
    th.addEventListener('click', () => {
      if (sortKey === col.key) sortDir = -sortDir;
      else { sortKey = col.key; sortDir = col.num ? 1 : 1; }
      renderResults();
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
}

function renderResults() {
  const cols = visibleColumns();
  if (!cols.some((c) => c.key === sortKey)) { sortKey = 'Rank'; sortDir = 1; }
  buildResultsHeader();
  const tbody = $('resultsTable').querySelector('tbody');
  tbody.innerHTML = '';

  const q = $('searchBox').value.trim().toLowerCase();
  const fPos = $('filterPos').value;
  const fRound = $('filterRound').value;
  const fDev = $('filterDev').value;

  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : 8; };

  let rows = players.filter((p) => {
    if (q && !(`${p.FirstName} ${p.LastName}`.toLowerCase().includes(q) || String(p.FormerTeam).toLowerCase().includes(q))) return false;
    if (fPos && p.CFB_Position !== fPos) return false;
    if (fRound && roundOf(p.ProjectRound) !== Number(fRound)) return false;
    if (fDev && p.DevTrait !== fDev) return false;
    return true;
  });

  const col = cols.find((c) => c.key === sortKey);
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (col && col.num) return (Number(av) - Number(bv)) * sortDir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * sortDir;
  });

  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const td = el('td', c.num ? 'num' : '');
      let v = p[c.key];
      if (c.key === 'DevTrait') {
        const badge = el('span', `dev-badge dev-${v}`, v === 'XFactor' ? 'X-FACTOR' : String(v).toUpperCase());
        td.appendChild(badge);
      } else if (c.key === 'ProjectRound') {
        const r = roundOf(v);
        td.textContent = r === 8 ? 'UD' : r;
        if (r <= 3) td.classList.add(`round-${r}`);
      } else if (c.key === 'Height') {
        td.textContent = formatHeight(v);
      } else if (c.key === 'CFB_Position') {
        td.appendChild(el('span', 'pos-code', String(v)));
      } else {
        td.textContent = v ?? '';
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  $('rowCount').textContent = `${rows.length} of ${players.length} players`;
  if (!resultsStale) {
    $('resultsSummary').textContent =
      `${players.length} players generated. Round-1 grades in gold, dev traits color-coded. Click headers to sort.`;
  }
}

['searchBox', 'filterPos', 'filterRound', 'filterDev'].forEach((id) => {
  $(id).addEventListener('input', renderResults);
});

$('exportCsvBtn').addEventListener('click', async () => {
  const res = await window.api.exportResults({ format: 'csv' });
  if (res.ok) toast('Exported CSV');
  else if (!res.cancelled) toast(res.error, true);
});
$('exportJsonBtn').addEventListener('click', async () => {
  const res = await window.api.exportResults({ format: 'json' });
  if (res.ok) toast('Exported JSON');
  else if (!res.cancelled) toast(res.error, true);
});

/* ---------------- collapsible settings nav group ---------------- */
const settingsToggle = $('settingsGroupToggle');
const settingsItems = $('settingsGroupItems');
if (localStorage.getItem('settingsGroupCollapsed') === 'true') {
  settingsItems.classList.add('collapsed');
  settingsToggle.setAttribute('aria-expanded', 'false');
}
settingsToggle.addEventListener('click', () => {
  const collapsed = settingsItems.classList.toggle('collapsed');
  settingsToggle.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem('settingsGroupCollapsed', String(collapsed));
});

/* ---------------- hide adjusted stats toggle ---------------- */
const hideStatsToggle = $('hideStatsToggle');
hideStatsToggle.checked = hideStats;
hideStatsToggle.addEventListener('change', () => {
  hideStats = hideStatsToggle.checked;
  localStorage.setItem('hideAdjustedStats', String(hideStats));
  if (players.length) renderResults();
});

/* ---------------- init ---------------- */
(async function init() {
  META = await window.api.configGet();
  cfg = META.config;
  defaultDirs = await window.api.defaultDirs();

  const posSel = $('filterPos');
  for (const p of META.positions) {
    const o = el('option'); o.value = p; o.textContent = p;
    posSel.appendChild(o);
  }

  rebuildAllPages();
})();
