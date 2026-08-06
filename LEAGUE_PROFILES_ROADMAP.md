# Per-League Settings Profiles -- Roadmap

**Status: Phases 1-5 implemented and verified. Roadmap complete.**

Goal: every adjustable tuning value gets an **independent NFL value and UFL
value**. The user flips the league switch to manage each league's set, and can
**export / import / share** a league's tuning as a file (so a good set of
weights can be handed to someone else). One generator runs both leagues; UFL
adds the overall boost, NFL doesn't.

This generalizes today's small `ufl` override block (globalStrength, debuff,
boost, devTraits) into a full, symmetric two-profile system -- and in doing so
the whole "override" concept dissolves: each league simply holds its own
complete values, nothing inherits.

---

## 1. Locked decisions (user, this session)

1. **Two fully independent profiles**, NFL and UFL. Each holds a complete,
   separate copy of every per-league tuning value. No inheritance / override
   layer.
2. **Export/import is one league per file.** A preset file carries a single
   league's tuning (so you can share a UFL set without touching someone's
   NFL). The file is tagged with which league it is.
3. **One generator, shared.** Both leagues run the identical
   translation/selection code. The only league-conditional behavior is the
   overall boost, which stays **UFL-only** (NFL never boosts).
4. **The engine choice stays global**, not per-league -- the dropdown is not
   part of a profile (consistent with the existing "engine left alone on
   flip" decision). Whatever engine is selected runs against the active
   league's profile.
5. **The Est. Madden OVR display is left as-is** for now. The user tunes by
   feel against the real Madden import, not against the app's estimate. (We
   verified the estimate diverges from Madden's real recompute in opposite
   directions per engine -- Dice Roll reads ~8 low, Power Curve reads high
   once the anchor is involved -- but rebuilding it is explicitly out of
   scope here.)

---

## 2. What is per-league vs. shared [CONFIRMED -- user, this session: draftBoard stays shared]

**Per-league (lives in each profile):**
- `positionValue` (draft-board weights)
- `positionStrength` (Power Curve per-position compression dials)
- `positionExtraDrop`
- `positionCaps`
- `powerCurve` (anchors, **globalStrength**, jitter, clampFloor/Ceiling,
  ratingCategory, categoryOverrides, ratingTweaks)
- `draftValue` (board weights: awards/ath/prod/round/variance/generational)
- `devTraits` (X-Factor / Superstar / Star rates)
- `overallAnchor`
- `diceRoll` (`classStrength` -- NFL profile's roll-or-forced-tier; `debuff`
  -- UFL profile's fixed value; each league's unused field sits inert. The
  **new Dice Roll spread control** from Phase 3 below still needs adding.)
