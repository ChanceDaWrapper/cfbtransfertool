/* Renderer for the Pipeline draft-class studio.
 * State lives here; all heavy lifting happens in the main process over IPC.
 * Config edits autosave (debounced) and regenerate marks results stale. */

let META = null;        // { config, defaults, descriptions, positions, ... } from main
let cfg = null;         // live editable config
let players = [];       // last generated class
let generatedOrganization = 'cfbProjected'; // draftBoard.organization USED to produce `players` (not the live dropdown -- it may have changed since)
let sortKey = 'Rank', sortDir = 1;

// Columns hidden by the "Hide Adjusted Stats" toggle -- lets a user look at
// a class without seeing the direct payoff of whatever they just tuned. Every
// Madden_* rating column is just as much an "adjusted stat" as the fixed
// ones, so this gets filled in with all of them once META arrives (see init).
const HIDDEN_WHEN_TOGGLED = new Set([
  'DevTrait', 'Madden_SpeedRating', 'Madden_StrengthRating', 'Madden_AgilityRating', 'Madden_AwarenessRating',
  'EstMaddenOverall',
]);
let hideStats = localStorage.getItem('hideAdjustedStats') === 'true';
let showCareerStats = localStorage.getItem('showCareerStats') === 'true';

// Rating Categories page (Phase 4c): which scope the Bucket column currently
// edits. 'ALL' writes the global cfg.powerCurve.ratingCategory; a position
// code writes cfg.powerCurve.categoryOverrides[pos] instead. Purely a view
// mode -- not persisted, not part of the generation config itself.
let ratingCatViewPosition = 'ALL';

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
  onConfigChanged();
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

/* ---------------- current-configuration summary ---------------- */
// Counts how many leaf values differ from the shipped defaults, grouped by
// the same three sections the settings pages (and their Reset buttons) use.
// Purely a diff -- nothing here is hardcoded to specific setting names
// beyond the section boundaries the app already treats as one unit.
function countSectionDiffs() {
  const d = META.defaults;
  let weights = 0, physical = 0, advanced = 0, translation = 0;

  // Rating Translation (power-curve engine): engine choice, per-position
  // strength dials, category anchors, and global clamp/jitter.
  if ((cfg.translation?.strategy || 'powercurve') !== (d.translation?.strategy || 'powercurve')) translation++;
  if (cfg.positionStrength && d.positionStrength) {
    for (const pos of META.positions) {
      const s = cfg.positionStrength[pos] || {}, ds = d.positionStrength[pos] || {};
      for (const k of ['tech', 'mental', 'physical']) if (s[k] !== ds[k]) translation++;
    }
  }
  // Extra Drop lives in its own config section (positionExtraDrop, not
  // positionStrength) but its control sits on this same Rating Translation
  // page now (Phase 3), so it counts toward this page's modified total too.
  for (const pos of META.positions) {
    if (cfg.positionExtraDrop[pos] !== d.positionExtraDrop[pos]) translation++;
  }
  if (cfg.powerCurve && d.powerCurve) {
    for (const cat of Object.keys(d.powerCurve.anchors)) {
      const a = cfg.powerCurve.anchors[cat] || {}, da = d.powerCurve.anchors[cat] || {};
      for (const k of ['x1', 'y1', 'x2', 'y2']) if (a[k] !== da[k]) translation++;
    }
    for (const k of ['globalStrength', 'jitter', 'clampFloor', 'clampCeiling']) {
      if (cfg.powerCurve[k] !== d.powerCurve[k]) translation++;
    }
  }

  for (const pos of META.positions) {
    if (cfg.positionValue[pos] !== d.positionValue[pos]) weights++;
  }
  const capKeys = new Set([...Object.keys(cfg.positionCaps || {}), ...Object.keys(d.positionCaps || {})]);
  for (const pos of capKeys) {
    if ((cfg.positionCaps[pos] ?? null) !== (d.positionCaps[pos] ?? null)) weights++;
  }

  // Rating Categories page (the 'physical' section key is retained; the page
  // was repurposed in Phase 4a/4b/4c): every global rating reclassification,
  // every per-rating Extra/Max Drop tweak, and every per-position exception
  // counts.
  const rc = (cfg.powerCurve && cfg.powerCurve.ratingCategory) || {};
  physical += Object.keys(rc).length;
  const rt = (cfg.powerCurve && cfg.powerCurve.ratingTweaks) || {};
  physical += Object.keys(rt).length;
  const co = (cfg.powerCurve && cfg.powerCurve.categoryOverrides) || {};
  for (const pos of Object.keys(co)) physical += Object.keys(co[pos] || {}).length;

  if (cfg.general.classSize !== d.general.classSize) advanced++;
  if ((cfg.general.seed || '') !== (d.general.seed || '')) advanced++;
  for (const key of ['xfactorPercentTarget', 'superstarPercentTarget', 'starPercentTarget']) {
    if (cfg.devTraits[key] !== d.devTraits[key]) advanced++;
  }
  for (const key of ['positionValueWeight', 'awardsWeight', 'athleticismWeight', 'productionWeight', 'roundWeight', 'boardVariance', 'generationalEnabled']) {
    if (cfg.draftValue[key] !== d.draftValue[key]) advanced++;
  }

  return { weights, physical, advanced, translation };
}

function renderConfigSummary() {
  const body = $('configSummaryBody');
  if (!body || !META) return;
  body.innerHTML = '';
  const { weights, physical, advanced, translation } = countSectionDiffs();
  if (!weights && !physical && !advanced && !translation) {
    body.appendChild(el('p', 'config-summary-default', 'Using Default Settings'));
    return;
  }
  const list = el('div', 'config-summary-list');
  for (const [page, label, count] of [
    ['translation', 'Rating Translation', translation],
    ['weights', 'Position Weights', weights],
    ['physical', 'Rating Categories', physical],
    ['advanced', 'Advanced', advanced],
  ]) {
    if (!count) continue;
    const row = el('button', 'config-summary-row');
    row.appendChild(el('span', 'config-summary-bullet', '•'));
    row.appendChild(el('span', 'config-summary-text', `${label} (${count} modified)`));
    row.addEventListener('click', () => gotoPage(page));
    list.appendChild(row);
  }
  body.appendChild(list);
}

