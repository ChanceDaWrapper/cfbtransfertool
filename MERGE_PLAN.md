# Merge Plan — `cfbtransfertool` + `cfb2madden` → Unified Converter

Status: **PROPOSAL — no code changed yet.** Implementation begins only after approval.

Analyzed:
- `cfbtransfertool` (ChanceDaWrapper) — the app we build here (now released as **Pipeline**).
- `cfb2madden` (seanpdwyer7) — cloned fresh from GitHub at v0.0.7 (`@RoamingAnalyst`).

Neither is treated as the source of truth. Below is a subsystem-by-subsystem
judgment of which implementation is stronger, followed by the target pipeline,
file-level changes, and a phased plan.

---

## 1. Architecture of each project

### cfbtransfertool (this repo)
- **Runtime:** Electron, `madden-franchise ^3.8.0` (npm), CFB schema `CFB27_schema.gz` (major 468 / minor 2 — **Franchise namespace only**).
- **`lib/pipeline.js`** — the whole pipeline:
  - `extractLeavingPlayers` — reads the `LeavingPlayer` table **only** (requires the dynasty be at the players-leaving stage; throws otherwise). Reads `PlayerAward` table, tiers awards, sums per player.
  - `calibratePlayers` — the crown jewel: **quantile mapping** onto real Madden per-position rating distributions (`quantile_calibration.json`), **per-position physical flat-drop calibration** (`position_calibration.json`), a **bell-curve "squeeze"**, per-rating adjustments, seedable RNG.
  - `estimateMaddenOverall` — **per-archetype linear regression** fit and cross-validated against real Madden data (`overall_formula.json`).
  - `selectDeparted` — draft-order sort: `overall + projected round + awards + athleticism z-score + position value` (all config-weighted).
  - `assignDevTraits` — **weighted-random-without-replacement** per tier (log-space keys), weighted by est. overall + athleticism + awards + CFB dev tier; **fresh RNG each run → regeneration variance**; target counts stay stable.
  - `writeCareerFile` — overwrites the franchise's incoming rookie slots in place, syncs `DraftPlayer` (DraftPosition / InitialDraftRank / TrueOverallRanking / ProductionGrade), skin tone via **head-asset-pool swap**.
- **`lib/defaults.js`** — full config system: `DEFAULT_CONFIG` (general / bell / positionExtraDrop / positionCaps / ratingAdjustments / devTraits / positionValue / draftValue), tooltip descriptions, grouped rating-column order, physical + position-specific highlight sets.
- **`main.js` / `preload.js`** — Electron IPC (config get/set/reset/import/export, extract-pool, generate-class, write-career, export-results, file pickers).
- **`renderer/`** — **multi-page config studio**: Dashboard, Draft Class board, Position Weights, Physical Attributes, Advanced. Two-color attribute highlighting, dev-trait badges, per-position knobs, live warnings, config summary.
- **`data/`** — `position_calibration.json`, `quantile_calibration.json`, `overall_formula.json`, `college_lookup.json`, (+ gitignored `real_draft_classes_veteran.json`).

### cfb2madden (seanpdwyer7)
- **Runtime:** Electron, `madden-franchise 4.3.0` (**vendored tarball, ahead of npm**) + `madden-file-tools`, CFB schema `CFB27_809_0.gz` (major 809 — **full Core+Football+Franchise**, unlocks the Team table, SeasonStats, correct CharacterVisuals decode).
- **`src/readCfbClass.mjs`** — dynasty reader:
  - Preferred `LeavingPlayer` source **AND a synthesized fallback** for earlier stages (all seniors + draft-worthy juniors) → **works before the players-leaving week**.
  - **Career stat aggregation** — sums `SeasonStats[]` into passYds/rushYds/recYds/TDs/tackles/sacks/INTs/games/gamesStarted.
  - School-name resolution with FCS-placeholder → previous-team fallback.
  - Long-snapper guarantee. Skin tone from `gen_<n>_` head names, fallback to CharacterVisuals `skinTone` JSON, loads full visuals JSON for the kept class.
