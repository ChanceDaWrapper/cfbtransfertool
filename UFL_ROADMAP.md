# UFL Draft Generator -- Roadmap

**Status: BUILD COMPLETE. Phases 1-4 and 6 implemented and verified against a
real save (DYNASTY-DRAFTSTAGE); all open questions resolved (Section 6a).**

The one remaining item is Phase 5's in-game readback -- importing a generated
UFL class into Madden/the UFL mod and reading back the REAL recomputed
Overalls to confirm this app's own estimates. The export half is built and
run (three ready-to-import files, see Phase 5), but the readback itself needs
a human at the game and cannot be automated here. Nothing else is
outstanding: if the readback confirms the bands, UFL ships as-is.

Findings below are from read-only measurement; the design decisions are
settled (see Section 3).

Goal: generate a SECOND draft class -- the tier of players the NFL draft
didn't take -- for import into a UFL roster mod. The UFL mod uses the
**identical** Madden file structure (same `CAREERDRAFT-` 402-slot format), so
every export/appearance/college/board mechanism is reused verbatim. The only
genuinely new work is (a) selecting the second tier and (b) keeping those
lower-stock players in a viable Madden band instead of letting the standard
compression sink them into the 50s.

---

## 1. Verified findings (measured, not assumed)

### 1a. The two tiers, as they stand today (Power Curve default)

| Tier | CFB overall (min / med / max) | Madden est (min / med / max) |
|---|---|---|
| NFL (top 402) | 78 / **85** / 93 | 54 / **64** / 75 |
| UFL (403-804) | 75 / **80** / 86 | 49 / **58** / 65 |

Two things this establishes:

1. **The UFL tier is barely lower in raw college overall** -- median 80 vs 85,
   a 5-point gap -- but its Madden band sags into the 50s. The gap is almost
   entirely *compression over-penalizing marginally-lower players*, not those
   players being genuinely bad. This is exactly the case for "give them less
   of a hit."
2. The tiers **overlap** in raw CFB overall (UFL max 86 > NFL min 78). What
   separates them is DRAFT SCORE (production, athleticism, position value,
   projected round), not overall alone -- so the second tier is "lower draft
   stock," not "worse players." Reinforces (1).

### 1b. "Reduce the hit" -- measured per engine

The core mechanism the user proposed: run the SAME translation with LESS
compression for the UFL tier only. Its power depends on the engine, because
each engine's "hit" is a different quantity.

**Dice Roll -- reduce-the-hit is the complete answer.** Its hit is the
class-strength debuff, which nudges EVERY rating (physical included) and can be
dialed toward zero or positive. Forcing a stronger class already lands the
target, same tier-2 players throughout:

| UFL class strength | UFL Madden band (min/med/max) | % >= 60 |
|---|---|---|
| Very Weak (-25%) | 49 / 56 / 68 | 30% |
| Normal (-20%) | 53 / 60 / 72 | 56% |
| **Very Strong (-15%)** | **56 / 64 / 76** | **91%** |

Very Strong alone puts the UFL squarely in the 60s/70s. A dedicated UFL debuff
smaller than -15% (or slightly positive) dials it precisely, WITHOUT a bolt-on
boost and without inventing ability beyond a "strong class" narrative.

**Power Curve -- reduce-the-hit lifts the floor but plateaus.** globalStrength
only un-compresses tech/mental (physical is a protected lever), and no amount
of reduced compression can push a rating ABOVE its raw college value (the
transform floor is `out = x`, zero drop). So the ceiling of "less hit" is the
players' actual college ratings, which Madden's overall formula computes to
~60:

| globalStrength | UFL Madden band (min/med/max) | % >= 60 |
|---|---|---|
| 1.0 (default) | 49 / 58 / 65 | 32% |
| 0.7 | 51 / 60 / 68 | 56% |
| 0.5 | 53 / 60 / 69 | 63% |
| 0.3 / 0.15 | 53 / 60 / 69 | 64% |

