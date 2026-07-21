# Draft Board Organization -- Roadmap

**Status: Phases 0-4 SHIPPED.** `lib/draftBoard.js` + `test/draftBoard.spec.js`
(32 assertions) + the Advanced dropdown + the Draft Class table's Δ column are
all live. Phase 5 (trait-biased displacement) is next; see §4.

Goal: let the user choose *how the selected class is organized into rounds and
picks*, entirely separately from which players were selected. Answers the
community ask: *"is there a possibility to make the draft class a little less
top heavy? like drafting more late round steals?"*

Two organization modes to start:

1. **CFB Projected Rounds** (default) -- today's behavior, driven by
   `projectDraftClass()`'s weighted score.
2. **Realistic Draft Day** -- the same selected pool, reordered by
   one-directional fat-tailed displacement, producing genuine late-round
   steals without manufacturing first-round busts.

---

## 1. Verified findings (measured against DYNASTY-DRAFTSTAGE)

Everything in this section is measured, not assumed. Scratchpad prototypes,
not shipped code.

### 1a. Baseline -- what the class looks like today

| Metric | Value |
|---|---|
| `EstMaddenOverall` range | 52 - 75 (median 64) |
| Players >= 78 OVR | **0** |
| corr(draft slot, overall) | **-0.75** |
| 70+ OVR landing in Rd4+ | 10 - 12 |
| Worst OVR inside Rd1 | 63 - 65 |

Per-round overall spread:

```
Rd1 67-75    Rd4 60-72    Rd7 54-67
```

**Two things this reveals.** First, the board is *already* only -0.75
correlated with overall, not -1.0 -- position value, awards, production and
athleticism decouple it substantially before any new feature exists. Second,
the round *ceiling* barely declines (75 -> 72 -> 71 -> 67) while the *floor*
collapses (67 -> 60 -> 54). Late rounds already contain players as good as the
median first-rounder.

Implication worth remembering: some of the perceived "top heaviness" is
**rating compression** (nothing above 75, median 64 -- there is no star tier
for a steal to *be*), which is a Power Curve concern, not a board concern.
Reordering can only redistribute the talent that exists.

### 1b. The existing `boardVariance` dial cannot solve this

| boardVariance | corr | 70+ in Rd4+ |
|---|---|---|
| 0 | -0.762 | 11 |
| 1.5 (default) | -0.759 | 10 |
| **10 (max)** | **-0.670** | 13 |

Maxing the existing setting barely moves anything -- it is +/-10 points against
a score whose total spread is 40-50 points, so it gets swamped. **Do not ship
"just turn up Board Variance" as the answer.**

### 1c. Random swaps work, but are structurally flawed

| swaps | corr | 70+ in Rd4+ | **worst OVR in Rd1** |
|---|---|---|---|
| 0 | -0.762 | 12 | 65 |
| 10 | -0.697 | 14 | **56** |
| 50 | -0.564 | 19 | 61 |
| 100 | -0.439 | 24 | **54** |

Swaps decouple aggressively and cheaply. But a swap is **conservation of
position**: moving a good player down to rank 200 *requires* dragging whoever
sat at 200 up to rank 5. Every steal is paid for with an equally dramatic
bust, 1:1, permanently. And because swap distance is uniform, those busts are
severe -- a **54 overall reaching round 1** in a class topping out at 75.

You can control how *often* it happens. You can never control how *far*.

### 1d. One-directional displacement -- the chosen approach

| chaos | corr | 70+ in Rd4+ | **worst OVR in Rd1** | biggest rise |
|---|---|---|---|---|
| 0 | -0.753 | 10 | 63 | 0 |
| 30 | -0.738 | 12 | **63** | 17 |
| 50 | -0.718 | 13 | **63** | 26 |
| 75 | -0.687 | 16 | **63** | 37 |
| 100 | -0.658 | 16 | **63** | 47 |

**The worst overall in round 1 never moves off 63, at any intensity.** That is
the decisive result. Because displacement is one-directional, a player who
falls causes everyone below to shift up by exactly *one slot each* -- the cost
is distributed across ~200 players instead of concentrated into one disaster.
Even at maximum chaos the biggest riser gains 47 slots (~1.5 rounds), versus
~375 for a single swap.

