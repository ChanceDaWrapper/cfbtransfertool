# Power Curve — Multi-Level Control Roadmap

Goal: one deterministic **Power Curve** engine, controllable at **four independent
levels** (Global → Category → Position → Rating), with **no dead knobs**, **no
bell curve**, and a **user-friendly** layout. The engine dropdown stays (for future
engines) but offers only Power Curve.

Guiding principles:
- **Deterministic & class-independent** — a player converts the same regardless of
  who else is in the class. (This is why the bell curve is being removed: it cut
  ratings by class-percentile, breaking this property.)
- **Every visible knob does something.** No control appears unless it affects output.
- **Progressive disclosure** — the common dials are obvious; the deep per-rating
  controls are available but tucked away, so the app stays friendly.

---

## Where we are today

- ✅ Power Curve engine is live and default; validated against the spec's worked
  examples (`npm test`, 35 assertions).
- ✅ Config has `powerCurve` (anchors, clamp, jitter, categoryOverrides) and
  `positionStrength` (per-position tech/mental/physical).
- ✅ Rating Translation page exists (raw category anchors + strength dials).
- ✅ BC Vision reclassified to heavy-technical.
- ⚠️ Engine dropdown still offers `v1` and `rosetta` (rosetta silently aliases v1).
- ⚠️ Bell-Curve Squeeze + K/P Awareness Cap + the whole Physical Attributes page +
  the Position "Extra Drop" column are **dead** under Power Curve (they only feed the
  old V1 adjuster).
- ⚠️ Category curves are edited as raw `99 → 87` boxes (confusing); should be
  percentage-based.
- ⚠️ Per-rating category reassignment exists in config but is **not** in the UI.

---

## Target: four levels of control

| Level | Control | Answers | Where it lives |
|---|---|---|---|
| **1 · Global** | Overall Class Strength (one dial) | "make the whole class stronger/weaker" | Rating Translation (top) |
| **2 · Category** | 5 curves, percentage-based + live preview | "how does a whole *type* of rating translate" | Rating Translation |
| **3 · Position** | Strength dials (tech/mental/physical) + flat drop | "toughen/soften one position" | Rating Translation |
| **4 · Rating** | Reclassify any rating's category + per-rating tweak | "this *specific* rating lands wrong" | Rating Translation (advanced) |

Untouched and already engine-independent: Draft Projection, Dev Traits, Class Size,
Seed, Overall Anchor (Est. OVR display only).

---

## Phases

Each phase is independently shippable and testable. Order is by dependency and risk.

### Phase 0 — Consolidate to one engine  *(foundation, low risk)*  ✅ DONE
**Deliverable:** clean slate — Power Curve is the only offered engine; bell curve gone.
- ✅ Engine dropdown offers only **Power Curve** (dropdown kept for future; a stale
  saved `v1`/`rosetta` strategy self-heals back to `powercurve` on page load).
- ✅ Removed the **Bell-Curve Squeeze** section from the Advanced page (HTML card,
  JS builder block, reset handler, config-summary diff count, and its one
  extreme-value warning all removed).
- ✅ Removed the **K/P Awareness Cap** knob from the Advanced page (same treatment) —
  per decision, Power Curve's mental compression hits K/P hard on its own via the
  regressor; no replacement cap needed.
- ✅ Removed the engine-note "dimming" logic (no longer needed — one engine, always
  fully opaque).
- ✅ `cfg.bell` / `cfg.kpAwarenessCap` left intact in `lib/defaults.js` and
  `calibratePlayersV1` — dormant, not deleted, so V1 still works if ever manually
  re-selected via a hand-edited config.
- ✅ **Validated:** app loads, `npm test` → 35/35 green, no dangling `bell`/`advBell`/
  `kpAwarenessCap`/`engineNote` references in renderer.js or index.html.

### Phase 1 — Level 1: Overall Class Strength  *(global dial)*  ✅ DONE
**Deliverable:** one slider that scales all compression at once.
- ✅ Added `powerCurve.globalStrength` (default 1.0). In `makePowerCurveAdjuster`,
  effective tech/mental strength = position strength × globalStrength (1.0 = today's
  per-position values, unchanged; lower = whole class stronger, higher = weaker).
  Physical/arm-leg strength is deliberately **not** scaled by it — athleticism stays
  the one lever this dial never reaches, per the earlier "compress technical/mental
  only" decision.
