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

const HUB_LOG_TAIL_LINES = 6; // compact "Recent Activity" mirror on the Dashboard hub
function appendLog(msg) {
  const log = $('log');
  log.textContent += (log.textContent ? '\n' : '') + msg;
  log.scrollTop = log.scrollHeight;

  const tail = $('hubLogTail');
  if (tail) {
    const lines = (tail.textContent ? tail.textContent.split('\n') : []).concat(msg);
    tail.textContent = lines.slice(-HUB_LOG_TAIL_LINES).join('\n');
    tail.scrollTop = tail.scrollHeight;
  }
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
  // CONFIG_HARDENING_ROADMAP.md Phase 6: Dice Roll's own knobs and the UFL
  // boost card both live on this same Rating Translation page (Phase 2) but
  // were invisible to this count until now -- edit either and the "modified"
  // badge never moved.
  if (cfg.diceRoll && d.diceRoll) {
    for (const k of ['classStrength', 'debuff', 'spread']) {
      if ((cfg.diceRoll[k] ?? null) !== (d.diceRoll[k] ?? null)) translation++;
    }
  }
  if (cfg.overallBoost && d.overallBoost) {
    for (const k of ['enabled', 'points']) {
      if (cfg.overallBoost[k] !== d.overallBoost[k]) translation++;
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
  // CONFIG_HARDENING_ROADMAP.md Phase 6: realism.agilityCodSizePenalty has
  // no dedicated card of its own -- wherever its control eventually lives,
  // it belongs in this count too.
  if (cfg.realism && d.realism && cfg.realism.agilityCodSizePenalty !== d.realism.agilityCodSizePenalty) advanced++;

  return { weights, physical, advanced, translation };
}

// Coach Settings live in localStorage (see loadCoachSettings, defined in the
// Coach Carousel section below -- safe to reference here since this function
// is only ever CALLED after the whole script has finished evaluating).
// Counted as a single "modified" flag rather than a per-field count: two
// simple settings don't need the same granularity as the player pages.
// Deliberately NO skipTalentTree/skipAppearance here -- those are real engine
// capabilities (used by tests/research probes to isolate variables) but never
// exposed as app options: skipping either leaves a coach reading as "Level 1
// / DUMMY ARCHETYPE" with no abilities, or as a silhouette, in Coach Central.
const COACH_SETTINGS_DEFAULTS = { allowOffWindowHeadCoachHire: false, contractLength: 4 };
function coachSettingsModified() {
  const s = loadCoachSettings();
  return Object.keys(COACH_SETTINGS_DEFAULTS).some((k) => s[k] !== COACH_SETTINGS_DEFAULTS[k]) ? 1 : 0;
}

function renderConfigSummary() {
  const body = $('configSummaryBody');
  if (!body || !META) return;
  body.innerHTML = '';
  const { weights, physical, advanced, translation } = countSectionDiffs();
  const coach = coachSettingsModified();
  if (!weights && !physical && !advanced && !translation && !coach) {
    body.appendChild(el('p', 'config-summary-default', 'Using Default Settings'));
    return;
  }
  const list = el('div', 'config-summary-list');
  for (const [page, label, count] of [
    ['translation', 'Rating Translation', translation],
    ['weights', 'Position Weights', weights],
    ['physical', 'Rating Categories', physical],
    ['advanced', 'Advanced', advanced],
    ['coach-advanced', 'Coach Settings', coach],
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

  const classSize = Number(cfg.general && cfg.general.classSize);
  if (Number.isFinite(classSize) && classSize > 0 && classSize < 224) {
    msgs.push('Class Size is below 224 (7 full rounds) — the exported draft-class file will show unconverted '
      + 'template prospects even in some DRAFTED rounds, not just the undrafted tail.');
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
  updateUflStartBadge();
  updateDashboardMissionCards();
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

  // Ensure the config has the power-curve/dice-roll sections even if it was
  // saved before they existed (mergeConfig on load supplies them, but guard
  // defensively).
  if (!cfg.powerCurve) cfg.powerCurve = JSON.parse(JSON.stringify(META.defaults.powerCurve));
  if (!cfg.positionStrength) cfg.positionStrength = JSON.parse(JSON.stringify(META.defaults.positionStrength));
  if (!cfg.translation) cfg.translation = JSON.parse(JSON.stringify(META.defaults.translation));
  if (!cfg.diceRoll) cfg.diceRoll = JSON.parse(JSON.stringify(META.defaults.diceRoll));
  if (!cfg.overallBoost) cfg.overallBoost = JSON.parse(JSON.stringify(META.defaults.overallBoost));

  /* --- engine selector --- */
  // Two real, independent engines. Sanitize any stale saved strategy (an old
  // config from before Dice Roll existed, 'v1'/'rosetta' hand-edited in, or
  // anything else the dropdown doesn't offer) back to the default rather than
  // silently rendering a value that isn't one of the options.
  const ENGINE_OPTIONS = [['powercurve', 'Power Curve'], ['diceroll', 'Dice Roll']];
  if (!ENGINE_OPTIONS.some(([v]) => v === cfg.translation.strategy)) {
    cfg.translation.strategy = 'powercurve'; scheduleSave();
  }
  const isDiceRoll = cfg.translation.strategy === 'diceroll';
  const eng = $('translationEngine');
  eng.innerHTML = '';
  eng.appendChild(knob('Conversion Engine', D['translation.strategy'],
    selectInput(cfg.translation.strategy, ENGINE_OPTIONS, (v) => {
      cfg.translation.strategy = v;
      buildTranslationPage();
      buildPhysicalPage();
      markResultsStale();
    })));

  // Power-Curve-only cards (its knobs do nothing under Dice Roll) vs the
  // Dice Roll card -- exactly one side is shown, so nobody tunes a dial that
  // silently has no effect on the engine they actually picked.
  $('diceRollControls').style.display = isDiceRoll ? '' : 'none';
  for (const id of ['powerCurveGlobalStrengthCard', 'powerCurveControls', 'strengthControls', 'globalTranslationControls']) {
    $(id).style.display = isDiceRoll ? 'none' : '';
  }

  // CONFIG_HARDENING_ROADMAP.md Phase 2: the boost is UFL-only but
  // engine-agnostic (pipeline.js applies it identically under Power Curve
  // and Dice Roll), so it has to be built BEFORE the isDiceRoll early-return
  // below, not inside either engine-specific branch -- otherwise it would
  // silently never render under one of the two engines.
  const isUfl = cfg.league === 'ufl';
  $('uflBoostCard').style.display = isUfl ? '' : 'none';
  if (isUfl) {
    const b = $('uflBoostSettings');
    b.innerHTML = '';
    b.appendChild(knob('Enable Overall Boost', D['overallBoost.enabled'],
      checkboxInput(cfg.overallBoost.enabled, (v) => {
        cfg.overallBoost.enabled = v;
        // Never let enabling it be a silent no-op (CONFIG_HARDENING finding
        // #4): a config saved before the shipped default changed to
        // points: 4 may still carry a persisted points: 0.
        if (v && !Number(cfg.overallBoost.points)) {
          cfg.overallBoost.points = META.defaults.overallBoost.points || 4;
        }
        // checkboxInput() already calls scheduleSave() right after this
        // callback returns -- it'll pick up both the `enabled` flip and the
        // points auto-fill above in the same save, no extra call needed here.
        buildTranslationPage();
      })));
    b.appendChild(knob('Boost Points', D['overallBoost.points'],
      numberInput(cfg.overallBoost.points ?? 4, { step: 1, min: 0, max: 25 },
        (v) => { cfg.overallBoost.points = v; })));
  }

  if (isDiceRoll) {
    const dr = $('diceRollSettings');
    dr.innerHTML = '';
    // The mechanism differs by league, not just the value (pipeline.js):
    // NFL rolls/forces a class-strength TIER via classStrength; UFL uses a
    // FIXED debuff via diceRoll.debuff and never reads classStrength at all
    // -- showing the Class Strength dropdown on UFL was a real dead control
    // (CONFIG_HARDENING finding #2).
    if (!isUfl) {
      dr.appendChild(knob('Class Strength', D['diceRoll.classStrength'],
        selectInput(cfg.diceRoll.classStrength || '', [
          ['', 'Auto (roll each generation)'],
          ['veryWeak', 'Very Weak'],
          ['weak', 'Weak'],
          ['normal', 'Normal'],
          ['strong', 'Strong'],
          ['veryStrong', 'Very Strong'],
        ], (v) => { cfg.diceRoll.classStrength = v; })));
    } else {
      dr.appendChild(knob('Fixed Class Debuff', D['diceRoll.debuff'],
        numberInput(cfg.diceRoll.debuff ?? -0.05, { step: 0.01, min: -0.5, max: 0.2 },
          (v) => { cfg.diceRoll.debuff = v; })));
    }
    dr.appendChild(knob('Player Roll Spread', D['diceRoll.spread'],
      numberInput(cfg.diceRoll.spread ?? 1, { step: 0.1, min: 0, max: 2 },
        (v) => { cfg.diceRoll.spread = v; })));
    return; // nothing below this point applies to Dice Roll
  }

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
  $('physicalEngineNotice').style.display = cfg.translation?.strategy === 'diceroll' ? '' : 'none';

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
    numberInput(cfg.general.classSize, { step: 10, min: 32, max: 1000 }, (v) => { cfg.general.classSize = v; })));
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
  cfg.diceRoll = JSON.parse(JSON.stringify(META.defaults.diceRoll));
  // CONFIG_HARDENING_ROADMAP.md Phase 6: overallBoost's card (Phase 2) lives
  // on this same page and was missing from this reset entirely.
  cfg.overallBoost = JSON.parse(JSON.stringify(META.defaults.overallBoost));
  // legacy/bell/ratingAdjustments/kpAwarenessCap have no UI of their own
  // (V1-engine-only -- see main.js's own comment on why V1 has no card), so
  // normal use can never cause them to differ from default. Reset anyway:
  // they're real TUNING_KEYS members a hand-edited or imported file COULD
  // set, they're conceptually part of "the conversion engine," same as
  // everything else this button already covers, and "Reset" should mean
  // reset rather than "reset everything that happens to have a control."
  cfg.legacy = JSON.parse(JSON.stringify(META.defaults.legacy));
  cfg.bell = JSON.parse(JSON.stringify(META.defaults.bell));
  cfg.ratingAdjustments = JSON.parse(JSON.stringify(META.defaults.ratingAdjustments));
  cfg.kpAwarenessCap = META.defaults.kpAwarenessCap;
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
      // A whole-app-state preset carries its own `league` -- may not match
      // whichever one was active before the import, so sync the toggle/hint/
      // defaults to it too, not just the tuning values.
      syncLeagueState(imported.config, imported.defaults);
      rebuildAllPages();
      markResultsStale();
      onConfigChanged();
      toast('Preset imported');
    }
  } catch (e) {
    toast(e.message || 'Import failed', true);
  }
});