Sample output at chaos 50:

```
Zay Wilbon      HB  ovr 74   talent Rd1 -> drafted Rd6
London Simmons  DT  ovr 71   talent Rd1 -> drafted Rd5
Jerome Myles    WR  ovr 72   talent Rd3 -> drafted Rd4
```

A 74 sliding to round 6 (median 64) is exactly the requested "late round
steal," with no bust created to pay for it.

**Known weakness:** displacement decouples more gently than swaps at nominally
similar settings (-0.718 vs -0.610). This is a tuning gap, not a ceiling --
bust-immunity comes from the *one-directional* design, not from small
magnitudes, so the tail can be widened freely. See Phase 0.

### 1e. The two engines must use two different SCORING functions

Decision 3 says the new mode must not use CFB's projected round for placement.
Today that term (`roundBonus = (8 - cfbRound) * roundWeight`) is worth up to
**+14 points** -- large against an overall spread of only 23 points. Measuring
today's board (`roundWeight: 2`) against a CFB-round-free board
(`roundWeight: 0`):

| Metric | Result |
|---|---|
| Rank correlation A vs B | **0.848** (meaningfully different orderings) |
| Round 1 overlap | **24/32** |
| **Selected-pool overlap** | **366/402 -- 36 different players** |
| corr(slot, ovr) | A: -0.751, B: -0.723 |

**Three consequences:**

1. **The first prototype was invalid.** It applied displacement on top of
   `DraftRank`, which already contains `roundBonus` -- so it measured "CFB's
   projection plus noise," not an independent engine. Engine B must start from
   a talent-only score.

2. **Selection must be computed once and shared.** If Engine B simply drops
   `roundBonus` from the score that *also* selects the top 402, then 36
   different players make the class -- violating Decision 1. Selection is
   computed up front, and only the ordering of that fixed pool differs by
   engine.

3. **Separation alone does not create steals** (-0.751 -> -0.723 is nearly
   nothing), because CFB's projected round is itself strongly correlated with
   overall. Displacement remains the actual mechanism; removing `roundBonus`
   only stops CFB's rounds from fighting it.

Side effect worth keeping: players with **no CFB round projection at all** are
currently penalized ~14 points versus a CFB round-1 prospect. Engine B
rehabilitates them (one such player moved 359 -> 187).

---

## 2. Locked decisions

1. **Selection is untouched.** The same players make the class either way.
   Reorganization changes only where they land. Hard constraint.
2. **No cap on how far a player can fall.** Biased toward staying near the
   front, but nothing artificially floors a slide.
3. **A fully separate system**, not a preset over `draftValue` weights and not
   `boardVariance` turned up. Follows the same swappable-strategy pattern
   `cfg.translation.strategy` already uses for rating engines
   (`calibratePlayers()` -> `Rosetta.translation.createTranslator()`).
4. **Runs strictly AFTER selection**, on the already-chosen pool.
5. **UI: a dropdown in Advanced**, beside the existing Draft Projection
   weights. A `<select>`, not a checkbox, so modes can be added over time.

---

## 3. The algorithm

### 3a. Shared selection, then two independent orderings

```
selectionScore  (INCLUDES roundBonus, exactly as today)
      |
      +--> pick top `classSize` players            [SHARED -- never varies by engine]
                          |
        ┌─────────────────┴─────────────────┐
        |                                   |
  Engine A: cfbProjected            Engine B: realisticDraftDay
  order by selectionScore           re-score talent-only (NO roundBonus),
  (byte-identical to today)         then apply displacement (3b)
```

Engine B's talent score is the current formula **minus** the
`(8 - cfbRound) * roundWeight` term:

```
talentScore = OverallRating
            + positionValue * positionValueWeight
            + awardsScore   * awardsWeight       (capped at +4)
            + prodScore/99  * productionWeight
            + athScore/99   * athleticismWeight
```

Selection is computed **once, before the engine branch**. Never recompute the
402 from a talent-only score -- doing so changes membership by ~36 players and
violates Decision 1 (see 1e).

### 3b. Displacement (Engine B only)

