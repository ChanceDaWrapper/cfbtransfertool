# Config Layer — Hardening & Fix Roadmap

**Status: Phases 1-6 implemented and verified.** Phase 7 not started (gated
on real Madden readback -- see its own section). Every finding below was
empirically reproduced (not inferred) during the post-Phase-5 audit of the
per-league profiles work; the repro for each is named in its phase.

Scope: fix the defects that audit found, close the structural gaps that let
them happen, and register the risks that will bite later if left alone.

Companion to [`LEAGUE_PROFILES_ROADMAP.md`](LEAGUE_PROFILES_ROADMAP.md)
(which built the thing being hardened) and
[`UFL_ROADMAP.md`](UFL_ROADMAP.md) (which the tuning values come from).

---

## 1. Findings → phase map

| # | Severity | Finding | Fixed in |
|---|---|---|---|
| 1 | **High** | A per-league file imported through "Import All Settings" silently resets every setting to defaults | Phase 1 |
| 2 | **High** | UFL + Dice Roll: `diceRoll.debuff` (the value that drives output) has no UI; `classStrength` is shown but ignored | Phase 2 |
| 3 | **High** | `overallBoost` has no UI on either profile — reachable only by hand-editing JSON | Phase 2 |
| 4 | Medium | `overallBoost` ships `{enabled:false, points:0}` — enabling it adds +0, reads as broken | Phase 2 |
| 5 | Medium | `generate-class` passes a FLAT config to `mergeConfig`, silently taking the legacy-migration path | Phase 3 |
| 6 | Low | Import preview diffs raw file keys, so it can list changes `foldIntoProfile` will drop | Phase 5 |
| 7 | Low | `countSectionDiffs` ignores `diceRoll.*`, `overallBoost`, `realism` — "modified" badges stay stale | Phase 6 |
| 8 | Low | Reset buttons don't cover `overallBoost` (nor pre-existing `legacy`/`bell`/`ratingAdjustments`/`kpAwarenessCap`) | Phase 6 |
| 9 | Low | `config-reset` IPC is dead code, and would return the NFL view regardless of active league | Phase 6 |
| 10 | Low | Import modal has no Escape / click-outside dismissal, no focus trap | Phase 6 |
| 11 | Low | Target league is read at *apply* time, not *preview* time — can drift via keyboard nav | Phase 6 |

---

## 2. Principles for these fixes

1. **One classifier, one truth.** File-shape detection gets written once and
   used by every import path. The current bug exists because two importers
   validated differently (one strictly, one not at all).
2. **The IPC boundary has a declared shape.** Everything crossing from the
   renderer is FLAT; everything at rest is CANONICAL. Conversions happen at
   the boundary, never implicitly inside `mergeConfig`.
3. **Invariants get tests, not comments.** The bug classes found here
   (forgot-to-register-a-key, shape ambiguity) are exactly what a cheap
   invariant test catches forever. See Phase 4.
4. **A setting that ships must be reachable in the UI**, or it is not a
   feature — it is a trap for whoever finds it in the JSON later.
5. **No silent destructive writes.** Anything that can replace user settings
   validates first and reports what it did.

---

## 3. Phases

### Phase 1 — Stop the data loss [DONE]

**Repro (confirmed):** export a league file → import it via "Import All
Settings" → `nfl.positionValue.QB 42→6`, `general.seed "my-seed"→""`,
`classSize 350→402`, both profiles reset. No error shown.

**Root cause:** `config-import` hands arbitrary JSON to
`configStore.save(parsed)`. `mergeConfig` sees no `profiles` key, takes the
legacy-flat path, finds no tuning keys at top level (they're nested under
`profile`), and returns pure defaults.

**Files:** `lib/defaults.js`, `main.js`

1. Add to `lib/defaults.js`, exported:

```js
// Identifies which of this app's config file shapes `parsed` is, so every
// import path validates the same way. Deliberately strict: a file matching
// nothing recognizable is 'unknown' rather than being treated as an empty
// legacy config, because mergeConfig({}) returns pure defaults -- i.e.
// silently wiping every setting the user has.
function classifyConfigFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  if (parsed.profile && typeof parsed.profile === 'object' && !Array.isArray(parsed.profile)) {
    return 'leagueProfile';                 // { league, profile } -- one league
  }
  if (parsed.profiles && typeof parsed.profiles === 'object'
      && (parsed.profiles.nfl || parsed.profiles.ufl)) {
    return 'canonical';                     // whole app, current shape
  }
  const known = [...SESSION_KEYS, ...TUNING_KEYS];
  if (known.some((k) => parsed[k] !== undefined)) return 'legacyFlat'; // pre-profiles export
  return 'unknown';
}
```

2. In `main.js` `config-import`, classify before saving:

```js
const kind = classifyConfigFile(parsed);
if (kind === 'leagueProfile') {
  throw new Error('This is a single-league settings file. Use "Import League Settings" '
    + 'to apply it to your current league.');
}
if (kind === 'unknown') {
  throw new Error('This does not look like a Pipeline settings file.');
}
const saved = configStore.save(parsed);
```

3. In `config-import-profile`, replace the ad-hoc `!parsed.profile` check with
   `classifyConfigFile(parsed) !== 'leagueProfile'` so both directions share
   one rule. Keep its existing (already good) error text.

**Gate:** a league file imported via All Settings throws and leaves the config
file byte-identical on disk; `{}` and `[]` throw; canonical and legacy-flat
files still import correctly. Assertions added in Phase 4.

**Verified.** Implemented exactly as specced -- `classifyConfigFile` added to
`lib/defaults.js`, both `config-import` and `config-import-profile` now
classify before acting (the latter's ad-hoc `!parsed.profile` check replaced
with the same classifier, so both directions share one rule as intended).
Re-ran the exact repro from the audit through `classifyConfigFile` directly:
a `{league, profile}` file now classifies as `'leagueProfile'` (rejected by
`config-import` with a clear redirect to "Import League Settings" instead of
silently wiping everything); `canonical`/`legacyFlat`/`{}`/`null`/`[]` all
classify correctly. Table-driven assertions for all of this now live in
`test/config.spec.js` (Phase 4).

---

### Phase 2 — Make the UFL dials reachable [DONE]

**Repro (confirmed):** zero references to `overallBoost` in `renderer.js`;
`pipeline.js` reads `diceRoll.debuff` for UFL and never reads `classStrength`,
yet the Dice Roll card renders `classStrength` and not `debuff`.

**Files:** `lib/defaults.js`, `renderer/index.html`, `renderer/renderer.js`

1. **Fix the zero-points papercut** in `defaultProfileTuning()`:

```js
overallBoost: { enabled: false, points: 4 },   // was points: 0
```
   Then delete the now-redundant `p.overallBoost = { enabled: false, points: 0 };`
   line in `defaultUflProfile()` (base value is already correct for both).
   *Existing saved configs keep their persisted `points: 0`* — step 5 handles
   that so nobody hits the no-op.

2. **Add the boost card** to the Rating Translation page in `index.html`,
   after the Dice Roll card:

```html
<div class="card" id="uflBoostCard">
  <h2>UFL Overall Boost</h2>
  <div id="uflBoostSettings"></div>
</div>
```

3. **Show the dial that is actually live for this league.** In
   `buildTranslationPage()`'s `isDiceRoll` branch, replace the unconditional
   Class Strength knob with:

```js
const isUfl = cfg.league === 'ufl';
if (!isUfl) {
  dr.appendChild(knob('Class Strength', D['diceRoll.classStrength'], selectInput(/* unchanged */)));
} else {
  dr.appendChild(knob('Fixed Class Debuff', D['diceRoll.debuff'],
    numberInput(cfg.diceRoll.debuff ?? -0.05, { step: 0.01, min: -0.5, max: 0.2 },
      (v) => { cfg.diceRoll.debuff = v; })));
}
dr.appendChild(knob('Player Roll Spread', D['diceRoll.spread'], /* unchanged */));
```