- **`src/convert.mjs`** — projection + scaling + dev + combine:
  - `POS_VALUE` position premiums, `productionBonus` (this-season), `computeProfiles` (position-normalized **production + athleticism percentiles → Floor/Ceiling profile**), **Generational** prospect (≤1/class), **positional market saturation / demand model**, **hard R1 positional caps**.
  - `targetOvrForRank` (piecewise rookie curve) → `scaleRatings` (**multiplicative, elite-preserving, profile-aware**) — **ratings driven by draft slot**.
  - Round-aware dev traits with class caps; **`combineNumbers`** (40 / bench / vertical / broad / 3-cone / shuttle).
- **`src/writeMadden.mjs`** — overwrites `ContractStatus='Draft'` rows, writes `Original*` rating mirrors, **college binary IDs** (`Colleges.csv`), **commentary name IDs** (`commentary_lookup.json`), combine + pro-day numbers, `IsVisible`/scout flags, skin tone via **CharacterVisuals `json.skinTone`** write, optional **full-visuals transfer**.
- **`ui/`** — single-page **draft board**: sortable/filterable table with SLOT, PROFILE, PROD, ATH, CAREER stat-line columns, school/position/height/round filters, rating-cell heat coloring.
- **`data/`** — `CFB27_809_0.gz`, `Colleges.csv` (494), `commentary_lookup.json`, `ovrweights_26.json` (**real EA per-archetype OVR weights — present but currently unused**).
- **Docs:** `FORMAT-NOTES.md` (raw CAREERDRAFT byte format research), `DEVELOPMENT.md`.

---

## 2. Subsystem comparison — who wins, and why

