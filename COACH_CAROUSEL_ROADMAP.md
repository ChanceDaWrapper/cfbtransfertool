# Cross-Game Coaching Carousel — Research & Roadmap

**Status: blueprint. No engine code exists yet and none was written for this document.**

A two-way carousel moving coaches between an EA College Football 27 dynasty save
and a Madden NFL 26 franchise save, as a sibling engine to the existing
CFB→Madden player-transfer pipeline.

- **Phase A** CFB27 → NFL (a college coach takes an NFL job)
- **Phase B** NFL → CFB27 (a fired/available NFL coach returns to college, HC or coordinator)
- **Phase D** (designed for, not built here) retired Madden players become coaches in either league

Supporting research: [`research/FINDINGS.md`](research/FINDINGS.md). Probes:
`research/probe01..08`, output in `research/out/`. Everything below marked
"verified" was read out of the two sample saves by those probes; everything else
is labelled as an assumption or an open question.

> **Read `research/FINDINGS.md` §1 first.** Eight of the briefing document's
> stated facts turned out to be wrong in ways that change design decisions —
> most importantly that schemes are *reference pointers into tables absent from
> the save*, that `ContractStatus` and `CoachBackstory` have **numeric value
> drift** between the games, and that Madden's `Archetype` enum has 8 members,
> not 3.

---

## 1. Data model & architecture

### 1.1 Where the engine sits

The existing app is an Electron desktop tool ("Pipeline"), plain CommonJS Node,
no build step, `madden-franchise@4.3.0` vendored at
[`vendor/madden-franchise-4.3.0.tgz`](vendor/). Current structure:

```
main.js                     Electron main; ALL ipcMain handlers; owns cachedPool/lastGenerated
preload.js                  contextBridge surface
renderer/                   index.html, renderer.js, style.css  (the whole UI)
lib/
  pipeline.js       (1847)  save I/O + the legacy CFB→Madden player path, end to end
  defaults.js        (493)  DEFAULT_CONFIG, descriptions, position/rating metadata
  configStore.js      (35)  persisted user config under app.getPath('userData')
  draftClassFile.js  (756)  CAREERDRAFT-* binary writer
  draftClassExporter.js     builds a draft-class file from a generated class
  appearanceCatalog.js      skin-coherent (portrait, head) assignment from baked EA pairs
  collegeIndex.js           college lookup
  rosetta/                  the "replace the legacy engine" subsystem
    index.js                front door — one door per lifecycle stage, no run-everything entry
    context.js              RosettaContext: services + environment ONLY, never population data
    lifecycle.js            STAGES = selection → hydrated → translated → draft → export; tagStage()
    identity/index.js       canonicalId(record) = row index; deriveSeedString()
    rng.js                  seeded mulberry32
    attributeTaxonomy.js
    population.js           the Season Exit Population selection stage
    translation/            Translator strategies (powercurve | v1 | rosetta), createTranslator()
    calibration/            CalibrationModel + narrow provider views + builder
data/  schema/  tools/  test/
```

**The carousel is a third Rosetta-style subsystem, not a fork of `pipeline.js`.**
Concretely:

```
lib/
  carousel/                 <-- NEW sibling engine
    index.js                front door, one function per stage (see 1.4)
    context.js              CarouselContext (services/environment only, mirrors rosetta/context.js)
    lifecycle.js            STAGES = pool → selection → mapped → staged → written
    person.js               the Person identity core (1.2)
    map/                    the cross-game map layer (1.3)
      coachFieldMap.js      the 156-row table from §2, as data
      enumBridge.js         name-based enum crossing (the ONLY legal way)
      schemeLookup.js       derived scheme pointer↔name map (§3.3)
      archetypeMap.js       (§3.2)
      levelScale.js         (§3.1)
      synthesis.js          (§3.4)
  saveIO.js                 <-- EXTRACTED shared core (see below)
```

**Shared save-I/O core.** `openCfbSave()` already exists at
[`lib/pipeline.js:1799`](lib/pipeline.js) and is already exported for reuse —
its own header comment says it was factored out precisely "so Rosetta's
calibration builder can open an independent connection to the same save without
duplicating the schema-override constants." The carousel needs the same thing
plus a Madden opener, which today is inlined in `writeCareerFile`
([`lib/pipeline.js:1442`](lib/pipeline.js)).

*Proposed, Phase 0:* extract `lib/saveIO.js` holding `openCfbSave()`,
`openMaddenSave()`, `defaultCfbSavesDir()`, `defaultMaddenSavesDir()`, the
schema-override constants, `safe(record, key)`, and a `biggestTableByName(file,
name)` helper (both games have **two** `Coach` tables and two `Team` tables —
`pipeline.js:buildTeamNames` already does the largest-capacity dance for `Team`
and the carousel needs it for `Coach` too). `pipeline.js` then requires those
back, so there is exactly one place that knows how to open a save. This is a
pure move — no behavioural change — and it is the only edit the carousel needs
to make to existing code.

**Registration.** The carousel gets its own `ipcMain` handlers in `main.js`
(`carousel-load-saves`, `carousel-list-coaches`, `carousel-preview-move`,
`carousel-commit`) and its own tab in `renderer/index.html`, following the
existing `extract-pool` / `generate-class` / `write-career` pattern. It does not
touch the player pipeline's handlers or its cached state.

**Rosetta conventions the carousel inherits** (from
[`lib/rosetta/context.js`](lib/rosetta/context.js) and
[`lifecycle.js`](lib/rosetta/lifecycle.js), both of which document their reasoning):

1. Context carries *services and environment only* — never in-flight population data.
2. Data moves as an explicit chain of tagged plain arrays, `f(prevStage, context) → nextStage`.
3. No sideways dependencies between sibling modules; shared leaves (`rng`, `identity`, `lifecycle`) are required directly.
4. One front door per stage, never a single run-everything entry point.
5. `lib/carousel/` must never `require('../pipeline')` — inject concrete functions instead, exactly as `translation/index.js` injects `legacyCalibratePlayers`.

### 1.2 The Person identity core

**The games already have this type, and it is called `Person`.** Verified from
the schema base chains (FINDINGS §2):

```
Coach → CoachingStaffPerson          (both games)
Scout/Trainer/GM → StaffPerson → Person   (CFB)
Player → FootballPlayer              (both games)
```

`Coach` and `Player` share a real, non-invented field core in each game — 22
fields in CFB, 21 in Madden, **19 in the intersection**:

```
IsUserControlled  Age            FirstName      IsCreated     IsLegend
LastName          PresentationId PrevTeamIndex  TeamIndex     Position
CharacterBodyType CharacterVisuals ExperiencePoints  GenericHeadAssetName
Height            LegacyScore    Personality    Weight        YearlyAwardCount
```

`lib/carousel/person.js` models exactly this and nothing more:

```
Person {
  identity:   { sourceGame, sourceTable, sourceRow, firstName, lastName, name, assetName }
  bio:        { age, height, weight, bodyType, personality }
  appearance: { genericHeadAssetName, characterVisuals, portrait, portraitLibraryPath }
  career:     { experiencePoints, legacyScore, yearlyAwardCount, yearsActive }
  assignment: { teamIndex, prevTeamIndex, position }
}
```

Then two role facets layer on top:

- `CoachFacet` — level, archetype, specialty, schemes, tendencies, contract, the career ledger
- `PlayerFacet` (Phase D) — ratings, dev trait, college, draft data