4. **Build the boost card** (both engines — the boost is engine-agnostic), and
   show it only on UFL, since `pipeline.js` gates it on `league === 'ufl'`:

```js
$('uflBoostCard').style.display = cfg.league === 'ufl' ? '' : 'none';
if (cfg.league === 'ufl') {
  const b = $('uflBoostSettings');
  b.innerHTML = '';
  b.appendChild(knob('Enable Overall Boost', D['overallBoost.enabled'],
    checkboxInput(cfg.overallBoost.enabled, (v) => {
      cfg.overallBoost.enabled = v;
      // Never let enabling it be a silent no-op (finding #4): a config saved
      // before this default changed still carries points: 0.
      if (v && !Number(cfg.overallBoost.points)) {
        cfg.overallBoost.points = META.defaults.overallBoost.points || 4;
      }
      buildTranslationPage();
    })));
  b.appendChild(knob('Boost Points', D['overallBoost.points'],
    numberInput(cfg.overallBoost.points ?? 4, { step: 1, min: 0, max: 25 },
      (v) => { cfg.overallBoost.points = v; })));
}
```
   Note this card must be built **outside** the `if (isDiceRoll) { ... return; }`
   early-return, or it will never render under Dice Roll. Place it immediately
   before that branch, or move the `return` accordingly.

5. Add to the defensive block at the top of `buildTranslationPage()`:

```js
if (!cfg.overallBoost) cfg.overallBoost = JSON.parse(JSON.stringify(META.defaults.overallBoost));
```

**Gate:** on UFL + Dice Roll the Class Strength dropdown is replaced by a
Fixed Class Debuff field showing `-0.05`; on NFL the reverse; the boost card
appears only on UFL and under both engines; enabling the boost on a
pre-existing config auto-fills 4 rather than 0; moving each dial visibly
changes generated output.

**Implemented as specced, with one adjustment.** All five steps applied:
`overallBoost` base default changed to `{enabled: false, points: 4}` in
`defaultProfileTuning()`, and the now-redundant UFL-specific override in
`defaultUflProfile()` removed (both profiles get the shared base since only
`enabled` ever differed, and it already defaults to `false`). The boost card
markup added to `index.html` right after the Dice Roll card. Its
build/show logic placed BEFORE the `isDiceRoll` early-return in
`buildTranslationPage()` exactly as the roadmap's step 4 note warned --
confirmed by placement, not just intent, since the boost has to render under
BOTH engines. The Class-Strength-vs-Fixed-Debuff swap applied inside the
`isDiceRoll` branch. Auto-fill-on-enable guards a pre-existing `points: 0`
config exactly as specced.

One deviation: the roadmap's sketch called `scheduleSave()` explicitly
inside the boost-enable checkbox's `onChange`. Checked `checkboxInput()`'s
own implementation first -- it already calls `scheduleSave()` right after
invoking the callback -- so the explicit call would have fired it twice per
click. Removed the redundant call rather than implement the sketch verbatim;
noted in the code comment so it doesn't look like an oversight later.

Verified: element IDs added to `index.html` cross-checked byte-for-byte
against every `$('uflBoost...')` reference in `renderer.js` (`uflBoostCard`,
`uflBoostSettings`) -- an exact-match check, not a visual one, since a typo
here would `$()`-to-null and throw the moment the Rating Translation page
renders. `DEFAULT_CONFIG.profiles.{nfl,ufl}.overallBoost` both confirmed
`{enabled: false, points: 4}` at the module level. Full test suite green
(`test/config.spec.js`'s legacy-migration assertions were unaffected --
they test explicit override values from a fixture, independent of the
shipped default). App launches without error.