// LEAGUE_PROFILES_ROADMAP.md Phase 4: one league's tuning per file, tagged,
// so a UFL (or NFL) setup can be shared without touching anyone's other
// league. NFL and UFL each have their OWN export/import buttons (wired by
// wireLeaguePresetButtons below), so neither needs the active-league
// relabelling those buttons used to do -- only the reset button, which acts
// on whichever league is currently being edited, still tracks it.
function updateLeagueResetLabel() {
  const lg = (cfg.league === 'ufl' ? 'UFL' : 'NFL');
  $('leagueResetProfile').textContent = `Reset ${lg} to Defaults`;
}
// LEAGUE_PROFILES_ROADMAP.md Phase 5: preview before applying. Reads the
// picked file (config-import-profile now only reads -- see main.js) and
// shows exactly what would change against the CURRENTLY ACTIVE league's live
// values, with a mismatch banner if the file's own tag doesn't match where
// it's landing. Nothing is written until "Apply Import" is clicked.
//
// Diffs generically by flattening both sides to leaf paths (recursing into
// any plain object -- works unmodified whether a key is a single number like
// diceRoll.spread or a 22-position table like positionValue) and keeping
// only paths whose value actually differs, so the list stays proportional
// to the real size of the change instead of listing 100+ unchanged rows.
function flattenLeaves(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenLeaves(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}
// `baseline` is the flat config of the league being imported INTO -- which
// is not necessarily the active one, since each league has its own import
// button now. Passed in explicitly rather than reading `cfg` so the diff
// can never silently describe the wrong league's values.
function diffProfileAgainstCurrent(incomingProfile, baseline) {
  const rows = [];
  for (const key of Object.keys(incomingProfile)) {
    const curLeaves = flattenLeaves({ [key]: baseline[key] });
    const newLeaves = flattenLeaves({ [key]: incomingProfile[key] });
    for (const path of new Set([...Object.keys(curLeaves), ...Object.keys(newLeaves)])) {
      const oldVal = curLeaves[path];
      const newVal = newLeaves[path];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) rows.push({ path, oldVal, newVal });
    }
  }
  return rows;
}