/* ---------------- intelligent warnings ---------------- */
// Flags settings combinations likely to produce an unrealistic class. Purely
// advisory -- never blocks generation, and disappears on its own once the
// triggering value moves back into a normal range.
function computeWarnings() {
  const msgs = [];
  const dt = cfg.devTraits;

  const gs = cfg.powerCurve && Number(cfg.powerCurve.globalStrength);
  if (Number.isFinite(gs)) {
    if (gs >= 1.6) msgs.push('Overall Class Strength is very high — the whole class will come in unusually weak.');
    else if (gs <= 0.4) msgs.push('Overall Class Strength is very low — ratings will stay close to college numbers (unusually strong class).');
  }
  if (cfg.powerCurve && Number(cfg.powerCurve.jitter) >= 10) {
    msgs.push('Very high Rating Scatter can create extremely inconsistent ratings.');
  }

  const extremePositions = META.positions.filter((p) => Math.abs(cfg.positionExtraDrop[p]) >= 15);
  if (extremePositions.length) {
    const names = extremePositions.map((p) => META.positionLabels[p] || p).join(', ');
    msgs.push(`Extra Drop for ${names} is set to an extreme value and may produce unrealistic ratings.`);
  }

  const extremeValue = META.positions.filter((p) => Math.abs(cfg.positionValue[p]) >= 12);
  if (extremeValue.length) {
    const names = extremeValue.map((p) => META.positionLabels[p] || p).join(', ');
    msgs.push(`Draft Value for ${names} is set to an extreme value and may push them far outside where their overall would normally land.`);
  }

  if (dt.starPercentTarget >= 60) {
    msgs.push('A Star Target % this high will make most of the class elite-tier — far above a typical draft class.');
  }
  if (dt.xfactorPercentTarget >= 1) {
    msgs.push('An X-Factor Target % this high will make Madden\'s rarest trait common instead of a once-in-a-class event.');
  }
  if (dt.superstarPercentTarget >= 15) {
    msgs.push('A Superstar Target % this high will hand out the trait far more often than a real draft class would.');
  }

  return msgs;
}