**Same honest gap as every renderer-facing phase this session:** the actual
card swap, checkbox auto-fill, and rendered `-0.05` value need a real
Electron window to see rendered. Verified everything checkable without one
(config values, ID wiring, syntax, no-crash launch); haven't watched the
Rating Translation page itself repaint on a league flip. Worth a manual
check: switch to UFL with Dice Roll selected -- Class Strength should be
gone, replaced by "Fixed Class Debuff" showing `-0.05`; a new "UFL Overall
Boost" card should appear below it with the toggle off and "4" already
filled in Boost Points.

---

### Phase 3 — Remove the flat/canonical ambiguity at the IPC boundary [DONE]

**Repro (confirmed):** `mergeConfig(flatRendererConfig)` takes the legacy path
and copies the active league's values into **both** profiles. Generation is
correct today only because it reads back solely the active league.

**Files:** `main.js`

1. In `generate-class`, convert explicitly instead of relying on migration:

```js
const canonical = enforceMinClassSize(foldIntoProfile(configStore.load(), config));
const players = generateClass(cachedPool, canonical, sendLog);
```

2. `write-career` also destructures a `config` argument — **but never uses
   it** (it writes `lastGenerated`, which was already built with the right
   config at generate time). Nothing to convert; delete the dead parameter
   from the handler signature, and drop it from the renderer's call site and
   `preload.js` so it can't be mistaken for a live config path later.

3. Add the invariant as a comment at the top of the config IPC block:

> Everything crossing IPC from the renderer is FLAT (one league). Everything
> at rest in ConfigStore is CANONICAL (both profiles). Convert with
> `foldIntoProfile` on the way in and `activeConfig` on the way out — never
> hand a flat config to `mergeConfig` and rely on the legacy path to fix it.

**Gate:** generated class is byte-identical before/after this change for
NFL/UFL × PowerCurve/DiceRoll on a fixed seed (capture a baseline first); the
canonical object built inside `generate-class` no longer has the active
league's values in the inactive profile.

