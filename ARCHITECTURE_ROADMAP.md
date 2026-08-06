# Architecture — Refactor Roadmap

**Status: Phase 0 complete. Phases 1-6 not started.** This is the execution
plan for the findings in the architectural audit. Nothing here is speculative
cleanup — every phase names a concrete structure that exists today, why it
costs us, and how we'll know the change was safe.

Baseline tag: **`pre-refactor-baseline`** (commit `38f3293`, app v0.2.3,
30 spec files / ~1116 assertions green). Safety branch:
`baseline/pre-refactor`.

```bash
git diff pre-refactor-baseline..HEAD --stat
```

Companion to [`COACH_CAROUSEL_ROADMAP.md`](COACH_CAROUSEL_ROADMAP.md) (built
the carousel this plan restructures) and
[`CONFIG_HARDENING_ROADMAP.md`](CONFIG_HARDENING_ROADMAP.md) (same
phase-by-phase, verify-every-step discipline).

---

## 1. Findings → phase map

| # | Severity | Finding | Phase |
|---|---|---|---|
| 1 | **High** | The carousel's top-level orchestrators (`moveCoach*`, `proposeMoves`/`commitMoves`) have **zero** direct test coverage — and they are exactly where the crash-on-advance and infinite-load bugs shipped from | Phase 1 |
| 2 | **High** | `lib/pipeline.js` is 2,231 lines and ~50 top-level functions: save extraction, draft projection, three rating engines, the Madden writer, and CSV I/O in one module | Phase 2 |
| 3 | Medium | Each rating engine's *driver* (`calibratePlayersV1` / `…PowerCurve` / `…DiceRoll`) lives in `pipeline.js` while its *math* lives in `lib/rosetta/translation/` — the seam is half-built | Phase 2c |
| 4 | Medium | The carousel branches on `direction` (`cfbToMadden` / `maddenToCfb`) in 7 separate modules, each re-deriving "which save is source" | Phase 3 |
| 5 | Medium | `main.js` holds 8 pieces of module-level mutable state (`cachedPool`, `lastGenerated`, `lastCoachPlan`, …) shared implicitly across 23 IPC handlers | Phase 4 |
| 6 | Low | `renderer/renderer.js` is 2,202 lines / 63 top-level functions with no module boundaries | Phase 5 |
| 7 | Low | No CI — the suite is green because it gets run by hand, every time, deliberately | Phase 6 |

---

## 2. Rules of engagement

These are the constraints every phase below inherits. They exist because this
app writes to save files people cannot get back.

1. **Behavior-preserving until proven otherwise.** These are refactors. If a
   phase changes output for any real save, that is a defect in the phase, not
   an improvement — revert and re-plan.
2. **Tests before restructuring, not after.** Phase 1 exists so Phases 2-5
   have something to fail against. Do not reorder it.
3. **Every phase ends green.** Full suite (`npm test`), plus `npm run build`
   for anything touching `main.js`/`renderer/`/packaging.
4. **Small, themed, reviewable commits.** One structural idea per commit. A
   commit that both moves code *and* changes it is not reviewable — split it.
5. **Move first, improve second.** When extracting a module, move the code
   verbatim in one commit; change it in the next. A pure move is diffable by
   eye; a move-plus-edit is not.
6. **Real-save verification for write paths.** The suite runs on fixtures.
   Anything touching `writeCareerFile`, the carousel write path, or the
   draft-class exporter also gets exercised against an actual save before its
   phase is called done.
7. **Stop at the checkpoint.** If a phase won't land safely in one pass, stop
   at its documented sub-step boundary and say what remains.

---

## 3. Phase 0 — Baseline & safety net ✅

**Done.** Committed the pending fake-save fixture extensions, tagged
`pre-refactor-baseline`, cut `baseline/pre-refactor`, and confirmed 30/30 spec
files green at the tag.

---

## 4. Phase 1 — Orchestration test coverage

**Goal:** the composition layer gets tested, not just the pieces it composes.

Every sub-module the carousel builds on (`coachFieldMap`, `enumBridge`,
`archetypeMap`, `synthesis`, `levelScale`, `schemeLookup`, `talentTree`,
`cfbEmploymentRecords`, `validate`, `timing`) is already tested in isolation.
Nothing tests them *wired together* — which is precisely the seam both
recent production bugs came through.