let pendingImportProfile = null;
// The league being imported INTO -- now always an explicit target (each
// league has its own Import button), never inferred from whatever happens
// to be active. Still held in a variable across the modal's lifetime rather
// than re-read at Apply time: CONFIG_HARDENING_ROADMAP.md Phase 6 finding
// #11 -- the whole preview (mismatch banner, diff, summary) describes ONE
// league, so Apply has to commit to that same one even if the active
// league changed while the modal was open.
let pendingImportLeague = null;
let modalPreviousFocus = null;
async function showImportPreview(fileLeague, profile, ignoredKeys, targetLeague) {
  pendingImportProfile = profile;
  pendingImportLeague = targetLeague;
  modalPreviousFocus = document.activeElement;
  const targetLg = targetLeague === 'ufl' ? 'UFL' : 'NFL';
  const mismatchEl = $('importPreviewMismatch');
  if (fileLeague && fileLeague !== targetLeague) {
    mismatchEl.textContent = `This file is tagged ${fileLeague.toUpperCase()}, but you're importing it into your ${targetLg} settings.`;
    mismatchEl.classList.remove('hidden');
  } else {
    mismatchEl.classList.add('hidden');
  }

  // CONFIG_HARDENING_ROADMAP.md Phase 5 (closes finding #6): main.js already
  // stripped anything not a real tuning key before this ever reached the
  // diff below, so it can't show up as a pending change -- surfaced here
  // instead, so "ignored" doesn't just mean "silently vanished."
  const ignoredEl = $('importPreviewIgnored');
  if (ignoredKeys && ignoredKeys.length) {
    ignoredEl.textContent = `${ignoredKeys.length} unrecognized setting${ignoredKeys.length === 1 ? '' : 's'} ignored: ${ignoredKeys.join(', ')}`;
    ignoredEl.classList.remove('hidden');
  } else {
    ignoredEl.classList.add('hidden');
  }

  // Diff against the TARGET league's values. When that's the active league,
  // use the live `cfg` so unsaved edits are reflected; otherwise fetch that
  // league's saved profile, since it has no in-memory representation here.
  const baseline = targetLeague === cfg.league
    ? cfg
    : (await window.api.configGetForLeague(targetLeague)).config;
  const rows = diffProfileAgainstCurrent(profile, baseline);
  $('importPreviewSummary').textContent = rows.length
    ? `${rows.length} value${rows.length === 1 ? '' : 's'} would change in your ${targetLg} settings:`
    : `No values differ from your current ${targetLg} settings -- applying this file would be a no-op.`;
  const diffEl = $('importPreviewDiff');
  diffEl.innerHTML = '';
  if (!rows.length) {
    diffEl.appendChild(el('div', 'import-diff-empty', 'Nothing to change.'));
  }
  for (const { path, oldVal, newVal } of rows) {
    const row = el('div', 'import-diff-row');
    row.appendChild(el('span', 'import-diff-key', path));
    row.appendChild(el('span', 'import-diff-old', oldVal === undefined ? '(none)' : JSON.stringify(oldVal)));
    row.appendChild(el('span', 'import-diff-arrow', '→'));
    row.appendChild(el('span', 'import-diff-new', newVal === undefined ? '(none)' : JSON.stringify(newVal)));
    diffEl.appendChild(row);
  }

  $('importPreviewOverlay').classList.remove('hidden');
  // Focus lands on Cancel, not Apply -- an accidental Enter/Space press
  // right after the modal opens should never commit an import.
  $('importPreviewCancel').focus();
}
function hideImportPreview() {
  pendingImportProfile = null;
  pendingImportLeague = null;
  $('importPreviewOverlay').classList.add('hidden');
  if (modalPreviousFocus && typeof modalPreviousFocus.focus === 'function') modalPreviousFocus.focus();
  modalPreviousFocus = null;
}
$('importPreviewCancel').addEventListener('click', hideImportPreview);
// Click on the backdrop (not the card itself) cancels, same as Escape.
// e.target === e.currentTarget is true only when the click landed directly
// on the overlay element -- a click anywhere inside .modal-card bubbles up
// with e.target still pointing at whatever was actually clicked, so this
// guard can't misfire on clicks inside the card.
$('importPreviewOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideImportPreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('importPreviewOverlay').classList.contains('hidden')) hideImportPreview();
});
$('importPreviewApply').addEventListener('click', async () => {
  if (!pendingImportProfile) return;
  const league = pendingImportLeague; // frozen at preview time -- see the comment above showImportPreview
  const profile = pendingImportProfile;
  try {
    // Flush the active league's pending edits first. The apply below folds
    // into whatever is ON DISK, so an edit still sitting in the autosave
    // debounce would be clobbered when that write lands afterwards. Doing
    // this unconditionally (not just when target === active) keeps one
    // ordering rule instead of two.
    clearTimeout(saveTimer);
    await window.api.configSet(cfg);
    const applied = await window.api.configApplyImportedProfile(league, profile);
    hideImportPreview();
    // Only adopt the result into the live view if it's the league currently
    // being edited -- importing into the OTHER league must not silently
    // switch which league the user is looking at, and can't have changed
    // anything the current results were generated from.
    if (league === cfg.league) {
      syncLeagueState(applied.config, applied.defaults);
      rebuildAllPages();
      markResultsStale();
      onConfigChanged();
      toast(`${league === 'ufl' ? 'UFL' : 'NFL'} weights imported`);
    } else {
      toast(`${league === 'ufl' ? 'UFL' : 'NFL'} weights imported (switch to ${league.toUpperCase()} to see them)`);
    }
  } catch (e) {
    hideImportPreview();
    toast(e.message || 'Import failed', true);
  }
});

// Both leagues' export/import, wired identically -- the only difference is
// which league each pair targets, so the target is a parameter rather than
// something inferred from the active league.
function wireLeaguePresetButtons(league) {
  const LG = league.toUpperCase();
  $(`${league}PresetExport`).addEventListener('click', async () => {
    try {
      const p = await window.api.configExportProfile(cfg, league);
      if (p) toast(`${LG} weights exported`);
    } catch (e) {
      toast(e.message || 'Export failed', true);
    }
  });
  $(`${league}PresetImport`).addEventListener('click', async () => {
    try {
      const picked = await window.api.configImportProfile();
      if (picked) await showImportPreview(picked.league, picked.profile, picked.ignoredKeys, league);
    } catch (e) {
      toast(e.message || 'Import failed', true);
    }
  });
}
wireLeaguePresetButtons('nfl');
wireLeaguePresetButtons('ufl');