| Subsystem | cfbtransfertool | cfb2madden | **Winner** | Merge action |
|---|---|---|---|---|
| **Dynasty reading / schema** | Franchise-only 468/2 schema, `madden-franchise 3.8.0` | Full 809 schema, `4.3.0` + `madden-file-tools`; unlocks Team, SeasonStats, ISON visuals | **cfb2madden** | Adopt 4.3.0 + 809 schema as the base. *(highest-risk change — see §6)* |
| **Draft declaration / stage detection** | `LeavingPlayer` only; hard-errors if too early | `LeavingPlayer` **or** synthesized (seniors + draft-worthy juniors); auto source detect | **cfb2madden** | Port the synthesized fallback + auto-detect + manual override. |
| **Player import / bio** | Solid bio + awards-table tiering | Bio + **career stat aggregation** + school FCS fallback + visuals JSON | **cfb2madden (breadth)** | Merge: keep awards-table tiering, add career-stat aggregation + school fallback. |
| **Rating conversion** | **Quantile map + position + physical calibration + bell curve** | Multiplicative `targetOvr/cfbOvr` scale (draft-slot-driven) | **cfbtransfertool** | Keep as the ratings authority. Optionally fold in "elite preservation"/"profile" as calibration *modifiers* (never as draft-rank coupling). |
| **Overall estimation** | **Per-archetype regression, cross-validated** | Unused `ovrweights_26.json` (real EA weights) | **cfbtransfertool** | Keep regression. Use `ovrweights_26.json` as a validation cross-check / optional alt-source. |
| **Draft projection** | overall + round + awards + athletic z + position value | **+ career production, floor/ceiling profile, generational, demand saturation, R1 caps** | **cfb2madden (richer)** | Port production, profiles, generational, saturation, R1 caps into the projection layer — feeding **draft order only**. |
| **Position value** | Config table (`positionValue`), tunable | Hardcoded `POS_VALUE` | **cfbtransfertool (tunable)** | Keep config table; seed defaults from the union of both. |
| **Production weighting** | none | per-position, this-season + career | **cfb2madden** | Port; expose weight in config (`draftValue`). |
| **Award weighting** | `PlayerAward` table, tiered/summed | `YearlyAwardCount` scalar | **cfbtransfertool (richer)** | Keep tiered awards; drop the scalar. |
| **Athletic profile** | athleticism z-score (draft order + dev weight) | position-normalized percentile + Floor/Ceiling profile | **complementary** | Merge into one athletic module feeding order + dev + display. |
| **Combine generation** | **none** | 40 / bench / vertical / broad / 3-cone / shuttle + pro-day | **cfb2madden** | Port wholesale into the write + board. |
| **Dev trait assignment** | **Weighted-random w/o replacement; regenerates with variance; stable counts** | Round-based caps, name-seeded → **identical every regenerate** | **cfbtransfertool** | Keep engine; enrich weights with production + profile + round (Phase 5). |
| **Character visuals / skin tone** | Head-asset-pool swap (verified 97.8% on 3.8.0) | CharacterVisuals `json.skinTone` write + optional full-visuals | **UNRESOLVED — see §6** | Empirically determine which actually changes in-game skin tone on M26; keep the winner, offer full-visuals as opt-in. |
| **Export / write pipeline** | Overwrites incoming rookie slots, DraftPlayer sync | Overwrites `Draft` rows, Original* mirrors, college IDs, commentary IDs, combine, scout flags, backup | **cfb2madden (more complete)** | Merge: take cfb2madden's field coverage; keep our slot-selection where stronger; add Original* mirrors, commentary, combine, scout flags. |
| **College mapping** | `college_lookup.json` | `Colleges.csv` (494) + alias/normalize/contains-match | **cfb2madden (matching logic)** | Adopt normalize+alias+containment matcher; reconcile the two data sets into one. |
| **Commentary names** | none | `commentary_lookup.json` → `PLYR_COMMENT` | **cfb2madden** | Port. |
| **UI** | Multi-page config studio, per-position knobs, highlighting | Single board w/ great columns + filters | **cfbtransfertool (depth)** | Keep the studio; adopt the board's SLOT/PROFILE/PROD/ATH/CAREER columns + school/height/round filters. |
| **Configuration / advanced settings** | Full tunable config + presets + warnings | Hardcoded constants | **cfbtransfertool** | Keep; add knobs for the new projection systems. |
| **CLI** | none | `cli.mjs` (dry-run, limit, out) | **cfb2madden** | Optional: port a CLI wrapper over the merged pipeline. |

---

## 3. What to keep (Phase 2)

**Foundation — from cfbtransfertool (unchanged philosophy: convert ratings accurately, then estimate overall):**
- Quantile mapping, position calibration, physical calibration, bell-curve squeeze, per-rating adjustments.
- Per-archetype regression overall estimation (`overall_formula.json`).
- Weighted-random dev-trait engine (regeneration variance, stable counts).
- Full configuration system, presets, warnings, tooltips.
- Multi-page Electron UI + two-color attribute highlighting + grouped columns.
- Position-value + draft-value config tables.
- Tiered `PlayerAward` extraction.

**Surrounding draft systems — from cfb2madden:**
- `madden-franchise 4.3.0` + full 809 CFB schema (foundation upgrade).
- Synthesized declarations + auto stage detection + manual override (earlier-dynasty support).
- Career stat aggregation → production weighting.
- Floor/Ceiling profiles + Generational prospect + demand saturation + hard R1 caps.
- Combine + pro-day generation.
- College binary-ID matching + commentary name IDs + `Original*` mirrors + scout flags.
- Board display niceties (SLOT / PROFILE / PROD / ATH / CAREER columns, filters).
- Optional full-visuals transfer.

---

## 4. Overlaps & which is superior (Phase 2 detail)