```
for each player i in the selected pool, ranked by talentScore:
    effectiveRank[i] = talentRank[i] + fall(rng, chaos)

fall(rng, chaos):
    u = rng()
    if   u < 0.70:  rounds = rng() * 0.5          // ~70%: under half a round
    elif u < 0.95:  rounds = 0.5 + rng() * 1.5    // ~25%: 0.5 - 2 rounds
    else:           rounds = 2 + rng() * 6        // ~5%:  2 - 8 rounds (tail)
    return rounds * 32 * (chaos / 50)             // 32 slots = 1 round

sort ascending by effectiveRank -> board order -> round / pick
```

Displacement is expressed in **round-space**, not points -- "he fell two
rounds" is what a user perceives, and it makes the tail directly tunable.

Must draw from the existing **projection RNG** (the salted `projectRng`), so
the board stays reproducible under a seed and ratings remain untouched.

---

## 4. Phases

### Phase 0 -- SHIPPED *(re-prototype on a talent-only rank, then tune)*

**First** rebuild the prototype on Engine B's talent-only score (§3a) rather
than `DraftRank`, since the original measurements were taken on a
CFB-round-contaminated ranking (see 1e). All numbers in 1d need re-taking
against the corrected base before they can be trusted.

**Then** widen the tail and recalibrate the chaos scale so the 0-100 dial
spans a genuinely useful range. Targets at chaos 100, while
**worst-OVR-in-Rd1 holds at baseline**:

- corr(slot, ovr) around **-0.55**
- 70+ OVR in Rd4+ in the **low 20s**

Levers: tail probability (currently 5%), tail magnitude (currently 2-8
rounds), and the chaos scale factor. Cheapest phase, entirely in scratchpad,
and it de-risks every phase after it.