It stops moving past ~0.5. To center a Power Curve UFL band in the 70s you must
genuinely INFLATE ratings (a small post-translation top-up) -- globalStrength
cannot.

### 1c. Post-boost, for reference (the only path to a 70s center in Power Curve)

A flat overall lift on the default Power Curve output: +10 -> min 59 / med 68 /
max 75; +14 -> min 63 / med 72 / max 79. Reaches a 70s-centered band, but it is
deliberate inflation (asserting the players are better than their ratings say)
and, since Madden recomputes Overall from ratings in-game, must be applied to
the RATINGS (the overall follows) and validated with one import-readback pass.

---

## 2. What this means

**Superseded by the two-stage model (see 2a).** The original plan made
reduce-the-hit itself the lift, tuned per engine. That worked, but it made the
two engines land in different places (Dice Roll median 68 vs Power Curve 60)
and buried "how much are we inflating these players?" inside two dials that
mean different things. Kept here for the reasoning; the shipped design is
below.

- **Reduce-the-hit is engine-native.** Each engine already owns the lever:
  Dice Roll = class-strength debuff; Power Curve = globalStrength. The UFL is
  literally "the same engine, gentler compression for the second tier" -- no
  new translation math.
- **Dice Roll reaches the 60s/70s natively.** Power Curve plateaus at a
  60s-centered band and needs an optional top-up boost only if a 70s center is
  wanted.

## 2a. What actually shipped -- two stages

Each engine's compression lever is used only to bring the second tier to the
SAME baseline; one shared, engine-independent boost then does the lifting.

| Stage | Purpose | Controls |
|---|---|---|
| 1. Baseline (per engine) | Get both engines to the same starting band (~60 median) | `ufl.powerCurveGlobalStrength` = 0.5, `ufl.diceRollDebuff` = -0.21 |
| 2. Boost (shared) | Lift that baseline up to the regular NFL class's band | `ufl.overallBoostEnabled` (on), `ufl.overallBoostPoints` = 4 |

Why this is better than tuning each engine's compression to taste:

- **The engines agree.** Measured baselines: Dice Roll 51/60/71 (avg 60.2),
  Power Curve 52/60/69 (avg 60.1). Whichever engine is selected, UFL lands in
  the same place -- so the league toggle and the engine dropdown stay genuinely
  independent, as Decision 4 requires.
- **The inflation is one legible number.** "+4 overall" is a thing you can
  read, argue with, and change in one place, rather than an emergent property
  of two dials measured in different units.
- **One implementation.** `applyOverallBoost` reads nothing but the position's
  overall formula and the already-converted ratings, so both engines share it.

---

## 3. Locked decisions

1. **A single NFL/UFL mode toggle on the Generate card drives everything.**
   This is the whole UX: a two-state control (NFL | UFL) next to Generate.
   Flipping it switches which tier the SAME "Generate Draft Class" produces and
   how hard it compresses -- nothing else in the app changes. The Draft Class
   table and "Export Draft Class File" are mode-agnostic: they operate on
   whatever the current mode just generated. To ship both files, the user sets
   NFL -> Generate -> Export, then UFL -> Generate -> Export. No "Generate
   Both," no separate UFL export button, no dependency on generating NFL first.
2. **The two tiers must never share a player, guaranteed -- not "usually."**
   In UFL mode, selection internally computes the top-402 (to exclude), then
   returns the NEXT 402, with UFL position caps and a `:ufl` seed salt. The
   user does NOT have to generate NFL first -- flip to UFL, Generate, get the
   second tier. **The guarantee requires a deterministic tier boundary:** the
   402-cut is computed from a variance-free talent score, so the top-402 UFL
   excludes is always exactly the top-402 NFL mode produces -- exact
   complements, regardless of seed or how many times either is regenerated.
   (See Section 5 Phase 2 for the board-variance interaction this changes.)
3. **REVISED -- reduce-the-hit sets the BASELINE, a shared boost does the
   lifting.** Originally: reduce-the-hit was itself the boost, tuned per
   engine. Shipped: each engine's compression lever is tuned only so both
   engines start the second tier from the same ~60 band, and a single
   engine-independent overall boost lifts them to the NFL class's range. See
   Section 2a for why.
