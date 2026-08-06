# Combine / Pro Day numbers — surfacing roadmap

**Goal.** Show the combine and pro-day numbers the app already generates. Today
they are computed for every player, written into the Madden save, and shown on
Madden's own scouting screens — but **nothing in Pipeline's UI displays them**.
This is the rare feature where the engine is finished and only the view is
missing.

**Hard requirement (user, 2026-07-26):** combine numbers stay visible when
**Hide Adjusted Stats** is on. See §3 — this is a deliberate product line, and
it has a caveat worth reading before implementing.

---

## 1. Where it stands

`combineNumbers(ratings, rng)` ([`lib/pipeline.js:1030`](lib/pipeline.js))
derives seven numbers from the **converted** ratings, so they always agree with
what the player actually is in Madden rather than what he was in college.
Formulas adapted from `seanpdwyer7/cfb2madden` (see NOTICE.md).

**Verified by direct probe**, not assumed:

| check | result |
|---|---|
| `row.Combine` present on preview rows | ✅ all 40/40 rows in a synthetic class |
| survives `JSON.parse(JSON.stringify(row))` (i.e. the IPC hop) | ✅ |
| attached on every generation path | ✅ three call sites (`pipeline.js` 1186, 1397, 1535) |
| referenced anywhere in `renderer/` | ❌ **zero hits** |

So Phase 1 is genuinely "add columns", not "plumb data through". Nothing in
`main.js`, `preload.js`, or the IPC contract needs to change.

It is also already **decoupled from draft order** — it uses the per-player
rating rng, so regenerating the board never reshuffles a player's 40 time.

---

## 2. The seven numbers, and their units