- `realism` (agility/size penalty)
- `overallBoost` (**UFL profile only in effect** -- NFL never applies it,
  even if its own profile's `enabled` were somehow true)
- `ratingAdjustments`, `kpAwarenessCap`, `bell` -- V1-engine-only, no UI today
- `legacy` -- **as shipped**: `dropLeniency`/`defaultDrop`/`calibrationJitter`/
  `quantileJitter`, carved out of the old shared `general` section (V1-engine
  only, no UI today)

**Shared / session-level (top of config, one value):**
- `league` (which profile is active -- the toggle itself)
- `translation.strategy` (engine)
- `general` (seed, classSize, dropLeniency, defaultDrop, jitters)
- `population.mode`
- `draftBoard` (organization + chaos) -- *debatable; proposed shared, easy to
  move per-league if wanted*

---

## 3. Architecture

**On disk / ConfigStore:**
```
{ league, translation, general, population, draftBoard,
  profiles: { nfl: { ...tuning keys... }, ufl: { ...tuning keys... } } }
```

**In the renderer (unchanged shape):** the renderer keeps working with a FLAT
`cfg` = session keys + the active league's tuning keys, exactly as today. This
is what keeps the ~70 existing `cfg.positionValue` / `cfg.powerCurve` / ...
touchpoints from all having to change.

Three choke points do the flat<->profile bridging:
- **load**: split the stored config into session keys (onto `cfg`) + both
  profiles (kept aside); flatten the active league's tuning onto `cfg`.
- **league switch**: capture `cfg`'s current tuning back into the old
  league's profile, flatten the new league's profile onto `cfg`, re-render
  every settings page.
- **save**: capture `cfg`'s tuning into the active profile, persist
  `{session + profiles}`.

`TUNING_KEYS` (the list of per-league keys) lives in defaults.js as the single
source of truth for what flatten/capture move.

**The `ufl` block dissolves:** `ufl.powerCurveGlobalStrength` becomes the UFL
profile's `powerCurve.globalStrength`; `ufl.diceRollDebuff` becomes the UFL
profile's `diceRoll.debuff`; `ufl.overallBoost*` becomes the UFL profile's
`overallBoost`; `ufl.devTraits` becomes the UFL profile's `devTraits`.
pipeline.js stops reading a special `ufl` section and instead reads the active
profile -- with the single remaining league check being "apply overallBoost
only in UFL mode."

---

## 4. Phases (each gated, tests added per project convention)

### Phase 1 -- Config architecture (no UI/behavior change yet) [DONE]
Restructure DEFAULT_CONFIG into session + `profiles.{nfl,ufl}`. Add
`TUNING_KEYS`, flatten/capture helpers, and migration in `mergeConfig` so an
existing saved (flat) config maps onto both profiles -- NFL profile takes the
old flat values verbatim; UFL profile takes them too but with the current
UFL-specific defaults folded in (globalStrength 0.5, diceRoll debuff, boost
on, thinner devTraits). pipeline.js reads the active profile.

*Gate: for the same save+seed, NFL and UFL generated output is byte-identical
to today's -- the numbers just come from profiles now. All specs pass.*
**Verified**:

- **Migration**, tested against the user's real on-disk `generation-config.json`
  (`league: 'ufl'`, a full `ufl` override block): every migrated value checked
  exactly against its expected pre-migration equivalent -- NFL/UFL
  `powerCurve.globalStrength` (1 / 0.5), `diceRoll.classStrength`/`debuff`
  (`normal` / -0.21), `overallBoost` (off+0 / on+4), `devTraits`
  (0.08/1/35 vs 0/0.25/20), shared `positionValue`/`legacy`/etc. identical on
  both profiles. `activeConfig()` on the migrated result reproduced the exact
  flat values the old runtime override used to compute.
- **Byte-identical pipeline output**: generated NFL and UFL classes (both
  engines) against the real save with the shipped config, and compared to
  the exact band numbers measured earlier this session before the
  refactor -- every value matched to the decimal (e.g. UFL Dice Roll
  55/64/75 avg 64.2 both before and after; UFL Power Curve 56/64/73 avg
  64.1 both before and after).
- **Full test suite**: all 15 specs pass (two stale accessors in
  `test/powerCurve.spec.js` updated to the new profile paths -- they were
  reading `mergeConfig(null).powerCurve` directly, now
  `activeConfig(mergeConfig(null), 'nfl').powerCurve`).
- **Live app IPC isolation**: simulated main.js's `config-get`/`config-set`
  round trip against a copy of the real saved config (no Electron launch
  needed for this part) -- editing a value while UFL is active persists to
  ONLY the UFL profile; the NFL profile's matching values are provably
  unchanged after reload from disk. The app was also launched directly
  (`npm start`) to confirm no startup errors from the new config shape.
- Also removed the now-dead runtime-override code in pipeline.js (the
  `if (cfg.league === 'ufl') cfg.powerCurve.globalStrength = cfg.ufl.
  powerCurveGlobalStrength` pattern, and the `cfg.league === 'ufl' ?
  cfg.ufl.devTraits : cfg.devTraits` ternary) -- both profiles' values are
  already correct once flattened via `activeConfig`, so the override logic
  simply isn't needed anymore.

### Phase 2 -- Renderer: the league switch drives which profile you edit [DONE]
Wire the three choke points. Flipping NFL/UFL re-renders every settings page
with that league's values; edits persist to that league only.

*Gate: edit a UFL position value, flip to NFL and back -- NFL values intact,
UFL edit preserved; both survive an app restart.* **Verified**, by simulating
the exact call sequence the renderer's switch handler now uses against a copy
of the real saved config (this app is a native Electron window, not
browser-previewable, so this replicates main.js's actual IPC handlers
directly -- same technique used to verify Phase 1): edited UFL's
`positionValue.QB`, flipped to NFL (came back untouched at its own value),
flipped back to UFL (edit intact), reloaded via a fresh `ConfigStore`
instance simulating an app restart (both leagues' values correct). All four
checks passed.

**A real bug was caught and fixed before this shipped**, not just measured
after the fact: the naive implementation (`cfg.league = e.target.value` on
the SAME flat `cfg`, matching the old single-league code) would silently
corrupt data -- flipping the toggle changes `cfg.league` but leaves every
OTHER field on `cfg` holding the OUTGOING league's tuning values; if
`scheduleSave()`'s debounced write (350ms) fired anytime after the flip
before the tuning values were refreshed, `foldIntoProfile` would fold the
wrong league's values into the new league's on-disk profile. Fixed with an
explicit sequence in the switch handler: clear the pending debounce, flush
the outgoing league's `cfg` via an immediate `configSet` (while `cfg.league`
still correctly names the outgoing league), THEN fetch the incoming league's
values fresh via a new `config-get-for-league` IPC call and replace `cfg`
wholesale -- never partially mutating a still-mixed object. A new
`syncLeagueState()` helper (config + defaults + toggle + hint, in one place)
is shared by init(), the switch handler, and preset import, so this sequence
only needs to be correct once.

Also fixed in passing: `config-import` previously returned only the flat
config, not matching defaults -- meant an imported preset's "differs from
default" indicators and Reset buttons would silently compare against
whichever league's defaults happened to be loaded before the import, not the
imported file's own league. Now returns both, via a shared
`flatConfigAndDefaults()` helper in main.js used by `config-get`,
`config-get-for-league`, and `config-import` alike.

### Phase 3 -- Dice Roll spread control (makes "compress" possible) [DONE]
Add a per-league Dice Roll spread/variance dial (`diceRoll.spread`, default
1.0) that scales the PER-PLAYER bust/gem roll (BUST_GEM_TABLE, roughly -0.10
to +0.06) before it's added to the class-wide debuff -- the class-wide term
itself is untouched, so this narrows spread around whatever that term already
gives, rather than being a second "how strong" dial. 0 = no roll at all,
every player gets exactly the class debuff.

*Gate: lowering it measurably narrows the regression-scored (Madden-real)
spread without moving the median; NFL and UFL each honor their own value.*
**Verified**, measured against a REAL Madden-real approximation (scoring the
actual written ratings through `data/overall_formula.json`, not the
misleading `EstMaddenOverall` display -- see the UFL_ROADMAP.md session
where that display was found to diverge from Dice Roll's real recompute) on
the July 06 save that first showed the crater:

| spread | UFL (min/p10/med/p90/max) | stdDev | NFL (min/p10/med/p90/max) | stdDev |
|---|---|---|---|---|
| 1.0 (old default) | 23/46/56/65/75 | 8.5 | 25/43/57/67/75 | 9.2 |
| 0.6 | 25/48/58/65/74 | 7.3 | 29/46/59/67/73 | 7.8 |
| 0.3 | 26/50/60/65/73 | 6.6 | 30/48/60/66/72 | 7.1 |
| 0.0 | 28/51/61/65/72 | 6.3 | 30/51/62/67/73 | 6.5 |

Confirmed independent: forcing UFL's spread to 0.1 while NFL stays at its own
default produces byte-identical NFL output.

**Median isn't perfectly pinned -- shifts ~5-6 points across the full
1.0-to-0.0 range, and I'm shipping that rather than engineering it away.**
BUST_GEM_TABLE isn't symmetric around zero (its negative/bust values run
larger in magnitude, -0.10 to -0.03, than its positive/gem values, +0.01 to
+0.06), so the roll's own average contribution is a small NEGATIVE bias, not
exactly zero -- scaling it toward 0 as spread drops also shrinks that bias,
nudging the median up a little as a side effect of narrowing. I considered
recentering the roll around its own mean before scaling (so spread would
touch ONLY variance, never the mean) and decided against it: it would need a
hardcoded mean-bias constant kept in sync with BUST_GEM_TABLE and the rank-
bias curve by hand, for a few points of precision, against a side effect that
is directionally the SAME thing the user originally asked for in this
session ("compressed... and buffed"). The measured shape also targets
exactly the right end: p90 barely moves (65 at every spread value) while the
LOW tail does nearly all the compressing (UFL min 23->28) -- it's narrowing
the crater specifically, not flattening the whole class toward the middle.

**Also wired into the UI**, ahead of the phase's literal wording -- a config
field nobody can reach without hand-editing JSON isn't a usable feature yet.
Added a "Player Roll Spread" number input to the existing Dice Roll settings
card (`renderer.js`'s `buildTranslationPage`), right below Class Strength,
0-2 range / 0.1 step. Also fixed a pre-existing gap this exposed: "Reset
Translation" never reset `cfg.diceRoll` at all (not even `classStrength`,
which predates this phase) -- now it does.

### Phase 4 -- Per-league export / import / share [DONE]
Export the active league's profile to a JSON file tagged with its league;
import a league file onto the active league (warn if the file's league tag
doesn't match what you're importing into). Built on the existing
config-export/import IPC, scoped to one profile.

*Gate: export UFL, reset UFL, import the file -> UFL restored; NFL untouched.
Importing an NFL file while on UFL warns before applying.* **Verified**
against a copy of the real saved config, exercising the exact logic
main.js's new handlers run: edited UFL's `positionValue.QB` (55) and
`diceRoll.spread` (0.4), exported -> file contains only `{league: 'ufl',
profile: {...}}`, no `nfl` key and no session keys leaked in. Reset UFL to
its defaults (confirmed both values back to 6 / 1). Imported the file back:
both values restored exactly, and the NFL profile was byte-identical before
and after the import. Also confirmed the mismatch condition the warning
dialog branches on: true for an NFL-tagged file landing on UFL, false
(no prompt) for a same-league file.

New IPC: `config-export-profile` (writes `{league, profile}}`, `profile`
being just the TUNING_KEYS subset of the active flat config -- session keys
never leak into a per-league file) and `config-import-profile(targetLeague)`
(validates the file has a `profile` object, shows an Electron confirm dialog
if the file's own `league` tag doesn't match `targetLeague`, then folds into
ONLY that profile via the same `foldIntoProfile` Phase 1/2 already rely on).
Distinct from `config-export`/`config-import`, which still round-trip the
WHOLE app (both profiles + session settings) -- relabeled in the UI to
"Export/Import All Settings" so the two aren't confused, with the new
"Export/Import League Settings" buttons alongside them, labels updating live
with the league toggle (`updateLeaguePresetLabels()`, called from the same
`syncLeagueState()` Phase 2 built).

**Honest gap**: the actual `dialog.showMessageBox` confirm prompt needs a
real Electron window to click through -- this app is a native window, not
browser-previewable, so I verified the CONDITION it branches on is correct
(above) rather than the literal button-click UX. Worth a manual check:
export a UFL file, switch to NFL, Import League Settings, pick that file --
should show a "This file is a UFL preset..." warning before applying.

### Phase 5 -- Starting values + a preset "reader" [DONE]
Ship sensible per-league starting defaults (NFL healthy ~mid-60s real; UFL
boosted toward the NFL band) as a baseline the user then fine-tunes against
real imports. Add a small preview so an imported preset can be inspected
before it's applied.

*Gate: fresh install lands both leagues in a reasonable real-Madden band; the
preview shows a file's contents without committing them.* **Verified** --
see below. Both halves ended up larger than the phase's one-line description
suggested, because auditing the SHIPPED defaults with an accurate metric
surfaced that several of them (chosen in earlier phases) were tuned against
`EstMaddenOverall`, which this session separately discovered does not match
what Madden actually computes on import.

**Part A -- the default-value retune.** All measurement here is regression-
scored: writing the actual generated ratings through `data/overall_formula.json`
(the same per-position model Madden's own recompute approximates), NOT
`EstMaddenOverall`. That distinction is the whole story of this part --
auditing the CURRENT shipped defaults this way, on the July 06 save that
first exposed the problem (`DYNASTY-MAINDYNASTY`), found:

| Combo (old shipped defaults) | Real median | vs. NFL PC reference (66) |
|---|---|---|
| NFL Power Curve | 66 | -- (the reference; healthy, 1 player <50) |
| NFL Dice Roll (auto-roll) | 55-62 across seeds | close, BUT 44-101 of 402 players under 50 overall |
| UFL Power Curve (boost +4) | 73 | +7 (overshooting) |
| UFL Dice Roll (boost +4) | 57 | -9, AND still 79 players under 50 |
| UFL Power Curve, boost OFF | 69 | +3 -- already near NFL with NO boost |
| UFL Dice Roll, boost OFF | 53 | -13, 140 players under 50 |

Three real problems, not one: (1) NFL Power Curve was already fine, untouched.
(2) NFL Dice Roll craters on the auto-rolled class-strength tier even though
its median looked reasonable -- up to a quarter of the class under 50
overall. (3) UFL's two engines were meant to "agree at baseline" (Decision 3)
but their REAL baselines were 16 points apart (53 vs 69) despite reading the
same on the misleading display, and the +4 boost -- sized against that same
display -- was stacking real inflation on a baseline that, measured
correctly, had already arrived at the NFL band on its own.

Retuned via sweeps (all against the real metric), verified on BOTH saves to
rule out overfitting to one CFB-overall distribution:

| Setting | Old | New | Why |
|---|---|---|---|
| `profiles.nfl.diceRoll.spread` | *(new field)* | **0.3** | Per-player roll swing scaled down. Even at spread=0 a "Very Weak" class-strength roll still leaves ~30 players <50 (the CLASS debuff itself, not something this per-player dial reaches) -- 0.3 cuts the auto-roll's typical <50 count roughly in half without going fully deterministic. |
| `profiles.ufl.diceRoll.debuff` | -0.21 | **-0.05** | Re-aligns Dice Roll's REAL baseline to Power Curve's REAL baseline (measured 69 vs 70, ~1 point apart -- the "engines agree" property Phase 3 of UFL_ROADMAP intended, this time actually true). |
| `profiles.ufl.diceRoll.spread` | *(new field)* | **0.3** | Same fix as NFL's, applied to UFL's own profile independently. |
| `profiles.ufl.overallBoost.enabled` | true | **false** | Stage 1 alone (globalStrength 0.5 + the two values above) already lands UFL at +3 to +5 over NFL's real median on both test saves -- adding +4 more was the overshoot. Reverts to the mechanism's ORIGINAL design (UFL_ROADMAP.md Decision 5: "off by default, the honest 'this is inflation' case") now that it's correctly understood to be optional rather than load-bearing. |
| `profiles.ufl.overallBoost.points` | 4 | **0** | Paired with the line above; still fully functional if re-enabled. |
| `profiles.ufl.powerCurve.globalStrength` | 0.5 | **0.5 (unchanged)** | Its real baseline (69) was already close to NFL's -- nothing to fix here. |

Final verification, both saves, all four combos real-scored:

| | DYNASTY-MAINDYNASTY | DYNASTY-DRAFTSTAGE |
|---|---|---|
| NFL PC (reference) | med 66, <50: 1 | med 65, <50: 1 |
| UFL PC (boost off) | med 69 (+3), <50: 1 | med 68 (+3), <50: 0 |
| UFL Dice (new debuff) | med 70 (+4), <50: 2 | med 70 (+5), <50: 2 |

**Also found and fixed while doing this**: `activeConfig()` only spread
TOP-LEVEL keys, leaving each tuning key's own value (e.g. `diceRoll`) as a
shared REFERENCE into whatever object was passed in, not a copy. Every
caller that gets its config from `mergeConfig()` was already safe (it clones
`DEFAULT_CONFIG` fresh every call), but `flatConfigAndDefaults()`'s
`defaults` field calls `activeConfig(DEFAULT_CONFIG, league)` on the raw
module singleton directly -- discovered when a verification script mutated
what it thought was an independent copy and silently corrupted the shared
default for the rest of that process. renderer.js's own code was never
actually at risk (every `META.defaults` access is read-only or explicitly
`JSON.parse(JSON.stringify(...))`-cloned before assignment -- checked every
call site), but that was a discipline holding the line, not a guarantee.
Fixed at the source: `activeConfig()` now deep-clones its own output, so no
caller -- present or future -- can hit this.

**Part B -- the import preview.** Split the per-league import IPC in two:
`config-import-profile` now only picks a file and reads/validates it, with
no side effects; a new `config-apply-imported-profile` is the sole place
that actually writes, and it's never called except from the preview
modal's "Apply Import" button. This replaces Phase 4's native
`dialog.showMessageBox` league-mismatch warning entirely -- the in-app
preview shows the same mismatch as a banner, plus (going further than the
original phase's ask) a full diff of every value that would actually
change, computed by recursively flattening both the incoming profile and
the current live config to leaf paths and keeping only the ones that
differ -- so a one-value tweak shows one line, not the whole profile.

Verified directly (pure logic, no Electron dependency needed for the diff
math itself): a profile differing in exactly 2 leaf values (one scalar, one
inside a 22-entry position table) produced exactly 2 diff rows; an
identical profile produced 0 (a clean "nothing to change" case); confirmed
the split IPC's read step writes nothing to disk (checked on-disk state
between read and apply) and the apply step commits only to the targeted
league's profile, leaving the other untouched.

**Same honest gap as Phase 4**: the actual modal rendering and click-through
needs a real Electron window. Verified the logic (diff computation, no-op
detection, read/apply separation) directly; haven't watched the modal
itself render and clicked through it. Worth a manual check: export a UFL
file with a couple of edited values, switch to NFL, Import League Settings,
pick that file -- should show a mismatch banner and a short list of exactly
what would change, with nothing applied until "Apply Import."

---

## 5. Non-goals
- Not rebuilding the Est. Madden OVR estimate (Decision 5).
- Not changing the engines' math -- only exposing a new Dice Roll spread dial
  and re-homing existing knobs per league.
- Not auto-tuning the numbers -- the user dials each league in against real
  imports; this roadmap builds the surface that lets them.