**Verified.** `generate-class` now builds
`enforceMinClassSize(foldIntoProfile(configStore.load(), config))` instead of
`enforceMinClassSize(mergeConfig(config))`. Confirmed against a copy of the
real saved config with an UNSAVED edit live in the flat config (simulating
the actual risk window -- an edit sitting in the 350ms autosave debounce at
the moment Generate is clicked): the OLD path leaked the edited value into
the NFL profile's intermediate object; the NEW path leaves NFL's real
on-disk value untouched while still correctly reflecting the unsaved edit
for generation (so nothing about "edit then immediately generate" changed
from the user's side -- only the wrong intermediate object is gone).
`write-career`'s dead `config` parameter removed from the handler, the
renderer's call site, and confirmed `preload.js`'s generic passthrough
needed no change. Full test suite unaffected (regression check, since this
phase touches IPC plumbing pipeline.js tests don't exercise directly).

---

### Phase 4 — Config-layer test suite *(the actual future-proofing)* [DONE]

Every verification in the profiles work was a throwaway scratchpad script.
Nothing in `npm test` currently exercises `mergeConfig` / `activeConfig` /
`foldIntoProfile` / migration. The next person to touch `defaults.js` has no
safety net — this phase is the highest-value item in the roadmap.

**Files:** `test/config.spec.js` (new), `package.json`

Assertions to lock, matching this project's existing `check(...)` spec style:

1. **Key-coverage invariant.** Every top-level key of `DEFAULT_CONFIG` is in
   `SESSION_KEYS` ∪ `TUNING_KEYS` ∪ `{'profiles'}`. *Catches the entire
   "added a config section, forgot to register it, it silently never
   persists" bug class.*
2. Every `TUNING_KEYS` member exists on both default profiles.
3. **Round trip:** `canonical → JSON → mergeConfig` deep-equals the original,
   including nested `powerCurve.anchors`, `ratingCategory`,
   `categoryOverrides`, `ratingTweaks`, `ratingAdjustments`.
4. **Isolation:** `foldIntoProfile` with an NFL-flat config leaves
   `profiles.ufl` byte-identical, and vice versa.
5. **Legacy migration:** a checked-in fixture of the real pre-refactor flat
   config (with its `ufl` block) migrates to both profiles correctly, and the
   five UFL-specific fields land exactly.
6. **`activeConfig` deep clone:** mutating its result never mutates
   `DEFAULT_CONFIG` (the bug found during Phase 5).
7. **`classifyConfigFile`:** table-driven over canonical / legacyFlat /
   leagueProfile / `{}` / `null` / `[]`.
8. Unknown keys in a flat config are dropped by `foldIntoProfile`.
9. `enforceMinClassSize` clamps on a canonical config.

Wire into `package.json`'s `test` script alongside the other specs.

**Gate:** `npm test` runs it green; deliberately removing a key from
`TUNING_KEYS`, or deleting the deep clone in `activeConfig`, each fails a
specific named assertion.

**Verified -- and the verification itself caught a real gap in the first
draft.** `test/config.spec.js` built with all 9 assertion groups (101
assertions), wired into `package.json`. Ran the gate literally: temporarily
removed `'legacy'` from `TUNING_KEYS` and temporarily deleted the deep-clone
line in `activeConfig`, one at a time, confirming each broke a named
assertion, then restored both (diffed byte-identical after restore).

The `activeConfig` break failed immediately, as expected. The `TUNING_KEYS`
break did NOT fail on the first attempt -- the round-trip test (assertion
group 3) had hand-picked ~8 fields to mutate and happened never to touch a
`legacy.*` value, so removing it from the list just made a loop iterate once
less, silently. Rewrote group 3 to touch a leaf under EVERY `TUNING_KEYS`
entry programmatically instead of by hand -- still didn't catch it, because
that mutation helper also iterated `TUNING_KEYS`, inheriting the same blind
spot from consulting the same broken list as its own source of truth.
Root-fixed by rewriting group 2 (key coverage) as a genuine two-way
set-equality check against `Object.keys(DEFAULT_CONFIG.profiles[league])`
directly -- an independent source of truth that still has `legacy` (only the
`TUNING_KEYS` array was broken, not the profile factory) -- which is what
actually catches a key silently dropped from the registration list. This is
exactly the failure mode Phase 4 exists to prevent, caught by trying to
build the very test meant to prevent it -- kept as a worked example in the
test file's own comments rather than filed away as a footnote.

---

### Phase 5 — Preset file robustness & provenance [DONE]

**Files:** `lib/defaults.js`, `main.js`, `renderer/renderer.js`

1. Add `const CONFIG_SCHEMA_VERSION = 1;` to `defaults.js` and export it.
2. Stamp both export paths:

```js
{ schemaVersion: CONFIG_SCHEMA_VERSION, app: 'Pipeline', appVersion: <package.json version>,
  exportedAt: new Date().toISOString(), league, profile }
```
3. On import, reject a `schemaVersion` newer than this build with a readable
   message ("saved by a newer version of Pipeline") instead of applying a
   partial/garbled config.
4. **Close finding #6:** have `config-import-profile` strip keys not in
   `TUNING_KEYS` before returning, and return the stripped names alongside.
   The renderer then diffs exactly what will apply, and can surface
   "3 unrecognized settings ignored" in the preview.

**Gate:** an exported file carries the header; `schemaVersion: 999` is
rejected with a clear message; a file with a bogus key shows it as *ignored*
rather than as a pending change.

**Implemented as specced, with the decision logic pulled out for testability
beyond what the roadmap asked for.** `CONFIG_SCHEMA_VERSION = 1` added and
exported from `lib/defaults.js`. Both export paths stamp
`{schemaVersion, app: 'Pipeline', appVersion: app.getVersion(), exportedAt}`
via a shared `presetHeader()` in `main.js`, spread onto the exported
object's TOP level (not nested) -- confirmed no collision with any
`SESSION_KEYS`/`TUNING_KEYS` name, and confirmed a stamped whole-app file
still classifies as `'canonical'` and round-trips through `mergeConfig`
with the header fields dropped automatically (nothing needed to strip them
manually -- `mergeInto` only ever reads keys it's told to look for).
`config-import-profile` now strips anything not in `TUNING_KEYS` from the
incoming `profile` before returning, reporting the dropped names as
`ignoredKeys`; the preview modal shows an amber "N unrecognized settings
ignored: ..." line above the diff whenever that list is non-empty.

**Deviation from the sketch:** rather than leaving the version check as an
inline throwing function in `main.js` (as sketched), split it into a pure
`isSchemaVersionCompatible(parsed)` in `lib/defaults.js` -- returns a
boolean, no throwing, no Electron dependency -- with `main.js` reduced to a
thin wrapper that throws the user-facing message. Same reasoning
`classifyConfigFile` was already split out for in Phase 1: Phase 4's whole
premise was "invariants get tests, not comments," so leaving new decision
logic covered only by a one-off verification script (which is all the
sketch as written would have produced, since `presetHeader()`'s
`app.getVersion()` call ties it to Electron) would have been inconsistent
with the phase that came right before it.

Added section 10 (schema compatibility, table-driven over the boundary --
newer/current/older/zero/missing/non-numeric/null/bare-number) and section
11 (unrecognized-key stripping, plus confirming a stripped profile survives
`foldIntoProfile` with no trace of the bogus key) to `test/config.spec.js`
-- 112 assertions total, up from 101. Proved load-bearing the same way
Phase 4's were: temporarily broke `isSchemaVersionCompatible`'s comparison
(`return true` unconditionally), confirmed it failed a specific named
assertion ("newer schema is incompatible: got true, expected false") rather
than passing silently, then restored and diffed byte-identical.

Also verified directly (mirroring `main.js`'s actual logic, same technique
used for every phase this session that touches `dialog`/`app`): a per-league
export carries all four header fields; a whole-app export carries the
header AND still has `profiles`/`league`/etc.; `schemaVersion: 999` throws
the intended message; no-schemaVersion and current-schemaVersion files are
both accepted; a dirty profile with two bogus keys strips exactly those two
and reports them, while every real `TUNING_KEYS` entry survives.

---

### Phase 6 — UI correctness polish [DONE]

**Files:** `renderer/renderer.js`, `renderer/index.html`, `main.js`, `preload.js`

1. **`countSectionDiffs`** — add to the Rating Translation count:
   `diceRoll.classStrength/debuff/spread`, `overallBoost.enabled/points`; add
   `realism.agilityCodSizePenalty` to Advanced. (These are currently invisible
   to the "N modified" badges.)
2. **`resetTranslation`** — add `cfg.overallBoost`. Consider also covering
   `legacy` / `bell` / `ratingAdjustments` / `kpAwarenessCap`, which no reset
   button has ever touched (pre-existing gap, harmless today since no UI edits
   them, but it means "Reset" doesn't mean reset).
3. **Modal dismissal** — Escape key handler, click-on-overlay-to-cancel
   (guard `e.target === overlay` so clicks inside the card don't close it),
   focus the Cancel button on open, restore prior focus on close.
4. **Freeze the target league at preview time** (finding #11):
   `pendingImportLeague = cfg.league` in `showImportPreview`, and use that on
   apply instead of re-reading `cfg.league`.
5. **Resolve `config-reset`** (finding #9) — currently dead and
   league-unaware. Recommend *repurposing* rather than deleting: per-league
   profiles make "Reset this league to defaults" genuinely useful. Rename to
   `config-reset-profile(league)`, reset only that profile, add a button next
   to the league preset buttons, and put a confirm step in front of it.

**Gate:** the modified badges react to the new dials; Esc and click-outside
cancel the import; Reset Translation restores boost defaults; a reset asks
before wiping.

**Implemented as specced, with one real bug caught in step 5 before it
shipped.** Steps 1/2/3/4 applied directly: `countSectionDiffs` now counts
`diceRoll.classStrength/debuff/spread`, `overallBoost.enabled/points`, and
`realism.agilityCodSizePenalty`; `resetTranslation` gained `overallBoost`
AND (going past the roadmap's "consider") `legacy`/`bell`/
`ratingAdjustments`/`kpAwarenessCap`, on the reasoning that "Reset" should
mean reset even for fields with no dedicated card, not "reset everything
that happens to have a control" -- checked `resetAdvanced` first and found
`realism` was already fully covered there, so no gap existed for that one.
The modal gained Escape, click-on-backdrop (guarded on
`e.target === e.currentTarget`, confirmed this can't fire from a click
inside `.modal-card` since bubbling preserves the original target),
focus-on-open landing on Cancel (not Apply, so a stray Enter can't commit an
import), and restores whatever had focus before the modal opened.
`pendingImportLeague` frozen at preview time, used everywhere the code
previously read `cfg.league` mid-flow (the mismatch banner, the summary
text, and critically the Apply handler's actual IPC call).

**Step 5's first draft would have reintroduced Phase 3's exact bug class.**
The natural implementation -- reuse `foldIntoProfile(canonical,
activeConfig(DEFAULT_CONFIG, league))`, the same helper every other config
IPC handler already uses -- silently resets SESSION_KEYS too, because
`foldIntoProfile` merges session keys from whatever flat config it's given,
and `activeConfig(DEFAULT_CONFIG, league)` carries `DEFAULT_CONFIG`'s
session values along with the league's tuning. A "reset UFL's settings"
button built that way would have also reset the ENGINE CHOICE, SEED, CLASS
SIZE, and DRAFT BOARD settings -- shared state a per-league reset has no
business touching. Caught by tracing what the helper actually does rather
than assuming reuse was safe because it's the "normal" pattern; fixed by
replacing `profiles[lg]` directly, bypassing `foldIntoProfile` entirely for
this one handler. Verified with a real repro, not just re-reading the code:
seeded a fake config with BOTH profiles edited and every session key
(`translation.strategy`, `general.seed`, `general.classSize`,
`draftBoard.chaos`) changed from default, reset only UFL, confirmed UFL's
two edited fields returned to their defaults while NFL's edit AND all four
session fields survived untouched, on a fresh disk read (not just the
in-memory result).

Also renamed the channel (`config-reset` -> `config-reset-profile(league)`,
`configReset` -> `configResetProfile` in `preload.js`) and removed
`ConfigStore.reset()` entirely -- confirmed zero remaining callers (grepped
`main.js`, every test file) before deleting rather than leaving a
now-orphaned whole-file-wipe method whose only reference was a comment
explaining why it isn't used anymore. New "Reset League to Defaults" button
added next to the export/import pair, label reactive to the active league,
gated behind `window.confirm()` (matching the one other irreversible-action
confirm already in this codebase, in the franchise-file overwrite path,
rather than introducing a second confirmation idiom).

**Same honest gap as every prior UI phase**: Esc/click-outside/focus
management need a real window to watch happen. Verified everything
checkable without one -- IDs cross-referenced between `index.html` and
`renderer.js`, no stale references to the old `config-reset` name anywhere,
full test suite green, app launches without error -- plus the one piece
that doesn't need a browser at all (`config-reset-profile`'s actual data
behavior), which got the rigorous treatment specifically because tracing it
by hand is what caught the bug in the first place.

---

### Phase 7 — *(Strategic)* Close the estimate-vs-reality gap

**This is the root cause of the entire Phase 5 retune and it is still open.**
`EstMaddenOverall` does not match what Madden computes on import: Dice Roll's
display is pure arithmetic that never inspects the written sub-ratings, and
Power Curve's anchored display understated the boost's real effect by ~9
points. Any future tuning done against the in-app number will be wrong the
same way this session's was.

**Gated on:** a real in-game readback (import one of the
`tools/phase5UflBuildRealClass.js` files, record actual overalls). Do not pick
an option before there is readback data to check it against.

- **Option A (recommended).** Make `EstMaddenOverall` the regression score
  over the actually-written ratings for both engines — i.e. what
  `data/overall_formula.json` already computes, unanchored. Pro: the number
  finally means what users think it means. Con: NFL classes will display
  lower and wider than today, which will *feel* like a regression even though
  it is strictly more accurate; needs a changelog note.
- **Option B.** Keep the anchored number, add a second column ("Madden Est.
  (raw)"). Pro: no perceived regression. Con: two numbers, needs explaining.
- **Option C.** Do nothing; add a tooltip warning that the estimate is
  indicative only. Cheapest, leaves the trap armed.

**Gate:** displayed median lands within a few points of a real readback on at
least one imported class.

---

## 4. Future-risk register

Risks not covered by the phases above, with the trigger that should prompt
action.

| Risk | Why it bites | Trigger | Mitigation |
|---|---|---|---|
| **`EstMaddenOverall` divergence** | Every future tuning decision made against it will be wrong, exactly as this session's was | Any new tuning work, or first user report of "ratings look nothing like in-game" | Phase 7 |
| **`TUNING_KEYS` drift** | Add a config section, forget to register it → it silently never saves; no error anywhere | Any new config section | Phase 4 invariant test |
| **Legacy migration becomes dead weight** | Untested branch nobody dares delete | After 0.3.x, when no user is plausibly on a pre-profiles config | Keep through 0.3.x with the Phase 4 fixture test guarding it, then delete deliberately |
| **Dice Roll "Very Weak" tail** | Measured 87 players <50 on a Very Weak roll vs 7 on Very Strong, even at the new `spread: 0.3`. `spread` only scales the *per-player* term, never the class-wide debuff | First complaint about an unusable rolled class | Either soften `CLASS_STRENGTH_DEBUFF`'s range in `diceRoll.js`, or expose the tier so users can pin it |
| **Three entangled workstreams, uncommitted** | UFL + Dice Roll + Coach Carousel (~2,800 LOC, verified in-game) all live in one uncommitted tree; a single bad `git checkout` loses the carousel | Now — this is the standing risk from the earlier repo audit | Split into three commits before further feature work |
| **`research/out/` is 57 MB and not gitignored** | A reflexive `git add -A` commits extracted game assets into history permanently | Same as above | Add to `.gitignore` before the next commit |
| **Preset sharing without provenance** | Users trade files with no version/date; a stale preset silently applies wrong values | First shared preset in the wild | Phase 5 |
| **Renderer `cfg` is a wholesale-swapped global** | Any future code capturing `cfg` *by value* in a closure would write to a stale object after a league switch | Any new async/deferred renderer code that touches config | Document the pattern; always read the module binding, never capture |
| **No confirmation on Reset buttons** | One misclick discards a tuned league profile | Any user losing work | Phase 6 step 5 |

---

## 5. Non-goals

- Not rebuilding either translation engine's math.
- Not re-tuning shipped defaults again until there is real readback data
  (Phase 7's gate) — the lesson of Phase 5 is that tuning against the wrong
  metric is worse than not tuning.
- Not adding UI for `legacy` / `bell` / `ratingAdjustments` / `kpAwarenessCap`
  (V1-engine-only, no live engine reads them).
- Not changing the per-league architecture — the audit found it sound
  (round-trip fidelity, isolation, and corrupt-file recovery all verified).

---

## 6. Suggested sequencing

**Do first (correctness, small, independent):** Phase 1 → Phase 3 → Phase 4.
Phase 1 stops data loss, Phase 3 removes the ambiguity that made it possible,
Phase 4 makes both permanent. None of the three touches UI.

**Then (user-visible):** Phase 2, the largest single piece and the one that
turns two shipped-but-invisible features into real ones.

**Then:** Phases 5 and 6 (polish, safely deferrable).

**Then, gated on readback:** Phase 7.

Recommend committing between phases — the standing "one uncommitted tree"
risk above compounds every phase this work continues without it.