1. **Rating conversion** — both convert CFB→Madden ratings. cfbtransfertool's data-driven calibration is materially more accurate and configurable than cfb2madden's single multiplicative factor. **Keep cfbtransfertool; delete cfb2madden's `scaleRatings`/`targetOvrForRank` as the ratings path.**
2. **Draft ordering** — both compute a draft score. cfb2madden's is richer (production, profiles, saturation, caps). **Merge cfb2madden's signals into cfbtransfertool's config-weighted sort.**
3. **Dev traits** — both cap by tier. cfbtransfertool's randomized engine satisfies Phase 5's "varies each regenerate"; cfb2madden's is deterministic. **Keep cfbtransfertool; add cfb2madden's production/profile/round into the weight.**
4. **Skin tone** — both attempt it, **by different mechanisms that may not agree** (§6).
5. **College mapping** — same goal; cfb2madden's matcher is more robust. **Adopt its matcher, reconcile data.**
6. **Dynasty read** — both read `LeavingPlayer`; only cfb2madden also synthesizes. **Adopt the fallback.**

---

## 5. Files: modify / create / delete

**In this repo (`cfbtransfertool` becomes the merged app's home):**

Modify:
- `package.json` — swap `madden-franchise ^3.8.0` → vendored `4.3.0` (+ `madden-file-tools`); update build to include the vendored tarball.
- `lib/pipeline.js` — biggest change; split into focused modules (below). Re-point schema to 809; add synthesized read + stage detect; add career-stat aggregation; add projection module (production/profiles/generational/saturation/caps) feeding **order only**; add combine generation; enrich dev-trait weights; extend `writeCareerFile` (Original* mirrors, commentary, combine, scout flags, college matcher); resolve skin-tone mechanism.
- `lib/defaults.js` — new config for production weight, profile influence, generational toggle, R1 caps, combine; reconcile rating-field list (note ThrowAccuracyRating — kept out of display per prior decision).
- `main.js` / `preload.js` — IPC for stage detection + manual override, full-visuals toggle, board's extra columns.
- `renderer/*` — add SLOT/PROFILE/PROD/ATH/CAREER columns + school/height/round filters + stage/override control + full-visuals toggle.
- `README.md` / `CHANGELOG.md` — document the merged converter + credit both authors/licenses.

Create (recommended refactor of the monolith `pipeline.js`):
- `lib/read.mjs` (dynasty read + stage detect + stats), `lib/project.mjs` (draft order + profiles + combine — **no ratings**), `lib/convert.mjs` (calibration + overall — **no draft rank**), `lib/dev.mjs` (traits), `lib/write.mjs` (export).
- `data/CFB27_809_0.gz`, `data/Colleges.csv` (reconciled), `data/commentary_lookup.json`, `data/ovrweights_26.json` (cross-check).
- `vendor/madden-franchise-4.3.0.tgz`.

Delete / retire:
- cfb2madden's `targetOvrForRank` + `scaleRatings` (ratings path) — **not ported** (violates Phase 4).
- Old 468/2 `schema/CFB27_schema.gz` once 809 is verified across read + write.
- cfb2madden's `FORMAT-NOTES.md` raw-format writer plan — research only, not part of the proven franchise-overwrite path; keep as a doc if useful, don't implement.
- Redundant college data set after reconciliation.

---

## 6. Critical decisions that change the plan (need your call)

1. **Library/schema upgrade to 4.3.0 + 809 — foundational, highest risk.**
   It unlocks career stats, the Team table, and correct ISON `CharacterVisuals`. But **all of cfbtransfertool's calibration data and write code were built and verified on 3.8.0.** Everything (ratings, DraftPlayer sync, skin tone) must be re-verified against real saves after the swap. Recommendation: **do it**, gated behind a full re-verification pass, because the surrounding-systems goals (production, visuals) depend on it.

2. **Ratings ⟂ Projection decoupling (Phase 4) — I will enforce this.**
   cfb2madden currently derives ratings from draft slot (`targetOvrForRank → scaleRatings`). The merged converter will **not** do that. Ratings come solely from calibration; draft projection only sets round/pick/expected-OVR-range and dev-trait weighting. cfb2madden's "elite preservation" + "profile" ideas can be adopted **only** as calibration modifiers, never reintroducing rank→rating coupling.

3. **Skin-tone mechanism — genuinely unresolved, needs an empirical test.**
   Last session I concluded (on 3.8.0) that writing `json.skinTone` did nothing because the Madden rookie blob held only `{loadouts}`. cfb2madden (on 4.3.0, ISON) writes `json.skinTone` and reports it working. These may both be true depending on library version. **Before committing to one, I'll run a controlled write both ways on 4.3.0 and confirm in-game which actually changes skin tone.** Whichever wins is the merged mechanism; the other is dropped.

4. **`ovrweights_26.json` (real EA archetype weights) vs our regression.**
   Our regression is validated and I recommend keeping it, but the EA weights are a strong independent cross-check and a possible future replacement. Recommendation: keep regression, add a validation script comparing the two.

---

## 7. Target pipeline (Phase 3) with the Phase-4 separation enforced

```
Read Dynasty (809 schema, 4.3.0)
   ├─ detect stage (LeavingPlayer present?) → official OR synthesized declarations  [manual override]
   └─ per-player: bio + full ratings + career stats + awards + visuals/skin tone

        ├──────────────── DRAFT PROJECTION (order only — never touches ratings)
        │      production · awards · athletic profile · position value · experience · overall
        │      → floor/ceiling profile · generational · demand saturation · R1 caps
        │      → draftScore → rank → round/pick → expected rookie-OVR range
        │
        └──────────────── RATING CONVERSION (independent of draft rank)
               quantile mapping · position calibration · physical calibration · bell squeeze
               → Estimate Madden Overall (per-archetype regression)
               → optional rookie sanity check vs expected range (flag only, never overwrite)

   → Development Traits (weighted by converted overall + round + production + awards + athletic upside + age + randomness; fresh roll each regenerate, stable totals)
   → Combine results (from converted ratings)
   → Visual transfer (skin tone [+ optional full visuals])
   → Export to Madden (overwrite Draft rows: ratings + Original* mirrors, college, commentary, DraftPlayer rank/grade/combine/scout flags; backup)
```

The two middle branches run **independently** and only rejoin at dev-trait
weighting and the optional non-destructive sanity check.

---

## 8. Phased implementation plan (after approval)

- **P0 — Foundation swap & re-verify.** Vendor 4.3.0 + 809 schema; re-verify existing read/calibrate/estimate/write against real saves unchanged. Gate everything else on this passing. Resolve the skin-tone test (§6.3).
- **P1 — Read layer.** Synthesized fallback + auto stage detect + manual override; career-stat aggregation; school FCS fallback.
- **P2 — Projection module (order only).** Port production, profiles, generational, saturation, R1 caps into the config-weighted sort; expose new `draftValue`/projection knobs. Verify ratings are byte-identical before/after (proves decoupling).
- **P3 — Dev traits enrichment (Phase 5).** Add production/profile/round/age to the existing weighted-random engine; confirm regeneration variance + stable totals on real data.
- **P4 — Combine + export enrichment.** Combine/pro-day generation; Original* mirrors, commentary IDs, college matcher, scout flags; reconcile college data.
- **P5 — UI.** Board columns (SLOT/PROFILE/PROD/ATH/CAREER) + filters + stage/override control + full-visuals toggle, inside the existing studio.
- **P6 — Docs, CLI (optional), packaging, licensing/credit for both projects.**

Each phase ends with a real-save verification pass (the standard here) and stays shippable.

---

## 9. Guiding outcome

The result should read as a new converter: **cfbtransfertool's calibration
engine** decides *what ratings a player has*; **cfb2madden's draft systems**
decide *where he's drafted and how he's presented* — kept deliberately
independent, exactly as Phase 4 requires.
