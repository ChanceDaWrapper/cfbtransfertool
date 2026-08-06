# Coach Transfer — audit & road to publish

Zoomed-out status for the **coach transfer between CFB and Madden, both
directions.** Ties together [`COACH_CAROUSEL_ROADMAP.md`](COACH_CAROUSEL_ROADMAP.md)
(the move) and [`COACH_FIDELITY_ROADMAP.md`](COACH_FIDELITY_ROADMAP.md) (the
presentation). This is one subsystem of the larger CFB→Madden pipeline; the
player-rating side lives in [`POWERCURVE_ROADMAP.md`](POWERCURVE_ROADMAP.md),
draft handling in [`DRAFTBOARD_ROADMAP.md`](DRAFTBOARD_ROADMAP.md).

**Bottom line (2026-07-25): both directions are built and VERIFIED IN-GAME.**
CFB → Madden was already done and verified in-game. Madden → CFB (§7) is now
built too — the decisive question (can this library even *write* a CFB save?)
was unverified until today; a no-op round trip and a real field write both
survive cleanly, and a batch of 5 real Madden coaches (2 HC, 2 OC, 1 DC,
chained across multiple writes) placed onto real CFB schools correctly:
right job, right level, a talent state matching a real donor, a tone-matched
face, both team pointers, zero corruption. **Confirmed in-game** on CFB 27's
"Choose Coach" screen — see §9, which also records the three defects that
screen exposed and the fixes for each.

---

## 1. Audit — what is built and verified

| Capability | State | Evidence |
|---|---|---|
| Cross-game field mapping (Coach → Coach) | ✅ done | `map/index.js`, 67 test assertions |
| Level / XP / archetype synthesis | ✅ verified in-game | Coach Central: Freeman L49 Offensive Guru |
| Talent-tree deep clone (private, load-bearing) | ✅ verified in-game | 28 abilities / 7 playsheets match the clone exactly |
| Mode B direct placement onto a named team | ✅ verified in-game | Giants/Bears/Jets all hired correctly |
| Incumbent displacement → free agency | ✅ verified | Canales, Daboll, Glenn all moved to TeamIndex 32 |
| Both job pointers written (Coach↔Team) | ✅ verified | probe27 confirms reciprocal refs agree |
| Head-coach hiring-window timing gate | ✅ done | `timing.js`, 17 test assertions |
| Portrait = head asset + 308 | ✅ 93/93 | `appearance.js` |
| **Madden head catalog — full 200 heads** | ✅ **verified in-game** | 3 never-observed inferred heads all render (§2) |
| **Skin-tone matching (Madden side)** | ✅ **measured, 6/6 validated** | portrait-art luma → tone, complete 1–8 coverage |
| **Skin-tone reading (CFB side)** | ✅ exact on all 493 | `cfbSkinTone()`, 0 false pos / 0 miss |
| Pre-write schema validation | ✅ done | `validate.js`, offset-int aware |
| Determinism (seeded, reproducible) | ✅ verified | same seed → same faces/tones |

**Tests:** 149 assertions across 5 carousel suites + 72 dice-roll, all green.

### This session's advances

1. **The head catalog is 200, not 83.** The earlier map covered only heads in
   use in one save. Walking the MyFranchise asar found the real catalog —
   assets 1–200, dense, gapless — and the save corroborates the top (a live DC
   wears `0200`). Supply per tone ~2.4×'d; scarce dark tones gained most
   (tone 8: 5→15, tone 6: 6→21).

2. **Inferred head names proven to render.** 117 of the 200 names were inferred
   from portrait art, never seen on a live coach. Three (`0039`/tone 8,
   `0110`/tone 7, `0084`/tone 6) were placed and **all three render correctly
   in-game** — Mike Anthony, Dave Aranda, Shannon Archer.

3. **CFB tone side scoped and handled.** 263 of 493 CFB coaches encode tone in
   their head name (read exactly). The other 230 are `Unique_*` authored
   likenesses of real people (Freeman, Day, Sarkisian…) with no tone anywhere.
   Four extraction/inference routes were tried and closed (§3). Resolved with a
   hand-override file + a fallback that samples the real CFB tone distribution,
   flagged via `toneWasGuessed`.

4. **Bug fixed: silent wrong-team placement.** `findMaddenTeam` matched
   `teamIndex` *or* `teamName` and returned whichever came first in table order,
   so a stale index silently placed a coach on the wrong team. Now requires
   agreement or throws. Regression test added.

---

## 2. Known limitations (honest, pre-publish)