4. **The engine choice is left alone.** Flipping to UFL does NOT auto-switch
   the engine -- it stays on whatever the user selected on the Rating
   Translation page. Under the two-stage model this is now genuinely
   neutral: both engines land in the same place, so the choice is about how
   ratings are shaped, not how strong the UFL class comes out.
5. **REVISED -- the top-up became the shared boost, on by default.**
   Originally: a Power-Curve-only, off-by-default lift for a 70s center.
   Shipped: `ufl.overallBoost*`, applied by BOTH engines and ON by default,
   because it is now UFL mode's primary mechanism rather than an optional
   extra -- without it the second tier sits ~4 points under the NFL class.
   It is still the honest "this is inflation" case, just named and defaulted
   to match what it actually does.
6. **NFL path is untouched, with one deliberate exception.** NFL translation,
   enrichment, and export are byte-identical to today. The single change is the
   deterministic tier cut in Decision 2 -- board variance no longer flips a
   borderline player across the 402 boundary -- which is required to guarantee
   non-overlap and is called out explicitly rather than hidden.

---

## 4. Architecture -- reused vs new

**Reused unchanged:** extraction, draft projection/selection, board
organization (both modes), BOTH translation engines, dev-trait assignment,
combine generation, appearance (skin/face/build), college baking, the 402
class-size floor, the agility fix, the draft-class exporter, the file format.

**New:** (1) a `league` mode value (`'nfl' | 'ufl'`) + the toggle on the
Generate card; (2) mode-aware selection (UFL = self-contained second tier);
(3) mode-aware compression (UFL = a per-engine baseline plus the shared
overall boost); (4) light import-readback validation of the band.

The UFL generator is a THIN mode-flag over the existing pipeline, not a
parallel system. Export and the results table need NO changes -- they render
whatever the current mode produced.

---

## 5. Phases (each gated; NFL path unchanged throughout)

### Phase 1 -- The mode toggle (no behavior yet) [DONE]
Add `league: 'nfl' | 'ufl'` to config and the NFL/UFL toggle to the Generate
card. UFL mode behaves exactly like NFL for now -- this phase is just the
control and the plumbing that carries the mode into generation.
*Gate: toggle renders and persists; with it on NFL, output byte-identical to
today; UFL currently produces the NFL class (wiring only).*

### Phase 2 -- Mode-aware selection (the second tier), with a deterministic cut [DONE]
When `league === 'ufl'`, selection internally computes the top-402 to exclude,
then returns the next 402, with UFL position caps and a `:ufl` seed salt
(self-contained -- no prior NFL generation needed; the generational lock won't
fire on second-tier talent).

To make "never the same players" a hard guarantee (Decision 2), the 402-cut is
taken on a **variance-free talent score** rather than the current
board-variance-inclusive `_draftScore`. Consequence to weigh: today, board
variance can flip a borderline player across the 402/403 line between
regenerations; after this, variance no longer changes tier MEMBERSHIP (it still
reorders the board WITHIN a class, via the existing board-organization stage).
This mirrors the talent-rank vs. board-rank split the draft-board engine
already uses, and also settles the earlier seed-reproducibility concern -- but
it is a small, deliberate change to how the NFL 402 boundary is chosen, so it's
called out rather than slipped in.
*Gate: NFL and UFL are exact complements for a given pool (zero shared
players), stable across regenerations and seeds; each tier is 402 and
cap-respecting.* **Verified.** Measured churn from the old variance-inclusive
cut: 51/402 NFL players (87.3% unchanged) differ under the new deterministic
cut, versus the old algorithm's own selection for the same seed -- almost
entirely variance removal, not round-bonus or cap changes (confirmed by A/B
testing with round-bonus excluded from the cut too: 54/402, i.e. round-bonus
accounts for only ~3 of the 51).

