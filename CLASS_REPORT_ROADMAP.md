# Class Report — roadmap

**Goal.** Turn a generated draft class from a 402-row table into a **readable,
shareable document**: who the class is, who stands out, who fell, what it's made
of. One button on the Draft Class page produces a self-contained file the user
can open, screenshot, or post.

**Why this and not another engine feature.** Every number it needs already
exists — this is presentation over data the app computes today. It is also the
cheapest adoption driver available: a class report is the artifact people post
in Discords and subreddits, and each one carries the app's name. Engine work
makes the tool better for existing users; this is what recruits new ones.

---

## 1. Where it stands

Nothing exists. There is an unrelated `export-results` IPC handler (CSV/JSON)
whose buttons were deliberately removed from the Draft Class header (see the
comment at `renderer/renderer.js:1713`) — that is a raw data dump, not a report,
and this roadmap does not revive or depend on it.

What *does* exist to build on:

| Existing piece | Reuse |
|---|---|
| `players[]` in the renderer — the full generated class | The entire data source |
| `generatedOrganization` | Knows whether Δ / steals are meaningful at all |
| `pick-save-location` IPC | File output, already permission-handled |
| `renderConfigSummary()` | Precedent for summarizing config state into prose |
| `roundDeltaOf(p)` | Steal/reach math, already written and UDFA-aware |
| `cellValue(p, key)` | Uniform accessor incl. nested `CareerStats` |
| `formatHeight()` | Ht formatting |

---

## 2. The data actually available per player

Confirmed from `BASE_COLUMNS` and the row shape built in `lib/pipeline.js`:

**Identity** — `FirstName`, `LastName`, `CFB_Position`, `FormerTeam` (college),
`Age`, `Height`, `Weight`
**Board** — `Rank`, `ProjectRound`, `DraftPick`, `BaselineRound`, `RoundDelta`
(derived), `Profile`
**Quality** — `CFB_Overall`, `EstMaddenOverall`, `DevTrait`, `ProdScore`, `AthScore`
**Detail** — `Madden_*` (every converted rating), `CareerStats` (10 totals),
`Combine` (6 numbers, see COMBINE_ROADMAP.md)

**Class-level context** — league (NFL/UFL), engine (Power Curve / Dice Roll),
seed, class size, board organization, and for Dice Roll the rolled class
strength.

That is more than enough for a genuinely good report without computing anything
new from the save.

---

## 3. Design principles

1. **A document, not a dashboard.** It should read top-to-bottom and be
   screenshot-friendly in sections. No interactivity required to get the value.
2. **Self-contained, single file.** Inline CSS, no external assets, no network.
   It must open correctly from a USB stick, an email attachment, or years later.
3. **Honest about mode.** Steals/reaches are meaningless under CFB Projected
   Rounds (Δ is always 0 — it *is* the baseline). Those sections must be omitted
   entirely in that mode, not shown empty or misleading.
4. **Never recompute.** The report describes `players[]` exactly as generated.
   If a number appears in the report and the table, they must agree — the report
   is a view, never a second engine.
5. **Reproducibility on its face.** Seed, engine, and settings are printed in
   the header, so a shared report doubles as a recipe for regenerating the class.
6. **Degrade gracefully.** Missing `CareerStats` (saves with no seasons played),
   missing `Combine`, a 40-player class instead of 402 — each section renders or
   omits itself cleanly rather than erroring.

---

## 4. Report contents

### 4.1 Header
Class name/title, source dynasty, generation date, **league (NFL/UFL)**, engine,
seed, class size, board organization. Under Dice Roll, the rolled class strength
tier. This is the "recipe" block from principle 5.

### 4.2 Class at a glance
Six to eight stat tiles: total players, drafted vs UDFA split, average
`EstMaddenOverall`, highest-rated player, X-Factor / Superstar / Star counts,
number of schools represented.

Dev-trait counts are the headline number here — under shipped defaults X-Factors
are ~1 in 1,300, so *"this class has one"* is genuinely notable and is exactly
the fact people share.

### 4.3 Top prospects
The top 10–15 by board position. Per player: rank, name, position, college,
Est. Madden OVR, dev trait, profile, and a one-line physical summary
(ht/wt/40 if combine is available).

### 4.4 Round-by-round
Rounds 1–7 plus the UDFA tail. Per round: the picks, compactly. This is the
section that makes it feel like a real draft-class document rather than a
leaderboard.

### 4.5 Steals and reaches — *Realistic Draft Day only*
Biggest positive Δ (fell furthest — the steals) and biggest negative Δ (went
earliest). `roundDeltaOf` already handles the drafted↔UDFA boundary via
`UDFA_ROUND`, so a player who fell out of the 224 still shows a real number.

**Omitted entirely under CFB Projected Rounds** (principle 3).

### 4.6 Superlatives
Fastest 40, most bench reps, highest vertical, best three-cone; heaviest,
tallest, youngest. Cheap to compute, disproportionately fun, and the most
screenshot-bait section in the document.

Respect direction-of-better per §2 of COMBINE_ROADMAP.md — lower wins on the
three timed drills. Whole section omits itself if `Combine` is absent.

### 4.7 Position breakdown
Count, average Est. Madden OVR, and best player per position. Flags positional
scarcity or glut at a glance — a class with 41 corners and 3 tackles is
immediately visible.