| # | Limitation | Severity | Notes |
|---|---|---|---|
| L1 | 230 CFB `Unique_*` coaches have no readable tone | medium | The marquee coaches. Need a one-line override each, or accept a distribution-sampled guess. `tools/listUntonedCoaches.js` ranks them. |
| L2 | Female coaches get a male face at the right tone | ✅ resolved by design | Madden 26 has no usable female head catalog. Product decision (2026-07-24): tone-match from the catalog we have. Tone reading is gender-agnostic, so this already works — a female coach lands on the correct skin tone automatically. Documented in `appearance.js`. |
| L3 | Level display is data + 1 — **Madden only** | low | `Level 48` shows as 49 in Madden. Verified §9.1 that CFB has NO such offset (wrote 24/26/28, displayed 24/26/28), so this decision only ever applied to the forward direction. |
| L4 | ~~Only head coaches transfer~~ — **corrected**: individual OC/DC moves already work both directions | ✅ resolved | Verified end-to-end 2026-07-25 (§10.1): a CFB OC → 49ers and a Madden DC → Alabama both commit cleanly, displace the incumbent, keep their position, get a face, and write both pointers. Moving a staff as a bundled unit was built and then deliberately rejected — individual coaches only, by product decision (§10.4). |
| L9 | ~~CFB landing slots are capped at ~64, and the tier-3 fallback degrades silently~~ | ✅ fixed | CFB can only land a coach on a row that already owns a talent chain; its 135 empty rows have none, so `findDisposableCfbSlot`'s empty-row fallback used to yield a row `grantCfbTalentTree` would report as `skipped` — the coach would arrive with no tree. Fixed: tier 3 now requires a usable chain too and throws honestly when none exists. 7 fixture assertions in `test/carouselPlaceOnCfbTeam.spec.js`. See §10.3. |
| L8 | `AlmaMater` left unwritten on Madden→CFB | low | An NFL coach genuinely has no CFB alma mater. Verified only 4 of 414 real coaches sit at 0, so it is near-unused but not invalid, and it is not shown on the coach card. Deliberately not fabricated — see §9.4. |
| L5 | ~~Stale team loadout slot~~ | ✅ fixed | Giants `GamedayLoadout` slot4 pointed at the old coach's talent row. Fixed via `clearStaleTeamLoadouts` — see §9.5. |
| L6 | Ability count reads 28/25 (112%) | cosmetic | Likely correct (cross-tree abilities); confirm against Tomlin/Shanahan. |
| L7 | ~~NFL → CFB direction unbuilt~~ | ✅ built | See §7. Both Manual and Auto-propose work; auto pairs via CFB's own `CurrentJobSecurityPercentage` (§7.3). |
| L10 | ~~`pickDonorCoach` only checked `GamedayTalents`~~ | ✅ fixed | 7 real coaches (all low-level assistants) have Gameday but no Playsheet tree; picking one as a donor silently produced an incomplete tree. Now requires both categories to be genuinely populated (not just referenced). `WearAndTearTalents` deliberately still not required — populated for 0/111 real coaches league-wide. See §11. |

---

## 3. Closed investigations (do not reopen)

- **Scraping CFB portraits.** No CFB coach art on disk (MyFranchise is
  Madden-only; Mini MyDynasty uninstalled). Game install packs it in Frostbite
  `.cas`/`.toc` behind one library — needs a Frostbite toolchain, out of scope.
- **Inferring CFB tone from data.** No Coach field predicts tone (all high-MI
  fields are high-cardinality); Portrait ids aren't tone-banded; the `Unique_`
  trailing number isn't a portrait id.
- **`CoachFace` tone-banded namespace / `skinTone` key / browser `Head <N>`
  labels** — all disproven earlier; the namespace is the *player* head space
  per MyFranchise's own `genHeadPortrait.json`.

---

## 4. Road to publish

Ordered by value-to-effort. Nothing here is a mechanism unknown.

| # | Task | Effort | Why it gates publish |
|---|---|---|---|
| ~~P1~~ | ~~Female-coach guard (L2)~~ | ✅ done | Resolved by design — tone-matched head, gender-agnostic. |
| P2 | **Seed the top ~30 `Unique_*` overrides (L1)** | small, manual | Freeman, Day, Sarkisian, Smart, etc. — the coaches people actually move. Turns "plausible guess" into "correct" for the ones that matter. |
| P3 | **Level +1 decision (L3)** | 1 line | Cheap correctness; make it deliberate. |
| P4 | **Confirm §2.1 reconciliation** | 30s in-game | Re-open Giants/Bears/Jets on the setup screen; if all read right, close the "setup screen doesn't resolve" caveat. |
| ~~P5~~ | ~~Repoint stale loadout slot (L5)~~ | ✅ done | Clears (not repoints — no benefit to guessing an equivalent) any Team-side loadout slot left over from the outgoing HeadCoach. See §9.5. |
| ~~P6~~ | ~~Batch dry-run report~~ | ✅ done | The Coach Carousel plan table is exactly this — per-coach team, tone, ⚠ when guessed, displaced incumbent, and a blocked-with-reason row for anything that can't proceed. |
| ~~P7~~ | ~~CharacterVisuals capacity guard~~ | ✅ done | `checkAppearanceHeadroom` in `run.js`, surfaced in the plan summary. See also §8 — the *landing-slot* pool had the same class of gap and is now guarded too. |

**Publish-ready when:** P2–P4 done (P5-P7 are done). All three remaining are
user-side calls — two need an in-game look, one needs judgment about real
people's appearances.

---

## 5. Beyond publish (new capability, not polish)

- ~~Coordinator transfers (L4)~~ — ✅ individual OC/DC moves already work both
  directions, see §10.1. Bundled "bring your coordinators" full-staff moves
  were built and then deliberately rejected (§10.4) — individual coaches only,
  by product decision.