### Phase 3 -- Mode-aware compression (the boost) [DONE]
When `league === 'ufl'`, run the SAME engine with reduced-hit settings: Dice
Roll = a UFL class-strength override (default landing the 60s/70s per 1b);
Power Curve = a lower UFL globalStrength. Dev traits assigned on the
PRE-reduction (true-tier) signal so a gentler class doesn't over-produce
Superstars. Reuses combine/appearance untouched.
**Now Stage 1 of the two-stage model (Section 2a)**: these two dials no longer
carry the lift, they just put both engines on the same starting line. Retuned
from the original per-engine values (`diceRollDebuff` -0.10 -> **-0.21**;
`powerCurveGlobalStrength` unchanged at **0.5**), measured:

| Engine | UFL baseline (min/med/max) | avg |
|---|---|---|
| Dice Roll (-0.21) | 51 / 60 / 71 | 60.2 |
| Power Curve (0.5) | 52 / 60 / 69 | 60.1 |

A sweep of `diceRollDebuff` across -0.10 .. -0.25 put -0.21 on Power Curve's
median almost exactly; -0.20 lands 61 and -0.22 lands 59, so the dial is
roughly 1 overall point per 0.01 on this pool.

Dev traits satisfy "assigned on the pre-reduction signal" with no code change
needed -- `devTraitWeight` (pipeline.js) reads `CFB_Overall`, the player's raw
college rating, never the converted/compressed `EstMaddenOverall`. NFL-mode
translation is unchanged and provably isolated: byte-identical output with the
entire `ufl` config block present, including with the boost cranked to +25.