function renderWarnings() {
  const box = $('settingsWarnings');
  if (!box || !META) return;
  box.innerHTML = '';
  const msgs = computeWarnings();
  if (!msgs.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  for (const msg of msgs) {
    const w = el('div', 'warning-box');
    w.appendChild(el('strong', null, 'Warning'));
    w.appendChild(el('span', null, msg));
    box.appendChild(w);
  }
}

function onConfigChanged() {
  renderConfigSummary();
  renderWarnings();
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
  // Snap out-of-range values back to min/max once the user finishes editing
  // (not on every keystroke, so they can still type "4" -> "40" -> "402").
  inp.addEventListener('change', () => {
    if (inp.value === '') return;
    let v = Number(inp.value);
    if (!Number.isFinite(v)) return;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    if (v !== Number(inp.value)) {
      inp.value = v;
      onChange(v);
      scheduleSave();
    }
  });
  return inp;
}

function checkboxInput(checked, onChange) {
  const inp = el('input');
  inp.type = 'checkbox';
  inp.checked = !!checked;
  inp.addEventListener('change', () => { onChange(inp.checked); scheduleSave(); });
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

function selectInput(value, options, onChange) {
  const sel = el('select');
  for (const [val, label] of options) {
    const o = el('option', null, label);
    o.value = val;
    if (val === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { onChange(sel.value); scheduleSave(); });
  return sel;
}

/* ---------------- power-curve preview math ---------------- */
// Tiny reimplementation of lib/rosetta/translation/powerCurve.js's
// deriveCurve/curveBase for the Rating Translation page's live "a 90 becomes
// ~82" readout. The renderer runs in a contextIsolation sandbox with no
// require() access to that module (see preload.js), and piping every
// keystroke through IPC to the main process just to preview a curve would be
// worse than duplicating ~4 lines of algebra. This is PREVIEW ONLY -- it never
// feeds into an actual generated class; the real conversion always runs
// through the real module in the main process.
function previewCurveBase(x, x1, y1, x2, y2) {
  const p = Math.log(y1 / y2) / Math.log(x1 / x2);
  const a = y1 / Math.pow(x1, p);
  return a * Math.pow(x, p);
}

/* ---------------- page builders ---------------- */
function buildWeightsPage() {
  const tbody = $('weightsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const pos of META.positions) {
    const tr = el('tr');

    const tdCode = el('td'); tdCode.appendChild(el('span', 'pos-code', pos)); tr.appendChild(tdCode);
    tr.appendChild(el('td', 'pos-label', META.positionLabels[pos] || pos));

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

    const tdValue = el('td');
    const valueInput = numberInput(cfg.positionValue[pos], { step: 0.5, min: -20, max: 20 }, (v) => {
      cfg.positionValue[pos] = v;
      valueDot.style.visibility = v !== META.defaults.positionValue[pos] ? 'visible' : 'hidden';
    });
    valueInput.title = META.descriptions.positionValue;
    tdValue.appendChild(valueInput);
    tdValue.appendChild(el('span', 'default-ref', `default ${META.defaults.positionValue[pos]}`));
    const valueDot = el('span', 'modified-dot', '●');
    valueDot.title = 'Modified from default';
    valueDot.style.visibility = cfg.positionValue[pos] !== META.defaults.positionValue[pos] ? 'visible' : 'hidden';
    tdValue.appendChild(valueDot);
    tr.appendChild(tdValue);

    tbody.appendChild(tr);
  }
}

function buildTranslationPage() {
  const D = META.descriptions;

  // Ensure the config has the power-curve sections even if it was saved before
  // they existed (mergeConfig on load supplies them, but guard defensively).
  if (!cfg.powerCurve) cfg.powerCurve = JSON.parse(JSON.stringify(META.defaults.powerCurve));
  if (!cfg.positionStrength) cfg.positionStrength = JSON.parse(JSON.stringify(META.defaults.positionStrength));
  if (!cfg.translation) cfg.translation = JSON.parse(JSON.stringify(META.defaults.translation));

  /* --- engine selector --- */
  // Power Curve is the only supported live engine right now -- the dropdown
  // stays (rather than being removed outright) so a future engine has
  // somewhere to slot in without another round of UI surgery. Sanitize any
  // stale saved strategy (from before this cleanup, or a hand-edited config)
  // back to the one real option rather than silently rendering a value the
  // dropdown doesn't offer.
  if (cfg.translation.strategy !== 'powercurve') { cfg.translation.strategy = 'powercurve'; scheduleSave(); }
  const eng = $('translationEngine');
  eng.innerHTML = '';
  eng.appendChild(knob('Conversion Engine', D['translation.strategy'],
    selectInput(cfg.translation.strategy, [
      ['powercurve', 'Power Curve'],
    ], (v) => { cfg.translation.strategy = v; })));

  /* --- global class strength (Level 1) --- */
  const gs = $('globalStrengthControl');
  gs.innerHTML = '';
  gs.appendChild(knob('Overall Class Strength', D['powerCurve.globalStrength'],
    numberInput(cfg.powerCurve.globalStrength, { step: 0.05, min: 0.1, max: 3 }, (v) => { cfg.powerCurve.globalStrength = v; })));

  /* --- category curves table (percentage-based, Phase 2) --- */
  // The two anchors' COLLEGE values (x1, x2 -- e.g. 99/80, or 97/86 for
  // Mental) are fixed, shown as read-only reference points; only how much of
  // that rating SURVIVES (as a %) is editable. This is a strict subset of the
  // old raw-point editor (x is no longer user-editable at all), which also
  // closes off a real bug the old editor had: setting Elite's and Good's
  // college value to the same number made deriveCurve() throw (division by
  // log(1) = 0) and silently failed class generation.
  const catBody = $('categoryTable').querySelector('tbody');
  catBody.innerHTML = '';
  const catMeta = META.powerCurveCategoryMeta || {};
  // Iterate the CANONICAL category set (the defaults'), not cfg's own keys.
  // A config saved before a category was removed (e.g. the retired ARMLEG)
  // still carries that stale anchor after mergeConfig's shallow merge -- and
  // rendering a row for it would read META.defaults.powerCurve.anchors[stale]
  // === undefined and throw, aborting the rest of this page (and every page
  // built after it). Prune any such stale key so it also stops persisting.
  for (const stale of Object.keys(cfg.powerCurve.anchors)) {
    if (!(stale in META.defaults.powerCurve.anchors)) { delete cfg.powerCurve.anchors[stale]; scheduleSave(); }
  }
  for (const cat of Object.keys(META.defaults.powerCurve.anchors)) {
    const a = cfg.powerCurve.anchors[cat];
    const def = META.defaults.powerCurve.anchors[cat];
    const meta = catMeta[cat] || { label: cat, blurb: '' };
    const tr = el('tr');

    const tdName = el('td');
    tdName.appendChild(el('span', 'pos-code', meta.label));
    if (meta.blurb) { const bl = el('span', 'pos-label'); bl.textContent = meta.blurb; bl.style.display = 'block'; tdName.appendChild(bl); }
    const previewSpan = el('span', 'curve-preview');
    tdName.appendChild(previewSpan);
    tr.appendChild(tdName);

    const refreshPreview = () => {
      const sample = 90;
      const base = previewCurveBase(sample, a.x1, a.y1, a.x2, a.y2);
      previewSpan.textContent = `A ${sample} college rating becomes ~${Math.max(1, Math.min(99, Math.round(base)))}`;
    };

    const keepPctCell = (xKey, yKey, tierLabel) => {
      const td = el('td', 'anchor-cell');
      const xVal = a[xKey]; // fixed reference point, never edited here
      const pctOf = (yVal) => Math.round((yVal / xVal) * 1000) / 10;

      const row1 = el('div', 'pct-row');
      row1.appendChild(el('span', 'pos-label', `${tierLabel} (college ${xVal}) keeps`));
      const pctIn = numberInput(pctOf(a[yKey]), { step: 0.5, min: 1, max: 100 }, (v) => {
        a[yKey] = Math.max(1, Math.min(99, Math.round(xVal * (v / 100))));
        landsAtSpan.textContent = `→ lands at ${a[yKey]}`;
        dot.style.visibility = a[yKey] !== def[yKey] ? 'visible' : 'hidden';
        refreshPreview();
        markResultsStale();
      });
      pctIn.title = D['powerCurve.anchors'];
      row1.appendChild(pctIn);
      row1.appendChild(el('span', null, '%'));
      td.appendChild(row1);

      const landsAtSpan = el('span', 'default-ref', `→ lands at ${a[yKey]}`);
      td.appendChild(landsAtSpan);
      const defPct = pctOf(def[yKey]);
      td.appendChild(el('span', 'default-ref', ` · default ${defPct}%`));
      const dot = el('span', 'modified-dot', '●');
      dot.title = 'Modified from default';
      dot.style.visibility = a[yKey] !== def[yKey] ? 'visible' : 'hidden';
      td.appendChild(dot);
      return td;
    };

    tr.appendChild(keepPctCell('x1', 'y1', 'Elite'));
    tr.appendChild(keepPctCell('x2', 'y2', 'Good'));
    catBody.appendChild(tr);
    refreshPreview();
  }

  /* --- per-position strength table --- */
  const strBody = $('strengthTable').querySelector('tbody');
  strBody.innerHTML = '';
  for (const pos of META.positions) {
    const s = cfg.positionStrength[pos] || { physical: 1, tech: 1, mental: 1 };
    cfg.positionStrength[pos] = s;
    const def = META.defaults.positionStrength[pos] || { physical: 1, tech: 1, mental: 1 };
    const tr = el('tr');

    const tdCode = el('td'); tdCode.appendChild(el('span', 'pos-code', pos)); tr.appendChild(tdCode);
    tr.appendChild(el('td', 'pos-label', META.positionLabels[pos] || pos));

    const dial = (key, descKey) => {
      const td = el('td');
      const inp = numberInput(s[key], { step: 0.01, min: 0, max: 2 }, (v) => {
        s[key] = v;
        dot.style.visibility = v !== def[key] ? 'visible' : 'hidden';
      });
      inp.title = D[descKey];
      td.appendChild(inp);
      td.appendChild(el('span', 'default-ref', `default ${def[key]}`));
      const dot = el('span', 'modified-dot', '●');
      dot.title = 'Modified from default';
      dot.style.visibility = s[key] !== def[key] ? 'visible' : 'hidden';
      td.appendChild(dot);
      return td;
    };
    tr.appendChild(dial('tech', 'positionStrength.tech'));
    tr.appendChild(dial('mental', 'positionStrength.mental'));
    tr.appendChild(dial('physical', 'positionStrength.physical'));

    // Extra Drop -- flat points off every rating for this position (all four
    // categories, applied post-curve in makePowerCurveAdjuster), unlike the
    // three proportional Strength dials above. Lives in cfg.positionExtraDrop,
    // not cfg.positionStrength -- a separate config section, same table.
    const tdDrop = el('td');
    const dropInput = numberInput(cfg.positionExtraDrop[pos], { step: 0.5, min: -20, max: 30 }, (v) => {
      cfg.positionExtraDrop[pos] = v;
      dropDot.style.visibility = v !== META.defaults.positionExtraDrop[pos] ? 'visible' : 'hidden';
    });
    dropInput.title = D.positionExtraDrop;
    tdDrop.appendChild(dropInput);
    tdDrop.appendChild(el('span', 'default-ref', `default ${META.defaults.positionExtraDrop[pos]}`));
    const dropDot = el('span', 'modified-dot', '●');
    dropDot.title = 'Modified from default';
    dropDot.style.visibility = cfg.positionExtraDrop[pos] !== META.defaults.positionExtraDrop[pos] ? 'visible' : 'hidden';
    tdDrop.appendChild(dropDot);
    tr.appendChild(tdDrop);

    strBody.appendChild(tr);
  }

  /* --- global knobs --- */
  const g = $('translationGlobals');
  g.innerHTML = '';
  g.appendChild(knob('Rating Scatter (Jitter)', D['powerCurve.jitter'],
    numberInput(cfg.powerCurve.jitter, { step: 0.5, min: 0, max: 15 }, (v) => { cfg.powerCurve.jitter = v; })));
  g.appendChild(knob('Rating Floor', D['powerCurve.clampFloor'],
    numberInput(cfg.powerCurve.clampFloor, { step: 1, min: 1, max: 99 }, (v) => { cfg.powerCurve.clampFloor = v; })));
  g.appendChild(knob('Rating Ceiling', D['powerCurve.clampCeiling'],
    numberInput(cfg.powerCurve.clampCeiling, { step: 1, min: 1, max: 99 }, (v) => { cfg.powerCurve.clampCeiling = v; })));
}

// The four buckets a rating can be assigned to, in compression order. Labels
// pull from the shared category metadata. Order also drives how the table is
// grouped. There is no "leave untouched" option -- every rating always
// converts through one of these four.
function categoryBucketOptions() {
  const m = META.powerCurveCategoryMeta || {};
  const opts = [];
  for (const k of ['physical', 'techmod', 'techhvy', 'mental']) {
    opts.push([k, (m[k] && m[k].label) || k]);
  }
  return opts;
}

// The Rating Categories page. Bucket dropdowns write EITHER the global
// reclassification map (roadmap Phase 4a, cfg.powerCurve.ratingCategory) OR a
// single position's exception (Phase 4c, cfg.powerCurve.categoryOverrides[pos])
// depending on the "Editing" selector at the top of the page. Extra Drop / Max
// Drop (Phase 4b) always stay global regardless of that selector -- per-
// position numeric tweaks aren't in scope (categoryOverrides is category-only).
// Only non-default entries are ever stored, at whichever scope is active.
function buildPhysicalPage() {
  const catDefaults = META.ratingCategoryDefaults || {}; // { [Rating]: category } from CATEGORY_OF
  const bucketOptions = categoryBucketOptions();
  const bucketLabel = Object.fromEntries(bucketOptions);
  const ratingCategory = cfg.powerCurve.ratingCategory || (cfg.powerCurve.ratingCategory = {});
  const categoryOverrides = cfg.powerCurve.categoryOverrides || (cfg.powerCurve.categoryOverrides = {});

  /* --- "Editing: All positions / QB / WR / ..." selector --- */
  const posContainer = $('ratingCatPositionSelect');
  posContainer.innerHTML = '';
  const posOptions = [['ALL', 'All positions']].concat(
    (META.positions || []).map((p) => [p, `${p} — ${META.positionLabels[p] || p}`])
  );
  // Guard against a position vanishing from META between builds (shouldn't
  // happen, but keeps this from silently pinning to a dead value).
  if (ratingCatViewPosition !== 'ALL' && !(META.positions || []).includes(ratingCatViewPosition)) {
    ratingCatViewPosition = 'ALL';
  }
  const posSel = selectInput(ratingCatViewPosition, posOptions, (v) => {
    ratingCatViewPosition = v; // view-only -- not a config change, no scheduleSave
    buildPhysicalPage();
  });
  posContainer.appendChild(posSel);

  const viewingAll = ratingCatViewPosition === 'ALL';
  $('categoryLegend').innerHTML =
    '<strong>Physical</strong> barely changes · '
    + '<strong>Technical (Light)</strong> mild · <strong>Technical (Heavy)</strong> moderate · '
    + '<strong>Mental</strong> hardest. '
    + 'A rating’s bucket also decides which Per-Position Strength dial governs it '
    + '(Technical buckets → Technical dial, Mental → Mental, Physical → Physical).'
    + (viewingAll ? '' : ` Showing <strong>${ratingCatViewPosition}</strong>'s effective bucket for each rating -- `
      + `changing one here only affects ${ratingCatViewPosition}, on top of the global choice above.`);

  const tbody = $('ratingCatTable').querySelector('tbody');
  tbody.innerHTML = '';

  const ratingTweaks = cfg.powerCurve.ratingTweaks || (cfg.powerCurve.ratingTweaks = {});
  // Drop a rating's tweaks entry entirely once both fields are back at
  // default, mirroring the category maps' delete-on-default pattern below.
  const pruneTweak = (rating) => {
    const t = ratingTweaks[rating];
    if (t && (t.extraDrop || 0) === 0 && (t.maxDrop ?? null) === null) delete ratingTweaks[rating];
  };

  // parentCat: what a rating resolves to WITHOUT a position-specific
  // exception -- the global override if set, else the structural default.
  // This is what "All positions" edits directly, and what a per-position
  // exception falls back to (and is compared/pruned against).
  const parentCatOf = (rating) => ratingCategory[rating] || catDefaults[rating] || 'techmod';
  // curCat: the EFFECTIVE bucket for the current view -- parentCat, unless
  // viewing one position AND that position has its own exception.
  const curCatOf = (rating) => {
    if (viewingAll) return parentCatOf(rating);
    const posOv = categoryOverrides[ratingCatViewPosition];
    return (posOv && posOv[rating]) || parentCatOf(rating);
  };

  const allRatings = (META.allRatingColumns || []).map((c) => c.key.replace(/^Madden_/, ''));
  // Group by the CURRENT VIEW's effective bucket (not always the structural
  // default) so a position-specific exception visibly moves a rating's row
  // into its new group when you're looking at that position.
  const ratingsOf = (bucket) => allRatings.filter((r) => curCatOf(r) === bucket);

  for (const [bucketKey, bucketName] of bucketOptions) {
    const ratings = ratingsOf(bucketKey);
    if (!ratings.length) continue;

    const headTr = el('tr', 'group-row');
    const headTd = el('td'); headTd.colSpan = 5;
    headTd.appendChild(el('span', 'group-label', bucketName));
    headTr.appendChild(headTd);
    tbody.appendChild(headTr);

    for (const rating of ratings) {
      const parentCat = parentCatOf(rating);
      const curCat = curCatOf(rating);
      const structuralDefault = catDefaults[rating] || 'techmod';
      const label = ratingLabelFor(rating);
      const tr = el('tr');

      const tdName = el('td');
      tdName.appendChild(el('span', 'pos-label', label));
      tr.appendChild(tdName);

      const tdSel = el('td');
      const sel = selectInput(curCat, bucketOptions, (v) => {
        if (viewingAll) {
          if (v === structuralDefault) delete ratingCategory[rating];
          else ratingCategory[rating] = v;
        } else {
          if (v === parentCat) {
            if (categoryOverrides[ratingCatViewPosition]) {
              delete categoryOverrides[ratingCatViewPosition][rating];
              if (!Object.keys(categoryOverrides[ratingCatViewPosition]).length) delete categoryOverrides[ratingCatViewPosition];
            }
          } else {
            (categoryOverrides[ratingCatViewPosition] || (categoryOverrides[ratingCatViewPosition] = {}))[rating] = v;
          }
        }
        markResultsStale();
        buildPhysicalPage(); // rebuild -- regroups by new bucket, syncs Extra/Max Drop enable-state
      });
      sel.title = META.descriptions['powerCurve.ratingCategory'];
      tdSel.appendChild(sel);
      tr.appendChild(tdSel);

      const tdDefault = el('td');
      tdDefault.appendChild(el('span', 'default-ref',
        viewingAll ? `default ${bucketLabel[structuralDefault]}` : `default ${bucketLabel[parentCat] || parentCat}`));
      const dot = el('span', 'modified-dot', '●');
      dot.title = viewingAll ? 'Changed from default' : `Overridden for ${ratingCatViewPosition}`;
      // In All-positions view, curCat === parentCat by construction (curCatOf
      // just returns parentCatOf when viewingAll) -- comparing them here would
      // never light the dot. Compare against the STRUCTURAL default instead,
      // which is what "All positions" actually edits (ratingCategory[rating]).
      // In a single-position view, parentCat IS the right comparison (it's
      // what this position falls back to without its own exception).
      const isModified = viewingAll ? curCat !== structuralDefault : curCat !== parentCat;
      dot.style.visibility = isModified ? 'visible' : 'hidden';
      tdDefault.appendChild(dot);
      tr.appendChild(tdDefault);

      // Extra Drop / Max Drop (Phase 4b) -- always global, and always active:
      // every rating converts through a real curve now, so there's no
      // copy-raw state left that would make these silently do nothing.
      const tweak = ratingTweaks[rating] || { extraDrop: 0, maxDrop: null };

      const tdDrop = el('td');
      const dropIn = numberInput(tweak.extraDrop, { step: 0.5, min: -20, max: 30 }, (v) => {
        const t = ratingTweaks[rating] || (ratingTweaks[rating] = { extraDrop: 0, maxDrop: null });
        t.extraDrop = v;
        pruneTweak(rating);
        markResultsStale();
      });
      dropIn.title = META.descriptions['ratingTweaks.extraDrop'];
      tdDrop.appendChild(dropIn);
      tr.appendChild(tdDrop);

      const tdMax = el('td');
      const maxIn = numberInput(tweak.maxDrop, { step: 1, min: 0, max: 50, blankable: true }, (v) => {
        const t = ratingTweaks[rating] || (ratingTweaks[rating] = { extraDrop: 0, maxDrop: null });
        t.maxDrop = v;
        pruneTweak(rating);
        markResultsStale();
      });
      maxIn.placeholder = 'none';
      maxIn.title = META.descriptions['ratingTweaks.maxDrop'];
      tdMax.appendChild(maxIn);
      tr.appendChild(tdMax);

      tbody.appendChild(tr);
    }
  }
}

// Friendly label for a rating key, preferring the Draft Class column labels
// (cover all ~57 ratings) and falling back to the physical-only RATING_LABELS
// then a de-suffixed key.
function ratingLabelFor(rating) {
  const col = (META.allRatingColumns || []).find((c) => c.key === 'Madden_' + rating);
  if (col) return col.label;
  return (META.ratingLabels && META.ratingLabels[rating]) || rating.replace(/Rating$/, '');
}

function buildAdvancedPage() {
  const D = META.descriptions;

  const g = $('advGeneral');
  g.innerHTML = '';
  g.appendChild(knob('Class Size', D['general.classSize'],
    numberInput(cfg.general.classSize, { step: 10, min: 402, max: 1000 }, (v) => { cfg.general.classSize = v; })));
  const seedIn = el('input');
  seedIn.type = 'text';
  seedIn.placeholder = 'random';
  seedIn.value = cfg.general.seed || '';
  seedIn.addEventListener('input', () => { cfg.general.seed = seedIn.value.trim(); scheduleSave(); });
  g.appendChild(knob('Seed', D['general.seed'], seedIn));

  const rl = $('advRealism');
  rl.innerHTML = '';
  rl.appendChild(knob('Big WR/CB Agility + COD Fix', D['realism.agilityCodSizePenalty'],
    checkboxInput(cfg.realism.agilityCodSizePenalty, (v) => { cfg.realism.agilityCodSizePenalty = v; })));

  const d = $('advDev');
  d.innerHTML = '';
  d.appendChild(knob('X-Factor Target %', D['devTraits.xfactorPercentTarget'],
    numberInput(cfg.devTraits.xfactorPercentTarget, { step: 0.01, min: 0, max: 10 }, (v) => { cfg.devTraits.xfactorPercentTarget = v; })));
  d.appendChild(knob('Superstar Target %', D['devTraits.superstarPercentTarget'],
    numberInput(cfg.devTraits.superstarPercentTarget, { step: 0.1, min: 0, max: 100 }, (v) => { cfg.devTraits.superstarPercentTarget = v; })));
  d.appendChild(knob('Star Target %', D['devTraits.starPercentTarget'],
    numberInput(cfg.devTraits.starPercentTarget, { step: 1, min: 0, max: 100 }, (v) => { cfg.devTraits.starPercentTarget = v; })));

  const bo = $('advDraftBoard');
  bo.innerHTML = '';
  bo.appendChild(knob('Board Organization', D['draftBoard.organization'],
    selectInput(cfg.draftBoard.organization, [
      ['cfbProjected', 'CFB Projected Rounds'],
      ['realisticDraftDay', 'Realistic Draft Day (late-round steals)'],
    ], (v) => { cfg.draftBoard.organization = v; buildAdvancedPage(); })));
  // The chaos dial only means anything for the sliding engine -- hide it under
  // the default mode rather than showing a control that does nothing.
  if (cfg.draftBoard.organization === 'realisticDraftDay') {
    bo.appendChild(knob('Draft Day Chaos', D['draftBoard.chaos'],
      numberInput(cfg.draftBoard.chaos, { step: 5, min: 0, max: 100 }, (v) => { cfg.draftBoard.chaos = v; })));
  }

  const dv = $('advDraftValue');
  dv.innerHTML = '';
  dv.appendChild(knob('Position Value Weight', D['draftValue.positionValueWeight'],
    numberInput(cfg.draftValue.positionValueWeight, { step: 0.25, min: 0, max: 5 }, (v) => { cfg.draftValue.positionValueWeight = v; })));
  dv.appendChild(knob('Awards Weight', D['draftValue.awardsWeight'],
    numberInput(cfg.draftValue.awardsWeight, { step: 0.1, min: 0, max: 5 }, (v) => { cfg.draftValue.awardsWeight = v; })));
  dv.appendChild(knob('Athleticism Weight', D['draftValue.athleticismWeight'],
    numberInput(cfg.draftValue.athleticismWeight, { step: 0.25, min: 0, max: 5 }, (v) => { cfg.draftValue.athleticismWeight = v; })));
  dv.appendChild(knob('Projected Round Weight', D['draftValue.roundWeight'],
    numberInput(cfg.draftValue.roundWeight, { step: 0.25, min: 0, max: 5 }, (v) => { cfg.draftValue.roundWeight = v; })));
  dv.appendChild(knob('Production Weight', D['draftValue.productionWeight'],
    numberInput(cfg.draftValue.productionWeight, { step: 0.25, min: 0, max: 10 }, (v) => { cfg.draftValue.productionWeight = v; })));
  dv.appendChild(knob('Board Variance', D['draftValue.boardVariance'],
    numberInput(cfg.draftValue.boardVariance, { step: 0.25, min: 0, max: 10 }, (v) => { cfg.draftValue.boardVariance = v; })));
  dv.appendChild(knob('Generational Prospect', D['draftValue.generationalEnabled'],
    checkboxInput(cfg.draftValue.generationalEnabled, (v) => { cfg.draftValue.generationalEnabled = v; })));
}

function rebuildAllPages() {
  buildWeightsPage();
  buildTranslationPage();
  buildPhysicalPage();
  buildAdvancedPage();
}

/* ---------------- section resets ---------------- */
async function resetSection(mutate) {
  mutate();
  cfg = await window.api.configSet(cfg);
  rebuildAllPages();
  markResultsStale();
  onConfigChanged();
  toast('Reset to defaults');
}
$('resetWeights').addEventListener('click', () => resetSection(() => {
  cfg.positionCaps = JSON.parse(JSON.stringify(META.defaults.positionCaps));
  cfg.positionValue = JSON.parse(JSON.stringify(META.defaults.positionValue));
}));
$('resetTranslation').addEventListener('click', () => resetSection(() => {
  cfg.powerCurve = JSON.parse(JSON.stringify(META.defaults.powerCurve));
  cfg.positionStrength = JSON.parse(JSON.stringify(META.defaults.positionStrength));
  cfg.positionExtraDrop = JSON.parse(JSON.stringify(META.defaults.positionExtraDrop));
  cfg.translation = JSON.parse(JSON.stringify(META.defaults.translation));
}));
$('resetPhysical').addEventListener('click', () => resetSection(() => {
  // Rating Categories page: clears every global reclassification, every
  // per-rating Extra/Max Drop tweak, and every per-position exception back to
  // defaults. (Reset button id kept as resetPhysical -- the page it drives
  // was repurposed from Physical Attributes in Phase 4a/4b/4c.)
  cfg.powerCurve.ratingCategory = {};
  cfg.powerCurve.ratingTweaks = {};
  cfg.powerCurve.categoryOverrides = {};
  ratingCatViewPosition = 'ALL';
}));
$('resetAdvanced').addEventListener('click', () => resetSection(() => {
  cfg.devTraits = JSON.parse(JSON.stringify(META.defaults.devTraits));
  cfg.draftValue = JSON.parse(JSON.stringify(META.defaults.draftValue));
  cfg.realism = JSON.parse(JSON.stringify(META.defaults.realism));
  cfg.general.classSize = META.defaults.general.classSize;
  cfg.general.seed = META.defaults.general.seed;
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
      onConfigChanged();
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

let sourceMode = 'auto'; // 'auto' | 'leaving' | 'synthesized' -- manual override for dynasty stage detection
document.querySelectorAll('input[name="sourceMode"]').forEach((r) => {
  r.addEventListener('change', (e) => { sourceMode = e.target.value; });
});

const SOURCE_LABELS = {
  leaving: 'official declarations',
  synthesized: 'predicted declarations (early dynasty)',
};

async function loadPool(sourceType) {
  const file = await window.api.pickFile(sourceType === 'csv'
    ? { title: 'Select departed-players CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] }
    : { title: 'Select your CFB 27 dynasty save', defaultDir: defaultDirs.cfb });
  if (!file) return;
  setPoolStatus('Loading…', 'busy');
  const res = await window.api.extractPool({
    sourcePath: file, sourceType,
    forceSource: sourceType === 'save' && sourceMode !== 'auto' ? sourceMode : null,
  });
  if (res.ok) {
    const label = res.detectedSource ? ` — ${SOURCE_LABELS[res.detectedSource] || res.detectedSource}` : '';
    setPoolStatus(`${res.count} players loaded${label}`, 'ok');
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
    generatedOrganization = cfg.draftBoard?.organization ?? 'cfbProjected';
    resultsStale = false;
    setGenStatus(`${players.length} players generated`, 'ok');
    $('viewResultsBtn').disabled = false;
    $('regenerateBtn').disabled = false;
    $('writeBtn').disabled = !maddenPath || (outMode === 'copy' && !outputPath);
    updateExportDraftEnabled();
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

const DRAFT_FILE_MIN = 402; // Madden draft-class files are a fixed 402 players
function updateExportDraftEnabled() {
  const btn = $('exportDraftFileBtn');
  const st = $('exportDraftFileStatus');
  if (!players.length) {
    btn.disabled = true;
    st.textContent = '';
    st.className = 'inline-status';
  } else if (players.length < DRAFT_FILE_MIN) {
    btn.disabled = true;
    st.textContent = `Need ${DRAFT_FILE_MIN}+ players (have ${players.length}). Raise Class Size and regenerate.`;
    st.className = 'inline-status err';
  } else {
    btn.disabled = false;
    st.textContent = `${players.length} players ready — top ${DRAFT_FILE_MIN} will be exported.`;
    st.className = 'inline-status';
  }
}

$('exportDraftFileBtn').addEventListener('click', async () => {
  const st = $('exportDraftFileStatus');
  st.textContent = 'Building…'; st.className = 'inline-status';
  $('exportDraftFileBtn').disabled = true;
  const res = await window.api.exportDraftClassFile();
  if (res.ok) {
    st.textContent = `Done — ${res.count} players → ${res.path}`;
    st.className = 'inline-status ok';
    toast('Draft class file exported');
  } else if (res.cancelled) {
    st.textContent = ''; st.className = 'inline-status';
  } else {
    st.textContent = res.error;
    st.className = 'inline-status err';
    toast(res.error, true);
  }
  updateExportDraftEnabled();
});

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
const BASE_COLUMNS = [
  { key: 'Rank', label: '#', num: true },
  { key: 'FirstName', label: 'First' },
  { key: 'LastName', label: 'Last' },
  { key: 'CFB_Position', label: 'Pos' },
  { key: 'FormerTeam', label: 'College' },
  { key: 'ProjectRound', label: 'Rd', num: true },
  { key: 'RoundDelta', label: 'Δ', num: true,
    title: 'How far this player moved from the round "CFB Projected Rounds" would have given them. Positive = fell later (a steal); negative = went earlier than that baseline. Only meaningful under Realistic Draft Day.' },
  { key: 'DraftPick', label: 'Pick', num: true },
  { key: 'CFB_Overall', label: 'CFB OVR', num: true },
  { key: 'EstMaddenOverall', label: 'Est. Madden OVR', num: true,
    title: 'A rough preview only -- has no effect on dev traits, draft order, or any other converted rating. Madden recalculates the real Overall itself once you open the player in-game.' },
  { key: 'DevTrait', label: 'Dev' },
  { key: 'Profile', label: 'Profile' },
  { key: 'ProdScore', label: 'Prod', num: true },
  { key: 'AthScore', label: 'Ath', num: true },
  { key: 'Age', label: 'Age', num: true },
  { key: 'Height', label: 'Ht', num: true },
  { key: 'Weight', label: 'Wt', num: true },
];

// Columns hidden by default (available via horizontal scroll / sort, but not
// clutter for a first look) -- career production totals, one per stat, only
// meaningful for the position that has them so most cells are blank.
const CAREER_STAT_COLUMNS = [
  { key: 'career.passYds', label: 'Pass Yds', num: true },
  { key: 'career.passTds', label: 'Pass TD', num: true },
  { key: 'career.rushYds', label: 'Rush Yds', num: true },
  { key: 'career.rushTds', label: 'Rush TD', num: true },
  { key: 'career.recYds', label: 'Rec Yds', num: true },
  { key: 'career.recTds', label: 'Rec TD', num: true },
  { key: 'career.recCatches', label: 'Rec', num: true },
  { key: 'career.tackles', label: 'Tkl', num: true },
  { key: 'career.sacks', label: 'Sacks', num: true },
  { key: 'career.ints', label: 'INT', num: true },
];

// Every rating, in the grouped display order from META.allRatingColumns
// (filled in once it arrives in init()) -- related ratings sit together
// (Speed & Athleticism, Throwing, Catching, ...) instead of alphabetically.
let ALL_RATING_COLUMNS = [];

function formatHeight(h) {
  const n = Number(h);
  if (!n) return '';
  return `${Math.floor(n / 12)}'${n % 12}"`;
}

function currentColumns() {
  // RoundDelta is always 0 under 'cfbProjected' (it IS the baseline) -- only
  // worth a column when Realistic Draft Day actually produced the results
  // being shown.
  const base = generatedOrganization === 'realisticDraftDay'
    ? BASE_COLUMNS
    : BASE_COLUMNS.filter((c) => c.key !== 'RoundDelta');
  return base.concat(showCareerStats ? CAREER_STAT_COLUMNS : []).concat(ALL_RATING_COLUMNS);
}

function visibleColumns() {
  const cols = currentColumns();
  if (!hideStats) return cols;
  return cols.filter((c) => !HIDDEN_WHEN_TOGGLED.has(c.key));
}

// CareerStats rides on each row as a nested object (see lib/pipeline.js) --
// this is the one place that knows how to reach into it, so both the cell
// renderer and the sort comparator stay in sync automatically.
// null = not comparable (both sides UDFA -- nothing to say). Otherwise the
// number of rounds moved from the 'cfbProjected' baseline: positive = fell
// later than that baseline (a steal), negative = went earlier (a reach), zero
// = landed exactly where CFB's own projection would have put them.
// Undrafted-to-drafted (or the reverse) is expressed relative to round 8, so a
// player who fell OUT of the drafted 224 (or rose INTO it) still shows a real
// delta instead of silently vanishing.
const UDFA_ROUND = 8;
function roundDeltaOf(p) {
  const base = p.BaselineRound === '' || p.BaselineRound == null ? null : Number(p.BaselineRound);
  const actual = p.ProjectRound === '' || p.ProjectRound == null ? null : Number(p.ProjectRound);
  if (base === null && actual === null) return null;
  return (actual ?? UDFA_ROUND) - (base ?? UDFA_ROUND);
}

function cellValue(p, key) {
  if (key.startsWith('career.')) return p.CareerStats ? p.CareerStats[key.slice(7)] : undefined;
  if (key === 'RoundDelta') return roundDeltaOf(p);
  return p[key];
}

function buildResultsHeader() {
  const thead = $('resultsTable').querySelector('thead');
  thead.innerHTML = '';
  const tr = el('tr');
  for (const col of visibleColumns()) {
    const th = el('th');
    th.textContent = col.label;
    if (col.title) th.title = col.title;
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

// Two-color highlight lookups, built once per position and cached -- Physical
// (same handful of measurables for every position, plus Throw Power for QBs)
// and Position-specific (the ratings that matter most for that position's
// evaluation, defined in lib/defaults.js POSITION_KEY_ATTRIBUTES so they're
// easy to find and edit in one place). A cell only ever gets one of the two.
const _highlightSetCache = new Map();
function highlightSetsFor(position) {
  if (_highlightSetCache.has(position)) return _highlightSetCache.get(position);
  const physical = new Set(
    (META.physicalHighlightAttributes || []).concat(
      (META.physicalHighlightExtraByPosition && META.physicalHighlightExtraByPosition[position]) || []
    )
  );
  const positionKey = new Set((META.positionKeyAttributes && META.positionKeyAttributes[position]) || []);
  const sets = { physical, positionKey };
  _highlightSetCache.set(position, sets);
  return sets;
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
  const fProfile = $('filterProfile').value;

  const roundOf = (v) => { const r = Number(v); return r >= 1 && r <= 7 ? r : 8; };

  let rows = players.filter((p) => {
    if (q && !(`${p.FirstName} ${p.LastName}`.toLowerCase().includes(q) || String(p.FormerTeam).toLowerCase().includes(q))) return false;
    if (fPos && p.CFB_Position !== fPos) return false;
    if (fRound && roundOf(p.ProjectRound) !== Number(fRound)) return false;
    if (fDev && p.DevTrait !== fDev) return false;
    if (fProfile && p.Profile !== fProfile) return false;
    return true;
  });

  const col = cols.find((c) => c.key === sortKey);
  rows.sort((a, b) => {
    const av = cellValue(a, sortKey), bv = cellValue(b, sortKey);
    if (col && col.num) return (Number(av) - Number(bv)) * sortDir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * sortDir;
  });

  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const tr = el('tr');
    const { physical, positionKey } = highlightSetsFor(p.CFB_Position);
    for (const c of cols) {
      let cls = c.num ? 'num' : '';
      if (c.key.startsWith('Madden_')) {
        const name = c.key.slice('Madden_'.length);
        if (physical.has(name)) cls += ' key-rating-physical';
        else if (positionKey.has(name)) cls += ' key-rating-position';
      }
      const td = el('td', cls.trim());
      let v = cellValue(p, c.key);
      if (c.key === 'DevTrait') {
        const badge = el('span', `dev-badge dev-${v}`, v === 'XFactor' ? 'X-FACTOR' : String(v).toUpperCase());
        td.appendChild(badge);
      } else if (c.key === 'ProjectRound') {
        const r = roundOf(v);
        td.textContent = r === 8 ? 'UD' : r;
        if (r <= 3) td.classList.add(`round-${r}`);
      } else if (c.key === 'RoundDelta') {
        const d = v; // already computed by cellValue -> roundDeltaOf
        if (d === null || d === 0) {
          td.textContent = d === 0 ? '—' : '';
        } else {
          // STEAL threshold matches the roadmap's displacement tail (Phase 4):
          // small moves are just board noise, not a story worth flagging.
          const badge = el('span', `delta-badge ${d >= 2 ? 'delta-steal' : d <= -2 ? 'delta-reach' : 'delta-mild'}`,
            d > 0 ? `+${d}` : String(d));
          badge.title = d > 0
            ? `Fell ${d} round${d === 1 ? '' : 's'} later than CFB's own projection had them -- a steal.`
            : `Went ${-d} round${d === -1 ? '' : 's'} earlier than CFB's own projection had them -- a reach.`;
          td.appendChild(badge);
        }
      } else if (c.key === 'Height') {
        td.textContent = formatHeight(v);
      } else if (c.key === 'CFB_Position') {
        td.appendChild(el('span', 'pos-code', String(v)));
      } else if (c.key === 'Profile' && v) {
        const badge = el('span', `profile-badge profile-${String(v).replace(/\s+/g, '')}`, v);
        td.appendChild(badge);
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
      `${players.length} players generated. Physical ratings in blue, position-key ratings in gold, dev traits color-coded. Click headers to sort.`;
  }
}

['searchBox', 'filterPos', 'filterRound', 'filterDev', 'filterProfile'].forEach((id) => {
  $(id).addEventListener('input', renderResults);
});

// CSV/JSON export of the generated class is not surfaced yet -- the buttons
// were removed from the Draft Class header. The main-process handler
// ('export-results') and window.api.exportResults are deliberately left in
// place, so restoring this is just re-adding the two buttons and their
// listeners.

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

/* ---------------- show career stats toggle ---------------- */
const careerStatsToggle = $('careerStatsToggle');
careerStatsToggle.checked = showCareerStats;
careerStatsToggle.addEventListener('change', () => {
  showCareerStats = careerStatsToggle.checked;
  localStorage.setItem('showCareerStats', String(showCareerStats));
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

  ALL_RATING_COLUMNS = (META.allRatingColumns || []).map((c) => ({ key: c.key, label: c.label, num: true }));

  rebuildAllPages();
  onConfigChanged();
})();
