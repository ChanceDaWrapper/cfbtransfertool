# Coaching Carousel — Research Findings (read-only probes)

Supporting notes for `COACH_CAROUSEL_ROADMAP.md`. Everything here was produced by
the read-only probes in this directory against the two sample saves. No save was
written; no probe calls `.save()`.

**Saves probed** (paths are the defaults in `research/_saves.js`, resolved from
the current user's home directory)
- CFB27: `~/Documents/EA SPORTS College Football 27/saves/DYNASTY-<name>`
- Madden 26: `~/Documents/Madden NFL 26/Saves/CAREER-<name>`

**Re-run**: `node research/probeNN-*.js` (override paths with `CFB_SAVE=` / `MAD_SAVE=`).
JSON output lands in `research/out/`.

| probe | question |
|---|---|
| `probe01-coach-schema.js` | Coach field union/diff, type + enum mismatches |
| `probe02-enums.js` | every Coach-reachable enum, member-by-member, both games |
| `probe03-coach-records.js` | record-level distributions for all 156 fields |
| `probe04-references.js` | which reference fields point where |
| `probe05-schemes.js` | full table inventory; scheme pointer inventory |
| `probe06-basescheme.js` | the named `BaseScheme` vocabulary in both games, auto-aligned |
| `probe07-scheme-crossref.js` | Coach scheme *pointer* → `BaseScheme` *name*, joined via Team |
| `probe08-visuals-level.js` | CharacterVisuals blob structure; Level percentile ladders; prestige percentiles |

---

## 1. Corrections to the briefing document

The brief's stated facts were mostly right but several load-bearing ones are
wrong. These corrections change design decisions, so they lead.

| # | Brief said | Probe found | Consequence |
|---|---|---|---|
| C1 | 101 shared fields | **102** shared, 35 CFB-only, 19 Madden-only (137 CFB / 121 Madden attrs) | Field table must cover 156 rows |
| C2 | "Position enum — compatible" | Types **differ**: CFB `CoachPosition` (13 members) vs Madden `StaffPosition` (12). `HeadCoach`/`OC`/`DC` do hold values 0/1/2 in both, but CFB adds `NumCollegeCoaches=3` **colliding with `SpecialTeams=3`** | Map by **name**, never by raw value. Safe for HC/OC/DC only. |
| C3 | `ContractStatus` is a direct-copy contract field | **Value drift**: `FreeAgent` cfb=7/mad=1, `Retired` cfb=8/mad=2, `Expiring` cfb=1/mad=4, `Deleted` cfb=9/mad=3, `None` cfb=10/mad=5. CFB has 9 extra members incl. **`PendingNFL`** | A raw copy silently corrupts contract state. Name-mapped lookup, mandatory. |
| C4 | `CoachBackstory` is shared → copy directly | Same enum *name*, different members. CFB adds 9 (`HCMotivator`,`HCSchemer`,`HCSalesman`,`OC*`,`DC*`); `Count_`/`Invalid_` drift. **And CFB doesn't use it** — 496/497 coaches are `Motivator`. Madden *does* use it (Strategist 59 / Motivator 44 / TeamBuilder 24) | CFB→Madden must **synthesize** backstory; Madden→CFB can copy-or-default |
| C5 | Madden `Archetype` has 3 values | Enum has **8**: `OffensiveGuru`, `DefensiveGenius`, `PersonnelCzar`, `DevelopmentWizard`, `HeadScout`, `HeadTrainer`, `MasterMotivator`, `MasterMotivator_JohnMadden`. Only 3 are *observed* on coaches | The mapping is 13↔8, not 12↔3. `MasterMotivator` exists on **both** sides — a free 1:1 anchor. |
| C6 | CFB `DominantArchetype` has 12 values | **13** real members — brief missed `Rainmaker` and `Visionary` (both unobserved in this save) | Expansion table needs 13 rows |
| C7 | Schemes are "same 32-bit width, game-specific enums, not a shared bitmap" | They are **reference pointers**, not enums — `{tableId, rowNumber}` into asset tables that **do not exist inside the save** (CFB tableIds 16433/16456/16482, Madden 16384). A raw copy points at a table that isn't there. | Confirms "needs a lookup", but for a harder reason. See §4 — the lookup is now fully derived. |
| C8 | Level scale "CFB ~85 max vs Madden ~49" | Schema **bounds** are CFB `int[0..100]`, Madden `int[1..50]` — an exact 2:1 declared range. But the **observed distributions are not 2:1**, and diverge by position. | Q1 answer is a position-conditioned percentile map, not `/2`. See §3. |
| C9 | `COACH_SPECIALTY`/`SpecialtyType` treated as one thing | Two separate fields. `COACH_SPECIALTY` is **shared and byte-identical** (11 members, same values). `SpecialtyType` (Offense/Defense/Any) is **CFB-only**. | Side inference on Madden→CFB must derive `SpecialtyType` from `COACH_SPECIALTY`. |

---

## 2. Architecture facts confirmed in the save schemas

**The games already have a Person type.** Schema base chains:

```
CFB27                              Madden 26
Coach   → CoachingStaffPerson      Coach   → CoachingStaffPerson
Owner   → CoachingStaffPerson      Owner   → CoachingStaffPerson
Scout   → StaffPerson → Person     Scout   → RenderableStaffPerson
Trainer → StaffPerson → Person     Trainer → RenderableStaffPerson
GM      → StaffPerson → Person     GM      → RenderableStaffPerson
Player  → FootballPlayer           Player  → FootballPlayer
```

`Coach` and `Player` share a real field core in both games:

- CFB (22): `IsUserControlled, Age, FirstName, IsCreated, IsLegend, LastName,
  PresentationId, PrevTeamIndex, TeamIndex, Position, CareerStats,
  CharacterBodyType, CharacterVisuals, ExperiencePoints, GenericHeadAssetName,
  Height, LegacyScore, Personality, SeasonStats, Weight, YearlyAwardCount, IsNIL`
- Madden (21): same minus `CareerStats`/`SeasonStats`/`IsNIL`, plus
  `ContractLength`/`ContractStatus`

That 19-field intersection is the empirical Person core the roadmap's identity
layer should be built on — and it is exactly what a retired-player→coach feature
needs to carry.

**CFB27 already runs a coach carousel.** Tables present in the CFB save:
`CoachCarouselStartEvent`, `CoachCarousel_PostSeasonWeekStartReaction`,
`CoachCarousel_PostSeasonWeekEndReaction`, `CoachCarousel_RegularWeekStartReaction`,
`CoachCarousel_UserRegisterReaction`, `CoachCarousel_UserUnregisterReaction`,
plus `StaffHiringEval`, `StaffMovesRequest`, `CoachRetirementEval`.
And `StaffPersonContractStatus` in CFB has a **`PendingNFL`** member.
CFB models "coach leaves for the NFL" natively.

Madden's equivalents: `StaffHiringEval`, `CoachCentralEval`, `CoachComebackStartEvent`,
`DemandReleaseCoachStartEvent`, `InductHallOfFameCoachesDataFlow`.

**Table capacity headroom** (no need to grow tables):
- Madden `Coach`: capacity 470, filled 127 → **343 free slots**
- CFB `Coach`: capacity 632, filled 497 → **135 free slots**

**Team↔Coach wiring.** `Team.HeadCoach` / `.OffensiveCoordinator` /
`.DefensiveCoordinator` are references *into* the Coach table, and
`Coach.TeamIndex` points back. Both sides must be written for a real hire.
- CFB `Team` table capacity 143 (143 named schools); `TeamIndex` range `[0..255]`, **255 = unassigned** (`FCS West` placeholder pool).
- Madden `Team` capacity 37 (35 named); `TeamIndex` range `[0..32]`, **32 = free-agent pool**.
- CFB has two Coach tables (ids 4173, 6110); Madden two (4160, 5899). Always take the largest by `recordCapacity`, as `pipeline.js:buildTeamNames` already does for `Team`.

---

## 3. Level: the actual scales (Q1)

Full percentile ladders, from `probe08`. `n` = filled coaches at that position.

| percentile | CFB HC (n=144) | MAD HC (n=37) | CFB OC (n=161) | MAD OC (n=46) | CFB DC (n=191) | MAD DC (n=44) |
|---|---|---|---|---|---|---|
| p10 | 20 | 9 | 0 | 0 | 0 | 0 |
| p25 | 29 | 12 | 16 | 3 | 5 | 4 |
| p50 | 41 | 23 | 33 | 6 | 26 | 13 |
| p70 | 49 | 31 | 40 | 8 | 38 | 14 |
| p90 | 67 | 41 | 47 | 11 | 46 | 18 |
| p100 | 87 | 49 | 61 | 49 | 63 | 19 |

Schema bounds: CFB `int[0..100]` (observed max 87), Madden `int[1..50]` (observed max 49).

**What this says.** A flat `cfbLevel / 2` is a decent approximation *for head
coaches* (CFB HC p50 41→20.5 vs Madden's actual 23; p90 67→33.5 vs 41) but it is
badly wrong for coordinators — CFB OC p50 33→16.5 against a Madden OC p50 of **6**.
Madden coordinators are compressed into roughly the bottom fifth of the Level
range; CFB coordinators occupy the same band as its head coaches. Any conversion
that ignores position will produce Madden coordinators three to five times higher
level than the league they're joining.

Madden's own `Level` distribution is also thin (37 HCs, 46 OCs) — a percentile map
built from one save will be lumpy. See roadmap Q1 for the proposed hybrid.

---

## 4. The scheme lookup table — derived, not guessed (§C7 follow-up)

Two representations coexist:
- `Team.CurrentOffensiveScheme` / `DefaultOffensiveScheme` — a **`BaseScheme` enum with readable names**
- `Coach.OffensiveScheme` / `DefensiveScheme` — a **`Scheme` reference pointer**

`probe07` joins them (each Team's readable enum value against the Coach row that
team's `HeadCoach` reference points at) and recovers the pointer→name mapping
empirically. Nearly every pointer resolved **PURE** (one name only).

### 4a. The `BaseScheme` vocabulary, both games

Structurally identical: 22 slots, offense 0–10, defense 11–19, same sentinels
(`Offense_First_=0`, `Offensive_Last_=10`, `Defense_First_=11`, `Defense_Last_/Count_=20`, `Locked=21`).
The **names at each slot are different vocabularies**.

| slot | CFB27 | Madden 26 | same name? |
|---|---|---|---|
| 0 | `OFF_WEST_COAST_ZONE_RUN` | `WestCoastZoneRun` | ✅ |
| 1 | `OFF_MULTIPLE_OFFENSE` | `WestCoastPowerRun` | ❌ |
| 2 | `OFF_VEER_AND_SHOOT` | `VerticalZoneRun` | ❌ |
| 3 | `OFF_POWER_SPREAD` | `MultipleZoneRun` | ❌ |
| 4 | `OFF_SPREAD_OPTION` | `MultiplePowerRun` | ❌ |
| 5 | `OFF_PRO_STYLE` | `VerticalPowerRun` | ❌ |
| 6 | `OFF_SPREAD` | `Spread` | ✅ |
| 7 | `OFF_RUN_AND_SHOOT` | `RunAndShoot` | ✅ |
| 8 | `OFF_AIR_RAID` | `AirRaid` | ✅ |
| 9 | `OFF_PISTOL` | `Pistol` | ✅ |
| 10 | `OFF_OPTION` | `WestCoastSpread` | ❌ |
| 11 | `DEF_BASE4_3` | `Base4_3` | ✅ |
| 12 | `DEF_3_3_5` | `Under4_3` | ❌ |
| 13 | `DEF_BASE3_4` | `Base3_4` | ✅ |
| 14 | `DEF_4_2_5` | `Under3_4` | ❌ |
| 15 | `DEF_MULTIPLE_DEFENSE` | `Tampa2` | ❌ |
| 16 | `DEF_4_3_MULTIPLE` | `Quarters4_3` | ❌ |
| 17 | `DEF_3_4_MULTIPLE` | `Disguise3_4` | ❌ |
| 18 | `DEF_3_3_5_TITE` | `Storm3_4` | ❌ |
| 19 | `DEF_3_2_6` | `Cover3_4_3` | ❌ |
| 20 | `DEF_UNUSED` | `Defense_46` | ❌ |

**7 of 20 slots are name-identical at the same index.** An index-preserving copy
would get those 7 right and produce 13 valid-but-wrong schemes. Not acceptable.

### 4b. `Coach.OffensiveScheme` pointer → name (derived by probe07)

CFB27 (`tableId 16433`), all PURE:

| rowNumber | scheme | teams |
|---|---|---|
| 111488 | `OFF_AIR_RAID` | 14 |
| 111492 | `OFF_SPREAD_OPTION` | 18 |
| 111493 | `OFF_POWER_SPREAD` | 25 |
| 111494 | `OFF_PISTOL` | 3 |
| 111495 | **unresolved** (3 coaches, no team join) | — |
| 111496 | `OFF_SPREAD` | 49 |
| 111500 | `OFF_PRO_STYLE` | 2 |
| 111501 | `OFF_VEER_AND_SHOOT` | 12 |
| 111502 | `OFF_MULTIPLE_OFFENSE` | 17 |
| 111503 | `OFF_OPTION` | 3 |

Unassigned CFB offensive names: `OFF_WEST_COAST_ZONE_RUN`, `OFF_RUN_AND_SHOOT`.
Only one unresolved pointer (111495) — needs one in-game read.

CFB27 defensive (`16433`) — **complete, all 9 observed slots resolved**:

| rowNumber | scheme | note |
|---|---|---|
| 111484 | `DEF_3_4_MULTIPLE` | PURE (22) |
| 111485 | `DEF_3_3_5_TITE` | PURE (11) |
| 111486 | `DEF_3_2_6` | PURE (1) |
| 111487 | `DEF_4_3_MULTIPLE` | PURE (6) |
| 111489 | `DEF_BASE3_4` | PURE (9) |
| 111490 | `DEF_BASE4_3` | 7/8 |
| 111497 | `DEF_MULTIPLE_DEFENSE` | PURE (14) |
| 111498 | `DEF_4_2_5` | 52/53 |
| 111499 | `DEF_3_3_5` | 17/19 |

The union `111484..111503` is a contiguous 20-value block = exactly the 20
`BaseScheme` slots, permuted. Useful invariant for validating a rebuild.

Madden 26 (`tableId 16384`):

| rowNumber | offensive scheme | | rowNumber | defensive scheme |
|---|---|---|---|---|
| 104572 | `Spread` | | 104581 | `Base4_3` |
| 104574 | `WestCoastZoneRun` | | 104582 | `Under4_3` |
| 104575 | `VerticalZoneRun` | | 104583 | `Under3_4` |
| 104576 | `MultiplePowerRun` | | 104584 | `Base3_4` |
| 104577 | `MultipleZoneRun` | | 104585 | `Defense_46` |
| 104578 | `VerticalPowerRun` | | 122542 | `Storm3_4` (5/6) |
| 104579 | `WestCoastPowerRun` | | 122544 | `Disguise3_4` |
| 104580 | `RunAndShoot` | | 122649 | `Cover3_4_3` |
| 122479 | `WestCoastSpread` (5/6) | | | |
| 122541 | `AirRaid` | | | |

Missing from observation: `Pistol` (off), `Tampa2` / `Quarters4_3` (def).
Note the two numeric bands (104xxx vs 122xxx) — likely base vs. title-update
assets. **These pointers are save/patch-version-specific and must be re-derived,
never hardcoded.** See roadmap R2.

---

## 5. CharacterVisuals portability (Q5) — answered: NOT portable for the head

Both games store the same JSON envelope
(`loadouts[].loadoutType / loadoutCategory / loadoutElements[].slotType / itemAssetName`,
plus optional top-level `bodyType` / `skinTone`). 100% parse rate on both sides
(CFB 201/201, Madden 125/125).

But the contents diverge:

| | CFB27 coach | Madden 26 coach |
|---|---|---|
| loadouts present | `CoachOnField`/`CoachApparel` **only** | `CoachOnField`/`CoachApparel` **+ `Head`/`Head`** |
| head carried in blob | ❌ never | ✅ `PlusHead` → `coachhead_M_0013_HS` |
| coaches with a visuals ref | 201 / 497 (296 null) | 125 / 127 |
| example item names | `CoachWardrobe_LeatherSneakerWhite`, `UC_Hat_None` | `CoachWardrobe_Shoe`, `CoachWardrobe_Hat`, `UC_Headset_1` |
| shared item names | `CoachWardrobe_Polo`, `CoachWardrobe_Pants` | same |

And the head-asset naming vocabularies have **zero overlap** — there are three
distinct namespaces:

- CFB `GenericHeadAssetName`: `Generic_0103_C_T0102_H_2_3`, `Unique_C_AltmanGarrett_900` (374 distinct)
- Madden `GenericHeadAssetName`: `coachhead_M_0013_HS` (94 distinct)
- Madden `FaceShape` enum: `coachhead_7_M_N_30`, plus named NFL figures (`BelichickBill`, `ReidAndy`, …), 231 members

Madden's own two head namespaces don't even match each other. Observed `FaceShape`
values: `Invalid_` 93, `MustBeUnique` 25, and 9 one-off named legends — so live
Madden coaches carry their head in `CharacterVisuals`, not `FaceShape`.

**Conclusion**: copying `CharacterVisuals` across games cannot preserve a face,
because CFB's blob doesn't contain one. The apparel loadout is structurally
copyable but references partly game-specific item names. The head must be
**synthesized from a Madden-side catalog** — exactly the pattern
`lib/appearanceCatalog.js` already established for players (it baked EA's own
shipped `(faceId, head)` pairs out of `CAREERDRAFT-*` files rather than guessing).

---

## 6. Field-population reality check

Fields the brief treats as meaningful that are **dead in one or both saves** —
these change synthesis decisions:

| field | CFB27 | Madden 26 | implication |
|---|---|---|---|
| all `COACH_*` position grades | **0 across all 497** | populated; `COACH_RATING` p50=**50** (= schema default), mean 57.6 | Q2: Madden's neutral is 50, not 0. Zeroing is out-of-distribution. |
| `LegacyScore` | **0 across all 497** | p50=395, max=20000 | CFB→Madden must synthesize or zero |
| `ContractSalary` | 496/497 zero | p50=300 (=$300k?), max=4000 | CFB has no salary model; must synthesize on transfer up |
| `CoachBackstory` | 496/497 `Motivator` | genuinely varied | synthesize CFB→Madden |
| `Personality` | 318/497 `Unpredictable` | 126/127 `Unpredictable` | effectively unused both sides; safe passthrough |
| `TeamBuilding` | **497/497 `Balanced`** | varied (Balanced 101 / Draft 22 / FA 4) | synthesize CFB→Madden |
| `TradingTendency` | **497/497 `DoesNotTrade`** | varied | synthesize CFB→Madden |
| `Weight` | varied (raw 10–151 → 170–311 lb) | **10 for all 127** (→170 lb) | Madden doesn't model coach weight; don't trust it Madden→CFB |
| `OffenseAudibles` / `DefenseAudibles` | null 497/497 | null 127/127 | drop both directions |
| `HasTrait` | null 497/497 | null 127/127 | drop |
| `AwardPoints`, `YearlyAwardCount`, `CareerTies`, `RegularWinStreak`, `COACH_CONSECTEAMCONTRACTS`, `COACH_RETIREYRSLEFT`, `CareerBigWinMargin`, `CareerBigLossMargin` | all zero | mostly zero | copy-as-zero is harmless |
| `HomeTown` | reference, **0:0 for every coach** | absent | never populated; don't try to carry it |
| `HomeState` | 236/497 = `Alabama` — but every one of those is a `TeamIndex=255` filler coach | absent | `Alabama` here is the *unset* value, not real data |
| `PersuadeAttempts`, `NumContractOffers`, `EarnedContractPoints_ThisYear` | all zero | absent | transient in-season state |

**`AlmaMater` decoded**: despite a schema range of `[1100..1300]`, the stored
values read back as `0..150` and index directly into `Team.TeamIndex` —
e.g. `AlmaMater=87` → `TCU`, `107` → `Wake Forest`, `11` → `Boise State`.
It is a CFB TeamIndex, and therefore meaningless to a Madden save.

**The CFB "free agent" pool is not a pool of real coaches.** All 68
`ContractStatus=FreeAgent` CFB coaches have `Level=0`, `SpecialtyType=Any`,
`PrevPosition=Invalid_`, `CoachPrestige=Dminus`, `TeamIndex=255`. They are blank
filler shells. That is good news for Madden→CFB: they are the natural landing
slots for an incoming NFL coach. Madden's 30 free agents *are* real (Levels 0–9,
`CareerAssistant` true for 17) but low-level.

**Prestige percentiles** (for the P70 synthesis rule; note the heavy skew —
this is precisely why it must be read live, not hardcoded):

| | n | p25 | p50 | **p70** | p75 | p90 | max | zeros |
|---|---|---|---|---|---|---|---|---|
| `CoachPrestigeScore`, all coaches | 497 | 6 | 194 | **609** | 778 | 3126 | 10000 | 114 |
| `CoachPrestigeScore`, head coaches only | 144 | 89 | 634 | **1190** | 1627 | 3398 | 10000 | 4 |

The two differ by ~2×. The roadmap specifies which cohort to draw from.

---

## 7. Enum stability summary

Byte-identical in both games (safe to pass through by value):
`COACH_ADAPTIVE_AI`, `COACH_DEMEANOR`, `COACH_SPECIALTY`, `COACH_STANCE`,
`CharacterBodyType`, `Personality`, `Portrait_Swappable_Library_Path`,
`TeamBuilding`, `TradingTendency`.

Require name-based mapping:
`Position` (type differs, sentinel collision), `ContractStatus` (value drift),
`CoachBackstory` (value drift + CFB-only members).

One-sided, no counterpart:
CFB `CoachTalentArcheType`, `LetterGrade`, `JobSecurityStatus`,
`ContractExpectations`, `CoachSpecialtyType`, `CoachHatType`, `Pipeline`,
`StateName`, `CoachNoHuddleTempo`, `ActiveTalentTree` /
Madden `StaffArchetypeEnum`, `CoachFace`.

**General rule this establishes**: in this schema family, enum *member names* are
stable across the two games where a concept is shared, but *numeric values* are
not. Every enum crossing must go through `getMemberByName`, never a raw integer.

---

## 8. Archetype ↔ specialty, empirically

Madden `Archetype` × `COACH_SPECIALTY` — the side alignment is strong:

| | QB | RB | WR | OL | DL | LB | DB |
|---|---|---|---|---|---|---|---|
| `OffensiveGuru` (65) | 32 | 7 | 13 | 9 | 1 | 2 | 1 |
| `DefensiveGenius` (54) | 2 | 3 | – | 4 | 12 | 17 | 16 |
| `DevelopmentWizard` (8) | 3 | – | – | 1 | 1 | 1 | 2 |

61/65 `OffensiveGuru` have an offensive specialty; 45/54 `DefensiveGenius` a
defensive one. `DevelopmentWizard` is side-agnostic. This validates
"specialty determines the side, archetype determines the flavor."

CFB `DominantArchetype` × `SpecialtyType` — **no archetype predicts a side**;
every one splits roughly evenly:

| archetype | Offense | Defense | Any |
|---|---|---|---|
| `Schemer` (86) | 27 | 20 | 39 |
| `Recruiter` (86) | 36 | 36 | 14 |
| `Motivator` (74) | 31 | 32 | 11 |
| `SchemeGuru` (65) | 31 | 34 | – |
| `MasterMotivator` (65) | 35 | 30 | – |
| `EliteRecruiter` (42) | 28 | 14 | – |
| `Architect` (20) | 9 | 11 | – |
| `Strategist` (16) | 13 | 3 | – |
| `ProgramBuilder` (13) | 9 | 4 | – |
| `TalentDeveloper` (8) | 4 | 4 | – |
| `CEO` (3) | 2 | 1 | – |
| `Invalid_` (19) | – | – | 19 |

So CFB→Madden archetype **must** read `SpecialtyType`/`COACH_SPECIALTY` for the
side and use `DominantArchetype` only to pick between guru/genius and
`DevelopmentWizard`. `Rainmaker` and `Visionary` do not occur in this save.

`SpecialtyType=Any` (83 coaches) is the ambiguous bucket the roadmap's fallback
rule exists for — and it correlates exactly with `Invalid_`/filler coaches.