### Phase 4 -- The shared UFL overall boost [DONE]
**Now Stage 2 of the two-stage model (Section 2a)**, and the piece that
actually makes UFL work. A post-translation overall lift in rating-space (so
Madden's own recompute follows), applied by BOTH engines in UFL mode, ON by
default at **+4**. Uses the app's per-position overall model to add points
where overall is weighted, clamped/redistributed at 99.

*Gate: both engines land close to the regular NFL band; NFL mode ignores it
entirely; no rating out of 1-99.* **Verified** against the real save:

| Boost | Dice Roll UFL | Power Curve UFL |
|---|---|---|
| +0 | 51 / 60 / 71 (avg 60.2) | 52 / 60 / 69 (avg 60.1) |
| +3 | 54 / 63 / 74 (avg 63.2) | 55 / 63 / 72 (avg 63.1) |
| **+4 (shipped)** | **55 / 64 / 75 (avg 64.2)** | **56 / 64 / 73 (avg 64.1)** |
| +5 | 56 / 65 / 76 (avg 65.2) | 57 / 65 / 74 (avg 65.1) |
| +6 | 57 / 66 / 77 (avg 66.2) | 58 / 66 / 75 (avg 66.1) |

+4 puts both engines on a **median of 64** -- matching NFL Power Curve's
54/64/75 exactly and sitting just under NFL Dice Roll (whose band still moves
seed to seed, since NFL keeps its class-strength roll). Zero out-of-range
ratings at any tested value. NFL mode is byte-identical for both engines even
with the boost set to +25.

**The boost is real in the exported file, not just on screen.** Scoring the
written ratings independently through `data/overall_formula.json` (the same
per-position model Madden's recompute approximates): **0 of 402** players had
unchanged ratings, and the achieved lift was **avg 3.98, range 3.47-4.25**
against a requested 4 -- the spread being integer rounding on individual
ratings. Both engines produce identical numbers here, since they share one
`applyOverallBoost` implementation.

*Two defects were found and fixed while building this -- both were the display
and the exported ratings disagreeing:*

1. **Anchor-coupled targeting (found via per-position fairness, Phase 6b).**
   The first implementation solved the ratings for a target expressed in
   ANCHORED terms, coupling the boost to each player's raw-vs-anchored gap.
   For 10 of 402 players (FS/WR heavy) the solved lift came out <= 0, so **no
   rating moved at all** -- while the displayed overall still jumped up to
   +19, because the display had switched from the anchored number to the raw
   one. Since Madden recomputes from the ratings, that was the Draft Class
   table showing 78 for a player the game would compute near 63. Fixed by
   decoupling: ratings are raised until the position's own formula reads
   exactly `lift` higher, and the display is the anchored baseline plus that
   same `lift`. Per-position achieved lift went from a 13.83..15 spread with
   outliers to +20, to exactly `[14, 14]` everywhere.
2. **Dice Roll's display is arithmetic, so it can't self-verify.** That engine
   shows `cfbOverall + delta`, so adding `+boostPoints` to it makes the class
   *look* boosted no matter what the ratings did. This is why the independent
   formula-scored check above exists rather than trusting `EstMaddenOverall`.

### Phase 5 -- Light validation [EXPORT DONE, READBACK PENDING -- manual]
Import a UFL class, read back ACTUAL Madden overalls, confirm the 60s/70s
target, nudge the UFL debuff / globalStrength / top-up. Small, because the Dice
Roll default already lands close.

The half of this that's real code is done: `tools/phase5UflBuildRealClass.js`
runs the actual pipeline against DYNASTY-DRAFTSTAGE with the shipped Phase
3/4 defaults and writes three real, full 402-slot `CAREERDRAFT-ufl-*` files
to the Desktop -- `diceroll`, `powercurve`, and `powercurve-topup` -- so any
of the three UFL candidates can be imported and checked without regenerating.
This app's own estimate for each (min/med/max, all this run's numbers, will
vary slightly seed-to-seed on individual bust/gem/jitter rolls):

| Variant | Madden est (min/med/max) |
|---|---|
| `diceroll` (shipped defaults) | 55 / 64 / 75 |
| `powercurve` (shipped defaults) | 56 / 64 / 73 |
| `diceroll-unboosted` (boost off, for comparison) | 51 / 60 / 71 |

The other half -- actually importing one of these into Madden/the UFL mod,
letting it recompute, and reading back the REAL in-game Overalls -- needs a
human at the game, which isn't something that can be automated here. Once
that readback happens, compare the real numbers against the table above: if
they're close, ship as-is; if Madden's actual recompute lands meaningfully
off from this app's own estimate, that's the signal to nudge
`ufl.diceRollDebuff` / `ufl.powerCurveGlobalStrength` /
`ufl.overallBoostPoints` in lib/defaults.js -- that last one being the single
dial to reach for first, since it moves both engines together.

### Phase 6 -- Polish [DONE]
UFL-specific dev-trait rates (fewer stars -- second tier), per-position
fairness on the shared overall boost, a "never exceed the NFL floor" guardrail if
desired. All three settled, measured against the real save:

**6a. UFL dev-trait rates** -- `ufl.devTraits` replaces the top-level
`devTraits` targets in UFL mode. Only the target SHARES change; who wins each
draw is still `devTraitWeight` over that class's own players, so the best UFL
prospects still get the best traits available to them. Measured on a 402
class: NFL `Star 141 / Superstar 4 / Normal 257` vs UFL `Star 80 /
Superstar 1 / Normal 321`, NFL unchanged. X-Factor is 0 rather than merely
small -- it's Madden's generational trait, and a generational player by
definition doesn't fall out of the NFL cut. (At realistic class sizes the
NFL's own 0.08% already rounds to zero, so this makes an existing
near-certainty explicit rather than removing something that was firing.)

**6b. Per-position boost fairness** -- measuring this found a real defect,
now fixed. The Phase 4 implementation solved the ratings for a target
expressed in ANCHORED terms, which coupled the boost to each player's
raw-vs-anchored gap. For the ~2.5% of players whose raw regression estimate
already sat far above their anchored value (10 of 402 -- concentrated in FS
and WR), the solved lift came out <= 0, so **no rating moved at all** -- yet
the displayed overall still jumped by up to +19, because the display had
switched from the anchored number to the raw one. Since Madden recomputes
Overall from the RATINGS, that was the Draft Class table showing a 78 for a
player the game would compute near 63. Fixed by decoupling the two halves:
ratings are raised so the position's own overall formula reads exactly `lift`
points higher (depends on nothing but the formula, so it lands evenly), and
the display is the normal anchored baseline plus that same `lift`. Result:
all 20 positions present in the class now land at exactly +14, range
`[14, 14]`, zero players over the requested lift -- versus a 13.83..15
per-position spread with individual outliers to +20 before. The fix also
removed code rather than adding it.