Units are **not uniform**, and the code comment above `combineNumbers` ("Distances/
times are stored x100") is only true for three of them. Measured directly from a
probe run with all physical ratings at 99:

| field | raw value | real meaning | encoding | display as |
|---|---|---|---|---|
| `CombineFortyYardDash` | `414` | 4.14 s | seconds ×100 | `4.14` |
| `CombineBenchPress` | `31` | 31 reps | plain count | `31` |
| `CombineVerticalJump` | `40.3` | 40.3 in | **inches, 1 decimal — not ×100** | `40.3"` |
| `CombineBroadJump` | `127` | 127 in | **plain inches — not ×100** | `10'7"` |
| `CombineThreeConeDrill` | `680` | 6.80 s | seconds ×100 | `6.80` |
| `CombineTwentyYardShuttle` | `422` | 4.22 s | seconds ×100 | `4.22` |

**Lower is better** for the forty, three-cone, and shuttle. Higher is better for
the other three. This matters twice: the table's default sort direction per
column, and any "best in class" highlighting (§CLASS_REPORT_ROADMAP.md §4.6).

### 2.1 Open question — is `CombineVerticalJump` written correctly today?

`writeCareerFile` copies `p.Combine` into the `DraftPlayer` row **verbatim**
([`lib/pipeline.js:1965`](lib/pipeline.js)) with no unit conversion. If Madden's
schema expects vertical jump ×100 (as it does for the three timed drills), then
`40.3` is being written where `4030` is meant, and in-game vertical has been
wrong since the feature shipped. Same question for `CombineBroadJump`.

No schema dump on disk covers these fields (`schema/` and `research/out/` both
have zero hits), so this is genuinely unresolved rather than assumed-fine.

**Resolve before Phase 1 ships**, because the UI must display whatever the save
actually holds — if the writer is wrong, the display would inherit the same bug
and make it look intentional. One probe against a live Madden save reading a
real prospect's `CombineVerticalJump` settles it. If it comes back ~4000, this
roadmap gains a Phase 0 bug fix; if ~40, the comment is just misleading and
should be corrected in place.

---

## 3. Visibility under "Hide Adjusted Stats" — the design decision

`HIDDEN_WHEN_TOGGLED` ([`renderer/renderer.js:15`](renderer/renderer.js)) hides
exactly six things: `DevTrait`, `EstMaddenOverall`, and the four Madden physical
ratings (Speed/Strength/Agility/Awareness). The sidebar tooltip states the
intent: *"useful if you don't want to see the effect of your own adjustments."*

**Decision: combine columns are NOT added to that set.** They stay visible.

**The rationale.** The toggle hides *rating readouts* — the game-mechanical
numbers that expose your own tuning back at you. Combine numbers are the
**in-world expression** of the same underlying athlete. Reading "4.31 forty"
feels like scouting a prospect; reading "Speed 94" feels like inspecting your
own config file. That is a coherent line to draw, and it is the line the user
asked for.

**The honest caveat, recorded so it is a choice and not an oversight.** Combine
numbers are *derived from* the converted ratings, so they leak information about
them. The forty is a near-invertible function of Speed (`545 - spd × 1.25`, ±2%
jitter), so a determined user can recover Speed to within a point or two from
the displayed time. The same holds for bench↔Strength, vertical/broad↔Jumping,
and cone/shuttle↔Agility.

So the toggle's guarantee should be understood — and, per Phase 3, *worded* — as
**"don't show me the rating numbers"**, not **"show me nothing downstream of my
adjustments."** Anyone who wants the stronger guarantee is not served by this
toggle today and would need a separate one; that is out of scope here and only
worth building if someone actually asks.

**Implementation consequence:** none. `visibleColumns()` filters against
`HIDDEN_WHEN_TOGGLED`; simply not adding the combine keys to that set gives the
required behavior with zero new logic.

---

## 4. Phases

### Phase 0 — Settle the vertical/broad unit question *(gate)*
- [ ] Probe a live Madden save for a real prospect's `CombineVerticalJump` and `CombineBroadJump`.
- [ ] If ×100: fix `combineNumbers` to match, add a regression assertion, and note the in-game correction in CHANGELOG.
- [ ] If plain: correct the misleading "stored x100" comment in place.

**Done when:** the stored encoding of all six fields is documented from evidence.
**Effort:** ~15 min. **Blocks:** display formatting in Phase 1.

### Phase 1 — Combine columns on the Draft Class table
Mirror `CAREER_STAT_COLUMNS` exactly — it is the same problem (an optional,
toggleable column group) and already solves sorting, hiding, and layout.

- [ ] `COMBINE_COLUMNS` in `renderer.js`, next to `CAREER_STAT_COLUMNS`, with a `fmt` per column for the unit table in §2.
- [ ] `cellValue()` reads `p.Combine[...]` — one new branch beside the existing `career.` branch, so the cell renderer and the sort comparator stay in sync automatically (the comment there already explains why that matters).
- [ ] `currentColumns()` concatenates them behind a `showCombine` flag.
- [ ] **Do not** add the keys to `HIDDEN_WHEN_TOGGLED` (§3).
- [ ] Sort ascending by default on the three timed drills (lower is better).
- [ ] "Show Combine Numbers" toggle in the sidebar footer, `localStorage`-persisted, exactly like `showCareerStats`.

**Done when:** a generated class shows all six numbers, correctly formatted and
sorted, and they remain visible with Hide Adjusted Stats on.
**Effort:** small. **Prereq:** Phase 0.

### Phase 2 — Per-player detail
The table is for scanning; this is for looking at one guy.

- [ ] Combine block in whatever per-player detail surface exists (or a hover card if none does).
- [ ] Show each number against its **position cohort percentile** — "4.42 (81st among WR)" is far more meaningful than a bare time, and the class is right there to compute it from.

**Done when:** a single prospect's athletic profile is readable at a glance.
**Effort:** small–medium. **Prereq:** Phase 1.

### Phase 3 — Wording + docs
- [ ] Update the Hide Adjusted Stats tooltip to say it hides *rating readouts*, per §3's caveat, so the guarantee is stated accurately.
- [ ] Short "where do these come from" hint on the toggle: derived from converted ratings, so they always agree with the player in-game.
- [ ] CHANGELOG entry.

**Effort:** trivial. **Prereq:** Phase 1.

---

## 5. Risks

| # | risk | severity | mitigation |
|---|---|---|---|
| C1 | Vertical/broad written in the wrong unit (§2.1) | **medium** | Phase 0 gates on resolving it |
| C2 | Six more columns crowd an already-wide table | low | Off by default behind a toggle, same as career stats |
| C3 | Users read combine numbers as scouting *inputs* rather than outputs | low | They are derived from final ratings, not the reverse; state it in the Phase 3 hint |
| C4 | The §3 leak is mistaken for a bug | low | Documented here and in the reworded tooltip |

## 6. Non-goals

- **Combine numbers never feed anything.** They are a pure downstream view of
  converted ratings — not an input to dev traits, draft order, or the board.
  Same posture `EstMaddenOverall` already takes.
- **No new tuning dials.** The ±2% scatter and the formula constants stay fixed;
  if they ever need tuning, that is a separate, evidence-driven change.
- **Not a combine *simulation*.** No drills, no re-rolling, no user-run event.