### 4.8 School representation
Which colleges sent the most players, top ~10. Directly meaningful for a dynasty
player: it is *their* recruiting showing up in the pros. This is the section
that ties the report back to the CFB half of the app.

### 4.9 Career production leaders — *when available*
Top passers/rushers/receivers/tacklers from `CareerStats`. Omits itself when the
save had no seasons played (an early-dynasty save has no stats to show).

### 4.10 Footer
App name + version, the seed again, and a one-line "generated by Pipeline"
attribution.

---

## 5. Format decision

**Ship HTML.** Self-contained, styled, opens anywhere, prints to PDF via the
browser, screenshots cleanly, and needs no dependency. It also reuses the visual
language of `style.css` so the report looks like the app that made it.

**Rejected, with reasons:**
- *PDF directly* — needs a renderer dependency; the browser's print-to-PDF from
  the HTML gets there for free.
- *PNG/image* — locks the content to one width and kills text selection. A
  screenshot of the HTML is strictly better and the user already knows how.
- *Markdown* — trivially easy but loses all layout; the value here is that it
  looks good. Worth adding later as a secondary "copy as text" if asked.

---

## 6. Phases

### Phase 1 — The generator (pure, testable, no UI)
- [ ] `lib/classReport.js` — `buildReportModel(players, context)` → a plain data object holding every section in §4, computing nothing that isn't in `players[]`.
- [ ] Pure and save-free, so it unit-tests against fixtures like every other lib module.
- [ ] `test/classReport.spec.js` — section presence/omission rules (§3.3, §4.5, §4.6, §4.9), superlative direction-of-better, Δ handling across the UDFA boundary, and graceful degradation on a tiny class.

**Done when:** a Node script turns a fixture class into a complete report model.
**Effort:** medium. **Prereq:** none.

### Phase 2 — HTML rendering
- [ ] `renderReportHtml(model)` → one self-contained string, inline CSS, no external refs.
- [ ] Responsive-ish and print-friendly; sections are individually screenshot-able.
- [ ] Snapshot-ish test: output parses, contains each expected section, and references nothing external.

**Done when:** the model renders to a file that opens correctly with no network.
**Effort:** medium. **Prereq:** Phase 1.

### Phase 3 — Wire into the app
- [ ] `class-report` IPC handler, following the `export-draft-class-file` shape exactly (same error handling, same save-location flow).
- [ ] `preload.js` bridge method.
- [ ] "Export Class Report…" button on the Draft Class page, disabled until a class exists.
- [ ] Pass the real generation context (league, engine, seed, organization, class strength) so the header is accurate rather than re-read from live config — **which may have changed since generation**, exactly the trap `generatedOrganization` already exists to avoid.

**Done when:** a user generates a class, clicks one button, and gets a shareable file.
**Effort:** small. **Prereq:** Phase 2.

### Phase 4 — Polish
- [ ] In-app preview before saving.
- [ ] Optional class title/nickname field for the header.
- [ ] Include the app version and a regeneration hint (seed + settings) in the footer.

**Effort:** small. **Prereq:** Phase 3.

### Phase 5 — Optional extras *(only if wanted)*
- [ ] Combine section gated on COMBINE_ROADMAP.md Phase 1 landing.
- [ ] "Copy as text" for forum/Discord posting.
- [ ] UFL-vs-NFL comparison when both have been generated from the same pool.

---

## 7. Open questions

1. **Does the report cover the full class or only the drafted 224?** Leaning
   full 402 with the UDFA tail as its own clearly-labelled section — the tail is
   where several of the best steals live under Realistic Draft Day.
2. **Ratings in the report?** Leaning no by default: the report is a scouting
   document, and full rating tables are what the Draft Class page is for. A
   per-player rating block may be worth it in Phase 4 for the top 10 only.
3. **Does Hide Adjusted Stats apply to the report?** The report is an
   intentional, explicit export, and the toggle is a *table view* preference —
   so leaning **no**, it does not filter the report. But it should be a conscious
   call, not an accident; see COMBINE_ROADMAP.md §3 for the same tension resolved
   on the table side.
4. **One file or a folder?** One file, per §5 — but if images are ever embedded
   they must be data-URIs to keep that true.
5. **Where do reports default to saving?** Reuse `defaultDirs` rather than
   inventing a new location.

## 8. Risks

| # | risk | severity | mitigation |
|---|---|---|---|
| CR1 | Report and table disagree on a number | **high** | Principle 4: the report never recomputes. Both read the same `players[]` through the same accessors |
| CR2 | Header describes settings that changed after generation | medium | Phase 3 passes captured generation context, never live `cfg` — the `generatedOrganization` precedent |
| CR3 | Steals section shown under CFB Projected Rounds, where Δ is always 0 | medium | Principle 3: omit the section entirely; covered by a Phase 1 test |
| CR4 | Crashes on a class missing `CareerStats` or `Combine` | medium | Principle 6 + explicit degradation tests |
| CR5 | A 402-player round-by-round makes an unusably huge file | low | Text-only HTML; even 402 rows is tens of KB |

## 9. Non-goals

- **Never changes the class.** Pure read-side; generation is untouched.
- **Not a second export format for Madden.** The draft-class file is the thing
  the game imports; this is for humans.
- **Not a comparison tool across dynasties.** One class, one report. (The
  cross-year "universe ledger" idea is a separate, much larger piece of work.)
- **No telemetry, no network.** The file is inert HTML and stays that way.