**Why this makes Phase D drop in cleanly.** `Coach.COACH_WASPLAYER` exists in
both games, and in CFB **483 of 497 coaches (97%) are flagged as former players**
(Madden: 4 of 127). CFB's data model already assumes a coach *is* a retired
player. So "retired Madden player → coach" is not a new concept to bolt on; it is
`Person + PlayerFacet` → `Person + CoachFacet`, reusing the identical Person
core, with `COACH_WASPLAYER = true` and the head/portrait carried straight
through. The `identity/` module's rule — **row index is the only stable
identity** ([`lib/rosetta/identity/index.js`](lib/rosetta/identity/index.js);
`PresentationId` recycles, asset names aren't stable) — applies unchanged to
coaches, and is what a carousel needs to track a coach across a multi-year move.

### 1.3 The cross-game map layer

A single layer, shared with the player pipeline where the concepts overlap:

```
map/
  enumBridge.js      crossEnum(value, fromSchema, toSchema, fieldName, {fallback})
  coachFieldMap.js   { field: { presence, action, cfbNote, madNote } }  -- §2 as data
  schemeLookup.js    pointer ↔ BaseScheme name, DERIVED at runtime (§3.3)
  archetypeMap.js    §3.2
  levelScale.js      §3.1
  synthesis.js       §3.4
```

`enumBridge.crossEnum` is the load-bearing piece and the single rule the whole
engine hangs on:

> **Cross every enum by member NAME via `getMemberByName`, never by numeric
> value.** Verified: `ContractStatus` has `FreeAgent`=7 in CFB and =1 in Madden;
> `Retired` 8/2; `Expiring` 1/4. A raw integer copy silently writes a *different,
> valid* contract state. `CoachBackstory` drifts the same way.

Two useful shared assets already exist and should be reused rather than
re-derived: `lib/collegeIndex.js` + `data/college_lookup.json` (school identity —
relevant to `AlmaMater`, which turns out to be a CFB `TeamIndex`), and
`lib/appearanceCatalog.js` (the "bake EA's own shipped asset pairs, don't guess"
pattern, which §3.5 reuses wholesale for coach heads).

### 1.4 Stage chain

```
pool       CoachPool[]    every non-empty Coach row in the source save, as Person+CoachFacet
selection  Selection[]    the coaches the user chose to move (UI-driven, not automatic)
mapped     Mapped[]       target-game field values: copied, looked up, synthesized
staged     Staged[]       + a resolved destination (target Coach row, TeamIndex, job slot)
written    WriteReport    what changed, per record — a dry-run report, then a commit
```

Each stage is a tagged plain array, per `lifecycle.js`. Crucially `staged →
written` is separable, so the whole engine can run **dry** and print a full diff
before anything touches a file.

---

## 2. Complete field-mapping table

All 156 fields: **102 shared + 35 CFB-only + 19 Madden-only**. Verified against
both live schemas by `probe01`; populations by `probe03`.

**Action key** — `COPY` verbatim · `NAME` cross by enum member name · `LOOKUP`
through a derived table · `SYNTH` compute a target value · `DROP` do not write
(leave the target's default/existing) · `ZERO` write 0/false · `RESOLVE` re-point
a reference at the target save's own object.

### 2.1 Person core & identity (shared)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `FirstName` | string | COPY | COPY | |
| `LastName` | string | COPY | COPY | |
| `Name` | string(18) | COPY | COPY | display name, e.g. `G. Altman` |
| `AssetName` | string(41) | DROP | DROP | source-game asset key; meaningless across games |
| `Age` | int[0..127] | COPY | COPY | CFB p50 47, MAD p50 47 — same distribution |
| `Height` | int[0..255] | COPY | COPY | both p50 72 |
| `Weight` | int[150..512] | COPY | **DROP** | offset-encoded (+160). Madden writes **10 for all 127 coaches** — no real data to carry back |
| `CharacterBodyType` | enum | COPY | COPY | enum byte-identical, verified |
| `Personality` | enum | COPY | COPY | identical enum; near-constant `Unpredictable` both sides |
| `PresentationId` | int | **DROP** | DROP | CFB `[0..1023]`, MAD `[0..65535]`; commentary id, game-specific |
| `SpeechId` | int[0..31] | DROP | DROP | game-specific VO bank |
| `IsCreated` | bool | ZERO | ZERO | |
| `IsLegend` | bool | ZERO | ZERO | false for all 624 coaches in both saves |
| `IsUserControlled` | bool | ZERO | ZERO | never transfer user control |
| `Probation` | bool | ZERO | ZERO | false everywhere |
| `COACH_WASPLAYER` | bool | COPY | COPY | **the Phase D hook.** CFB 483/497 true, MAD 4/127 |

### 2.2 Job assignment (shared)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `Position` | enum (**types differ**) | NAME | NAME | CFB `CoachPosition` vs MAD `StaffPosition`. HC/OC/DC = 0/1/2 in both. CFB's `NumCollegeCoaches=3` **collides with `SpecialTeams=3`** — reject anything not HC/OC/DC |
| `TeamIndex` | int | RESOLVE | RESOLVE | CFB `[0..255]`, **255 = unassigned**; MAD `[0..32]`, **32 = FA pool**. Must be a target-save team index, plus the reciprocal `Team.HeadCoach/OC/DC` reference |
| `PrevTeamIndex` | int | SYNTH | SYNTH | set to the destination-game "unassigned" sentinel; the source index is meaningless |
| `SeasonsWithTeam` | int[0..127] | ZERO | ZERO | new hire |
| `COACH_LASTCONTRACTTEAM` | int[0..1023] | ZERO | ZERO | source team id |
| `COACH_LASTTEAMFIRED` | int[0..1023] | ZERO | ZERO | MAD uses 1023 as "none" — write the destination's own sentinel |
| `COACH_LASTTEAMRESIGNED` | int[0..1023] | ZERO | ZERO | same |
| `COACH_FIREREPORTED` | bool | ZERO | ZERO | |
| `COACH_RESIGNREPORTED` | bool | ZERO | ZERO | |
| `COACH_CONSECTEAMCONTRACTS` | int[0..31] | ZERO | ZERO | zero in both saves |
| `PrevPosition` | enum | *(CFB-only)* | SYNTH | set from the Madden coach's `OriginalPosition` |

### 2.3 Contract (shared)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `ContractStatus` | enum (**value drift**) | NAME | NAME | **must** be name-mapped. CFB `First_Active`(0)→MAD `Signed`(0); CFB `FreeAgent`(7)→MAD `FreeAgent`(1). CFB-only members incl. `PendingNFL`, `PendingHire` have no Madden equivalent → map to `Signed`/`FreeAgent` |
| `ContractLength` | int[0..7] | COPY | COPY | CFB p50 3, MAD p50 3 |
| `ContractYearsRemaining` | int[0..31] | COPY | COPY | clamp ≤ `ContractLength` |
| `ContractSalary` | int[0..16383] | **SYNTH** | DROP | CFB 496/497 = 0 (no salary model). Derive from target-game peers by Level — see §3.4 |

### 2.4 Quality, archetype, specialty

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `Level` | int CFB`[0..100]` MAD`[1..50]` | **LOOKUP** | **LOOKUP** | §3.1. Position-conditioned percentile map |
| `ExperiencePoints` | int[0..1000000] | SYNTH | SYNTH | must be re-derived from the mapped `Level`, or the game's own level-up curve will disagree with the Level written. Same range both games |
| `COACH_SPECIALTY` | enum | COPY | COPY | **byte-identical enum, verified** — safe passthrough |
| `SpecialtyType` | enum Off/Def/Any | *(CFB-only)* | SYNTH | derive from `COACH_SPECIALTY`: QB/RB/WR/OL→`Offense`, DL/LB/DB→`Defense`, ST→`Any` |
| `Archetype` | enum (8) | *(MAD-only)* | SYNTH | §3.2 |
| `DominantArchetype` | enum (13) | *(CFB-only)* | SYNTH | §3.2 |
| `CoachBackstory` | enum (**value drift + CFB-only members**) | **SYNTH** | NAME | CFB is 496/497 `Motivator` — no signal to carry. Synthesize from archetype (§3.4). Madden→CFB: `Strategist`→`HCSchemer`/`OCSchemer`/`DCSchemer` by position |
| `COACH_RATING` | int CFB`[0..127]` MAD`[0..100]` | **Q2** | ZERO | CFB all-zero. Madden default is **50**, p50 = 50 — see Q2 |
| `COACH_QB` `COACH_RB` `COACH_WR` `COACH_OL` `COACH_DL` `COACH_LB` `COACH_DB` `COACH_S` `COACH_K` `COACH_P` | int[0..127] ×10 | **Q2** | ZERO | all zero in CFB. Madden p50: QB 65, RB 55, WR 60, OL 55, DL 55, LB 55, DB 55, K 50, P 50 (`COACH_S` unpopulated in both) |
| `COACH_OFFENSE` `COACH_DEFENSE` | int[0..127] | **Q2** | ZERO | ditto |
| `COACH_DEFENSETYPE` | int[0..127] | DROP | DROP | unpopulated |
| `COACH_PERFORMANCELEVEL` | int[0..255] | ZERO | ZERO | 126/127 zero in Madden |
| `COACH_RETIREYRSLEFT` | int[0..7] | ZERO | ZERO | zero in both |

### 2.5 Tendencies & philosophy (shared)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `COACH_ADAPTIVE_AI` | enum | COPY | COPY | identical enum verified |
| `COACH_DEMEANOR` | enum | COPY | COPY | identical |
| `COACH_STANCE` | enum | COPY | COPY | identical |
| `COACH_OFFTENDENCYRUNPASS` | int[0..127] | COPY | COPY | CFB p50 55, MAD p50 60 — comparable |
| `COACH_OFFTENDENCYAGGRESSCONSERV` | int[0..127] | COPY | COPY | CFB p50 60, MAD p50 65 |
| `COACH_DEFTENDENCYAGGRESSCONSERV` | int[0..127] | COPY | COPY | CFB p50 47, MAD p50 50 |
| `COACH_DEFTENDENCYRUNPASS` | int[0..127] | **SYNTH 50** | COPY | CFB 496/497 = 0, which is out-of-distribution for Madden (p50 50). Write the neutral |
| `COACH_RBTENDENCY` | int[0..127] | COPY | COPY | CFB 226/497 = 0; pass 0→50 through the same neutral rule |
| `COACH_NO_HUDDLE_TEMPO` | enum | *(CFB-only)* | SYNTH `Balanced` | CFB modal value (245/497) |
| `TeamBuilding` | enum | **SYNTH** | COPY | identical enum, but CFB is **497/497 `Balanced`** — no signal. Derive from Madden peers or default `Balanced` |
| `TradingTendency` | enum | **SYNTH** | COPY | identical enum, CFB **497/497 `DoesNotTrade`**. Default `DoesNotTrade` |
| `TeamPhilosophy` | reference | RESOLVE | RESOLVE | points into per-game asset tables. Adopt the **destination team's** philosophy, don't carry |
| `DefaultTeamPhilosophy` | reference | RESOLVE | RESOLVE | same |
| `TraitExpertScout` | bool | COPY | COPY | false for all 624 |
| `HasTrait` | reference | DROP | DROP | null for all 624 |

### 2.6 Schemes & playbooks (shared, all references)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `OffensiveScheme` | `Scheme` ref | **LOOKUP** | **LOOKUP** | §3.3. Raw copy is invalid — the target tableId doesn't exist in the other save |
| `DefensiveScheme` | `Scheme` ref | **LOOKUP** | **LOOKUP** | §3.3 |
| `OffensivePlaybook` | ref | RESOLVE | RESOLVE | CFB 147 distinct across 4 asset tables (per-school books, e.g. "SCAR - Air Raid"); Madden 33, one table. No cross-game correspondence — adopt a destination playbook matching the mapped scheme |
| `DefensivePlaybook` | ref | RESOLVE | RESOLVE | CFB 30 distinct / 2 tables; MAD 32 |
| `OffenseAudibles` | ref | DROP | DROP | **null for all 624 coaches in both saves** |
| `DefenseAudibles` | ref | DROP | DROP | null for all 624 |

### 2.7 Career ledger (shared)

Copy where both games mean the same thing; note that CFB stores **no
wins/losses at all** on the Coach row (see Q3).

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `CareerPointsFor` | int[0..65535] | COPY | COPY | CFB max 5295, MAD max 2152 — scale differs (12-game college seasons vs 17-game NFL) but the field means the same |
| `CareerPointsAgainst` | int[0..65535] | COPY | COPY | |
| `CareerWinSeasons` | int[0..127] | COPY | COPY | CFB max 25, MAD max 22 |
| `CareerPlayoffsMade` | int[0..63] | COPY | COPY | CFB = bowl/CFP appearances |
| `CareerLongWinStreak` | int[0..1023] | COPY | COPY | |
| `CareerTies` | int[0..1023] | COPY | ZERO | CFB all-zero (no ties in modern CFB) |
| `CareerBigWinMargin` | int[0..255] | COPY | COPY | zero in both |
| `CareerBigLossMargin` | int[0..255] | COPY | COPY | zero in both |
| `AwardPoints` | int[0..127] | COPY | COPY | zero in both |
| `YearlyAwardCount` | int[0..31] | COPY | COPY | zero CFB; MAD max 2 |
| `LegacyScore` | int CFB`[0..65535]` MAD`[0..100000]` | **SYNTH** | DROP | CFB all-zero. Derive from Level + career (§3.4) |
| `RegularWinStreak` `SeasWinStreak` `WinSeasStreak` `ConfPlayoffWinStreak` `DivPlayoffWinStreak` `WCPlayoffWinStreak` `SuperbowlWinStreak` | int | ZERO | ZERO | 7 fields, zero or unpopulated in both; a new hire has no streak |
| `SeasPointsFor` `SeasPointsAgainst` `SeasTies` `SeasLongWinStreak` `SeasBigWinMargin` `SeasBigLossMargin` | int | ZERO | ZERO | current-season state; a mid-carousel hire starts clean |
| `OWNER_COMMENTID` `OWNER_COMMENTTYPE` | int[0..31] | ZERO | ZERO | zero in both |
| `YearsCoaching` | int CFB`[0..127]` MAD`[0..63]` | COPY+**clamp 63** | COPY | CFB max 43 today, but the range allows 127 |

### 2.8 Appearance (shared)

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `CharacterVisuals` | ref → JSON blob | **SYNTH** | **SYNTH** | §3.5. Same JSON envelope, incompatible contents. CFB coach blobs contain **no head loadout at all** |
| `GenericHeadAssetName` | string(33) | **LOOKUP** | LOOKUP | zero vocabulary overlap: CFB `Generic_0103_C_T0102_H_2_3` / `Unique_C_AltmanGarrett_900` vs MAD `coachhead_M_0013_HS` |
| `Portrait` | int[0..8191] | **LOOKUP** | LOOKUP | per-game portrait id; pair with the head, per `appearanceCatalog.js` |
| `Portrait_Force_Silhouette` | bool | ZERO | ZERO | false for all 624 |
| `Portrait_Swappable_Library_Path` | enum | COPY | COPY | identical single-value enum |
| `FaceShape` | enum (231) | *(MAD-only)* | SYNTH `Invalid_` | Madden observed: `Invalid_` 93, `MustBeUnique` 25 — live coaches carry the head in `CharacterVisuals`, not here |
| `HatType` | enum | *(CFB-only)* | SYNTH `None` | CFB modal (337/497) |

### 2.9 CFB-only — drop on the way out, synthesize on the way in

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `CoachPrestige` | `LetterGrade` enum | DROP | SYNTH | derive the letter from the synthesized `CoachPrestigeScore` percentile |
| `CoachPrestigeScore` | int[0..10000] | DROP | **SYNTH P70** | §3.4. Read the *live* distribution — this save's P70 is **609** overall but **1190** among head coaches |
| `CoachPoints` | int[0..4095] | DROP | **SYNTH 0** | locked decision |
| `CurrentJobSecurityStatus` | enum | DROP | SYNTH `Safe` | consistent with 80% |
| `SeasonStartJobSecurityStatus` | enum | DROP | SYNTH `Safe` | |
| `CurrentJobSecurityPercentage` | int[0..100] | DROP | **SYNTH 80** | locked decision. Save p50 is 98, so 80 sits deliberately below "comfortable" |
| `CurrentJobSecurityPercentageRank` | int[0..500] | DROP | ZERO | recomputed by the game |
| `CurrentContractExpectation` | enum | DROP | SYNTH | from destination team prestige; modal `Win5Games`/`Win4Games` |
| `ContractExpectationProgress` | enum | DROP | ZERO | |
| `EarnedContractPoints_ThisYear` | int[-300..300] | DROP | ZERO | zero for all 497 |
| `EarnedContractPoints_LastYear` | int[-300..300] | DROP | ZERO | |
| `EarnedContractPoints_TwoYearsAgo` | int[-300..300] | DROP | ZERO | |
| `CurrentStatRankPosition` | int[0..500] | DROP | ZERO | in-season |
| `CurrentWinStreak` | int[-128..127] | DROP | ZERO | |
| `DominantArchetype` | enum (13) | DROP | **SYNTH** | §3.2 |
| `SpecialtyType` | enum | DROP | SYNTH | from `COACH_SPECIALTY` |
| `AlmaMater` | int → CFB `TeamIndex` | DROP | **Q4** | verified: `87`→TCU, `107`→Wake Forest. A CFB team index |
| `HomeState` | `StateName` enum | DROP | **Q4** | 236/497 = `Alabama`, but all are `TeamIndex=255` filler — `Alabama` is the *unset* value here |
| `HomeTown` | `City` ref | DROP | ZERO | **0:0 for every coach** — never populated |
| `PrimaryPipeline` | `Pipeline` enum (44) | DROP | **Q6** | real recruiting-territory data, genuinely varied |
| `IsNIL` | bool | DROP | **Q6** | 267 false / 230 true — not a trivial default |
| `ActiveTalentTree` | ref | DROP | **Q6** | 477/497 populated, one row each |
| `ProgramPointsBudgetAllocationPosture` | ref | DROP | RESOLVE | 5 distinct values; adopt destination default |
| `SeasonStats` | `SeasonCoachStats` ref | **read for Q3** | ZERO | 396/497 populated — the source for synthesized W/L |
| `CareerStats` | `CareerCoachStats` ref | **read for Q3** | ZERO | 396/497 populated |
| `ContractYearSummaries` | array ref | DROP | ZERO | |
| `SeasonalGoal` | `CoachGoal` ref | DROP | ZERO | null for all 497 |
| `WeeklyGoals` | `CoachGoal[]` ref | DROP | ZERO | |
| `PersuadeAttempts` | int[0..100] | DROP | ZERO | zero for all 497 |
| `NumContractOffers` | int[0..12] | DROP | ZERO | zero for all 497 |
| `PrevPosition` | enum | DROP | SYNTH | from Madden `OriginalPosition` |
| `PreOrderCurrentTitle` | bool | DROP | ZERO | entitlement flag |
| `PreOrderPartnerTitle` | bool | DROP | ZERO | entitlement flag |

### 2.10 Madden-only — synthesize on the way in, drop on the way out

| field | type | CFB→MAD | MAD→CFB | notes |
|---|---|---|---|---|
| `Archetype` | enum (8) | **SYNTH** | DROP | §3.2 |
| `OriginalPosition` | enum | SYNTH = `Position` | DROP | matches `Position` for all 127 |
| `CareerWins` | int[0..1023] | **SYNTH — Q3** | DROP | MAD p50 45, max 464 |
| `CareerLosses` | int[0..1023] | **SYNTH — Q3** | DROP | p50 43 |
| `CareerPlayoffWins` | int[0..255] | SYNTH — Q3 | DROP | p50 1 |
| `CareerPlayoffLosses` | int[0..255] | SYNTH — Q3 | DROP | p50 2 |
| `CareerSuperbowlWins` | int[0..63] | ZERO | DROP | 104/127 zero |
| `CareerSuperbowlLosses` | int[0..100] | ZERO | DROP | 107/127 zero |
| `CareerProBowlPlayers` | int[0..1023] | ZERO | DROP | 88/127 zero |
| `SeasWins` | int[0..31] | ZERO | DROP | mid-season hire starts clean |
| `SeasLosses` | int[0..31] | ZERO | DROP | |
| `CareerAssistant` | bool | SYNTH | DROP | true iff mapped `Position` ≠ `HeadCoach`. MAD: 21/127 true |
| `IsMaxLevel` | bool | SYNTH | DROP | `mappedLevel >= 50` |
| `IndexInUnlockList` | int[0..150] | ZERO | DROP | 25/127 zero; ability-unlock bookkeeping |
| `PlaysheetTalents` | `Talent[]` ref | ZERO | DROP | locked decision: drop talent trees |
| `GamedayTalents` | `Talent[]` ref | ZERO | DROP | |
| `WearAndTearTalents` | `Talent[]` ref | ZERO | DROP | |
| `CurrentPurchasedTalentCosts` | int[0..8000] | ZERO | DROP | zero for all 127 |
| `FaceShape` | enum (231) | SYNTH `Invalid_` | DROP | see §2.8 |

**Coverage check:** 16+11+4+13+16+6+21(+7+6 grouped)+7+32+19 — every one of the
102 shared, 35 CFB-only and 19 Madden-only fields appears exactly once.

---

## 3. Sub-system specs

### 3.1 Level / quality conversion (`map/levelScale.js`)

**Locked**: CFB `Level` ↔ Madden `Level` is the transferable quality signal.

**What the data says.** Schema bounds are CFB `int[0..100]`, Madden `int[1..50]`
— a declared 2:1. But observed distributions are *not* 2:1, and diverge sharply
by position (FINDINGS §3):

| | CFB p50 | MAD p50 | CFB p90 | MAD p90 | CFB max | MAD max |
|---|---|---|---|---|---|---|
| HeadCoach | 41 | 23 | 67 | 41 | 87 | 49 |
| OffensiveCoordinator | 33 | **6** | 47 | **11** | 61 | 49 |
| DefensiveCoordinator | 26 | 13 | 46 | 18 | 63 | 19 |

`/2` is a fair approximation for head coaches (41→20.5 vs an actual 23) and
**badly wrong for coordinators** (CFB OC p50 33→16.5 against a Madden OC p50 of
**6**). A position-blind linear map drops CFB coordinators into Madden at 3–5×
their peers' level.

**Proposed model — position-conditioned percentile with a linear guardrail:**

1. Read the destination save's live `Level` distribution **for the target
   position** (`HeadCoach` / `OC` / `DC`), excluding `Level == 0` rows (CFB has
   68 zero-level filler shells, Madden 16).
2. Compute the source coach's percentile within the *source* save's distribution
   for their position.
3. Map to the destination value at that percentile.
4. **Blend with the schema-ratio anchor** — `linear = round(cfbLevel * 50/100)`
   — as `out = round(w·percentile + (1-w)·linear)`, default `w = 0.75`.
   Rationale: Madden's per-position samples are thin (37 HC, 46 OC, 44 DC) so a
   pure percentile map is lumpy and would compress the whole top of the CFB
   distribution onto a handful of observed Madden values. The linear term keeps
   the tail monotone and separated.
5. Clamp to the destination schema range (`[1..50]` into Madden, `[0..100]` into CFB)
   and enforce **strict monotonicity**: a higher CFB level must never produce a
   lower Madden level.
6. Re-derive `ExperiencePoints` from the mapped level using the destination
   save's own observed level↔XP relationship, so the game's progression system
   agrees with the Level written. (Both games use `int[0..1000000]`, but CFB
   p50 XP is 7,050 at level 35 while Madden's is 21,646 at level 10 — the curves
   are entirely different and XP must not be copied.)

`w` is a config constant, exposed in the UI like the existing Power-Curve knobs.
**Q1 remains open on whether `w = 0.75` feels right in-game** — see the
verification plan.

### 3.2 Archetype mapping (`map/archetypeMap.js`)

**Correction to the brief**: Madden's `Archetype` enum has **8** members, not 3.
`MasterMotivator` exists in *both* vocabularies — a free 1:1 anchor. CFB's
`CoachTalentArcheType` has **13** real members (the brief missed `Rainmaker` and
`Visionary`).

**The empirical rule** (FINDINGS §8): in Madden, `Archetype` tracks
`COACH_SPECIALTY` strongly (61/65 `OffensiveGuru` have an offensive specialty;
45/54 `DefensiveGenius` a defensive one). In CFB, `DominantArchetype` predicts
side **not at all** — every archetype splits ~evenly. So:

> **`COACH_SPECIALTY` / `SpecialtyType` determines the side. `DominantArchetype`
> only chooses between the side archetype and `DevelopmentWizard`.**

`side(coach)` = `SpecialtyType` if present, else from `COACH_SPECIALTY`
(QB/RB/WR/OL → Offense, DL/LB/DB → Defense, ST → Any).

**CFB → Madden (13 → 8)**

| CFB `DominantArchetype` | default Madden | variety roll |
|---|---|---|
| `EliteRecruiter`, `Recruiter`, `ProgramBuilder`, `TalentDeveloper` | `DevelopmentWizard` | **p = 0.25** → side archetype (`OffensiveGuru` if side=Offense, `DefensiveGenius` if Defense) |
| `Schemer`, `SchemeGuru`, `Strategist`, `Architect` | side archetype | p = 0.15 → `DevelopmentWizard` |
| `MasterMotivator` | **`MasterMotivator`** (1:1, exists in Madden) | — |
| `Motivator` | side archetype | p = 0.20 → `MasterMotivator` |
| `CEO` | side archetype | p = 0.25 → `DevelopmentWizard` |
| `Rainmaker` | `DevelopmentWizard` | p = 0.25 → side archetype. *Unobserved — flavour inferred from the name; verify* |
| `Visionary` | side archetype | p = 0.20 → `DevelopmentWizard`. *Unobserved; verify* |
| `Invalid_` | `DevelopmentWizard` | — (all 19 are filler shells) |

Side = `Any` (83 CFB coaches, all filler) → `DevelopmentWizard`, no roll.
`PersonnelCzar`, `HeadScout`, `HeadTrainer` are never assigned — they belong to
Madden's Scout/Trainer/PlayerPersonnel staff types, not `Coach`.
`MasterMotivator_JohnMadden` is a licensed special, never assign.

All rolls use `rosetta/rng.makeSeededRng` with a seed from
`identity.deriveSeedString(globalSeed, 'carousel:archetype', sourceRow)` — same
determinism contract as the player pipeline.

**Madden → CFB (8 → 13)** — expand using side + `Level` as a proxy for tier:

| Madden `Archetype` | side | CFB `DominantArchetype` |
|---|---|---|
| `OffensiveGuru` / `DefensiveGenius` | any | `SchemeGuru` if Level ≥ dest-P70, else `Schemer` |
| `DevelopmentWizard` | any | `TalentDeveloper` if Level ≥ dest-P70, else `Recruiter` |
| `MasterMotivator` | any | `MasterMotivator` (1:1) |
| `PersonnelCzar` | any | `CEO` |
| `HeadScout` | any | `EliteRecruiter` if Level ≥ P70 else `Recruiter` |
| `HeadTrainer` | any | `TalentDeveloper` |
| `MasterMotivator_JohnMadden` | any | `MasterMotivator` |

`Architect`, `Strategist`, `ProgramBuilder`, `Rainmaker`, `Visionary`, `Motivator`
are reachable only via a config-driven variety roll (default off) — an NFL coach
arriving in college is deliberately mapped to the scheme/development families
rather than the recruiting-flavour ones.

### 3.3 Scheme lookup (`map/schemeLookup.js`)

**The finding that changes the design**: `Coach.OffensiveScheme` /
`DefensiveScheme` are **reference pointers** `{tableId, rowNumber}` into asset
tables that are **not present in the save file** (CFB ids 16433/16456/16482,
Madden 16384). A raw 32-bit copy points at a table the other game doesn't have.

But `Team.CurrentOffensiveScheme` / `DefaultOffensiveScheme` is a **`BaseScheme`
enum with readable names**, and `probe07` recovers the pointer→name map by
joining each team's readable enum value against the coach its `HeadCoach`
reference points at. Both games' full vocabularies and the derived pointer tables
are in FINDINGS §4.

The `BaseScheme` enums are **structurally identical** (22 slots, offense 0–10,
defense 11–19, same sentinels) but only **7 of 20 slots share a name**. An
index-preserving copy gets 7 right and silently produces 13 valid-but-wrong
schemes.

**Design:**

1. **Derive, never hardcode.** At load, run the probe07 join against both open
   saves and build `{pointer → BaseScheme name}` per game. The observed pointer
   values (`16433:111484..111503`, `16384:104572..104585` + a second `122xxx`
   band) are save/title-update-specific — the `122xxx` band strongly suggests
   post-launch additions. Hardcoding them will break on the next patch.
2. Cross games on the **name**, through an editable table.
3. Ship the table as JSON in `data/coachSchemeMap.json` so a user can retune it
   without a code change — same posture as `data/overall_formula.json`.

**Proposed default map** (concept-nearest; `†` = needs in-game verification):

| CFB | → Madden | Madden | → CFB |
|---|---|---|---|
| `OFF_AIR_RAID` | `AirRaid` | `AirRaid` | `OFF_AIR_RAID` |
| `OFF_SPREAD` | `Spread` | `Spread` | `OFF_SPREAD` |
| `OFF_RUN_AND_SHOOT` | `RunAndShoot` | `RunAndShoot` | `OFF_RUN_AND_SHOOT` |
| `OFF_PISTOL` | `Pistol` | `Pistol` | `OFF_PISTOL` |
| `OFF_WEST_COAST_ZONE_RUN` | `WestCoastZoneRun` | `WestCoastZoneRun` | `OFF_WEST_COAST_ZONE_RUN` |
| `OFF_POWER_SPREAD` † | `WestCoastSpread` | `WestCoastSpread` † | `OFF_POWER_SPREAD` |
| `OFF_SPREAD_OPTION` † | `Spread` | `MultipleZoneRun` † | `OFF_MULTIPLE_OFFENSE` |
| `OFF_VEER_AND_SHOOT` † | `VerticalZoneRun` | `MultiplePowerRun` † | `OFF_MULTIPLE_OFFENSE` |
| `OFF_OPTION` † | `MultiplePowerRun` | `VerticalZoneRun` † | `OFF_VEER_AND_SHOOT` |
| `OFF_MULTIPLE_OFFENSE` † | `MultipleZoneRun` | `VerticalPowerRun` † | `OFF_PRO_STYLE` |
| `OFF_PRO_STYLE` † | `VerticalPowerRun` | `WestCoastPowerRun` † | `OFF_PRO_STYLE` |
| `DEF_BASE4_3` | `Base4_3` | `Base4_3` | `DEF_BASE4_3` |
| `DEF_BASE3_4` | `Base3_4` | `Base3_4` | `DEF_BASE3_4` |
| `DEF_4_2_5` † | `Quarters4_3` | `Under4_3` † | `DEF_4_3_MULTIPLE` |
| `DEF_3_3_5` † | `Under3_4` | `Under3_4` † | `DEF_3_3_5` |
| `DEF_3_3_5_TITE` † | `Storm3_4` | `Tampa2` † | `DEF_MULTIPLE_DEFENSE` |
| `DEF_3_2_6` † | `Cover3_4_3` | `Quarters4_3` † | `DEF_4_2_5` |
| `DEF_4_3_MULTIPLE` † | `Under4_3` | `Disguise3_4` † | `DEF_3_4_MULTIPLE` |
| `DEF_3_4_MULTIPLE` † | `Disguise3_4` | `Storm3_4` † | `DEF_3_3_5_TITE` |
| `DEF_MULTIPLE_DEFENSE` † | `Tampa2` | `Cover3_4_3` † | `DEF_3_2_6` |
| — | | `Defense_46` † | `DEF_BASE4_3` |

The 6 unmarked offensive and 2 unmarked defensive rows are name-identical and
safe. Every `†` row is a judgement call about football concepts and needs an
in-game look. Playbooks are **not** mapped — no cross-game correspondence exists
(CFB carries 147 per-school books like "SCAR - Air Raid" across four asset
tables; Madden has 33 in one). Pick a destination playbook consistent with the
mapped scheme, from the destination team's own default.

Two CFB offensive slots (`OFF_WEST_COAST_ZONE_RUN`, `OFF_RUN_AND_SHOOT`) and one
CFB pointer (`16433:111495`) are unresolved from this save; Madden `Pistol`,
`Tampa2`, `Quarters4_3` likewise. They need one in-game read each.

### 3.4 Field synthesis rules (`map/synthesis.js`)

All constants live in one config object, UI-exposed like `DEFAULT_CONFIG`.

**Into CFB:**

| field | rule | evidence |
|---|---|---|
| `CurrentJobSecurityPercentage` | **80** (constant) | locked. Save p50 is 98 — 80 reads as "solid but not untouchable" |
| `CurrentJobSecurityStatus` | `Safe` | consistent with 80 |
| `SeasonStartJobSecurityStatus` | `Safe` | |
| `CoachPoints` | **0** | locked |
| `CoachPrestigeScore` | **P70 of the live destination distribution, if arriving from the NFL**; P40 if a CFB-internal move | Read `CoachPrestigeScore` from every non-empty destination Coach row **of the same `Position`**, drop zeros, take the 70th percentile. Cohort matters: this save's overall P70 is **609** but head-coach-only P70 is **1190** — a ~2× difference. Use the position-matched cohort. Never hardcode |
| `CoachPrestige` | letter grade from the score's percentile band | `LetterGrade` enum A+…F |
| `ContractSalary` | DROP | CFB has no salary model (496/497 zero) |
| `SpecialtyType` | from `COACH_SPECIALTY` | |
| `HatType` | `None` | CFB modal 337/497 |
| `COACH_NO_HUDDLE_TEMPO` | `Balanced` | CFB modal 245/497 |
| `CoachBackstory` | `{HC,OC,DC} × {Motivator,Schemer,Salesman}` from mapped position + archetype | CFB has these 9 members; Madden doesn't |

**Into Madden:**

| field | rule | evidence |
|---|---|---|
| `Archetype` | §3.2 | |
| `CoachBackstory` | `OffensiveGuru`/`DefensiveGenius` → `Strategist`; `DevelopmentWizard` → `TeamBuilder`; `MasterMotivator` → `Motivator` | CFB carries no signal (496/497 `Motivator`); Madden's real split is Strategist 59 / Motivator 44 / TeamBuilder 24 |
| `ContractSalary` | interpolate the destination save's live `ContractSalary`-vs-`Level` relation at the mapped level | MAD p25 100, p50 300, p70 525, max 4000 |
| `LegacyScore` | destination percentile matching the mapped Level percentile | MAD p50 395, max 20000; CFB all-zero |
| `TeamBuilding` | `Balanced` | destination modal 101/127 |
| `TradingTendency` | `DoesNotTrade` | destination modal 82/127 |
| `COACH_DEFTENDENCYRUNPASS` | **50** when source is 0 | CFB 496/497 zero; Madden p50 50 |
| `COACH_RBTENDENCY` | 50 when source is 0 | CFB 226/497 zero |
| `CareerAssistant` | `mappedPosition !== HeadCoach` | |
| `IsMaxLevel` | `mappedLevel >= 50` | |
| `OriginalPosition` | = mapped `Position` | matches for all 127 |
| `CareerWins/Losses/PlayoffWins/PlayoffLosses` | **Q3** | |
| `COACH_*` position grades | **Q2** | |

**Both directions:** `PrevTeamIndex` → destination unassigned sentinel (CFB 255 /
MAD 32); `SeasonsWithTeam` = 0; all `*WinStreak` and `Seas*` = 0; all
`COACH_LASTTEAM*` = destination sentinel.

### 3.5 Appearance synthesis

Q5 is **answered by the data, and the answer is "do not copy"** (FINDINGS §5):

- Both games use the same `CharacterVisuals` JSON envelope; 100% parse rate on both sides.
- **CFB coach blobs contain no head loadout at all** — only `CoachOnField`/`CoachApparel`. Madden's carry `Head`/`Head` → `PlusHead` → `coachhead_M_0013_HS`.
- The three head namespaces (CFB `Generic_*`/`Unique_*`, Madden `coachhead_M_NNNN_HS`, Madden `FaceShape` `coachhead_N_X_Y_NN`) have **zero overlap**.
- Only 201/497 CFB coaches even have a visuals reference.

**Design**: reuse the `lib/appearanceCatalog.js` pattern — bake a **coach**
appearance catalog of *shipped, coherent* `(Portrait, GenericHeadAssetName,
CharacterVisuals head loadout)` triples out of a real destination save via a new
`tools/bakeCoachAppearanceCatalog.js`, then assign by extracted skin tone with
least-used-first spreading. Both games encode skin tone in head-asset naming, and
`pipeline.js:extractSkinTone` already parses the CFB form
(`Generic_1450_P_T0071_H_7_1` → tone 7). The Madden coach form
(`coachhead_M_0013_HS`) does **not** appear to encode a tone digit — an open
sub-question flagged under Q5.

Apparel is separately copyable: `CoachWardrobe_Polo` / `CoachWardrobe_Pants`
appear in both games. `CoachWardrobe_LeatherSneakerWhite`, `UC_Hat_None`,
`UC_Headset_1` do not obviously cross — validate per item name against the
destination save's observed vocabulary and fall back to the destination's modal
item when an item name is unknown.

### 3.6 Direction-dependent drop/synthesize logic

One rule, three cases, driven by `coachFieldMap.js` and the presence data in §2 —
no direction-specific branching scattered through the writer:

```
for each field in coachFieldMap:
  presence = both | CFB | MAD
  if presence == both:
      action = map[field].action[direction]        // COPY | NAME | LOOKUP | RESOLVE | SYNTH | ZERO | DROP
  else if presence == destinationGame:
      action = SYNTH (or ZERO)                      // must be produced; source has nothing
  else:  // presence == sourceGame only
      action = DROP                                 // nowhere to put it
```

The non-obvious case the data forces: a field can be `both` and still need
`SYNTH`, because *shared* does not mean *populated*. `TeamBuilding`,
`TradingTendency`, `CoachBackstory`, `LegacyScore`, `ContractSalary` and every
`COACH_*` grade are structurally shared but dead on the CFB side. §2 marks each
one explicitly.

---

## 4. Verification plan (in-game, after this roadmap is locked)

Each experiment: what to set → what to look at → what the result means.
**Always work on a copy of the save.**

**V1 — Zero vs. neutral `COACH_*` grades (decides Q2).**
Inject three identical CFB→Madden head coaches into three teams, differing only
in `COACH_*`: coach A all-zero, coach B all-50 (Madden's schema default and
observed p50), coach C synthesized from Level. Sim 3 seasons.
*Look at*: each team's W-L, `TEAM_RATINGOVR` drift, in-game player progression,
and whether Coach Central renders normally.
*Means*: if A's teams sim materially worse → Madden's sim reads these fields and
zeroing tanks it; ship the synthesized path. If A ≈ B ≈ C → zeroing is safe;
ship the simpler default. **If A is visibly broken (crash, 0 rating shown), 50 is
the floor regardless.** Note that CFB coaches are all-zero natively, so zeroing
is "correct" for CFB but likely wrong for Madden.

**V2 — `CharacterVisuals` portability (closes Q5).**
Copy one CFB coach's `CharacterVisuals` blob verbatim into a Madden coach row;
copy a second with the blob dropped and only `GenericHeadAssetName` set to a
valid Madden `coachhead_*`; a third with the full synthesized catalog triple.
*Look at*: Coach Central portrait, the 3D model on the sideline during a game,
and the team-select screen.
*Means*: the prediction from the data is that #1 renders headless/default
(CFB blobs contain no head loadout) and #3 renders correctly. If #1 renders
fine, the head is being resolved from somewhere else and §3.5 can be simplified.

**V3 — Level scale sanity (closes Q1).**
Move four CFB coaches spanning the distribution — a p50 HC (Level 41), a p90 HC
(67), the max HC (87), and a p50 OC (33) — using `w = 0.75`.
*Look at*: where each lands in Madden's Coach Central level display relative to
real NFL coaches; whether the 87 lands near the league's best without exceeding
50; whether the OC lands among Madden OCs (p50 = 6) rather than among head coaches.
*Means*: if the p50 OC arrives above Madden's OC p90 (11), raise the percentile
weight `w`. If the max HC pins at 50 and compresses the tail, lower it.
**Do this before any other tuning** — every downstream synthesis (salary,
LegacyScore, prestige, archetype tier) keys off the mapped level.

**V4 — Contract-status name mapping.**
Write one coach with a name-mapped `ContractStatus` and one with a raw numeric
copy (CFB `FreeAgent`=7 → Madden 7, which is out of Madden's 0–5 range).
*Look at*: whether the raw-copy coach appears in the correct place in Madden's
staff screens, or at all; whether the save reloads.
*Means*: confirms the enum-bridge rule empirically and gives a concrete failure
mode to test against in a unit test. Expect the raw copy to be invalid or wildly
wrong.

**V5 — Scheme mapping fidelity (fills the `†` rows in §3.3).**
For each unresolved/`†` scheme, set a coach to that scheme and read the in-game
Schemes screen name; also read the CFB pointer `16433:111495` and the two
unassigned CFB offensive names, plus Madden `Pistol`/`Tampa2`/`Quarters4_3`.
*Look at*: the scheme name and the formations listed under it in both games.
*Means*: converts each `†` from a judgement call into a verified row. Also
re-derive the pointer table on a *different* save/patch to confirm R2 (pointer
instability).

**V6 — Team wiring round-trip.**
Move a coach into a Madden team as HC: write `Coach.TeamIndex`,
`Coach.Position`, **and** `Team.HeadCoach`. Then repeat writing only
`Coach.TeamIndex`.
*Look at*: does the team show the new coach; does the previous HC vanish or
duplicate; does advancing a week re-assign anyone.
*Means*: determines whether the reciprocal `Team.*` reference is mandatory (it
almost certainly is) and whether the displaced coach must be explicitly moved to
the FA pool (`TeamIndex` 32 / 255) rather than left dangling.

**V7 — Does the destination game's own carousel fight us?**
Inject a coach, then advance through the destination's hiring window
(CFB `CoachCarouselStartEvent` / `StaffHiringEval`; Madden `StaffHiringPeriodStartEvent`).
*Look at*: whether the injected coach survives, gets re-signed, gets fired, or
gets overwritten.
*Means*: decides whether the carousel must write during a specific offseason week
(the likely answer), and whether `ContractStatus`/`ContractYearsRemaining` need
particular values to be left alone. **This is the single highest-risk unknown for
Phase 3 automation.**

**V8 — Blank-shell landing slots (Madden→CFB).**
Write an incoming NFL coach into one of CFB's 68 `Level=0` / `TeamIndex=255`
filler free-agent rows, versus into a fresh empty row (135 free slots exist).
*Look at*: whether the coach appears in CFB's hiring pool and can be hired by an
AI school.
*Means*: decides the destination-row allocation strategy. The filler rows look
purpose-built for this.

---

## 5. Open questions

**Q1 — Level scale conversion.** *Partly answered.* Schema bounds are exactly
2:1 (CFB `[0..100]`, MAD `[1..50]`) but observed distributions are not, and
diverge by position (CFB OC p50 33 vs Madden OC p50 6). §3.1 proposes a
position-conditioned percentile map blended `w=0.75` with the linear anchor.
**Still open**: the value of `w`, and whether Madden's thin per-position samples
(37/46/44) support percentile mapping at all. → **V3**.

**Q2 — Zero vs. synthesized `COACH_*` grades on CFB→Madden.** *Sharpened.* CFB is
all-zero across 497 coaches; Madden's schema **default is 50** and its observed
p50 is exactly 50 with mean 57.6. So zero is not the neutral value in Madden —
50 is. The real choice is 50-flat vs. Level-derived. → **V1**.

**Q3 — Madden career W/L splits.** CFB stores **no `CareerWins`/`CareerLosses` at
all** on the Coach row — only `CareerPointsFor/Against`, `CareerWinSeasons`,
`CareerPlayoffsMade`, `CareerLongWinStreak` (and `CareerTies`, all-zero). Real
records live in the CFB-only `CareerStats` reference (`CareerCoachStats` table,
396/497 coaches populated) and `SeasonStats` (`SeasonCoachStats`). **Not yet
probed** — the next research step is to dump `CareerCoachStats`'s fields and
confirm it carries wins/losses. If it does, CFB→Madden `CareerWins/Losses` reads
straight from there (with a note that Madden's p50 of 45-45 reflects 17-game
seasons vs college's 12). If it doesn't, estimate from
`CareerWinSeasons × ~12 × winRate` with `winRate` inferred from
`CareerPointsFor / (For + Against)` — a Pythagorean estimate.

**Q4 — `AlmaMater` / `HomeState` / `HomeTown` on Madden→CFB.** *Partly answered.*
`AlmaMater` is verified to be a **CFB `TeamIndex`** (87→TCU, 107→Wake Forest), so
an NFL coach genuinely has no value for it. `HomeTown` is a `City` reference that
is **`0:0` for every one of the 497 CFB coaches** — never populated, so leave it.
`HomeState` is populated but 236/497 are `Alabama`, and every one of those is a
`TeamIndex=255` filler — `Alabama` is the *unset* value in this save, not data.
**Still open**: does a blank/zero `AlmaMater` break CFB's recruiting-pipeline or
alumni logic (`Team.DesiresAlumni` exists), and is a random real school a better
default than none? → new experiment: give one incoming coach `AlmaMater=0` and
one a real school, recruit a cycle, compare pipeline influence.

**Q5 — `CharacterVisuals` / head-asset portability.** *Answered: not portable.*
See FINDINGS §5 and §3.5. **Residual sub-question**: does Madden's coach head
naming (`coachhead_M_0013_HS`) encode a skin tone the way its player heads
(`gen_<skin>_<combo>_<style>_<v>`) do? The `M` and `HS` tokens are unexplained.
Needed before a coach appearance catalog can be keyed by tone. → **V2** + a
targeted probe of Madden coach heads vs. their rendered skin.

**Q6 — `IsNIL`, `PrimaryPipeline`, `ActiveTalentTree`.** `IsNIL` splits 267/230 —
genuinely bimodal, not a default; needs an in-game read of what the flag toggles
(probably "coach engages with NIL"). `PrimaryPipeline` is a 44-value recruiting
territory, well populated and geographically sensible (Ohio 37, Alabama 29) — an
arriving NFL coach needs *something*; proposal is to derive it from the
destination school's own region rather than leave it `Invalid`. `ActiveTalentTree`
is a reference, 477/497 populated one row each, into the CFB-only
`ActiveTalentTree` table — an incoming coach probably needs a fresh empty tree
row created rather than a null reference. All three need an in-game read.

**Q7 (new) — Do the games' own carousel/hiring systems overwrite injected
coaches?** CFB has a full native carousel (`CoachCarouselStartEvent`,
`StaffHiringEval`, `CoachRetirementEval`) and a `ContractStatus.PendingNFL`
member; Madden has `StaffHiringPeriodStartEvent`, `CoachCentralEval`,
`DemandReleaseCoachStartEvent`. Writing a coach mid-window may be undone on the
next advance. → **V7**. Highest-risk unknown for automation.

**Q8 (new) — Is the reciprocal `Team.HeadCoach`/`OC`/`DC` reference mandatory?**
`Coach.TeamIndex` and `Team.<slot>` are two independent pointers at the same
relationship. Writing only one probably leaves an inconsistent save. → **V6**.

**Q9 (new) — Are the scheme *pointer* values stable across saves and patches?**
Madden's observed pointers fall in two bands (`104xxx` and `122xxx`), which looks
like base-game vs. title-update assets. If pointers move between saves, the
derive-at-load design in §3.3 is mandatory rather than merely prudent. → **V5**,
run against a second save.

**Q10 (new) — `ExperiencePoints` curve.** CFB p50 XP is 7,050 at Level 35;
Madden's is 21,646 at Level 10. Same field range `[0..1000000]`, entirely
different curves. Copying XP would fight the mapped Level. §3.1 re-derives it,
but the exact destination curve needs fitting from the destination save.

**Enum ordering — resolved.** In this schema family, enum **member names are
stable** where a concept is shared, but **numeric values are not**
(`ContractStatus.FreeAgent` = 7 in CFB, 1 in Madden). Nine enums are byte-identical
(`COACH_SPECIALTY`, `COACH_ADAPTIVE_AI`, `COACH_DEMEANOR`, `COACH_STANCE`,
`CharacterBodyType`, `Personality`, `TeamBuilding`, `TradingTendency`,
`Portrait_Swappable_Library_Path`); three drift (`Position`, `ContractStatus`,
`CoachBackstory`). **Rule: always cross by `getMemberByName`.** A startup
assertion should verify the nine "identical" enums really are identical in the
loaded saves and refuse to run if a patch changed one.

---

## 6. Phased build plan

### Phase 0 — Shared core & Person identity
**Goal.** Extract `lib/saveIO.js` (openers, schema constants, `safe`,
`biggestTableByName`); build `lib/carousel/person.js`, `context.js`,
`lifecycle.js`; read-only coach enumeration from both saves.
**Prereqs.** None. All research needed is in FINDINGS.
**Done when.** `carousel-list-coaches` returns every coach from both saves as a
`Person + CoachFacet`, with a unit test asserting round-trip fidelity of the 19
shared Person fields. `npm test` still green — `pipeline.js` behaviour unchanged.
**Blocking questions.** None.

### Phase 1 — The map layer (no writes)
**Goal.** `coachFieldMap.js` (§2 as data), `enumBridge.js`, `levelScale.js`,
`archetypeMap.js`, `schemeLookup.js` (derived at load), `synthesis.js`.
Plus a **dry-run diff report**: pick a coach, pick a destination, print every
field with its action and resulting value.
**Prereqs.** Phase 0.
**Done when.** A CFB coach can be fully mapped to a Madden coach record *on
paper*, with every one of the 156 fields accounted for and no field silently
defaulted. Startup assertion for the nine identical enums. Tests for the
enum-bridge drift cases (`ContractStatus.FreeAgent` 7→1) and the scheme
pointer→name derivation.
**Blocking questions.** None — the dry run is exactly how V1/V3/V5 get set up.

### Phase 2 — CFB → NFL, one way
**Goal.** Actually write a coach into a Madden save. Destination-row allocation
(343 free slots), `Team.<slot>` reciprocal wiring, displaced-coach handling,
backup-before-write.
**Prereqs.** Phase 1. **Q1 (V3), Q2 (V1), Q5 (V2), Q8 (V6) resolved.**
**Done when.** A CFB head coach appears correctly in Madden's Coach Central with
a sane level, a rendered face, a valid scheme, and the team shows them as HC —
and the save reloads cleanly and sims a season.
**Blocking questions.** Q1, Q2, Q5, Q8. Q3 can ship with the Pythagorean estimate.

### Phase 3 — NFL → CFB
**Goal.** The reverse direction: 13-value archetype expansion, prestige-P70,
job-security 80, CoachPoints 0, `SpecialtyType` derivation, landing-slot choice
(blank filler shells vs fresh rows), `ActiveTalentTree` row creation.
**Prereqs.** Phase 2. **Q4 (AlmaMater), Q6 (IsNIL/Pipeline/TalentTree), V8 resolved.**
**Done when.** A Madden coach appears in a CFB dynasty at the right prestige tier,
gets hired by or assigned to a school, and survives an advance.
**Blocking questions.** Q4, Q6.

### Phase 4 — Bidirectional carousel automation
**Goal.** Move from "user moves one coach" to "run the carousel": propose moves
(a top CFB HC gets an NFL job; a fired NFL HC returns to college), multi-coach
batches, deterministic seeding, an offseason-timing model.
**Prereqs.** Phases 2 + 3. **Q7 (V7) resolved — this phase is blocked on it.**
**Done when.** One command produces a coherent, reproducible carousel across both
saves that survives an advance in both games.
**Blocking questions.** Q7 is a hard gate. If the games' own hiring evaluators
overwrite injected coaches, automation must be restricted to a specific offseason
week, and that constraint has to be discovered before the UX is designed.

### Phase 5 — Retired player → coach
**Goal.** `Person + PlayerFacet` → `Person + CoachFacet`. Derive `Position` from
the player's playing position, `COACH_SPECIALTY` from position group,
`Level`/`Archetype` from career accomplishment, `COACH_WASPLAYER = true`; carry
the head/portrait straight through (a real advantage — the player already has a
valid destination-game head, so §3.5's synthesis is unnecessary here).
**Prereqs.** Phases 0–3. The Person core must be load-bearing by now, not aspirational.
**Done when.** A retired Madden player appears as a coach in either league with a
recognisable face and a plausible level.
**Notes.** CFB's data model already expects this (483/497 coaches are ex-players)
— this phase is aligning with the game, not fighting it.

---

## 7. Risks & unknowns register

| # | risk | severity | evidence | mitigation |
|---|---|---|---|---|
| R1 | **The game's own hiring/carousel evaluator overwrites injected coaches** | **critical** | CFB has 6 `CoachCarousel*` tables + `StaffHiringEval`; Madden has `StaffHiringPeriod*`, `CoachCentralEval` | V7 before Phase 4. Restrict writes to a verified offseason week; treat automation as gated |
| R2 | **Scheme pointer values are save/patch-specific** | high | Madden pointers span two bands (`104xxx`, `122xxx`) — likely base vs. title update. Target asset tables aren't in the save at all | Derive the pointer→name map at load from the live saves (§3.3). Never hardcode. Fail loudly if derivation yields fewer than N pointers |
| R3 | **Schema drift on game patches** | high | Both games are new; the app already carries a `schemaOverride` to `data/schemas/CFB27_809_0.gz` because the auto-detected `468/2` schema was insufficient | Startup assertion on the 9 byte-identical enums and on Coach field presence. Version the field map. Refuse to write on mismatch rather than corrupting |
| R4 | **Zeroed `COACH_*` grades tank Madden's sim** | high | CFB is all-zero; Madden's default and p50 are both **50**. A zeroed coach is far outside Madden's distribution | V1. Default to 50-flat rather than 0 until proven otherwise — 0 is the *riskier* default, not the safe one |
| R5 | **Enum value drift silently writes wrong data** | high | `ContractStatus.FreeAgent` 7 vs 1; `Retired` 8 vs 2; `CoachBackstory.Count_` 13 vs 4 | The enum-bridge rule, enforced by making raw-value writes impossible in the writer's API. V4 |
| R6 | **Faces don't carry** | medium | CFB coach `CharacterVisuals` contains **no head loadout**; three non-overlapping head namespaces | Synthesize from a baked destination-side catalog (§3.5), the pattern `appearanceCatalog.js` already proved for players |
| R7 | **Level conversion produces cartoonish coaches** | medium | CFB OC p50 = 33 vs Madden OC p50 = 6 — a naive map is 5× off | Position-conditioned mapping + V3 before anything else is tuned |
| R8 | **Broken Team↔Coach wiring corrupts the save** | medium | Two independent pointers describe one relationship (`Coach.TeamIndex`, `Team.<slot>`) | V6. Always write both. Mandatory backup-before-write; the app already has a save-as flow (`pick-save-location`) to follow |
| R9 | **`Position` sentinel collision** | medium | CFB `NumCollegeCoaches` = 3 = `SpecialTeams` | Whitelist HC/OC/DC only; reject everything else at the map layer |
| R10 | **Thin Madden sample distorts every percentile rule** | medium | 127 filled coaches; 37 HC / 46 OC / 44 DC. Prestige P70 shifts 609→1190 depending on cohort | Always position-matched cohorts; blend percentile with a linear anchor; validate against a second Madden save |
| R11 | **CFB "free agent" coaches are blank shells, not coaches** | low | All 68 have `Level=0`, `SpecialtyType=Any`, `CoachPrestige=Dminus`, `TeamIndex=255` | Never treat CFB FAs as a source pool. They are good *destination* slots — V8 |
| R12 | **Shared ≠ populated** | low but pervasive | `TeamBuilding` 497/497 `Balanced`; `TradingTendency` 497/497 `DoesNotTrade`; `CoachBackstory` 496/497 `Motivator`; `LegacyScore`, `ContractSalary`, all `COACH_*` grades zero in CFB | §2 marks every such field `SYNTH` explicitly. Never infer "shared field → safe copy" |
| R13 | **Offset-encoded ints read back raw** | low | `Weight` schema `[150..512]` reads as 10–151 (offset +160); `AlmaMater` schema `[1100..1300]` reads as a 0–150 TeamIndex | Read and write through the same library API; never hand-compute from schema bounds. `pipeline.js:decodeWeight` is the precedent |
| R14 | **Table capacity** | low | Madden Coach 343 free slots, CFB 135 | Check headroom before a batch; fail with a clear message rather than growing a table |

---

## Appendix — reproducing the research

```bash
node research/probe01-coach-schema.js      # field union/diff, type + enum mismatches
node research/probe02-enums.js             # every Coach-reachable enum, both games
node research/probe03-coach-records.js     # record distributions, all 156 fields
node research/probe04-references.js        # what the reference fields point at
node research/probe05-schemes.js           # table inventory + scheme pointer inventory
node research/probe06-basescheme.js        # named BaseScheme vocabulary, both games, auto-aligned
node research/probe07-scheme-crossref.js   # pointer -> BaseScheme name, joined via Team
node research/probe08-visuals-level.js     # CharacterVisuals, Level ladders, prestige percentiles
node research/check-coverage.js            # asserts section 2 accounts for all 156 fields
```

Override save paths with `CFB_SAVE=... MAD_SAVE=... node research/probeNN-*.js`.
All probes are strictly read-only; none calls `.save()`.