- ✅ Surfaced as **"Overall Class Strength"** in its own card, directly under Engine
  and above Category Curves on Rating Translation.
- ✅ **Validated:** at 1.0, all 73 regression assertions stay green (no-op confirmed);
  manual sweep at 0.5/1.0/1.5/2.0 shows Speed locked at 89 throughout while Catching/
  Short Route/Awareness scale smoothly (81→77→74→70, 79→73→67→61, 73→61→49→36).

Also folded into this pass (your explicit instruction, ahead of Phase 4): shipped
`positionStrength` defaults updated to your live-tuned values from the screenshot
(HB tech 0.5/mental 0.7, WR tech 1.0/mental 1.0, TE 0.9/0.75, OL 0.7/1.0, EDGE/DT
0.8–0.95/1.0, LB 0.8/1.0, CB/S 0.85–0.95/1.0, LS 1.2/1.0). `npm test` now locks these
as a separate "shipped defaults" section, decoupled from the spec-fidelity assertions
(which now pin the *original* spec's WR/QB strengths explicitly, so retuning defaults
can never silently break the proof that the engine itself still matches the model
spec's Sec 9 worked examples). 73 assertions total.

### Phase 2 — Level 2: Percentage-based category curves  *(clarity)*  ✅ DONE
**Deliverable:** the confusing `99 → 87` boxes become intuitive "keep %" with a live
preview.
- ✅ UI now shows, per category: "Elite (college 99) keeps **[88]%** → lands at 87" and
  "Good (college 80) keeps **[85]%** → lands at 68", each with its own default-%
  reference and modified-dot. The college reference value (x1/x2) is now a fixed,
  read-only label — no longer user-editable.
- ✅ Live preview per category row: "A 90 college rating becomes ~XX", recomputed on
  every keystroke via a small local reimplementation of `deriveCurve`/`curveBase`
  (renderer has no `require()` access to the real module under contextIsolation;
  verified byte-identical to the real engine across all 5 categories at x=90).
- ✅ Config schema unchanged (`x1,y1,x2,y2` under the hood) — percentage is purely a
  UI presentation layer, converting `%` ↔ landing value on read/write.
- ✅ **Side effect: closes the audit's #1 real bug.** Since x1/x2 are no longer
  user-editable, a user can no longer set Elite's and Good's college value to the same
  number and crash `deriveCurve()` (division by `log(1) = 0`). The crash is still
  theoretically reachable via a hand-edited config file, but no longer through the UI.
- ✅ **Validated:** `npm test` stays at 73/73 (this phase touched only renderer.js/
  index.html/style.css and one tooltip string — no math or config-schema change);
  manual cross-check of all 5 categories' preview formula vs. the real engine's
  `deriveCurve`+`curveBase` matched exactly.

### Phase 3 — Level 3: Position controls  *(wire the flat drop)*  ✅ DONE
**Deliverable:** per-position flat drop works again, alongside the strength dials.
- ✅ Wired `positionExtraDrop` as a flat post-curve subtraction in `makePowerCurveAdjuster`
  — applied across all four categorized buckets (physical/armleg/techmod/techhvy/
  mental) alike, then re-clamped/rounded. Deliberately does **not** touch copy-raw
  ratings (no category assigned, e.g. `LongSnapRating`) — matches the model spec's
  Sec 5 exemption.
- ✅ Relocated the control off the Position Weights page (which now only has Class Cap
  + Draft Value — pure roster-construction, no longer conflated with rating toughness)
  onto Rating Translation's **Per-Position Strength** table as a 4th "Extra Drop
  (flat)" column, sitting directly beside the three proportional Strength dials — the
  page's intro copy now explicitly calls out the proportional-vs-flat distinction and
  that they stack.
- ✅ Config-summary diff count, reset handlers, and the extreme-value warning message
  all moved/reworded to match the control's new home.
- ✅ **Validated:** `npm test` → **79/79** (73 prior + 6 new). New coverage proves,
  end-to-end through the real `calibratePlayers` path: a flat drop of 3 shifts a WR's
  Speed/Catching/Short-Route/Awareness (physical, techmod, techhvy, mental) by
  *exactly* 3 each; the same change leaves QB's Awareness and Throw Power completely
  untouched; and a manual check confirmed a Kicker's copy-raw Kick Return stays fixed
  under a flat drop of 5 while categorized Kick Power shifts by exactly 5.

### Phase 4 — Level 4: Per-rating control  *(the key capability — detailed plan)*
**Deliverable:** fix "specific ratings translate wrong" — by better shipped defaults,
by letting the user reclassify any rating's category in the UI, and by per-rating flat/
cap tweaks. This is the level that answers "BC Vision is too high," "Catching should
stay stronger," etc. without touching the whole category.

#### What exists today (studied)
- `categoryFor(position, rating, overrides)` ([powerCurveCategories.js:108](lib/rosetta/translation/powerCurveCategories.js))
  reads **per-position only**: `overrides = { [position]: { [rating]: category } }`.
  There is no global "reclassify everywhere" path, and it **cannot express copy-raw**
  (an override value must be one of the 5 real categories; you can promote a copy-raw
  rating into a category but can't demote a categorized rating to copy-raw).
- `powerCurve.categoryOverrides` exists in config (default `{}`) but has **no UI**.
- The engine ([pipeline.js `makePowerCurveAdjuster`](lib/pipeline.js)) has clean hooks:
  category resolve → curve → `positionExtraDrop` → jitter → clamp. Copy-raw ratings
  return early (untouched) — the flat drop already correctly skips them.
- A per-rating numeric system already exists but is **V1-only/dead and physical-only**:
  `ratingAdjustments` = `{ [rating]: { extraDrop, jitter, maxDrop } }` for the 12
  physical ratings, **and ships a non-zero `AgilityRating` default (extraDrop 3, maxDrop
  7)**. ⚠️ Wiring `ratingAdjustments` straight into Power Curve would silently activate
  that Agility cut — so Phase 4 introduces a *fresh* structure instead (see 4b).
- The renderer already has the building blocks: `selectInput()` (dropdowns),
  per-position table patterns, and `META.allRatingColumns` (labels for all ~57 rating
  columns, copy-raw ones included) to drive a full rating list.

#### Proposed config schema (additive — no breaking changes)
```
powerCurve: {
  ...existing (anchors, globalStrength, clampFloor/Ceiling, jitter, categoryOverrides)...,
  ratingCategory: {},   // GLOBAL reclassification { [Rating]: 'physical'|'armleg'|
                        //   'techmod'|'techhvy'|'mental'|'copy-raw' }. Empty = built-in
                        //   defaults. This is the "fix it everywhere" surface (4a).
  ratingTweaks:  {},    // GLOBAL per-rating numeric { [Rating]: { extraDrop, maxDrop } }.
                        //   Fresh + all-zero (does NOT reuse ratingAdjustments). (4b)
}
// categoryOverrides (existing, per-position) stays as the advanced exception layer (4c).
```
New `categoryFor` precedence: **per-position override → global `ratingCategory` →
structural `CATEGORY_OF` → copy-raw**. `'copy-raw'` becomes a valid, first-class value
at every layer (resolves to null = untouched), closing the demote-to-copy-raw gap.

#### Sub-phases (each independently shippable + testable)

**Phase 4a — Global category reclassification** *(the 90% case)*  ✅ DONE
- ✅ Added `powerCurve.ratingCategory`; extended `categoryFor` to the 4-layer precedence
  (per-position → global `ratingCategory` → structural `CATEGORY_OF` → copy-raw) with
  `COPY_RAW` a first-class sentinel at every layer (closes the demote-to-copy-raw gap);
  threaded through `makePowerCurveAdjuster`. `CATEGORY_OF` now flows to the renderer via
  `META.ratingCategoryDefaults` so UI and converter can't disagree.
- ✅ UI: **repurposed the dead Physical Attributes page into "Rating Categories"** — a
  per-rating Bucket dropdown (Physical / Arm-Leg / Technical-Light / Technical-Heavy /
  Mental / Copy-Raw), grouped by default bucket, each row showing its built-in default +
  a modified-dot, with a legend spelling out that a bucket also decides which Strength
  dial governs the rating. Only non-default choices are stored.
- ✅ **Dead-knob cleanup came free with the repurpose** (pulled forward from Phase 5):
  Drop Leniency, Default Drop, Physical Jitter, Skill Jitter, and the physical-only
  per-rating Extra/Jitter/Max table are all gone from the UI; the two dead jitter
  warnings and the dead config-summary "Physical Attributes" counter were replaced with
  live ones (global-strength / rating-scatter warnings; a Rating-Categories modified
  count). `cfg.ratingAdjustments` / `cfg.general.dropLeniency` etc. remain in config,
  dormant, for V1.
- ✅ Shipped-default fixes: only BC Vision baked in (per decision — user tunes the rest
  live in the new dropdown, then flags which to bake as defaults).
- ✅ **Validated:** `npm test` → **82/82** (79 prior + 3 new). New coverage proves, via
  the real pipeline: reclassifying WR Catching techmod→techhvy lowers it; →copy-raw pins
  it at the exact college value (83); Awareness mental→physical jumps it up >10; and a
  manual check confirmed a global reclassification of Short Route (76→80 lighter) and
  Speed→copy-raw (pinned at 92). Spec-fidelity suite pins an empty `ratingCategory` so
  future default reclassifications can't break the engine-correctness proof.
- ⏭️ Deferred to 4b/4c: per-rating Extra/Max Drop numeric tweaks; per-position category
  exceptions.

### Interlude — EstMaddenOverall made fully cosmetic  ✅ DONE
Prompted by the audit flagging this as the highest-leverage loose end: `EstMaddenOverall`
was still driving `devTraitWeight()` (dev-trait odds), meaning tuning any rating-
conversion knob could silently reshape who gets Star/Superstar/X-Factor.
- ✅ `devTraitWeight()` now reads `overallAnchorFor(CFB_Overall)` — a pure, deterministic
  function of the player's real college overall, with **zero dependency on converted
  sub-ratings**. Every other input (round, production/athletic percentile, age, awards,
  CFB dev tier) was already conversion-independent.
- ✅ `EstMaddenOverall` itself is unchanged (still the regression + `overallAnchor` blend)
  and still written into the Madden save as a pre-recompute placeholder — both already
  genuinely cosmetic (Madden overwrites it on its own recompute; nothing reads it back).
  The write path was audited and left alone; only the dev-trait read was cut.
- ✅ UI: the Draft Class table's "Est. Madden OVR" column header now has a tooltip
  spelling out that it's preview-only with no effect on dev traits, draft order, or any
  other converted rating.
- ✅ **Validated:** `npm test` → **104/104** (82 prior + 22 new). New coverage runs
  `generateClass` twice with the same seed but wildly different rating-conversion
  settings (globalStrength 0.3, 4 ratings reclassified, WR strength maxed out, ±15 flat
  drops) on **fresh** row objects (a first attempt reusing row objects across both calls
  produced false failures, since `projectDraftClass` stamps mutable `_rank`/`_prodScore`/
  `_athScore` fields onto each row in place) — DevTrait matches for all 20 players, Age
  matches, and a sanity check confirms the two configs really do produce different
  converted ratings (Awareness 57 vs 65), so the invariance isn't vacuous.

**Phase 4b — Per-rating flat / cap tweaks**  ✅ DONE
- ✅ Added `powerCurve.ratingTweaks` — fresh, empty (`{}`), non-default entries only
  (mirrors `ratingCategory`'s delete-on-default pattern, kept lean via `pruneTweak`).
  Deliberately NOT the old physical-only `ratingAdjustments` (already retired in 4a,
  along with its live `AgilityRating` silent-activation hazard).
- ✅ Wired post-curve in `makePowerCurveAdjuster`, in order: category curve (with
  position strength) → position Extra Drop → rating Extra Drop → jitter → rating
  Max Drop (enforced LAST, after jitter, as a true final guarantee) → clamp/round.
  Copy-raw ratings skip both fields entirely (same exemption as position Extra Drop).
- ✅ Dropped the per-rating jitter field per plan — global `powerCurve.jitter` already
  covers it.
- ✅ UI: **Extra Drop** + **Max Drop** columns added to the Rating Categories table
  (same page as 4a's Bucket dropdown). Both inputs auto-disable, with an explanatory
  tooltip, whenever a rating currently resolves to copy-raw — rather than letting a
  user set values the engine will silently ignore. Switching a rating's bucket
  live-rebuilds the page so that disabled state stays in sync.
- ✅ **Validated:** `npm test` → **107/107** (104 prior + 3 new). New coverage proves,
  through the real pipeline: `extraDrop=4` shifts Catching by exactly 4; `maxDrop=1`
  correctly overrides a larger `extraDrop=5` and caps the rating at exactly
  college-value-minus-1 (82, not the 73 extraDrop alone would give); and a rating
  reclassified to copy-raw ignores both fields entirely, staying pinned at its raw
  college value even with `extraDrop=10, maxDrop=0` set.

**Phase 4c — Per-position category exceptions** *(power users)*  ✅ DONE
- ✅ Added an "Editing: **All positions ▾** / QB / WR / …" selector at the top of the
  Rating Categories page. "All" edits the global `ratingCategory` exactly as in 4a; a
  specific position edits `categoryOverrides[pos]` instead (category only — Extra Drop
  / Max Drop always stay global, per plan, since `categoryOverrides` has no numeric-
  tweak slot).
- ✅ Every row now resolves against the CURRENT VIEW: `parentCat` (what the rating would
  be without a position-specific exception) vs. `curCat` (the effective bucket for the
  view). The table **regroups by curCat**, so switching to a position with an exception
  visibly moves that rating into its new bucket group rather than showing it stuck under
  its old one. The default-ref/modified-dot logic unified to one rule
  (`curCat !== parentCat`) that's correct in both view modes without special-casing.
  Extra Drop/Max Drop's copy-raw disabled-state now follows the CURRENT VIEW's effective
  bucket too.
- ✅ Selecting a position is a pure UI view mode (`ratingCatViewPosition`, module-level,
  not persisted) — never written to config, so it can't pollute a saved preset.
- ✅ Reset now clears `categoryOverrides` alongside `ratingCategory`/`ratingTweaks` and
  snaps the view back to "All positions"; config-summary diff count includes every
  per-position exception.
- ✅ **Validated:** `npm test` → **110/110** (107 prior + 3 new). New coverage proves,
  through the real pipeline: a global copy-raw reclassification of Catching pins WR's
  Catching at the exact college value (83); a WR-only exception overriding that global
  choice back to `techhvy` produces a real (non-83) converted value; and the same
  WR-only exception leaves QB's Throw Power completely byte-identical to the no-
  exception baseline. Manual check additionally confirmed `categoryOverrides` survives
  a save/reload round-trip intact, and that a WR-only BC Vision→physical override
  produces WR≈87 (near-identity) while HB stays at its unaffected default 81.

### Phase 4 complete
All four levels of control are now live: **Global** (Phase 1) → **Category** (Phase 2)
→ **Position** strength + flat drop (Phase 3) → **Rating** bucket/tweaks/exceptions
(4a/4b/4c), plus the EstMaddenOverall-is-cosmetic interlude. `npm test` sits at
**110/110** across engine fidelity, shipped defaults, dev-trait invariance, and every
phase's own behavioral proof. Remaining work is Phase 5 (much smaller than originally
scoped — see its section above for what 4a already pulled forward) and Phase 6.

#### UI home
Repurpose the now-dead **Physical Attributes** page into a **"Per-Rating"** page
covering *all* ratings (not just the 12 physical), which simultaneously removes the
Drop-Leniency / Default-Drop / Physical-&-Skill-Jitter dead knobs living there — so
Phase 4 also clears the single biggest chunk of the audit's dead-knob surface.

#### Risks / watch-items
- **Config size:** per-position × per-rating overrides can bloat the saved JSON; only
  write non-default entries. `mergeConfig` is a 2-level shallow merge — verify the
  nested `categoryOverrides` and the new maps round-trip through save/export/import.
- **Reclassification is a two-for-one:** changing a rating's category changes *both* its
  curve *and* which Strength dial governs it — the UI must make that legible.
- **Copy-raw + tweaks:** decide (recommend: tweaks skip copy-raw, consistent with the
  flat drop) and document it.
- **Test isolation:** the spec-fidelity suite must pin an empty `ratingCategory` /
  `ratingTweaks` (same pattern already used for `positionStrength` / `positionExtraDrop`)
  so future default reclassifications can't break the engine-correctness proof.

### Interlude — Arm/Leg and Copy Raw categories removed entirely  ✅ DONE
Per explicit user instruction (both were empty-by-default after the prior bucket
re-placement): deleted both as OPTIONS, not just as defaults.
- ✅ `powerCurveCategories.js`: removed `armleg` from `CATEGORY_STRENGTH_KIND`; removed the
  `COPY_RAW` sentinel and its resolve-to-null branch entirely. `categoryFor` now ALWAYS
  returns a real, convertible category (`physical`/`techmod`/`techhvy`/`mental`) — no
  "leave untouched" outcome exists anywhere in the engine anymore.
- ✅ Gave `PersonalityRating` (the one rating with no prior category — a flavor rating,
  not gameplay-affecting) an explicit `techmod` default, so every convertible rating now
  has a real bucket.
- ✅ `defaults.js`: removed the `armleg` anchor curve and its `POWER_CURVE_CATEGORY_META`
  entry — 4 categories now, not 5.
- ✅ `pipeline.js`: removed the dead `if (!cat) return ...` copy-raw early-return in
  `makePowerCurveAdjuster` (cat is now always truthy).
- ✅ Renderer: `categoryBucketOptions()` trimmed to the 4 real buckets; removed the
  Copy-Raw force-show/empty-group special case (no longer needed — collapses like any
  other empty group, resolving the Phase-5 "empty-bucket asymmetry" watch-item);
  Extra Drop/Max Drop are now always enabled (no copy-raw state can disable them).
  Updated all tooltips/legends/descriptions mentioning Arm/Leg or Copy Raw.
- ✅ **Validated:** `npm test` → **115/115**. The original spec's ThrowPower worked
  example (91→89 via its now-removed ARMLEG curve) is preserved as a standalone pure-
  algebra check (`deriveCurve`/`transform` fed the spec's literal anchor points directly,
  bypassing the categorization system) rather than through the full pipeline — honestly
  documenting that the ROUTING changed by design even though the ALGEBRA didn't. The
  two copy-raw-specific tests (reclassify-to-copy-raw, copy-raw tweak exemption) were
  removed as no longer applicable; the per-position-exception test (1e) was redesigned
  to use a `mental` global baseline instead of `copy-raw`, preserving the same
  global-vs-position-override proof. Manual check confirmed all 5 previously-moved
  ratings (Throw/Kick Power, Hit Power, Long Snap, Kick Return) convert identically to
  before this cleanup — this was a structural removal, not a math change.

### Phase 5 — UI polish  *(much smaller than originally scoped — 4a already did the dead-knob cleanup)*  ✅ DONE
**Deliverable:** honest indicators, coherent labels.
- ✅ **Fixed the modified-dot in "All positions" view.** Was: `curCat !== parentCat`,
  always false in All view since `curCatOf` just returns `parentCatOf` there (a global
  reclassification showed no amber dot despite the dropdown/tooltip being correct).
  Fix: compare against the structural default (`catDefaults[rating] || 'techmod'`) in
  All view; keep `curCat !== parentCat` in position view. Verified all 4 cases
  (All-modified, All-default, position-override, position-inherited) render correctly.
- ~~Wire K/P Awareness Cap~~ — retired (Phase 0). ~~Wire Physical/Skill Jitter split~~ —
  obsolete, those knobs were removed in 4a.
- ~~Decide the empty-bucket rendering convention~~ — resolved by removing Arm/Leg and
  Copy Raw entirely (interlude above).
- **Decided: leave V1 dormant**, not deleted. Kept as a working fallback/reference,
  reachable only by hand-editing a config file; no UI exposes it.
- ✅ Confirmed no V1-only knobs (`dropLeniency`, `calibrationJitter`, `quantileJitter`,
  `ratingAdjustments`, `bell`, `kpAwarenessCap`) referenced anywhere in `renderer.js` or
  `index.html`.
- ✅ **Validated — every visible control changes output**, proven with a 14-knob smoke
  test comparing `generateClass` output against a baseline for each: globalStrength,
  category anchor %, positionStrength, positionExtraDrop, ratingCategory,
  categoryOverrides, ratingTweaks (extraDrop + maxDrop), jitter, clampCeiling,
  positionValue, positionCaps, devTraits, classSize. 13/14 changed output immediately;
  positionCaps needed a closer look (below) — turned out to be a real, separate,
  pre-existing bug, not a dead knob.

#### 🐞 New finding (out of scope for this phase — flagged, not fixed): `positionCaps` silently drops any position not in its sparse default
`mergeConfig`'s per-section merge only iterates `Object.keys(out[section])` — the
**default's own keys** — when copying scalar values from a saved config. Every other
per-position section (`positionStrength`, `positionExtraDrop`, `positionValue`) ships
pre-populated for all 22 positions, so this never bites. `positionCaps` is the one
section that ships **sparse** (`{ K: 3, P: 5, LS: 3 }` only) — so setting a Class Cap
for any position other than K/P/LS in the UI is silently dropped the moment
`mergeConfig` runs (i.e., at every generation, and on save/reload). Confirmed directly:
`mergeConfig({ positionCaps: { CB: 5 } }).positionCaps.CB` → `undefined`. Nested maps
(`ratingCategory`, `categoryOverrides`, `ratingTweaks`, `positionStrength[pos]`) are
unaffected — those merge via a full object spread (`{...default, ...saved}`) one level
down, which correctly picks up new keys; `positionCaps` merges as a flat top-level
section instead, which doesn't. Likely fix: iterate the union of `out[section]` and
`sv` keys instead of just `out[section]`'s, for flat sparse-map sections.

### Phase 6 — Validation, tests & docs  ✅ DONE
**Deliverable:** locked-in and documented.
- ✅ Extended `npm test` with an explicit `globalStrength=1.0` no-op check (explicit
  1.0 produces byte-identical output to omitting it entirely) — the category-override
  and flat-drop criteria were already covered by 1b/1c/1e's existing assertions.
  **117/117 total.**
- ✅ Updated `CHANGELOG.md`'s Unreleased section to reflect the full journey (Phases
  0–5 and every interlude), not just the original Power-Curve rollout — including the
  EstMaddenOverall-cosmetic fix and the Arm/Leg/Copy-Raw removal.
- ✅ Refreshed `README.md`: item 3 (rating calibration) now describes the Power Curve
  model instead of the retired quantile-mapping approach; item 4 (Est. Overall)
  clarifies it's display-only; the settings-page list and "Data & calibration" section
  now correctly separate Power-Curve-owned settings (no data files needed) from the
  one file that still matters (`overall_formula.json`, display-only) and the two that
  are v1-only dormant fallbacks.
- ✅ Fixed a stale test comment claiming ratings like `LongSnapRating` have "no category
  assigned" — no longer true post-4a/4c interlude; every rating is now categorized.
- ✅ Generated a full synthetic class (QB/WR/HB/CB/Edge/K, 3–4 overalls per position)
  through the real `generateClass` path with shipped defaults, no overrides. Results:
  **WR (93→79) and CB (91→74) land almost exactly on the original calibration targets**
  (upper-70s, mid-70s); QB (91→75) close. **HB (90→68) and Edge (89→70) came in lower
  than their ~74/~76 targets** — but the synthetic test data uses crude, uniform
  per-rating offsets that don't reflect a real HB's or edge-rusher's actual sub-rating
  shape (e.g. a real HB's BC Vision/Trucking relative to Overall looks nothing like a
  flat `ovr-5`), so this reads as a synthetic-data artifact rather than a confirmed
  model gap — worth re-checking against a real CFB save rather than retuning blind.
  K (78→56) is the expected, already-decided outcome of retiring the Awareness cap.

### Roadmap status: all six phases complete
Global → Category → Position → Rating (bucket/tweaks/exceptions) are all live and
independently tunable, EstMaddenOverall is fully cosmetic, Arm/Leg and Copy Raw are
gone, and `npm test` sits at **117/117**. Open items: the `positionCaps` merge bug
(flagged, not fixed — see the Phase 5 finding above) and the HB/Edge synthetic-data
question just above, both good candidates for a follow-up session with a real save.

---

## Decisions (answered)

1. **RB (HB) overalls were way too low; WR is "close-ish" after live-tuning the
   Per-Position Strength dials** (screenshot: HB tech 0.5 / mental 0.7 — far less
   compression than the 0.88/0.95 default; WR tech 1 / mental 1 — more compression
   than the 0.68/0.80 default). Direction for Phase 4 default-category work: HB needs
   meaningfully *lower* tech/mental strength than currently shipped; WR should stay
   near where it's tuned now, not drift back toward the old low defaults. These are the
   user's own saved `positionStrength` values today — Phase 0 does not touch them.
2. **K/P Awareness Cap: retire, don't port.** ✅ Done in Phase 0 (see above) — user is
   fine with K/P getting hit hard by the regressor's own Awareness weighting, no
   separate cap needed.
3. **Old V1 code: stays dormant** — not deleted. ✅ Confirmed in Phase 0 (bell/
   kpAwarenessCap config + calibratePlayersV1 all left intact and unreferenced by the
   UI).

---

## Suggested sequencing

Phase 0 first (clean slate), then 1 → 2 → 3 are quick wins that make the app coherent.
Phase 4 is the biggest and most valuable (your "full control" ask) — do it once 0–3
have simplified the surface. Phase 5–6 finish and lock it.