// CONFIG_HARDENING_ROADMAP.md Phase 6, finding #9: repurposed from the old
// dead, league-unaware config-reset. Resets ONLY the currently active
// league's tuning -- the other league, and shared session settings (engine
// choice, seed, class size, draft board), are untouched. window.confirm()
// matches the one other irreversible action in this app (overwriting the
// franchise file in place, in the write-career handler below) rather than
// introducing a second confirmation pattern.
$('leagueResetProfile').addEventListener('click', async () => {
  const lg = cfg.league === 'ufl' ? 'UFL' : 'NFL';
  const sure = confirm(`Reset all ${lg} settings to their shipped defaults? This can't be undone (though you can Export first if you want a backup).`);
  if (!sure) return;
  try {
    const result = await window.api.configResetProfile(cfg.league);
    syncLeagueState(result.config, result.defaults);
    rebuildAllPages();
    markResultsStale();
    onConfigChanged();
    toast(`${lg} settings reset to defaults`);
  } catch (e) {
    toast(e.message || 'Reset failed', true);
  }
});

/* ---------------- dashboard: pool + generate + write ---------------- */
let defaultDirs = { cfb: null, madden: null };
let maddenPath = null, outputPath = null, outMode = 'edit';
let cfbSavePath = null; // last CFB save picked -- shared with the Coach Carousel pages

// Both status chips mirror to a Dashboard-hub twin when one exists (Build
// Class keeps the canonical id; the hub's copy is purely a reflection).
function setPoolStatus(text, cls) {
  const c = $('poolStatus');
  c.textContent = text;
  c.className = 'status-chip ' + (cls || 'empty');
  const hub = $('hubCfbStatus');
  if (hub) { hub.textContent = text; hub.className = 'status-chip ' + (cls || 'empty'); }
}
function setGenStatus(text, cls) {
  const c = $('genStatus');
  c.textContent = text;
  c.className = 'status-chip ' + (cls || 'empty');
}

// Draft Class mission card on the Dashboard hub -- shows whichever is most
// advanced: a generated class, a loaded pool, or neither. Derives from state
// that already exists (players.length, the poolStatus chip's own class)
// rather than tracking a second parallel status.
function updateDashboardMissionCards() {
  const chip = $('missionDraftStatus');
  if (chip) {
    if (players.length) {
      chip.textContent = `${players.length} players generated`;
      chip.className = 'status-chip ok';
    } else if ($('poolStatus') && $('poolStatus').classList.contains('ok')) {
      chip.textContent = 'Pool loaded — ready to generate';
      chip.className = 'status-chip ok';
    } else {
      chip.textContent = 'Not started';
      chip.className = 'status-chip empty';
    }
  }

  // Coach Carousel mission card -- same derive-don't-track-twice approach,
  // reading state the Coach Carousel page already maintains (coachPlan/
  // coachSummary, declared further down but safe to reference here: this
  // function is only ever CALLED after the whole script has evaluated).
  const coachChip = $('missionCoachStatus');
  if (coachChip) {
    if (typeof coachPlan !== 'undefined' && coachPlan && coachSummary) {
      coachChip.textContent = `${coachSummary.included}/${coachSummary.total} ready`;
      coachChip.className = 'status-chip ' + (coachSummary.included ? 'ok' : 'err');
    } else {
      coachChip.textContent = 'Not started';
      coachChip.className = 'status-chip empty';
    }
  }
}

let sourceMode = 'auto'; // 'auto' | 'leaving' | 'synthesized' -- manual override for dynasty stage detection
document.querySelectorAll('input[name="sourceMode"]').forEach((r) => {
  r.addEventListener('change', (e) => { sourceMode = e.target.value; });
});

// NFL/UFL switch (see UFL_ROADMAP.md). Unlike sourceMode above, this IS part
// of the persisted generation config -- it has to reach main.js's
// generateClass() -- so it writes cfg.league and autosaves, same as any
// cfg-backed knob elsewhere in the app.
//
// LEAGUE_PROFILES_ROADMAP.md Phase 2: `cfg` is a FLAT view of whichever
// league is active -- flipping the toggle has to swap ALL of it (every
// tuning value, not just the `league` field itself), or the settings pages
// would keep showing the OLD league's numbers under the NEW league's label.
// syncLeagueState() is the shared primitive for "adopt this flat config/
// defaults pair and reflect it in the toggle + hint"; callers decide
// separately whether/when to rebuild pages (init() sequences that after its
// own setup; the switch handler and preset import do it immediately).
function updateLeagueModeHint() {
  $('leagueModeHint').textContent = (META && META.descriptions && META.descriptions.league) || '';
}
// classSize is a session-level setting (shared by both leagues, edited only
// on Advanced), so this just needs to track it -- not the active league.
function updateUflStartBadge() {
  const badge = $('uflStartBadge');
  if (!badge) return;
  const size = Number(cfg && cfg.general && cfg.general.classSize);
  badge.textContent = Number.isFinite(size) && size > 0 ? `starts at #${size + 1}` : '';
}
function syncLeagueState(flatCfg, flatDefaults) {
  cfg = flatCfg;
  META.defaults = flatDefaults;
  const radio = document.querySelector(`input[name="leagueMode"][value="${cfg.league === 'ufl' ? 'ufl' : 'nfl'}"]`);
  if (radio) radio.checked = true;
  updateLeagueModeHint();
  updateLeagueResetLabel();
}
document.querySelectorAll('input[name="leagueMode"]').forEach((r) => {
  r.addEventListener('change', async (e) => {
    const newLeague = e.target.value;
    if (newLeague === cfg.league) return;
    // Flush the OUTGOING league's edits immediately rather than waiting on
    // any pending debounced scheduleSave() -- clear its timer too, since that
    // timer closes over the OUTER `cfg` and would otherwise fire against
    // whatever `cfg` has been swapped to by the time it goes off (harmless
    // in practice, since cfg's own `.league` field always matches its own
    // content, but a needless extra write racing this explicit flush).
    clearTimeout(saveTimer);
    await window.api.configSet(cfg);
    const { config, defaults } = await window.api.configGetForLeague(newLeague);
    syncLeagueState(config, defaults);
    rebuildAllPages();
    markResultsStale();
    onConfigChanged();
  });
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
  if (sourceType === 'save') {
    cfbSavePath = file;
    if ($('hubCfbPathInput')) $('hubCfbPathInput').value = file;
  }
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
  updateDashboardMissionCards();
  if (sourceType === 'save' && res.ok) {
    updateCoachSavesSummary();
    cfbScanResult = null; // stale -- a new CFB save invalidates any prior scan
    loadCoachTonesPage();
  }
}
$('loadSave').addEventListener('click', () => loadPool('save'));
$('loadCsv').addEventListener('click', () => loadPool('csv'));
$('hubLoadCfb').addEventListener('click', () => loadPool('save'));

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
  updateDashboardMissionCards();
}
$('generateBtn').addEventListener('click', generate);
$('regenerateBtn').addEventListener('click', generate);
$('viewResultsBtn').addEventListener('click', () => gotoPage('results'));
$('openBuildBtn').addEventListener('click', () => gotoPage('build'));
$('openCoachCarouselBtn').addEventListener('click', () => gotoPage('coach-carousel'));

