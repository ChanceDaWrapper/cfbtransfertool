# Pipeline app — integration spec (coaches + sidebar reorg + dashboard)

A precise, implementation-ready plan for three linked changes. Written for a
future Claude to execute in order. **No new architecture** — every part reuses a
pattern the app already uses; this document points at the exact ones.

Three deliverables:
- **Part A** — ✅ **done.** Sidebar reorganized: "Generation Settings" → "Draft Class"; the loose "Draft Class" nav item moved inside as "Class Results".
- **Part B** — ✅ **done.** Dashboard rebuilt as a hub; the player workflow moved to a new "Build Class" page.
- **Part C** — ✅ **done.** Coach Carousel added as its own "Coaches" nav group (Carousel / Tone Overrides / Coach Settings), backed by a new headless engine entry point.

Do them in order (A → B → C). A and B are pure front-end reshuffles; C adds the
engine wiring. Each part ends with a manual verification step.

## Part A/B — as-built notes

Implemented per spec with a few concrete decisions worth recording:

- **Build Class nav icon:** 🛠, placed second in the Draft Class group (after Class Results, before Position Weights).
- **Shared save state:** `maddenPath` (JS variable, not a DOM id) is now the single source of truth, set by a new shared `selectMaddenSave()` function. Both the Dashboard hub's picker (`hubPickMadden`/`hubMaddenPathInput`, live) and Build Class's Write-to-Franchise picker (`pickMadden`/`maddenPathInput`, still `.locked-card`/disabled) call it, so whichever surface is used first, the other agrees once unlocked.
- **CFB save mirroring:** `setPoolStatus()` mirrors its text/class into `#hubCfbStatus` when present; `loadPool()` mirrors the picked path into `#hubCfbPathInput`. The hub's "Load…" button (`hubLoadCfb`) calls the same `loadPool('save')` used by Build Class — no duplicated logic, no duplicate ids.
- **Mission card status:** `updateDashboardMissionCards()` derives the Draft Class card's chip from state that already exists (`players.length`, the `poolStatus` chip's own class) rather than tracking a second parallel status. Hooked into `onConfigChanged()` plus called explicitly after `loadPool()` and `generate()` resolve.
- **Recent Activity:** `appendLog()` now also mirrors into `#hubLogTail`, capped to the last `HUB_LOG_TAIL_LINES` (6) lines — a compact read-only tail, not a live duplicate of the full log.
- **Coach Carousel mission card:** `.locked-card` with a "Coming Together" badge (spec's suggested wording, kept as-is) — inert until Part C.
- **Verification method used:** this app is Electron (`window.api` comes from `preload.js`'s context bridge), so a bare `file://` load in the Browser pane has no bridge and `renderer.js` throws before its nav-item listeners attach (pre-existing, unrelated to these changes — see Part A's original verification note). Structural correctness was instead confirmed via `read_page`/`get_page_text` (exact copy, correct grouping, correct ids) plus manually replicating the page-switch logic to confirm both `page-dashboard` and `page-build` render their full intended content. Full real-app click-through still needs `npm start`.

No engine code was touched by A or B — the full test suite (16 suites, 683 assertions) stayed green throughout.

---

## 0. Architecture reference (verified against the current code)

Know these five conventions — every part below builds only on them.

**Nav + pages** (`renderer/renderer.js:55-64`)
```js
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    // clears .active on all .nav-item and .page, sets it on the clicked one
    $('page-' + btn.dataset.page).classList.add('active');
  });
});
function gotoPage(name) { document.querySelector(`.nav-item[data-page="${name}"]`).click(); }
```
- A nav button is `<button class="nav-item" data-page="X">`; its panel is `<section class="page" id="page-X">` inside `<main class="content">` (`renderer/index.html:84`).
- A collapsible group is `<button class="nav-group-toggle">` + `<div class="nav-group-items">` (index.html:26-43); collapse logic at renderer.js:1628-1632.

**IPC** — three files, one channel name each:
- `main.js`: `ipcMain.handle('channel', async (_e, args) => {...})`
- `preload.js`: add to the `api` object → `channel: (args) => ipcRenderer.invoke('channel', args)` (preload.js:3-28)
- `renderer.js`: call `await api.channel(args)`

**Log streaming**: main sends `app-log`; renderer subscribes via `api.onLog(cb)` (preload.js:27). Any long op streams progress this way.

**Config**: per-league flat config (`nfl`/`ufl`), autosaved with a debounce, with profile export/import (`config-*` handlers, main.js:154-339). New settings ride this same store -- **correction (Part C as-built):** that store is specifically the *player-generation* config (deeply typed, league-profiled, exported/imported as shareable presets). Coach Carousel settings are UI preferences for a separate subsystem and deliberately do NOT ride this store -- see Part C's as-built notes for why and what was used instead.

**Tables**: clear + rebuild — `tbody.innerHTML = ''`, then `createElement` rows via the **`el(tag, cls, text)` helper** (renderer.js:29 -- corrected; an earlier draft of this doc called it `n(tag)`, which was a misreading of `const n = document.createElement(tag)`, `el`'s own internal local variable, not a separate helper). Follow this exactly for the coach plan table.

**File pickers**: `api.pickFile(opts)` / `api.pickSaveLocation(opts)` already exist (preload.js:5-6). Reuse verbatim for coach save selection.

---

## Part A — sidebar reorganization

**Current** (index.html:19-43): two loose items (Dashboard, Draft Class) above a
group "Generation Settings" { Position Weights, Rating Translation, Rating
Categories, Advanced }.

**Target**: Dashboard stays loose at top. "Draft Class" moves *into* the group,
as its first item. The group is renamed to cover both the results view and the
settings under it.

### A.1 Naming
Rename group **"Generation Settings" → "Draft Class"**, and rename the moved
results item **"Draft Class" → "Class Results"** (avoids item==group collision).
Final players group:
```
Draft Class            (nav-group-toggle)
  Class Results        data-page="results"   (unchanged id)
  Position Weights     data-page="weights"
  Rating Translation   data-page="translation"
  Rating Categories    data-page="physical"
  Advanced             data-page="advanced"
```
Alternatives if "Draft Class" as a group reads oddly next to the Coaches group:
"Players" or "Draft Class Studio". Recommended: **"Draft Class"** — it mirrors
the coach group's noun-first naming and matches the brand sub "Draft Class Studio".

### A.2 Changes
- **index.html**: move the `data-page="results"` button (lines 22-24) inside `#settingsGroupItems` (line 30) as the first child; change its label to "Class Results". Change the group label text (line 27) to "Draft Class".
- **renderer.js**: no logic change — nav switching is generic. Verify the group-collapse default still makes sense with Results inside (it's `aria-expanded="true"`, so open by default — keep it).
- **Nothing else** references the old grouping structurally; `data-page` ids are unchanged so all existing handlers keep working.

### A.3 Verify
Launch the app; the Draft Class result view is now "Class Results" under the
"Draft Class" group; clicking it still shows the generated class.

---

## Part B — new Dashboard

**Problem**: the Dashboard *is* the entire player workflow today (pool → generate
→ export → write → log, index.html:87-221). Once coaches are a peer subsystem,
the Dashboard should be a **hub** that routes into either one, not the player
build itself.

### B.1 Move the player build off the Dashboard
Relocate the four workflow cards (Player Pool, Generate Class, Export Draft Class
File, Write to Franchise) and the Activity Log **into a new page**
`data-page="build"` labeled **"Build Class"**, placed in the "Draft Class" group
directly under Class Results. This is a cut-and-paste of index.html:100-220 into
a new `<section class="page" id="page-build">`; all element ids stay identical, so
every renderer.js handler that references them (`loadSave`, `generateBtn`,
`exportDraftFileBtn`, `writeBtn`, `log`, etc.) keeps working with **zero JS
changes**. Update `gotoPage` targets if any point at `dashboard` expecting the
workflow (grep `gotoPage(` — repoint those to `'build'`).

### B.2 Dashboard becomes a hub
New `#page-dashboard` content:
- **Saves in play** (shared state, top): two rows — CFB source save, Madden target save — each with its picker and a resolved/updated status chip. These are the inputs *both* subsystems consume, so they live at the hub. (Wire the CFB picker to the same pool-load path; Madden picker stores a shared path both Build Class and Coach Carousel read.)
- **Two mission cards** side by side (reuse `.grid-2`):
  - **Draft Class** — status line (pool loaded? class generated? N players), primary button "Open Draft Class →" (`gotoPage('build')`).
  - **Coach Carousel** — status line (moves proposed? committed? N coaches), primary button "Open Coach Carousel →" (`gotoPage('coach-carousel')`, Part C). Show a "Coming together" badge until Part C lands.
- **Current Configuration** card: keep the existing `#configSummaryBody` block (index.html:93-98) — it already summarizes config; extend it later to include coach settings.
- **Recent activity**: a compact read-only tail of the same log stream.

### B.3 Changes
- **index.html**: new `#page-build` section (moved cards); rewrite `#page-dashboard` inner HTML to the hub layout; add the two mission cards.
- **renderer.js**: add the `build` nav handling (automatic once the nav-item exists); add mission-card status updaters (small functions that read `poolStatus()` and, later, coach plan state, and set the card text). Repoint any `gotoPage('dashboard')` that assumed the workflow.
- **index.html nav**: add `<button class="nav-item" data-page="build">Build Class</button>` as second item in the Draft Class group (after Class Results).

### B.4 Verify
Dashboard shows two mission cards + shared saves; "Open Draft Class" jumps to the
moved workflow, which still generates and exports exactly as before.

---

## Part C — Coach Carousel section

A new sibling group below the Draft Class group. This is where the engine
(`lib/carousel/*`, done + tested) meets the UI.

### C.1 Engine entry point (headless, no UI) — do this first
New file **`lib/carousel/run.js`** exporting three functions, thin wrappers over
existing modules (no new engine logic):

```js
// scanCoaches(cfbPath) -> { coaches: [{ row, name, position, level, school,
//   head, tone|null, toneWasGuessed:false }], counts }
//   Reads the CFB Coach table; tone via cfbSkinTone (appearance.js).
async function scanCoaches(cfbPath) { ... }

// proposeMoves({ cfbPath, maddenPath, config, log }) -> { plan: [PlanRow], summary }
//   PlanRow = { cfbRow, coach, fromSchool, toTeam, position, level,
//     tone, toneWasGuessed, displaces:{name,row}|null, blocked:string|null }
//   Uses movement.js (who moves) OR an explicit team list from config, then
//   planTeamPlacement (placeOnTeam.js) per coach in DRY-RUN — computes, no write.
//   `blocked` carries a timing-gate/validation reason (describeWindow, etc.).
async function proposeMoves({ cfbPath, maddenPath, config, log }) { ... }

// commitMoves({ plan, cfbPath, maddenPath, outputPath, config, log }) -> { written, outputPath }
//   Applies each non-blocked PlanRow via moveCoachCfbToMaddenTeam, chaining
//   onto one output save. NEVER writes in place (mirror write-career's rule).
async function commitMoves({ plan, cfbPath, maddenPath, outputPath, config, log }) { ... }
```
- Reuse `biggestTableByName`, `safe` (saveIO), the existing carousel modules.
- `proposeMoves` must be pure/side-effect-free (dry-run) so the UI can show the plan before any bytes change — the engine already separates `planTeamPlacement` (compute) from `moveCoachCfbToMaddenTeam` (write), so this is wiring.
- Test **`test/carouselRun.spec.js`** against a fixture in the existing spec style (fake file like carouselPlaceOnTeam.spec.js uses).

### C.2 IPC (three channels, mirror extract-pool/generate/write)
- **main.js**:
  - `coach-scan` → `run.scanCoaches(cfbPath)`
  - `coach-propose` → `run.proposeMoves({...})`, streaming `app-log`
  - `coach-commit` → `run.commitMoves({...})`, streaming `app-log`; returns output path
  - Store the last proposed plan in main-process state (like the pool cache) so commit uses exactly what was reviewed.
- **preload.js**: add to `api`:
  ```js
  coachScan: (cfbPath) => ipcRenderer.invoke('coach-scan', cfbPath),
  coachPropose: (opts) => ipcRenderer.invoke('coach-propose', opts),
  coachCommit: (opts) => ipcRenderer.invoke('coach-commit', opts),
  ```

### C.3 Nav group + pages
Add below the Draft Class group in index.html:
```
Coaches                (nav-group-toggle, id="coachGroupToggle")
  Carousel             data-page="coach-carousel"
  Tone Overrides       data-page="coach-tones"
  Coach Settings       data-page="coach-advanced"
```
Icons: reuse the emoji-in-`.nav-icon` convention (e.g. 🏈 / 🎨 / ⚙).

**`#page-coach-carousel`** (the main one):
- Reuses the shared CFB + Madden saves from the Dashboard (show them read-only with a "change on Dashboard" link, or repeat the pickers — prefer shared).
- Mode radio: "Auto-propose (movement engine)" vs "Manual (pick teams)" — mirrors the Dashboard's `sourceMode`/`leagueMode` radio pattern (index.html:114-118).
- **"Propose Moves"** button → `api.coachPropose(...)` → fills the plan table.
- **Plan table** (`n(tag)` builder, clear-and-rebuild): columns
  `Coach · From · To · Pos · Lvl · Tone · Displaces · Status`.
  - Tone cell shows the number; append ⚠ + tooltip when `toneWasGuessed`.
  - Blocked rows: greyed, Status shows the reason, excluded from the write.
  - A per-row checkbox to include/exclude (default include for non-blocked).
- **Summary bar** above the table: "N moves · M tone-guessed · K blocked".
- **"Write Franchise"** button, disabled until a plan exists → `api.coachCommit(...)`; on success, show output path and offer "reveal in folder".
- **Activity Log** card (same `#log` pattern, or a scoped `#coachLog`).

**`#page-coach-tones`** (Tone Overrides):
- Table of coaches with `toneWasGuessed` / unknown tone (data from `tools/listUntonedCoaches.js` logic — expose it via `coach-scan` output or a dedicated call).
- Editable tone dropdown (1-8) per row; saving writes `data/cfbCoachTones.json` `overrides` (new `coach-set-tone` IPC → writes the file, clears the appearance.js cache) and re-runs the plan.
- This is how a user turns Freeman/Day/Sarkisian from "guessed" into "matched".

**`#page-coach-advanced`** (Coach Settings):
- Toggles bound to config (Part C.4): `allowOffWindowHeadCoachHire`, `skipTalentTree`, `skipAppearance`, default contract length.

### C.4 Config integration
- Add a `coach` sub-object to the per-league flat config (or a shared section — coach settings likely aren't league-split; put them in a top-level `coach` block).
- Extend `config-get` / `config-set` to round-trip it (main.js:154-202); include it in profile export/import (main.js:271-330) so a shared profile carries coach settings.
- Extend the Dashboard `#configSummaryBody` to list active coach settings.

### C.5 Safety rails (in-UI, from the audit's P-items)
- **Validation**: `validateCoachFields` failures surface as a blocked row with the reason — never a silent skip.
- **CharacterVisuals headroom**: before commit, check free rows; warn if the batch would exhaust them (audit P7).
- **Timing gate**: blocked HC hires show `describeWindow` per row (audit's timing.js), not a bare refusal.
- **Backup note**: commit writes to a new save path by default; surface that path clearly (never overwrite the source).

### C.6 Verify
Pick two saves on the Dashboard → Coaches ▸ Carousel → Propose → review the plan
(tone ⚠ on the `Unique_*` coaches) → set an override on the Tone Overrides page →
re-propose (now matched) → Write → load the output in Madden and confirm a placed
coach.

---

## Part C — as-built notes

Implemented per spec, C.1 through C.5, with concrete decisions worth recording:

**C.1 — `lib/carousel/run.js`.** `scanCoaches`/`proposeMoves`/`commitMoves` built exactly to spec's shape, plus two exported internals (`resolveTone`, `checkAppearanceHeadroom`) kept small and pure/fixture-testable on purpose. `proposeMoves` wraps each candidate's `planTeamPlacement` call in try/catch and turns ANY thrown error into a `blocked` row with the error's own message -- this reuses planTeamPlacement's existing errors verbatim (the timing gate's message already embeds `timing.js`'s `describeWindow`), so run.js never had to duplicate that logic or even import `timing.js` directly. One bad row never aborts the batch; verified live: a bad team name blocked correctly while a good row in the same call proceeded.

Opens saves via `saveIO.js`'s `openCfbSave`/`openMaddenSave` (the CFB schema-override path pipeline.js already uses for reliable Team-table access), not a bare `FranchiseFile.create` -- the research probes elsewhere in this repo use the bare form and get a "generic schema" fallback warning, which is fine for ad-hoc probing but not for something feeding a shipped UI.

**Testing split, matching this project's own convention:** every existing `test/*.spec.js` is fixture-only (grepped -- none touch a real save). `scanCoaches`/`proposeMoves`/`commitMoves` themselves open real saves and orchestrate the whole engine, so they're validated against real saves in `research/probe28-run-integration.js` (writes a throwaway save, verifies it, deletes it -- same pattern as probe21/26/27), not test/. `test/carouselRun.spec.js` fixture-tests only the two exported pure/lightly-coupled pieces. Both ran clean; the probe additionally confirmed the blocked-row and manual-mode paths live against `DYNASTY-MAINDYNASTY` / `CAREER-JUL06-10h10m34a-AUTOSAVE`.

**C.2 — IPC.** Four channels, not three: `coach-scan`, `coach-propose`, `coach-commit`, plus `coach-set-tone` for the Tone Overrides page (folded into C.2 rather than deferred to C.3, since it's the same shape of work). `coach-commit` takes `excludedCfbRows` (cfbRow numbers unchecked in the UI), not a full plan object -- main.js re-derives `included` flags onto its own cached `lastCoachPlan` before committing, so a commit is always provably exactly what `coach-propose` last computed and logged, never a renderer-reconstructed plan. `coach-set-tone` writes `data/cfbCoachTones.json`'s `overrides` key in place (preserving every other key in the file) and calls a new `clearCfbToneCache()` export from `appearance.js` so the very next propose call picks it up without an app restart.

**C.3 — nav group + pages.** Built all three pages (Carousel, Tone Overrides, Coach Settings), including the collapsible-group JS (mirrored from the existing `settingsGroupToggle`/`settingsGroupItems` pattern, since that wiring turned out to be per-id, not generic). Manual mode is a real, usable feature, not a stub: a coach `<select>` (populated from `coach-scan`) + a free-text destination-team input + an "Add" button build a `manualMoves` queue shown as removable rows before Propose. Team names are matched at propose-time by the engine itself (`findMaddenTeam`'s existing case-insensitive lookup) -- an unknown name simply shows up as a blocked row with the reason, not a separate validation path to maintain. No dedicated `#coachLog` was added -- Coach Carousel's `log()` callback IS `sendLog`, the exact same stream the player pipeline already uses, so its lines already appear in the existing Activity Log (Build Class) and the Dashboard's Recent Activity tail with zero extra wiring.

One CSS fix required: the sticky-column rule for the results table's First/Last name columns was written against the generic `.results-table` class, and the coach plan table (which reuses that class for its base look) would have inherited it wrongly (pinning "Coach"/"From" at a fixed width meant for name columns). Rescoped that rule to `#resultsTable` specifically -- a pure narrowing, since `#resultsTable` was the only element with that class before this change.

**C.4 — config integration, deliberately NOT as spec'd.** The spec suggested folding coach settings into the per-league flat config store. Looking at that store closely (`lib/defaults.js`'s `DEFAULT_CONFIG`/`mergeConfig`, `lib/configStore.js`) showed it's a deeply-typed, multi-phase system (CONFIG_HARDENING_ROADMAP, LEAGUE_PROFILES_ROADMAP) purpose-built for *player-generation* tuning values that get exported/imported as shareable presets and reset via "Reset League to Defaults". Coach settings are simple UI toggles for an unrelated subsystem -- folding them in risked confusing bleed (would "Reset League to Defaults" silently reset coach settings too?) for no real benefit. Used the SAME pattern this codebase already uses for exactly this kind of setting (`hideAdjustedStats`/`showCareerStats`): `localStorage`, read once at load, written on change. The Dashboard's Current Configuration card still reflects them (a "Coach Settings (modified)" row, shown whenever a setting differs from default, linking to the Coach Settings page) -- so C.4's actual goal (settings persist, and are visible from the hub) is met; the mechanism is just the right-sized one instead of the suggested one.

**Post-build correction: `skipTalentTree`/`skipAppearance` toggles removed entirely.** The Coach Settings page originally shipped with "Skip talent tree" and "Skip appearance/face" toggles (both off by default, both labeled "not recommended") because the underlying engine (`lib/carousel/index.js`'s `moveCoachCfbToMaddenTeam`) genuinely supports `config.skipTalentTree`/`config.skipAppearance` -- real flags used by tests and research probes to isolate variables. But exposing them as app-facing options was a mistake: turning either on leaves a placed coach reading as "Level 1 / DUMMY ARCHETYPE" with no abilities, or as a silhouette, in Coach Central -- a genuinely broken-looking franchise, not a cosmetic quirk. Removed the toggles from `index.html`'s Coach Settings page (replaced with a one-line explanation of why they don't exist here), removed the two keys from `COACH_SETTINGS_DEFAULTS`/`loadCoachSettings`/`coachConfigFromToggles` in `renderer.js`, so `coachConfigFromToggles()`'s output now simply never carries those keys -- `run.js`'s `moveCoachCfbToMaddenTeam` call sees them as `undefined`, which is already the safe default (`!undefined` is `true`, so both are always granted). No engine change -- the capability stays available to tests/probes, it's just no longer reachable from the UI.

**C.5 — safety rails.** No new code was needed -- all four items fell out of C.1-C.3's own design: schema/timing failures were ALREADY caught-and-surfaced by C.1's try/catch; CharacterVisuals headroom was ALREADY computed in `proposeMoves` and shown in the plan summary; timing-gate messages ALREADY read as human explanations because they're the caught error text verbatim; and Write ALREADY only ever calls `pickSaveLocation` (no in-place option exists on this page at all, unlike the player pipeline's edit-in-place/copy toggle).

**Verification method, and its limit.** Every id referenced in the new JS was cross-checked against the HTML (all present, zero typos), every `data-page`/`page-*` pair matched 1:1, no duplicate ids anywhere, and `node --check` passed on all three touched files. Structural rendering of all four new/changed pages (Carousel, Tone Overrides, Coach Settings, plus the Dashboard's config-summary hook) was confirmed via `read_page`/`get_page_text` against the real `renderer/index.html` (not a mockup).

A deeper functional click-test (injecting a mocked `window.api` into a scratch copy of the page, so the real event listeners attach and can actually be clicked) was attempted **twice**, in two separate sessions. Both times the Browser pane tool itself failed to hold the navigated state: first with two straight 300s navigation timeouts on different tabs; the second attempt actually navigated successfully (`tabs_context` confirmed the correct file loaded) but every follow-up call -- `read_console_messages`, `javascript_tool`, `read_page` -- then reported "No site is open in this tab," on three different tab handles including the one that had reliably served the real (unmocked) `index.html` moments before and again moments after. This is a tool-session-state issue, not a page issue -- the plain, unmocked `index.html` kept loading and responding correctly on the very same tab immediately before and after each failed attempt. The click-driven paths (Propose/Write/tone-edit button handlers) remain verified by structural checks and careful code review, not a live click. `npm start` remains the way to confirm those interactively; do not keep retrying the mocked-harness approach in this tool -- it has now failed twice for session-state reasons unrelated to the code.

No player-pipeline code was touched by Part C. Full test suite: **17 suites, 742 assertions, all green.**

---

## Sequencing for future prompts (historical — all steps below are done)

| Step | Scope | Status |
|---|---|---|
| 1 | Part A (sidebar reorg + rename) | ✅ done |
| 2 | Part B (dashboard hub + move workflow to Build Class) | ✅ done |
| 3 | Part C.1 (`lib/carousel/run.js` + spec test + real-save probe) | ✅ done |
| 4 | Part C.2 (IPC channels, incl. `coach-set-tone`) | ✅ done |
| 5 | Part C.3 (nav group + carousel page + plan table + manual mode) | ✅ done |
| 6 | Part C.3 (tone-overrides page) + C.4 (settings persistence) | ✅ done |
| 7 | Part C.5 (safety rails) | ✅ done (no new code needed — see as-built note) |

All of Parts A-C are now live in the app. What's NOT done: the deeper live
click-through verification blocked by the Browser pane tool's navigation
timeout (see Part C's "Verification method" note) — run `npm start` to
confirm interactively. Beyond that, natural next steps are the ones the
Coach Carousel's own roadmaps already call out: coordinator/staff transfers,
the NFL→CFB direction, and wiring `movement.js`'s auto-propose into a true
one-click whole-league carousel (currently proposes up to 5 moves per
direction per call, not a full league sweep).

## Invariants (do not violate)
- Never write a coach save in place — always a new output path (matches `write-career`). **Enforced**: `commitMoves` requires `outputPath`; the UI's Write button always calls `pickSaveLocation`.
- `proposeMoves` is dry-run only; no bytes change until `commitMoves`. **Enforced.**
- All `data-page` ids for existing pages stay unchanged (keeps every current handler working). **Enforced.**
- Tone reading stays gender-agnostic; female coaches get tone-matched heads (settled decision). **Enforced** (unchanged from the prior session's work in `appearance.js`).
- Reuse `el(tag, cls, text)`, `api.onLog`, and the file pickers — no parallel implementations. **Enforced**, EXCEPT the player-generation config store specifically, which Coach Settings deliberately does NOT ride (see Part C's C.4 as-built note for why).