`lib/carousel/map/index.js` is already covered
(`test/carouselMapOrchestration.spec.js`, 33 assertions, verified
non-tautological by reintroducing the historical `CareerWins` bug and
confirming the spec caught it). This phase finishes the job.

### 1a. `moveCoachMaddenToCfbTeam`
The heaviest path and the one behind both bug reports. Needs a fixture with:
- a CFB `Coach` schema complete enough to satisfy `validateCoachFields` —
  which refuses the **entire** write if any mapped field is missing, so every
  field `mapCoachMaddenToCfb` emits needs a schema entry with the right enum
  member set;
- a `SeasonInfo` table in an open hiring window (the gate now covers HC **and**
  both coordinators);
- a disposable "nobody" free-agent coach carrying a non-zero `ActiveTalentTree`
  reference — required at *selection* time by `hasUsableChain` even when
  `config.skipTalentTree` bypasses the later grant;
- an employment donor with `CareerStats` / `SeasonStats` / `CharacterVisuals`
  references, plus free rows in those tables to claim.

Run with `{skipTalentTree: true, skipAppearance: true}` in the first pass to
avoid modeling the full 11-subtree chain.

Assertions: preflight gate fires; dry run returns a plan and does **not**
write; full run writes and saves; the job-security-rank transfer is *wired in*
(not merely correct in isolation, which `cfbJobSecurityRank.spec.js` already
proves).

### 1b. `moveCoachCfbToMadden` / `moveCoachCfbToMaddenTeam`
The reverse direction, reusing the Phase 1a fixture spine.

### 1c. `run.js` — `proposeMoves` / `commitMoves`
The batch layer `main.js` actually calls. Covers exclusion handling and the
propose→commit handoff.

**Exit criteria:** each new spec proven non-tautological by mutation (break the
source, watch it fail, restore, watch it pass). Suite green.

**Risk:** low — additive, no production code changes.

**Known hazard:** enum member sets in the fake schema are easy to get subtly
wrong, and wrong ones fail quietly rather than loudly. Derive them from the
real schema dump rather than from memory.

---

## 5. Phase 2 — Decompose `lib/pipeline.js`

**Goal:** 2,231 lines → a thin composition module over focused units.

This is the single highest-leverage structural change in the app, and it is
low-risk *if* done as pure moves. Sub-steps are ordered easiest-to-hardest so
early wins build confidence in the process.

| Step | Extract | To | Approx. size |
|---|---|---|---|
| 2a | `writeCareerFile` | `lib/careerFileWriter.js` | ~270 lines |
| 2b | `extractLeavingPlayers` + its visual/stats/award helpers | `lib/extract/` | ~420 lines |
| 2c | `calibratePlayersV1` / `…PowerCurve` / `…DiceRoll` drivers | `lib/rosetta/translation/*Engine.js` | ~370 lines |
| 2d | `projectDraftClass`, `computeProfiles`, combine/age/size helpers | `lib/projection.js` | ~350 lines |
| 2e | CSV helpers (`parseCsv`, `toCsv`, `loadDepartedCsv`) | `lib/csv.js` | ~65 lines |
| 2f | `pipeline.js` becomes composition + `runConversion` only | — | target <400 lines |

**2a first** because it's self-contained, has the clearest boundary, and gives
us a template for the rest.

**2c is the one with a design decision in it.** The injection seam already
exists and is clean — `calibratePlayers` builds a `RosettaContext` and hands
each engine's driver to `createTranslator` so `lib/rosetta/` never requires
`pipeline.js`. What's inconsistent is *where the drivers live*: the math is in
`lib/rosetta/translation/powerCurve.js` and `diceRoll.js`, but the driver that
uses it is 700 lines away in `pipeline.js`. Moving each driver next to its math
finishes the seam that's already three-quarters built. Preserve the injection
pattern exactly — it is what enforces the no-back-edge rule.

**Exit criteria per step:** the moved code is byte-identical (verify with
`git diff -M --stat` showing a rename/move, not a rewrite); suite green;
`npm run build` succeeds; a real save round-trips through the app for 2a and
2b.

**Risk:** low-to-moderate. The risk is not the move — it's accidentally
"improving" during the move. Rule 5 exists for this phase specifically.

---

## 6. Phase 3 — Carousel directional duplication

**Goal:** one place decides what `direction` means.