**6c. "Never exceed the NFL floor" guardrail -- deliberately NOT built.** The
roadmap listed this as optional; the data says it's unnecessary, and the
two-stage retune made that conclusion stronger still. Under shipped defaults
the two tiers now land on the same median:

| Engine | NFL (min/med/max) | UFL (min/med/max) | median gap |
|---|---|---|---|
| Dice Roll | 57 / 66 / 81 | 55 / 64 / 75 | -2 |
| Power Curve | 54 / 64 / 75 | 56 / 64 / 73 | 0 |

That is precisely the "lower-rated college players converting to similar
rookie overalls" target -- there is no runaway to guard against. A hard cap
at the NFL floor would also be the wrong shape of fix: it clamps the top of
the UFL class, when the thing anyone would actually want to adjust is the
whole band, which `ufl.overallBoostPoints` already moves in one place. And
the two classes never coexist in one roster file anyway -- they're separate
league imports, so there is no in-game inconsistency for a guardrail to
prevent. (NFL Dice Roll's band still shifts seed to seed, since NFL keeps its
class-strength roll while UFL is fixed; the gap above will breathe by a few
points either way.)

*(Export and the Draft Class table need no phase -- they already render the
current class, whatever mode produced it.)*

---

## 6. Open questions

None -- all three resolved; see below.

## 6a. Resolved
- **Exact UFL default debuff: -0.21** (`ufl.diceRollDebuff`). Under the
  two-stage model this is a BASELINE, not the lift -- it's tuned so Dice Roll
  starts the UFL tier where Power Curve does (51/60/71 vs 52/60/69), and the
  shared `overallBoostPoints` = +4 then lifts both to a median of 64. (The
  original answer was -0.10, which made Dice Roll UFL land at median 68 while
  Power Curve landed 60 -- the disagreement that prompted the redesign.) Was
  Open Question 1.
- **Small-dynasty edge case: fill what it can, and warn.** UFL needs a pool
  roughly twice the class size, since it takes the tier below a full NFL cut
  (~804 players for a 402 class; the exit population is normally ~2,500, so
  this effectively never fires). A short pool now produces the largest tier it
  can and logs an explicit WARNING naming the actual vs requested size and the
  pool depth required -- rather than failing generation or silently returning
  a short class. This matches how an under-402 class is already handled at
  export (unfilled slots keep the template's own prospects). Verified: silent
  at 402 on a 2,535 pool, fires correctly when forced short, never
  false-positives on NFL mode. Was Open Question 2.
- **Dev-trait rates: a dedicated, thinner UFL profile.** See Phase 6a above.
  Was Open Question 3.
- **Toggle is a plain two-state switch** (NFL | UFL) -- the only two draft
  types, so binary; not a continuous slider.
- **The engine dropdown is left alone** on flip -- UFL applies reduced
  compression to whatever engine the user has selected; no auto-switch.
- **Non-overlap is a hard guarantee**, via the deterministic tier cut
  (Decision 2 / Phase 2).

---

## 7. Non-goals
- No change to the NFL path.
- Not a more-accurate translation -- reduced compression for the UFL is a
  deliberate, league-appropriate lift, and the shared overall boost is explicit
  inflation.
- Not simulating which UFL team drafts whom (order only, same as NFL).

---

## 8. Synergy
The reduced-compression lever and the shared overall boost are the same
tools the 0.1.1 notes flagged wanting for the whole class ("ratings sit
heavily low, capping generational players"). Building tier-specific compression
control for the UFL is direct groundwork for a general, per-class version of
the compression fix.