// Shared by the (currently locked) Build Class picker and the Dashboard hub's
// picker -- both write the same `maddenPath` state, so whichever one a user
// reaches first for Write to Franchise (or, later, the coach carousel) just
// works, and both input fields always agree.
async function selectMaddenSave() {
  const file = await window.api.pickFile({ title: 'Select your Madden franchise save', defaultDir: defaultDirs.madden });
  if (!file) return null;
  maddenPath = file;
  if ($('maddenPathInput')) $('maddenPathInput').value = file;
  if ($('hubMaddenPathInput')) $('hubMaddenPathInput').value = file;
  if (outMode === 'edit') outputPath = file;
  updateWriteEnabled();
  updateCoachSavesSummary();
  maddenScanResult = null; // stale -- a new Madden save invalidates any prior scan
  return file;
}
$('pickMadden').addEventListener('click', selectMaddenSave);
$('hubPickMadden').addEventListener('click', async () => {
  const file = await selectMaddenSave();
  if (!file) return;
  const chip = $('hubMaddenStatus');
  if (chip) { chip.textContent = 'Selected — ' + file.split(/[\\/]/).pop(); chip.className = 'status-chip ok'; }
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

// The file's total slot count is fixed PER GAME (Madden 26 = 402, Madden 27 =
// 389 in the export our template was baked from), so it follows the selected
// export target rather than being a constant. Seeded with M26's value and
// replaced once the main process reports the real templates.
let DRAFT_FILE_SLOTS = 402;
let exportTarget = 'm26';
let exportTargetInfo = {};   // key -> { label, slots }

// Builds the game picker from whatever templates this build actually bundles.
async function initExportTargets() {
  const row = $('exportTargetRow');
  if (!row) return;
  let info;
  try { info = await window.api.exportTargets(); } catch (e) { return; }
  const targets = (info && info.targets) || [];
  if (!targets.length) return;
  exportTarget = localStorage.getItem('exportTarget') || info.defaultTarget || targets[0].key;
  if (!targets.some((t) => t.key === exportTarget)) exportTarget = targets[0].key;

  row.innerHTML = '';
  for (const t of targets) {
    exportTargetInfo[t.key] = t;
    const label = el('label', 'radio');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'exportTarget';
    input.value = t.key;
    input.checked = t.key === exportTarget;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      exportTarget = t.key;
      localStorage.setItem('exportTarget', t.key);
      applyExportTarget();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(' ' + t.label));
    row.appendChild(label);
  }
  applyExportTarget();
}

// Reflects the chosen target in the slot count, the hint, and the warning text.
function applyExportTarget() {
  const t = exportTargetInfo[exportTarget];
  if (t && Number.isFinite(t.slots)) DRAFT_FILE_SLOTS = t.slots;
  const slotEl = $('exportSlotCount');
  if (slotEl) slotEl.textContent = String(DRAFT_FILE_SLOTS);
  const hint = $('exportTargetHint');
  if (hint) {
    hint.textContent = t
      ? `Builds a ${t.label} draft-class file (${DRAFT_FILE_SLOTS} slots). Pick the game you'll import into — `
        + 'the two file formats are not interchangeable.'
      : '';
  }
  updateExportDraftEnabled();
}
const DRAFT_FILE_DRAFTED = 224; // 7 rounds x 32 -- below this, even drafted rounds get unconverted fillers
function updateExportDraftEnabled() {
  const btn = $('exportDraftFileBtn');
  const st = $('exportDraftFileStatus');
  if (!players.length) {
    btn.disabled = true;
    st.textContent = '';
    st.className = 'inline-status';
    return;
  }
  btn.disabled = false;
  const filled = Math.min(players.length, DRAFT_FILE_SLOTS);
  if (filled >= DRAFT_FILE_SLOTS) {
    st.textContent = `${players.length} players ready — top ${DRAFT_FILE_SLOTS} will be exported.`;
    st.className = 'inline-status';
  } else if (filled < DRAFT_FILE_DRAFTED) {
    st.textContent = `Only ${filled} players ready — even some DRAFTED rounds (round ${Math.floor(filled / 32) + 1}+) `
      + `will show unconverted template prospects. Raise Class Size to at least ${DRAFT_FILE_DRAFTED} to fill every drafted round.`;
    st.className = 'inline-status err';
  } else {
    st.textContent = `${filled} of ${DRAFT_FILE_SLOTS} slots will be your players — the remaining `
      + `${DRAFT_FILE_SLOTS - filled} (UDFA tail) keep the template's original prospects.`;
    st.className = 'inline-status warn';
  }
}

$('exportDraftFileBtn').addEventListener('click', async () => {
  const st = $('exportDraftFileStatus');
  st.textContent = 'Building…'; st.className = 'inline-status';
  $('exportDraftFileBtn').disabled = true;
  const res = await window.api.exportDraftClassFile(exportTarget);
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
  const res = await window.api.writeCareer({ maddenPath, outputPath: outputPath || maddenPath });
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

/* ---------------- collapsible coaches nav group ---------------- */
const coachToggle = $('coachGroupToggle');
const coachItems = $('coachGroupItems');
if (localStorage.getItem('coachGroupCollapsed') === 'true') {
  coachItems.classList.add('collapsed');
  coachToggle.setAttribute('aria-expanded', 'false');
}
coachToggle.addEventListener('click', () => {
  const collapsed = coachItems.classList.toggle('collapsed');
  coachToggle.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem('coachGroupCollapsed', String(collapsed));
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

/* ================= Coach Carousel ================= */
// PIPELINE_APP_INTEGRATION_SPEC.md Part C.3, extended for the reverse
// direction per COACH_TRANSFER_AUDIT.md. Mirrors the player pipeline's own
// pool -> generate -> write shape: propose is a dry run (coach-propose, no
// bytes touched), review the plan, then commit (coach-commit, always to a
// NEW save the user picks -- there is no "edit in place" here, unlike the
// player Write to Franchise card).
//
// Two SEPARATE scan caches, not one shared "coachScanResult": cfbScanResult
// (CFB coaches) feeds both the Tone Overrides page AND the Carousel's Manual
// mode when direction is cfbToMadden; maddenScanResult (Madden coaches)
// feeds Manual mode only, and only when direction is maddenToCfb. Tone
// Overrides is inherently CFB-side regardless of which direction the
// Carousel is currently set to -- sharing one cache risked a maddenToCfb
// scan silently clobbering the Tone Overrides page's CFB data.
let cfbScanResult = null;
let maddenScanResult = null;
let coachPlan = null;       // last coach-propose plan (mirrors main.js's own lastCoachPlan cache)
let coachSummary = null;
let coachDirection = 'cfbToMadden';
let coachMode = 'auto';
let manualMoves = []; // [{ sourceRow, coachLabel, teamName }] queued for Manual mode, before Propose

function updateCoachSavesSummary() {
  const box = $('coachSavesSummary');
  if (!box) return;
  const base = (p) => String(p).split(/[\\/]/).pop();
  const ready = !!(cfbSavePath && maddenPath);
  box.textContent = ready
    ? `CFB: ${base(cfbSavePath)}   ·   Madden: ${base(maddenPath)}`
    : 'Pick a CFB dynasty save and a Madden franchise save on the Dashboard first.';
  if ($('coachProposeBtn')) $('coachProposeBtn').disabled = !ready;
}

// Direction-dependent copy. Auto-propose now works in BOTH directions --
// the reverse direction pairs against CFB's own CurrentJobSecurityPercentage
// field (movement.js's scoreCfbJobVulnerability), so a hot-seat coach at a
// high-prestige school reads as the most open job, exactly the way a weak
// incumbent on a good NFL roster does going the other way.
function updateCoachDirectionUI() {
  const isReverse = coachDirection === 'maddenToCfb';
  const intro = $('coachPageIntro');
  if (intro) {
    intro.textContent = isReverse
      ? 'Transfer a Madden head coach, OC, or DC into your CFB dynasty — right job, level, talent state, and a tone-matched face. Uses the saves picked on the Dashboard.'
      : 'Transfer a CFB head coach, OC, or DC into your Madden franchise — right job, level, abilities, and a tone-matched face. Uses the saves picked on the Dashboard.';
  }
  const hint = $('coachDirectionHint');
  if (hint) {
    hint.textContent = isReverse
      ? 'Move an NFL coach into your college dynasty.'
      : 'Move a college coach into your NFL franchise.';
  }
  const modeHint = $('coachModeHint');
  if (modeHint) {
    modeHint.textContent = isReverse
      ? "Auto-propose finds the CFB jobs most likely to open — a coach on the hot seat at a high-prestige school — and pairs available NFL coaches to them. Manual lets you pick exactly which NFL coach goes to which school."
      : "Auto-propose scores who's likely to move and pairs them to the most vulnerable jobs. Manual lets you pick exactly which coach goes to which team.";
  }
  const writeWarning = $('coachWriteWarning');
  if (writeWarning) {
    writeWarning.textContent = isReverse
      ? 'Writes to a NEW save you choose — your CFB dynasty save is never overwritten in place.'
      : 'Writes to a NEW save you choose — your Madden save is never overwritten in place.';
  }
  const teamInput = $('coachManualTeamInput');
  if (teamInput) {
    teamInput.placeholder = isReverse
      ? 'Destination school name (e.g. Nebraska)'
      : 'Destination team name (e.g. Giants)';
  }
  // A direction switch invalidates any queued manual moves and the coach
  // picker's contents (they're row indices into a specific save's table).
  manualMoves = [];
  renderManualList();
  if (coachMode === 'manual') ensureCoachScanForManual();
}
document.querySelectorAll('input[name="coachDirection"]').forEach((r) => {
  r.addEventListener('change', (e) => { coachDirection = e.target.value; updateCoachDirectionUI(); });
});

// Coach Settings persistence. These are UI preferences for the carousel
// subsystem, not player-generation tuning values -- they don't belong in
// DEFAULT_CONFIG's league profiles (which get exported/imported as shareable
// generation presets and reset via "Reset League to Defaults"; folding
// carousel toggles in there would make them bleed into that flow in
// confusing ways). Persisted the same way hideAdjustedStats/showCareerStats
// already are: localStorage, read once at load, written on change.
const COACH_SETTINGS_KEY = 'coachSettings';
function loadCoachSettings() {
  try {
    return { allowOffWindowHeadCoachHire: false, contractLength: 4, ...JSON.parse(localStorage.getItem(COACH_SETTINGS_KEY) || '{}') };
  } catch (e) {
    return { allowOffWindowHeadCoachHire: false, contractLength: 4 };
  }
}
function saveCoachSettings(s) { localStorage.setItem(COACH_SETTINGS_KEY, JSON.stringify(s)); }

// Talent tree and appearance are NEVER skippable from here -- always granted
// in full, matching lib/carousel/index.js's own defaults. See the comment on
// COACH_SETTINGS_DEFAULTS above for why.
function coachConfigFromToggles() {
  const cfgOut = {
    allowOffWindowHeadCoachHire: $('coachAllowOffWindowToggle').checked,
    contractLength: Number($('coachContractLengthInput').value) || 4,
  };
  saveCoachSettings(cfgOut);
  return cfgOut;
}

// Apply the persisted settings to the toggles once, at load.
(function initCoachSettingsToggles() {
  const s = loadCoachSettings();
  $('coachAllowOffWindowToggle').checked = s.allowOffWindowHeadCoachHire;
  $('coachContractLengthInput').value = s.contractLength;
  for (const id of ['coachAllowOffWindowToggle', 'coachContractLengthInput']) {
    $(id).addEventListener('change', () => coachConfigFromToggles());
  }
})();

document.querySelectorAll('input[name="coachMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    coachMode = e.target.value;
    $('coachManualPanel').style.display = coachMode === 'manual' ? '' : 'none';
    if (coachMode === 'manual') ensureCoachScanForManual();
  });
});

// Populates the Manual-mode coach picker from whichever save is the SOURCE
// for the current direction -- cfbScanResult for cfbToMadden,
// maddenScanResult for maddenToCfb. Each cache is scanned at most once per
// save (cleared when that save changes -- see loadPool/selectMaddenSave).
async function ensureCoachScanForManual() {
  const select = $('coachManualCoachSelect');
  const isReverse = coachDirection === 'maddenToCfb';
  const sourcePath = isReverse ? maddenPath : cfbSavePath;
  if (!sourcePath) { select.innerHTML = ''; return; }

  if (isReverse) {
    if (!maddenScanResult) {
      const res = await window.api.coachScanMadden(sourcePath);
      if (!res.ok) { toast(res.error, true); return; }
      maddenScanResult = res;
    }
  } else if (!cfbScanResult) {
    const res = await window.api.coachScan(sourcePath);
    if (!res.ok) { toast(res.error, true); return; }
    cfbScanResult = res;
  }

  const scan = isReverse ? maddenScanResult : cfbScanResult;
  select.innerHTML = '';
  const sorted = [...scan.coaches].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = c.row;
    o.textContent = `${c.name} — ${c.position} (${c.school})`;
    select.appendChild(o);
  }
}

function renderManualList() {
  const box = $('coachManualList');
  box.innerHTML = '';
  manualMoves.forEach((m, i) => {
    const row = el('div', 'warning-box subtle coach-manual-row');
    row.appendChild(el('span', '', `${m.coachLabel} → ${m.teamName}`));
    const rm = el('button', 'ghost small', 'Remove');
    rm.addEventListener('click', () => { manualMoves.splice(i, 1); renderManualList(); });
    row.appendChild(rm);
    box.appendChild(row);
  });
}

$('coachManualAddBtn').addEventListener('click', () => {
  const select = $('coachManualCoachSelect');
  const teamInput = $('coachManualTeamInput');
  if (!select.options.length) { toast('No coaches loaded yet', true); return; }
  const teamName = teamInput.value.trim();
  if (!teamName) { toast('Enter a destination team name', true); return; }
  const sourceRow = Number(select.value);
  const scan = coachDirection === 'maddenToCfb' ? maddenScanResult : cfbScanResult;
  const coach = scan && scan.coaches.find((c) => c.row === sourceRow);
  manualMoves.push({ sourceRow, coachLabel: coach ? `${coach.name} (${coach.position})` : `row ${sourceRow}`, teamName });
  teamInput.value = '';
  renderManualList();
});

async function coachPropose() {
  const config = coachConfigFromToggles();
  if (coachMode === 'manual') {
    if (!manualMoves.length) { toast('Add at least one move first', true); return; }
    config.mode = 'manual';
    config.moves = manualMoves.map((m) => ({ sourceRow: m.sourceRow, teamName: m.teamName }));
  }
  const chip = $('coachProposeStatus');
  chip.textContent = 'Proposing…'; chip.className = 'status-chip busy';
  $('coachProposeBtn').disabled = true;
  const res = await window.api.coachPropose({ direction: coachDirection, cfbPath: cfbSavePath, maddenPath, config });
  $('coachProposeBtn').disabled = false;
  if (res.ok) {
    coachPlan = res.plan;
    coachSummary = res.summary;
    renderCoachPlanTable();
    renderCoachPlanSummary();
    chip.textContent = `${res.summary.included}/${res.summary.total} ready`;
    chip.className = 'status-chip ' + (res.summary.included ? 'ok' : 'err');
    updateCoachWriteEnabled();
    toast(`Proposed ${res.summary.total} move(s)`);
  } else {
    chip.textContent = 'Propose failed';
    chip.className = 'status-chip err';
    appendLog('ERROR: ' + res.error);
    toast(res.error, true);
  }
  updateDashboardMissionCards();
}
$('coachProposeBtn').addEventListener('click', coachPropose);

function renderCoachPlanSummary() {
  const box = $('coachPlanSummary');
  if (!coachSummary) { box.textContent = ''; return; }
  let txt = '';
  // Which two builds this plan was actually computed against. Detected from
  // the saves themselves, never picked by the user -- a save states its own
  // year and title update, so asking would only add a way to be wrong. Shown
  // because "which Madden was this?" was the first question every bug report
  // needed answered, and nothing surfaced it.
  if (coachSummary.cfbVersion || coachSummary.maddenVersion) {
    const cfb = coachSummary.cfbVersion ? coachSummary.cfbVersion.label : 'unknown CFB save';
    const mad = coachSummary.maddenVersion ? coachSummary.maddenVersion.label : 'unknown Madden save';
    txt += `Detected: ${cfb} → ${mad}\n`;
  }
  txt += `${coachSummary.total} move(s) · ${coachSummary.included} ready · ${coachSummary.blocked} blocked `
    + `· ${coachSummary.toneGuessed} tone-guessed`;
  if (coachSummary.visualsFree !== null && !coachSummary.visualsOk) {
    txt += ` — WARNING: only ${coachSummary.visualsFree} free face slots for ${coachSummary.visualsNeeded} needed.`;
  }
  // Explains why "(free agent)" fills the From column: the movement engine
  // prefers unemployed NFL coaches on purpose. A swollen pool is also the tell
  // that this save has already had carousel moves committed into it, so the
  // raw numbers are shown and flagged rather than silently accepted.
  if (coachSummary.nflCoaches) {
    const { nflCoaches, nflFreeAgents } = coachSummary;
    txt += `\nNFL pool: ${nflFreeAgents} of ${nflCoaches} coaches are free agents`;
    txt += nflFreeAgents / nflCoaches > 0.3
      ? ' — unusually high. This save may already have carousel moves written into it; '
        + 'check you loaded the Madden save you meant to.'
      : ' (the engine prefers unemployed coaches for college jobs).';
  }
  if (coachSummary.cfbSlotsFree !== undefined && !coachSummary.cfbSlotsOk) {
    txt += ` — WARNING: only ${coachSummary.cfbSlotsFree} disposable CFB coach slot(s) for `
      + `${coachSummary.cfbSlotsNeeded} proposed move(s). Try a smaller batch, or advance a CFB season `
      + `first so retirements/firings free up more slots.`;
  }
  box.textContent = txt;
}

// Blocked reasons come from the engine as full sentences -- far too long for a
// table cell, where they overflow and push the useful half off the right edge
// behind a horizontal scrollbar (so the "here's how to fix it" part never gets
// read). The cell shows a short, actionable summary; the full text stays
// available on hover.
function shortBlockedReason(msg) {
  const m = String(msg || '');
  if (/hiring window/i.test(m)) return 'Outside the destination save\'s coach-hiring window — turn on the override in Coach Settings';
  if (/no disposable Coach row/i.test(m)) return 'No reusable coach slot left in the destination save';
  if (/no school named|no team with TeamIndex|no team named/i.test(m)) return 'That team wasn\'t found in the destination save';
  if (/failed schema validation/i.test(m)) return 'Blocked by a pre-write safety check';
  if (/no coach at .* row/i.test(m)) return 'Source coach row is empty';
  const firstSentence = m.split(/(?<=\.)\s/)[0];
  return firstSentence.length > 110 ? `${firstSentence.slice(0, 107)}…` : firstSentence;
}

function renderCoachPlanTable() {
  const tbody = $('coachPlanTable').querySelector('tbody');
  tbody.innerHTML = '';
  if (!coachPlan) return;
  for (const row of coachPlan) {
    const tr = el('tr');
    if (row.blocked) tr.classList.add('plan-row-blocked');

    const tdChk = el('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    row.included = !row.blocked;
    chk.checked = row.included;
    chk.disabled = !!row.blocked;
    chk.addEventListener('change', () => { row.included = chk.checked; updateCoachWriteEnabled(); });
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    tr.appendChild(el('td', '', row.coach || '—'));
    tr.appendChild(el('td', '', row.fromSchool || '—'));
    tr.appendChild(el('td', '', row.toTeam || '—'));
    tr.appendChild(el('td', '', row.position || '—'));
    tr.appendChild(el('td', 'num', row.level ?? '—'));

    const tdTone = el('td');
    if (row.tone === null || row.tone === undefined) {
      tdTone.textContent = row.toneWasGuessed ? '?' : '—';
    } else {
      tdTone.textContent = String(row.tone);
    }
    if (row.toneWasGuessed) {
      const warn = el('span', '', ' ⚠');
      warn.title = coachDirection === 'maddenToCfb'
        ? 'No measured tone for this coach\'s head (a licensed likeness) -- a face will be picked at random from the CFB head catalog.'
        : 'No tone encoded for this coach -- will be sampled from the CFB tone distribution '
          + 'unless you set an override on Tone Overrides.';
      tdTone.appendChild(warn);
    }
    tr.appendChild(tdTone);

    tr.appendChild(el('td', '', row.displaces ? row.displaces.name : '(vacant)'));

    const tdStatus = el('td', 'inline-status status-cell ' + (row.blocked ? 'err' : 'ok'),
      row.blocked ? shortBlockedReason(row.blocked) : 'Ready');
    if (row.blocked) tdStatus.title = row.blocked; // full engine text on hover
    tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  }
}

function updateCoachWriteEnabled() {
  $('coachWriteBtn').disabled = !(coachPlan && coachPlan.some((r) => !r.blocked && r.included !== false));
}

$('coachWriteBtn').addEventListener('click', async () => {
  if (!coachPlan || !coachPlan.length) return;
  const excludedSourceRows = coachPlan.filter((r) => r.included === false).map((r) => r.sourceRow);
  const isReverse = coachDirection === 'maddenToCfb';
  const basePath = isReverse ? cfbSavePath : maddenPath;
  const defaultPath = basePath ? `${basePath}-COACHES` : undefined;
  const outPath = await window.api.pickSaveLocation({ defaultPath });
  if (!outPath) return;
  const st = $('coachWriteStatus');
  st.textContent = 'Writing…'; st.className = 'inline-status';
  $('coachWriteBtn').disabled = true;
  const res = await window.api.coachCommit({ outputPath: outPath, excludedSourceRows, config: coachConfigFromToggles() });
  if (res.ok) {
    // A face is cosmetic and never blocks the write (see lib/carousel/index.js),
    // but the user still needs to know it didn't get applied -- otherwise a
    // coach quietly keeps the destination row's old face with no explanation.
    const noFace = (res.results || []).filter((r) => r.appearanceError);
    if (noFace.length) {
      st.textContent = `Done — ${res.written} coach(es) written to ${res.outputPath}. `
        + `Note: ${noFace.length} kept their destination slot's existing face — this save's `
        + 'appearance data could not be read. Everything else (job, level, contract, abilities) transferred normally.';
      st.className = 'inline-status warn';
      toast(`Written — ${noFace.length} coach(es) kept an existing face`);
    } else {
      st.textContent = `Done — ${res.written} coach(es) written to ${res.outputPath}.`;
      st.className = 'inline-status ok';
      toast('Coach carousel written');
    }
  } else {
    st.textContent = res.error;
    st.className = 'inline-status err';
    toast(res.error, true);
  }
  updateCoachWriteEnabled();
});

/* ---------------- tone overrides page ---------------- */
async function loadCoachTonesPage() {
  const summary = $('coachTonesSummary');
  if (!summary) return;
  if (!cfbSavePath) { summary.textContent = 'Pick a CFB save on the Dashboard first.'; return; }
  summary.textContent = 'Scanning…';
  const res = await window.api.coachScan(cfbSavePath);
  if (!res.ok) { summary.textContent = res.error; return; }
  cfbScanResult = res;
  renderCoachTonesTable();
}
$('coachTonesRescan').addEventListener('click', loadCoachTonesPage);
$('coachTonesShowAllToggle').addEventListener('change', renderCoachTonesTable);

const COACH_POS_RANK = { HeadCoach: 0, OffensiveCoordinator: 1, DefensiveCoordinator: 2 };
function renderCoachTonesTable() {
  if (!cfbScanResult) return;
  const showAll = $('coachTonesShowAllToggle').checked;
  const rows = showAll ? cfbScanResult.coaches : cfbScanResult.coaches.filter((c) => c.toneWasGuessed);
  $('coachTonesSummary').textContent =
    `${cfbScanResult.counts.toneKnown} known tone, ${cfbScanResult.counts.toneGuessed} guessed — showing ${rows.length}.`;

  const tbody = $('coachTonesTable').querySelector('tbody');
  tbody.innerHTML = '';
  const sorted = [...rows].sort((a, b) => (COACH_POS_RANK[a.position] ?? 9) - (COACH_POS_RANK[b.position] ?? 9) || b.level - a.level);
  for (const c of sorted) {
    const tr = el('tr');
    tr.appendChild(el('td', '', c.name));
    tr.appendChild(el('td', '', c.position));
    tr.appendChild(el('td', 'num', c.level));
    tr.appendChild(el('td', '', c.school));
    tr.appendChild(el('td', '', c.head));

    const tdTone = el('td');
    const select = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = c.toneWasGuessed ? '— (will be guessed)' : '— (from head)';
    select.appendChild(blank);
    for (let t = 1; t <= 8; t++) {
      const o = document.createElement('option');
      o.value = String(t);
      o.textContent = String(t);
      select.appendChild(o);
    }
    select.value = c.toneWasGuessed ? '' : String(c.tone);
    select.addEventListener('change', async () => {
      const tone = select.value === '' ? null : Number(select.value);
      const res = await window.api.coachSetTone({ headAssetName: c.head, tone });
      if (res.ok) {
        c.tone = tone;
        c.toneWasGuessed = tone === null;
        toast(tone === null ? `Cleared override for ${c.name}` : `${c.name} set to tone ${tone}`);
        cfbScanResult.counts.toneKnown = cfbScanResult.coaches.filter((x) => !x.toneWasGuessed).length;
        cfbScanResult.counts.toneGuessed = cfbScanResult.coaches.filter((x) => x.toneWasGuessed).length;
        renderCoachTonesTable();
      } else {
        toast(res.error, true);
      }
    });
    tdTone.appendChild(select);
    tr.appendChild(tdTone);

    tbody.appendChild(tr);
  }
}

/* ---------------- init ---------------- */
(async function init() {
  META = await window.api.configGet();
  syncLeagueState(META.config, META.defaults);
  defaultDirs = await window.api.defaultDirs();

  const posSel = $('filterPos');
  for (const p of META.positions) {
    const o = el('option'); o.value = p; o.textContent = p;
    posSel.appendChild(o);
  }

  ALL_RATING_COLUMNS = (META.allRatingColumns || []).map((c) => ({ key: c.key, label: c.label, num: true }));

  rebuildAllPages();
  await initExportTargets();
  onConfigChanged();
  updateCoachSavesSummary();
  updateCoachDirectionUI();
})();
