# Coach Carousel → Pipeline App integration roadmap

**Goal:** surface the coach transfer inside the Electron pipeline app, next to the
player draft-class flow, so a user does it from the UI instead of running probes.

**Where it stands:** the engine is done and verified in-game
([`COACH_TRANSFER_AUDIT.md`](COACH_TRANSFER_AUDIT.md)). Everything under
`lib/carousel/*` works and is tested (149 assertions). It is simply **not wired
into the app** — no IPC handler, no UI page. This roadmap closes that gap.

**Design principle:** mirror the player pipeline that already exists. Don't invent
new patterns — the app already has file pickers, a per-league config system, a
dry-run-then-write flow, and a sidebar-nav page model. The carousel slots into
all four.

---

## 0. What already exists to build on

| Existing piece | Reuse for coaches |
|---|---|
| `ipcMain.handle('pick-file' / 'pick-save-location')` (main.js) | CFB source + Madden target selection — already there, no change |
| `ipcMain.handle('extract-pool')` → `pool-status` | Model: scan a save, cache the result, report status |
| `ipcMain.handle('generate-class')` / `write-career` | Model: compute a plan, then commit it to an output path |
| Per-league config (`config-get-for-league`, profiles) | Tone overrides, timing-gate toggle, skip flags live here |
| Sidebar nav `data-page` sections (renderer/index.html) | Add one "Coaches" page the same way |
| `pipeline.js extractSkinTone()` | Same regex as `cfbSkinTone()` — already proven on the player side |
| `lib/carousel/*` (movement, placeOnTeam, appearance, timing) | The engine; called from the new IPC handlers |

The carousel is deliberately structured as pure-plan + commit already
(`planTeamPlacement` computes, `moveCoachCfbToMaddenTeam` writes), which maps
cleanly onto the app's dry-run → confirm → write UX.

---

## Phase 1 — headless entry point (no UI yet)

Give the app one clean function to call, so the UI work in Phase 2 is thin.

- [ ] `lib/carousel/run.js` — `scanCoaches(cfbPath)`, `proposeMoves(cfbPath, maddenPath, config)`, `commitMoves(plan, outputPath)`. Thin wrappers over the existing modules; no new logic.
- [ ] `proposeMoves` returns a **plan array** (per coach: name, from-school, to-team, position, level, tone, `toneWasGuessed`, displaced incumbent, any timing block) — everything the UI table needs, computed without writing.
- [ ] `commitMoves` takes the reviewed plan and writes once to an output path — never in place (same rule as `write-career`).
- [ ] Unit test `run.spec.js` against a fixture, mirroring the existing spec style.

**Done when:** the whole flow runs from a single Node script via these three calls.

## Phase 2 — IPC + a "Coaches" page

- [ ] main.js: `coach-scan`, `coach-propose`, `coach-commit` handlers calling Phase 1. Follow the `extract-pool` / `generate-class` / `write-career` shapes exactly (same error handling, same log streaming).
- [ ] preload.js: expose the three on the existing bridge object.
- [ ] renderer: new `data-page="coaches"` nav item + panel. Two file rows (CFB source, Madden target) reusing the existing pickers; a "Propose moves" button; a plan table; a "Write franchise" button gated until a plan exists.
- [ ] Plan table columns: Coach · From · To · Pos · Lvl · Tone (with a ⚠ when `toneWasGuessed`) · Displaces. Read-only preview — this is the review surface before any bytes change.

**Done when:** a user picks two saves, clicks Propose, reviews the table, clicks Write, and gets a playable output save — no terminal.

## Phase 3 — config integration

Wire the carousel's knobs into the existing per-league config system so they
persist and export with everything else.

- [ ] Tone overrides (`data/cfbCoachTones.json`) editable from the UI, or at least surfaced: the plan table's ⚠ rows link to "set a tone." Writing an override re-runs the plan.
- [ ] Toggles: `allowOffWindowHeadCoachHire` (timing gate), `skipTalentTree`, `skipAppearance`, contract length. Defaults match the engine's.
- [ ] These ride the existing `config-export-profile` / `import-profile` so a shared profile carries coach settings too.

**Done when:** coach settings live in the same profile a user already exports for player generation.

## Phase 4 — safety rails (the publish blockers, in-app)

Pull the audit's P-items into the UI so they can't be skipped.

- [ ] **Pre-write validation surfaced:** `validateCoachFields` failures show in the UI as a blocked row with the reason, never a silent skip.
- [ ] **CharacterVisuals headroom check** before commit; warn if a batch would exhaust rows.
- [ ] **Timing gate messaging:** if HC hires are blocked by the season stage, the plan says so per row (`describeWindow`) instead of just refusing.
- [ ] **Dry-run summary** at the top of the plan: N moves, M tone-guessed, K blocked.

**Done when:** a bad run is impossible to commit without seeing why.

## Phase 5 — the driver (one-click carousel)

The engine's `movement.js` already proposes *who* should move (desirability ×
willingness). Connect proposals → placement so the app can do a whole league at
once, not one coach at a time.

- [ ] "Auto-propose carousel" mode: movement.js picks the moves, plan table shows them, user prunes, commit.
- [ ] Respect the timing gate league-wide (only fill HC openings in the hiring window).

**Done when:** one button turns a finished CFB season into a coherent NFL coaching carousel.

---

## Sequencing & effort

| Phase | Effort | Unblocks |
|---|---|---|
| 1 — headless entry | small | everything else |
| 2 — IPC + page | medium | usable by non-devs |
| 3 — config | small | shareable profiles |
| 4 — safety rails | small–med | safe to publish |
| 5 — driver | medium | the "wow" one-click flow |

**Minimum shippable:** Phases 1–2 + audit P2–P4. That's a user picking two
saves and getting tone-matched coaches placed, reviewed before writing. Phases
3–5 layer on without rework because Phase 1 fixes the plan/commit contract up
front.

**Ties into the pipeline:** this shares the same source save, same Madden
target, same config profiles, and the same skin-tone concept as the player
draft-class flow. Once Phase 2 lands, "generate a draft class" and "run the
coach carousel" are two pages of one app pointed at the same pair of saves.