**Shipped:** re-measured on the corrected talent-only base (§3a) -- the
original 1d numbers were on the contaminated ranking and are superseded here.
Widened the tail from 5% to 12% (`lib/draftBoard.js`'s `drawFall`). Real-save
result, chaos 0 -> 100: corr(slot, ovr) **-0.669 -> -0.555**, 70+ OVR in Rd4+
**11 -> 12-15** across the range, **worst OVR in Rd1 held at 62 at every
level**. The -0.55 target was hit; bust-immunity confirmed on the shipped
constants, not just the prototype's.

### Phase 1 -- SHIPPED *(the `organizeBoard()` seam)*

`lib/draftBoard.js` exports `organizeBoard(selected, cfg, rng)`, dispatched by
`cfg.draftBoard.organization` through an `ORGANIZATIONS` registry -- the same
shape `Rosetta.translation.createTranslator` uses. `projectDraftClass()` in
`lib/pipeline.js` now ends by handing its selected pool to `organizeBoard()`
instead of stamping round/pick itself.

Acceptance verified: with the default mode, `organizeBoard`'s `cfbProjected`
strategy is a pure pass-through (`test/draftBoard.spec.js` asserts this
directly), and the full `npm test` suite -- unrelated specs included -- was
green before and after the extraction.

### Phase 2 -- SHIPPED *(config + dropdown)*

`draftBoard: { organization: 'cfbProjected', chaos: 50 }` added to
`lib/defaults.js` with tooltip copy. Advanced page has a **Board
Organization** `<select>`; a **Draft Day Chaos** number input appears only
when `realisticDraftDay` is selected (hidden otherwise -- no point showing a
dial that does nothing under the default mode).

### Phase 3 -- SHIPPED *(`realisticDraftDay` strategy)*

Implemented per §3: `talentScoreOf()` (the draft-value formula minus the CFB
round-projection term) ranks the selected pool, then `drawFall()` (Phase 0's
tuned distribution) displaces it. Wired as the dropdown's second entry.

Verified against the real save: selection membership held at **402/402**
across every chaos level (Decision 1), output is reproducible under a seed,
and `talentScoreOf` was confirmed to ignore `ProjectRound` entirely (a
round-1-projected and a round-7-projected player with identical other stats
score identically).

### Phase 4 -- SHIPPED *(make it visible)*

`projectDraftClass()` now stamps `_baselineRound` on every selected player --
the round `cfbProjected` would have given them -- BEFORE handing off to
`organizeBoard()`, using the pre-organize selection order (which IS
`cfbProjected`'s ordering) rather than re-running that strategy. Exposed as
`BaselineRound` on the generated row alongside the actual `ProjectRound`.

Draft Class table gains a **Δ** column (only shown when the currently
displayed results were generated under `realisticDraftDay` --
`generatedOrganization` is captured at generate time, not read live off the
dropdown, so it can't mismatch if the user changes the setting without
regenerating). Positive = fell later than the baseline (steal, green badge);
negative = went earlier (reach, red badge); a UDFA<->drafted crossing is
expressed relative to round 8 so falling out of the drafted 224 entirely still
shows a real delta instead of silently disappearing.

Verified end to end against the real save: under `cfbProjected`,
`BaselineRound === ProjectRound` for all 402 players (it's the same
ordering). Under `realisticDraftDay`, each player's `BaselineRound` matches
what `cfbProjected` independently gave that same player -- confirming the
stamped baseline is correct, not just self-consistent. At chaos 60: 61 notable
steals (delta >= 2 rounds) and 66 notable reaches, with the single largest
example a round-1-baseline corner who fell out of the draft (UDFA) entirely
and, symmetrically, undrafted-baseline QBs rising as high as round 2 once
CFB's own round projection stops suppressing them.

**One honest side effect worth flagging, not hiding:** reaches are not
purely chaos-driven. Some come from Engine B's talent score genuinely
disagreeing with CFB's round -- a QB CFB never projected to be drafted, but
whom the talent formula (overall + production + athleticism + position value,
no round term) rates well, will show as a big riser even at low chaos. That's
expected per 1e (removing `roundBonus` rehabilitates unprojected players) and
is a feature, not noise -- but it means "Δ" isn't purely a measure of random
slide; part of it is the two engines legitimately disagreeing on a player's
value.

### Phase 5 -- Trait-biased displacement (believability) *(next up)*

Bias *who* slides using signals already on the row, so steals have a reason:

**Slide risk up:** `High Ceiling` profile (raw/unpolished), age,
production-athleticism mismatch, and **injury history** --
`WasPreviouslyInjured`, `LatestInjuryYear`, `InjurySeverity`, `WearAndTear_*`
are all present on the CFB Player row and **completely unused by projection
today**. Most realistic slide signal available, free.

**Reach risk up:** elite athleticism with modest production (workout warrior),
high dev trait relative to output.

A gem then emerges naturally: a high-talent player who drew a slide.

### Phase 6 -- Tunability + more modes

Sub-dials (tail weight, injury weighting, whether a generational prospect can
slide), and additional dropdown entries. Once Phases 1-2 exist, a new mode is
a module plus one `<option>`.

---

## 5. Open questions

1. **Positional structure.** Round-1 positional caps and market saturation are
   computed inside `projectDraftClass()` off `_draftScore`. Does
   `realisticDraftDay` still respect them (max 6 QBs in Rd1), or is overriding
   them exactly the chaos we want? Blocks Phase 3's final shape.
2. **Generational prospect.** Today's `+12` locks #1. Stay locked in the new
   mode, or slide like anyone else? (Leaning locked-by-default with a Phase 6
   toggle.)
3. **UDFA tail.** Do players past pick 224 (but inside the 402) participate in
   displacement? The "late round steals" framing argues yes.
4. **Preset export.** Should almost certainly ride along with the other
   `draftValue` settings -- no reason to special-case it.

---

## 6. Non-goals

- **Never touch ratings.** Converted ratings stay a pure function of the
  player's college self plus the global seed.
- **Never touch class membership.** Decision 1, hard constraint.
- **Not team-needs simulation.** Which *team* drafts whom is out of scope.
- **`cfbProjected` stays the default.** Nobody sees a change unless they open
  the dropdown.

---

## 7. Sequencing

**Phase 0 -> 1 -> 2 -> 3 -> 4 are shipped** (`lib/draftBoard.js`,
`test/draftBoard.spec.js`, the Advanced dropdown, the Δ column). **Phase 5
(trait-biasing) is next** -- it meaningfully improves believability and
shouldn't be deferred indefinitely now that the mechanical core is proven
against a real save. Phase 6 (open question 1's positional-cap decision, more
modes, sub-dials) is refinement after that.