- **Full-league carousel sweep** — both directions now propose *and* commit
  multi-coach batches, but `maxProposalsPerDirection` still caps a run
  (default 5, split per position). A true "run the whole offseason" sweep
  would lift that cap and resolve cascades (a school that loses its HC to the
  NFL becomes an opening itself, which currently isn't fed back in).

---

## 6. How it fits the pipeline

Coach transfer is the coach half of CFB→Madden. The player half is the Power
Curve rating conversion (its own roadmap). Both feed the same goal: take a CFB
dynasty and produce a coherent Madden franchise — players rated, coaches placed,
draft class built. This subsystem is the furthest along and can ship
independently of the rest.

---

## 7. Madden → CFB (the reverse direction) — built 2026-07-24

### 7.1 The gate: can this library write a CFB save at all?

Every write anywhere in this repo, before today, targeted Madden. CFB opens
through a schema override (`data/schemas/CFB27_809_0.gz`, major 809) because
the auto-detected schema is insufficient — whether that override survives a
save-and-reload round trip had never been tested. `research/probe29-cfb-
write-roundtrip.js` settled it: a pure no-op save-and-reload is lossless
(493/493 coaches byte-identical, same file size), and a real field write
(`Level = 5` on a throwaway coach) survives a full write → reload → read-back
cycle. **CFB saves can be written.** Everything below is a build job on top of
that, not a research question.

### 7.2 What existed already vs. what was missing

The design work for this direction turned out to be mostly already done —
`lib/carousel/map/coachFieldMap.js` has a `maddenToCfb` action for all 156
fields, `levelScale.js`/`archetypeMap.js`/`schemeLookup.js`/`enumBridge.js`/
`synthesis.js` were already fully bidirectional. Only the **orchestrator**
(`mapCoachMaddenToCfb`) and the **placement/talent/appearance layers** for a
CFB destination were missing. Built:

| Module | Role | Mirrors (forward direction) |
|---|---|---|
| `map/index.js`'s `mapCoachMaddenToCfb` | Field mapping | `mapCoachCfbToMadden` |
| `placeOnCfbTeam.js` (new) | Mode B placement | `placeOnTeam.js` |
| `cfbTalentTree.js` (new) | Talent granting | `talentTree.js` |
| `appearance.js`'s `grantCfbAppearance` | Face granting | `grantAppearance` |
| `index.js`'s `moveCoachMaddenToCfbTeam` | Orchestration | `moveCoachCfbToMaddenTeam` |
| `run.js`'s `scanMaddenCoaches` / direction-aware `proposeMoves`/`commitMoves` | App entry point | `scanCoaches` / `proposeMoves`/`commitMoves` |

**Real structural differences from the forward direction** (not just
asymmetry for its own sake — each is a verified fact about how CFB's schema
actually behaves):

- **Talent trees don't need row allocation.** Every CFB Coach row — including
  the blank Level-0/TeamIndex-255 filler shells this lands on — already owns
  a fully private, pre-allocated chain (`ActiveTalentTree` → `TalentSubTree-
  StatusList` → 11× `TalentSubTreeStatus`). Granting a tree means copying
  VALUES from a donor into the destination's own already-existing rows, never
  cloning/allocating new ones. Verified live: `Owned`-talent count and
  `CoachPointsSpent` both trend up with Level across a real sample (Level 17
  → 20 owned, Level 48 → up to 86), a real signal, not flat.
- **Appearance needs no CharacterVisuals write.** CFB head names encode tone
  directly (`Generic_<idx>_C_T<tex>_<hair>_<TONE>_<variant>`), reusing
  `cfbSkinTone` unchanged — no portrait-art measurement project was needed.
  Head + Portrait are copied together from a real donor coach's own pair
  (CFB's Portrait-vs-head-index relationship has no clean formula the way
  Madden's `+308` does, so donor-copying sidesteps needing one).
- **`'Signed'` is a valid enum member CFB never actually uses.** Verified
  live: 0 of 493 coaches in the sample save are ever `ContractStatus:
  'Signed'`; every one of 275 real employed coaches reads `'First_Active'`.
  Writing `'Signed'` would have been the exact class of out-of-distribution
  value that caused the original Madden corruption incident, just on the CFB
  side. `planCfbTeamPlacement` writes `'First_Active'`.

### 7.3 Auto-propose — built, using CFB's own job-security field

Initially shipped Manual-only, because `movement.js` scored which Madden
coaches might leave (`nflToCfb`) but paired them to **no destination**. That
gap is now closed: `readCfbJobs` + `scoreCfbJobVulnerability` are the CFB
counterparts to `readNflJobs`/`scoreJobVulnerability`, and `proposeCarousel`
pairs both directions through one shared `pairToOpenings` helper.

**The CFB side is better instrumented than the NFL side for this.** Madden has
no "how hot is this seat" field, so the NFL scorer has to *infer* vulnerability
from a weak incumbent + losing record + expiring contract. CFB gives it
directly: `Coach.CurrentJobSecurityPercentage`, a real 0–100 field populated
for all **414 employed coaches** in the sample save (mean 70, p10 16). So job
security carries the bulk of the weight (0.70), with an expiring contract
(0.15) and a weak incumbent (0.15) as secondary terms, multiplied by school
attractiveness (`TeamPrestige` 0–10, three-quarters of the weight, plus roster
quality as a percentile).

Two data findings shaped this, both verified live and both recorded in the
code so they aren't re-litigated:

- **`CurrentJobSecurityStatus` is a banding of the percentage, not an
  independent signal** — HotSeat 0–49, Low 50–64, SafeForNow 60–78, Safe
  80–100. The raw percentage carries strictly more resolution, so it's the
  primary term; the enum is surfaced only in the human-readable `reasons`
  (it's what the game shows the user). A regression test asserts two coaches
  in the same status band but 49 points apart don't score identically.
- **`CurrentJobSecurityPercentageRank` is NOT usable.** It looks like a
  least-secure-first ordering and isn't — rank 1 in the sample save is a 65%
  "SafeForNow" coach while the max rank is a 100% "Safe" one. Reading it as
  vulnerability would invert the model across much of the pool.

Sanity of the output (live, sample save): the top HC opening is **Nebraska**
(prestige 8, M. Rhule at 16% on the hot seat, 1 year left), and 17 of 138 HC
jobs score above 0.40 — a realistically carousel-sized pool, not everyone and
not nobody. A full auto-proposed 6-coach batch (2 HC, 2 OC, 2 DC) proposed
*and committed* cleanly, e.g. a fired NFL head coach → Nebraska, a fired Rams
DC → the 0%-security Ole Miss DC job.

Both directions now expose Auto and Manual in the app; the Coach Carousel
page's Mode hint changes to describe whichever direction is selected.

One incidental bug fixed while wiring this: `readNflCandidates` never set
`teamName` (its CFB counterpart did), so any consumer formatting
"`<coach> (<teamName>)`" printed `(undefined)` for every NFL candidate. It now
labels the free-agent pool explicitly, since that's where most realistic
NFL→CFB candidates sit.

### 7.4 Verification

Three tiers, matching how the forward direction was verified before it had
in-game confirmation:

- **Round trip** (`probe29`) — the write-capability gate. Pass.
- **Field mapping** (`mapCoachMaddenToCfb` alone) — all 111 real HC/OC/DC in
  the sample Madden save mapped and passed `validateCoachFields` against the
  live CFB schema. 0 failures.
- **Full placement, single coach and batch** (`probe30`) — 5 real Madden
  coaches (2 HC, 2 OC, 1 DC), placed onto 5 real CFB schools, **chained**
  across multiple saved-and-reopened files (each placement builds on the
  previous write, the same posture a real multi-coach carousel run would
  use). All 5: correct destination row, correct reciprocal Team pointer,
  distinct destination rows (no collisions), non-self-donated talent tree,
  granted appearance. Two real bugs were caught and fixed in the process of
  building this verification, not left for later:
  1. **Scheme-crossing could throw and abort the whole coach's move** over
     one unmapped scheme name (`crossSchemeName` was outside the `try`/`catch`
     that was supposed to make this recoverable) — a **latent bug in the
     already-shipped forward direction too**, just never triggered until a
     live Madden "Spread" defensive scheme hit it. Fixed both directions.
  2. **The destination row could become its own talent donor.** `write-
     CoachFields` writes `Name`/`Level` onto the destination BEFORE talent
     granting runs; `pickCfbDonorCoach` re-reads the table live, so without
     excluding the destination's own row, a coach could match itself as the
     "nearest level" donor — a silent no-op that looked like it worked (no
     error) but copied nothing real. Caught because the log showed `0 points
     spent`, which was suspicious against the ~500–1900 range every other
     real donor showed. Fixed by passing `excludeRows`, matching what the
     forward direction already did correctly.

**Not yet done:** an in-game screenshot of a Madden-coach-turned-CFB-coach in
CFB27's own Coach Central-equivalent screen, the way Marcus Freeman's Madden
placement was confirmed visually. The engine-level verification here is
substantially more thorough than what the forward direction had at the
equivalent stage (batch + chained + validated, vs. single-coach dry runs), but
"does it *look* right in the game" is still open the way it briefly was for
the forward direction before that got its own screenshot.

---

## 8. Batch planning — a pre-existing bug, found and fixed 2026-07-24

Found while sanity-checking multi-coach batches after the reverse direction
landed. It affected **both directions equally** and predated the reverse-
direction work entirely.

**The bug.** Every plan in a batch ran against the same unmodified save, so
`findDisposableSlot`/`findDisposableCfbSlot` handed *every* coach the same
best landing row. A 6-coach plan reported `destRow` `[109,109,109,109,109,109]`
(forward) and `[18,18,18,18,18,18]` (reverse).

**What it did and didn't break.** The writes were always correct — the commit
path re-plans against the chained save for each coach, so they really did land
on distinct rows. Two things were wrong:

1. **The preview lied.** A plan's `destRow` was wrong for every coach after
   the first. Not shown in the plan table's columns today, so no user ever saw
   a wrong number, but it was wrong in the returned data.
2. **The real problem: an oversized batch could not be detected at plan time.**
   Because each row planned in isolation, planning happily succeeded even if
   the save had only ONE disposable slot left. The failure surfaced mid-commit
   — *after* earlier coaches had already been written to the output save,
   leaving a partially-written result. This is the same class of gap P7 closed
   for `CharacterVisuals`, just for the landing-slot pool instead.

**The fix.** One mechanism solves both: `excludeRows` (a Set of rows already
claimed by earlier plans in the same batch) threaded from `run.js`'s
`proposeMoves` → `planTeamPlacement`/`planCfbTeamPlacement` →
`findDisposableSlot`/`findDisposableCfbSlot`. Plans now claim as they go, so
destRows are distinct and an oversized batch surfaces as a **blocked row with
a reason at plan time** rather than a partial write. Composes with the
existing single-row `excludeRowIndex` guard rather than replacing it.

**Verification.** Both directions now plan distinct rows, and — the check that
matters — the reverse direction's planned rows `[18,47,124,129,485,…]` are
*exactly* the rows probe30's real commit independently produced. The preview
now matches the write. 7 new fixture assertions in `carouselPlaceOnTeam.spec.js`
cover the preference order, the claim behavior, composition with
`excludeRowIndex`, and the guarantee that a fully exhausted pool **throws**
rather than overwriting an established coach (the H. Flohr incident's rule).

---

## 9. In-game verification of Madden → CFB (2026-07-25)

`DYNASTY-COACHTEST`, built from `DYNASTY-DATATESTYEAR1-TEST` (base save never
modified — verified byte-size and its own Florida/Kentucky/Clemson coaches
unchanged after every run). Three coaches chosen for **maximum tone spread**,
so a human eye could settle tone matching in one look. Verified on CFB 27's
**"Choose Coach" screen** — recorded here as CFB's equivalent of Madden's
Coach Central, i.e. the surface that actually resolves coach data.

The timing gate was **not** overridden: that save sits in CFB's real carousel
window, so this was also the first HC placement made through a legitimately
open CFB window rather than a bypass (§9.1).

### 9.1 What passed first time

| School | Coach | Source tone | Result |
|---|---|---|---|
| Florida | T. Peters | 8 (darkest) | ✅ renders clearly dark |
| Kentucky | D. Menard | 6 (mid) | ✅ renders medium |
| Clemson | E. Ortega | 1 (lightest) | ✅ renders clearly light |

A clean, unambiguous light-to-dark gradient. Peters is the strongest single
data point: he is the same coach independently confirmed "clearly dark" on the
**Madden** side during the head-catalog work, so his face is an apples-to-apples
match across both games. Faces render (no silhouettes), levels are correct, and
schemes crossed sensibly and with variety (Pro Style/3-4, Spread/4-3, Air
Raid/Multiple).

**Also settled: CFB has NO level display offset.** Written 24/26/28, displayed
24/26/28. Madden's +1 (L3/P3) is Madden-only, so that decision only ever
applied to the forward direction.

### 9.2 Defect found: head coaches were given a coordinator-only archetype

All three cards read "Tactician" — a string that appears **nowhere in the CFB
schema**, so it is a display label resolved outside the save (the same pattern
as Madden's archetype names). Chasing it exposed the real bug underneath.

`DominantArchetype` is strongly **position-partitioned** in CFB's own data:

|  | HC | OC | DC |
|---|---|---|---|
| ProgramBuilder | 22 | 0 | 0 |
| CEO | 4 | 0 | 0 |
| **Schemer** | **0** | 11 | 17 |
| **Recruiter** | **0** | 13 | 23 |
| **Motivator** | **0** | 13 | 20 |

`mapArchetypeMaddenToCfb` was position-blind, so every arriving NFL head coach
below CFB's P70 level received `Schemer` — an archetype **zero of ~140 real CFB
head coaches have**. It rendered fine, but writing a value outside the
destination game's own distribution *for that position* is precisely the class
of mistake that produced the original Madden corruption incident (R4/R12), so
it was fixed rather than left as "works anyway".

Now position-aware: head coaches get `Strategist` (31 real HCs use it) where
coordinators still correctly get `Schemer`; `PersonnelCzar→CEO` is HC-only,
with coordinators routed to an in-distribution equivalent; the unrecognized-
archetype fallback and the opt-in variety roll are both split the same way, so
a head coach can never draw `Motivator`. 5 new assertions pin both families.

**Confirmed in-game:** Peters now reads "Strategist", and so does **D. Aranda
at Baylor** — a real, untouched CFB coach who was already `Strategist`. Same
label on both is the control that proves the mapping now lands on a genuine
head-coach archetype.

### 9.3 Defect found: every arrival looked identical

Side-by-side with a real coach, two fields gave the transfer away:

- **Prestige.** Every arrival drew a flat P70, so all three read **B+** while
  Aranda beside them read **C+**. `synthesizeCoachPrestige` now spreads the
  draw around that centre by the coach's own `levelPercentile` (±half the
  centre, so the *average* arrival still lands on the locked P70 decision).
  Now C / B− / B− across the three, scaling with quality.
- **Recruiting pipeline.** All three showed `Alabama`; Aranda showed
  `Southern California`. `PrimaryPipeline` (roadmap Q6) had never been
  written, so they were displaying the destination row's unset default.

Pipeline is **per-coach, not per-school** — verified: Alabama's own three
coaches hold MetroAtlanta / SouthernCalifornia / Missouri — so there is no
"school's pipeline" to look up. It now **inherits the displaced incumbent's**
territory (falling back to a staff peer, else left unset): a program keeps
recruiting where it recruits, and it is entirely live-derived, with no
hardcoded geography table.

**The proof it works is Kentucky.** W. Stein held `Kentucky`; D. Menard
inherited `Kentucky` — which is *not* the empty-row default. Florida and
Clemson legitimately had `Alabama` (Sumrall and Swinney really do recruit that
footprint), which happens to collide with the default — exactly why the bug was
invisible at those two schools and obvious at the third.

### 9.4 Deliberately still unwritten

`AlmaMater` (roadmap Q4). An NFL coach genuinely has no CFB alma mater, and it
is not shown on the coach card. Only 4 of 414 real employed coaches sit at 0,
so it is near-unused but demonstrably not invalid. Setting it to the
destination school would be plausible and might even help alumni logic
(`Team.DesiresAlumni`) — but it would be inventing a biographical fact, so it
stays unset pending evidence that blank actually harms recruiting. Tracked as
L8.

### 9.5 P5 — stale team loadout slot, fixed 2026-07-25

L5's finding (from the original CAREER-HEADTEST placement): the Giants'
`GamedayLoadout` slot4 still pointed at the previous coach's own talent row.
Investigated the actual mechanism (`research/probe33-loadout-diag.js`,
read-only): `Team.GamedayLoadout` / `PlaysheetLoadout` / `WearAndTearLoadout`
each point at a `TalentLoadoutSlot[]` array (table 5604) of `TalentLoadoutSlot`
rows (table 4119, schema: `IsLocked`, `IsUserLocked`, `Talent`). `Talent` is a
reference into whichever coach personally equipped that ability — and every
Talent row is private to one coach (no sharing, same rule `talentTree.js`
already documents), so once the HeadCoach changes, any slot still holding a
`Talent` reference is holding the outgoing coach's data specifically.

Neither real save on disk had a populated slot to observe live (both Giants
loadouts read empty in the current save state), so the fix was proven by
synthesizing the exact failure — seeding a real `Talent` reference onto a
throwaway copy's Giants `GamedayLoadout` slot 0, running the actual
Freeman → Giants commit path through it, and confirming the reference reads
back null after a real save/reload round-trip
(`research/probe34-loadout-clear-verify.js`, all checks pass).

**Fix:** `clearStaleTeamLoadouts` (`lib/carousel/placeOnTeam.js`) walks all
three loadout categories on the destination team and clears (writes the
all-zero null reference to) any slot's `Talent` field. Clearing, not
repointing, per the roadmap's own "or clear" option — a freshly-hired coach
has never equipped anything, matching a real new hire's state, and repointing
would mean inventing which of the new coach's abilities corresponds to a slot
they've never touched. Wired into `moveCoachCfbToMaddenTeam`
(`lib/carousel/index.js`), gated on `plan.position === 'HeadCoach'` since only
a HeadCoach's tree populates these slots (OC/DC hires leave them untouched).
CFB has no equivalent structure (`Team.CoachTalentEffects` is a different,
non-slotted field), so this is Madden-only, matching L5's own scope. Full test
suite (769 assertions) and probe28's live-save integration check both still
pass.

---

## 10. Coordinators & full-staff transfers — 2026-07-25

Started as a research-only pass (probes 35–39) answering "how would we do
coordinators?" — headline finding: **most of it was already done**, L4 was
wrong. Closed out same-day with the two real gaps it surfaced: L9 (§10.3,
fixed) and "bring your coordinators" (§10.4, built).

### 10.1 Individual coordinator moves already work — both directions

`probe37-coordinator-viability.js` ran a real OC and a real DC through the
public `proposeMoves`/`commitMoves` path against live saves. All checks pass:

| | CFB → Madden | Madden → CFB |
|---|---|---|
| coach | G. Altman (OC) → 49ers | C. Kelly (DC) → Alabama |
| committed | ✅ | ✅ |
| position preserved | ✅ | ✅ |
| incumbent displaced | ✅ K. McPherron | ✅ K. Wommack |
| reciprocal `Team.<slot>` pointer | ✅ | ✅ |
| face granted | ✅ | ✅ |
| timing gate | correctly **not** applied (HC-only) | correctly not applied |

Nothing was HC-only: `scanCoaches`, `movement.js` (`HC_OC_DC`), `levelScale`,
`archetypeMap` (already position-aware since §9.2), `place`/`placeOnCfbTeam`,
and the renderer all iterate all three positions. The only HC-specific branch
in the whole engine is the §9.5 loadout clear, which is *correctly* HC-gated.

### 10.2 What a "staff" actually is in the data

- **A staff is a query, not an object.** Neither game has any field linking a
  coordinator to their head coach — no staff id, no `HiredBy`, no mentor
  pointer. The *only* association is a shared `TeamIndex`. So "move the staff"
  means "move the N coaches sharing this TeamIndex", not "move a staff record".
- **A staff is exactly 3 people: HC + OC + DC.** Two apparent extra slots are
  both dead ends, verified in `probe36-staff-slot-reality.js`:
  - CFB `Team.SpecialTeamsCoach` — all **143 schools point at the same row**
    (`4173:375`, blank name, `Position=NumCollegeCoaches`, `TeamIndex=255`,
    `Level=0`). A shared placeholder, not a job. (Contrast: HC/OC/DC each have
    143 *distinct* targets.) Madden's `SpecialTeamsCoach` is the same pattern
    (1 distinct target, 0 into the Coach table).
  - `HeadTrainer` (both games) points at a **separate `Trainer` table**, not
    the Coach table — different schema (CFB's trainer has no visuals fields at
    all), and **both tables are at capacity** (Madden 101/101, CFB 17/17).
    A different entity type; explicitly out of scope for coach transfer.
- **Staffs do NOT share a scheme.** Worth recording because it is the opposite
  of what a truncated first look suggested: staff agree on `OffensiveScheme` on
  only **5/28** Madden teams and **26/143** CFB teams (schemes vary league-wide
  — 10 distinct offensive, 9 defensive). So a coordinator carrying their own
  scheme into a new staff is *normal*, matching how both games ship. There is
  no scheme-coherence constraint to enforce.

### 10.3 Capacity — the real constraint, and it is asymmetric

| | Madden | CFB |
|---|---|---|
| landing slots (`findDisposable*Slot`) | 358 (16 nobodies + 342 empty rows) | **64** (nobodies only) |
| talent-row ceiling | ~185 coaches (limited by `Talent[]` 5603: 555 free ÷ 3 per coach) | none — grants copy values into pre-allocated chains |
| **effective ceiling** | **~185 coaches ≈ 61 staffs** | **64 coaches ≈ 21 staffs** |
| source teams with a complete staff | 26/35 | 143/143 |

Measured per-coach talent cost (`probe38`): 129–213 rows across 6 tables,
consistently **3 rows of `Talent[]`** — that table is always the binding one.

**L9, a latent gap this surfaced:** CFB's 135 empty Coach rows have *no*
pre-wired `ActiveTalentTree`, but `findDisposableCfbSlot`'s tier-3 fallback
returns them anyway. `grantCfbTalentTree` handles it gracefully (returns a
`skipped` report rather than throwing) — but the coach lands with **no talent
tree**, which per `talentTree.js`'s founding finding is exactly the "Level 1 /
no abilities" failure. Unreachable today (64 tier-2 slots vs. a 5-proposal
cap), but a full-staff feature spends slots 3 at a time. Fix is small: make
tier 3 require a usable chain and fail loudly instead, so the ceiling is
honest.

### 10.4 "Bring your coordinators" — built, then reverted 2026-07-25

Built exactly as designed (`readStaff`/`expandStaffGroups`/`blockStaffGroups`
in `lib/carousel/run.js`, a `bringStaff` manual-mode flag, `staffGroup`/
`staffRole` plan fields) and verified end-to-end both directions against real
saves. **Product decision: reverted the same day.** Individual coaches only —
every move (HC, OC, or DC) is proposed and committed on its own, never
auto-bundled with anyone else's job. If a user wants a coordinator to follow
their old boss, they select that move themselves, same as any other move.

No residue: the plan-row shape, `run.js`, and both test suites are back to
their pre-§10.4 state. §10.1–10.3's findings (coordinators individually
already worked; there's no engine-level staff object; L9's capacity fix)
stand unaffected — only the auto-bundling convenience layer was removed.

---

## 11. Donor-selection gap in the talent tree — found and fixed 2026-07-26

Ran a health check against `CAREER-HEADTEST` (the long-lived Madden save from
the original probe27/33/36 work) to sanity-check the three coaches placed
there (S. Archer→Jets, D. Aranda→Bears, M. Anthony→Giants). 25 of 26 checks
passed — pointers, positions, contracts, appearances all correct. One check
failed: Archer's `WearAndTearTalents` tree is empty.

**Investigating the failure found something bigger than the failure itself.**
Checked the CURRENT real Madden save (`CAREER-JUL06-...`) for how common this
actually is:

| category | populated / 111 real coaches |
|---|---|
| `GamedayTalents` | 111/111 (100%) |
| `PlaysheetTalents` | 104/111 (94%) |
| `WearAndTearTalents` | **0/111 (0%)** |

**`WearAndTearTalents` at 0/111 is not a bug — it's universal.** No coach
anywhere in the league has one, so a transferred coach having none too is
the correct, in-distribution outcome (same reasoning already applied to
CFB's near-zero `ContractSalary`). `cloneTalentCategory` already leaves an
unclonable category alone rather than fabricating one, so this needed no
code change — just documenting that it's intentional, not a defect.

**`PlaysheetTalents` at 94% is the real, live, still-reachable gap.**
`pickDonorCoach` (`lib/carousel/talentTree.js`) only ever checked that a
candidate had a `GamedayTalents` reference before selecting them as a donor
— never `PlaysheetTalents`. 7 real coaches (all low-level assistants: H.
Flohr, D. Douglas, J. Hiller, B. Perkins, K. Leisman, M. Charron, P. Troyer
— H. Flohr is, fittingly, the exact coach `findDisposableSlot`'s own
"never overwrite an established coach" guard is named after) have Gameday
but no Playsheet tree. Any of them being picked as the nearest-level donor
silently produced an incomplete tree — precisely what happened to Archer
for WearAndTear, just reachable here for a much more commonly-populated
category.

**Fixed:** added `hasPopulatedTalentCategory(maddenFile, coachRecord,
category)` — checks not just that a reference exists but that it resolves
to a real, non-empty, `arraySize > 0` row (a reference CAN exist yet point
at an unallocated row, which a bare truthiness check on the reference alone
would miss). `pickDonorCoach` now requires this for both `GamedayTalents`
and `PlaysheetTalents`. `WearAndTearTalents` is deliberately NOT required —
doing so would mean no donor ever qualifies, since it's genuinely populated
for zero coaches league-wide.

**Verified live** (`research/probe41-headtest-diagnostics.js` for the
original health check, `research/probe42-donor-filter-verify.js` for the
fix): targeting each of the 7 gap coaches' own exact level — the scenario
that would previously guarantee picking them as a distance-0 match — now
always resolves to a different donor with a real Playsheet tree. A real
CFB→Madden transfer at a gap-adjacent level (an OC to the Falcons) committed
with both `GamedayTalents` and `PlaysheetTalents` actually cloned, confirmed
by re-opening the written save. Full test suite (767 assertions) unaffected
— no existing fixture exercised `pickDonorCoach` directly.

---

## 12. Closing the fixture-coverage gap — 2026-07-26

§11's fix landed with zero permanent regression protection — only the
one-off `probe42` script, which isn't part of `npm test`. Auditing coverage
across every `lib/carousel/*.js` module found the engine's core talent-tree
logic had **never** had a fixture test, on either side of the game boundary:
every claim about it (including "263/493 tone names parse exact, zero false
positives," and everything in §11) had only ever been verified once, live,
against a real save. A regression in any of it would go undetected until
someone happened to notice wrong faces or missing abilities in-game again.

**Five new fixture-only spec files, no real save needed for any of them:**

| file | covers | assertions |
|---|---|---|
| `test/talentTree.spec.js` | `hasPopulatedTalentCategory`, `pickDonorCoach` (the exact §11 fix), `cloneTalentRow`/`cloneTalentCategory` (the deep-clone chain: scalars, static-asset refs, Tiers deep-clone with genuinely distinct rows, the "unrecognized in-save reference throws rather than shares state" guard), `unlockIndexForLevel`, `grantTalentTree` end-to-end | 37 |
| `test/cfbTalentTree.spec.js` | `readOwnTalentChain` (missing ref/row/list at every link), `pickCfbDonorCoach` (nearest-level, no archetype pass — verified irrelevant for CFB), `grantCfbTalentTree` (asymmetric donor/dest slot pairing, the loud donor-chain throw vs. the soft dest-chain skip) | 22 |
| `test/clearStaleTeamLoadouts.spec.js` | The L5 fix (§9.5) — missing refs at every link, the null-bitstring vs. real-reference distinction, all three loadout categories processed independently, idempotence on an already-clear slot | 10 |
| `test/cfbSkinTone.spec.js` | The name-parsing regex across every documented real pattern and all 8 tone digits, `Unique_*` correctly null, override precedence (using the same safe temp-write-and-restore pattern `research/probe26` established, confirmed the real `data/cfbCoachTones.json` is byte-identical after the run) | 21 |
| `test/validate.spec.js` | Every branch of `validateCoachFields` — enum/bool/string/int/float/reference, the offset-encoding correction (the exact real incident this file exists to prevent: a value that looks "below the declared minimum" but is actually valid raw), truncated enum-member listing, `undefined`-always-skipped, multi-field `formatProblems` | 47 |

**Total: 137 new assertions, all fixture-based (no `research/` probe needed
to run them), wired into `npm test`.** Full suite: 904 assertions across 23
spec files, all green. Nothing in `write.js`/`index.js`'s full-orchestration
functions was added here — that split is intentional, not an oversight (see
`carouselRun.spec.js`'s own header): those genuinely need a real save and
stay validated under `research/`.

---

## 13. User-reported bug: "could not read a donor CharacterVisuals blob (row 0)" — fixed 2026-07-26

**Report:** a user transferring K. Gauthier (Oregon → Titans, HeadCoach, L46,
tone 7) got `grantAppearance: could not read a donor CharacterVisuals blob
(row 0)` on Write Save. They supplied their CFB dynasty (`DYNASTY-OREGON`).

**The CFB side was blameless.** Gauthier is an ordinary `Generic_*` coach
(`Generic_0160_C_T0159_M_7_4`) whose tone reads exactly as 7 — no override
needed, nothing unusual. Re-running their exact move against our own Madden
save succeeds. The fault was entirely in how we pick the *donor* on the
Madden side.

**Root cause.** A catalog-only head (one no in-save coach currently wears —
~117 of the 200) has no `CharacterVisuals` row of its own, so it borrows one
purely for its apparel shape. The old code borrowed
`catalog.entries[0].visualsRow` **unconditionally, with no validation**:

```js
const donorRow = chosen.visualsRow !== null ? chosen.visualsRow : catalog.entries[0].visualsRow;
```

In our sample save `catalog.entries[0].visualsRow` is *literally row 0*, and
row 0 happens to be readable — so this never failed here, in any probe, ever.
In the user's save row 0 is not readable. Because that single row was the
fallback for every catalog-only head, **one bad row broke every appearance
grant in that save, for every coach** — not just Gauthier.

**Fix:** `findUsableVisualsDonor(maddenFile, visualsTableId, candidateRows)`
tries candidates in preference order — the chosen head's own row first, then
every other catalog entry — and returns the first whose blob actually parses.
Any readable coach donor is equally valid (the blob contributes only apparel;
`withHead()` swaps the head and `skinTone` is overwritten), so falling
through costs nothing and cannot pick a wrong face. The failure message now
reports how many rows were tried and points at `config.skipAppearance`.

**A safety property this surfaced, now pinned by both a comment and a test:**
the candidate list is restricted to rows a real **coach** points at, and must
stay that way. `CharacterVisuals` is *shared with players*, and players
outnumber coaches ~24:1 in it (verified: 3052 player-referenced rows vs 126
coach-referenced, of 3248 filled). A tempting "just scan the table for any
readable blob" fallback would almost always land on a player's uniform/pads
loadout and dress a head coach as an athlete.

**Coverage:** `test/carouselAppearance.spec.js` (43 assertions) consolidates
this module's tests — `cfbSkinTone` name parsing + override precedence, plus
`findUsableVisualsDonor` (skips empty rows, skips unparseable JSON, dedupes,
ignores null candidates, reports what it tried) and a `grantAppearance`
end-to-end case built to mirror the user's save exactly: several coaches, the
first pointing at an unreadable row 0. That last test **failed against an
earlier draft of the fix** and forced the coach-scoped-donor decision above,
rather than the broader table scan that would have shipped a subtler bug.
`grantCfbAppearance` is unaffected — CFB coach heads carry no visuals blob.