Today, `cfbToMadden` vs `maddenToCfb` is branched on independently in
`carousel/index.js`, `map/index.js`, `map/archetypeMap.js`,
`map/coachFieldMap.js`, `map/schemeLookup.js`, `placeOnCfbTeam.js`, and
`run.js`. Each re-derives which file is source, which is destination, which
schema to validate against, and which sentinel means free agent (CFB `255`,
Madden `32`). Adding a third game — or fixing a directional bug — means
finding all seven.

**Shape:** a `GameAdapter` describing one game's save conventions (free-agent
sentinel, coach/team table names, position set, schema quirks), with
`direction` resolving to a `{source, dest}` adapter pair once, at the entry
point. Downstream code asks the adapter instead of re-branching.

**Do not start this before Phase 1 is complete.** This is the only phase that
meaningfully changes control flow in the coach path, and the coach path is the
one that has already burned users' saves twice. Without orchestration tests
underneath it, this is the riskiest change on the list; with them, it's
routine.

**Exit criteria:** suite green; both directions verified against real CFB and
Madden saves; no `direction ===` comparisons left outside the adapter
resolution point.

**Risk:** moderate — the highest of any phase here. Gated behind Phase 1
deliberately.

---

## 7. Phase 4 — `main.js` session state

**Goal:** make the implicit explicit.

Eight module-level `let`s (`cachedPool`, `cachedPoolSource`, `lastGenerated`,
`lastCoachPlan`, `lastCoachDirection`, `lastCoachCfbPath`,
`lastCoachMaddenPath`, plus `configStore`) are read and written across 23 IPC
handlers with no declared lifecycle. The propose→commit coach flow and the
extract→generate→write player flow both depend on state one handler left
behind for another, and nothing enforces the ordering — a commit with no prior
propose, or a write with no prior generate, is a runtime surprise rather than a
clear error.

**Shape:** a small `SessionStore` with named transitions and explicit
preconditions, so "commit without propose" fails with a real message instead of
a null dereference.

**Exit criteria:** suite green; `npm run build` succeeds; manual pass through
both flows in the running app, including the out-of-order cases.

**Risk:** low-moderate. Contained to `main.js`; the IPC contract with the
renderer does not change.

---

## 8. Phase 5 — `renderer/renderer.js`

**Goal:** module boundaries in the UI layer.

2,202 lines, 63 top-level functions, one file, no boundaries. Lowest priority
here — it's the layer where a mistake is most visible and least destructive
(nothing in it writes a save directly), so it can wait until the layers that
*do* write saves are solid.

**Shape:** split by page/concern (config panels, draft-class table, coach
carousel, shared DOM helpers). No framework introduction — this is
decomposition, not a rewrite.

**Risk:** low, high visibility. Verify in the running app, not just by build.

---

## 9. Phase 6 — CI

**Goal:** the suite runs without someone remembering to run it.

A GitHub Actions workflow on push/PR running `npm test`. Cheap, and it makes
every phase above self-verifying from here on. Deliberately last: it's the
least interesting change and the easiest to add at any point, but it's also
the one that keeps the work above from quietly rotting.

---

## 10. Explicitly out of scope

Naming this now so it doesn't creep in mid-phase:

- **No framework adoption** (React/Vue in the renderer, a DI container, a test
  runner swap). The hand-rolled spec pattern works and is consistent across 30
  files.
- **No rating-math changes.** Power Curve and Dice Roll output is tuned against
  real saves and user feedback. Refactors must not move a single rating.
- **No formatting-only or rename-only commits** unless they serve a phase.
- **No new features.** This roadmap is structural debt only.
- **No reviving the Two-Anchor engine.** It was removed at `bfcdc05` after
  being confirmed dead; `lib/rosetta/translation/rosettaTranslator.js` remains
  only as a permanent delegate to `v1`.

---

## 11. Suggested order

1. **Phase 1** — the safety net everything else leans on.
2. **Phase 2a-2b** — fastest visible payoff, lowest risk, builds the move
   discipline.
3. **Phase 2c-2f** — finish the decomposition.
4. **Phase 4** — independent of the others; good filler between big phases.
5. **Phase 3** — the risky one, once Phase 1 has it covered.
6. **Phase 5**, then **Phase 6**.

Phases 2 and 4 are independent of each other and of Phase 3; if a phase stalls,
move sideways rather than pushing through it.
