# CFB → Madden: Faces, Bodies & Draft-Class — Research & Roadmap

Research-only (no code yet). Findings gathered by reading the real save files:
`DYNASTY-PLAYERSLEAVINGSTAGE`, `DYNASTY-DRAFTSTAGE`, `DYNASTY-POSTDRAFTRESULTS`,
a Madden `CAREER-*` franchise, and a Madden `CAREERDRAFT-*` draft-class export.

---

## 1. Player sourcing — leaving stage vs. draft stage

**The leaving stage is NOT more draft players — it's polluted with transfers.**

| | `LeavingPlayer` entries | Composition |
|---|---|---|
| **Leaving stage** | **2,317** | ~224 NFL early-declarers (`EarlyNFL_*`) **+ ~2,093 transfer-portal players** (`Transfer_PlayingStyle` 428, `Transfer_ChampionshipContender` 396, `Transfer_ProPotential` 304, …) |
| **Draft stage** | **270** | 100% `EarlyNFL_1..7` — clean early declarers, zero transfers |
| **Post-draft** | 0 | (draft over) |

The extra ~2,000 in the leaving stage are players changing *schools*, not going pro —
using them for a draft class is exactly the long-standing `Transfer_*` inclusion bug.

**There is no clean "draft class" table in the CFB save.** The `DraftPlayer` table has
**1 junk row**; `DraftClassInfo` only stores a year. So the draft-eligible set must be
**derived**, not read.

**The real draft-eligible pool (derived, confirmed against POST-DRAFT):**
- **Graduating seniors** — never appear in any leaving table (they just graduate). At the
  draft stage: 2,489 on real teams + 205 already at TeamIndex 255 = **2,694 seniors**.
- **Early NFL declarers** — the 270 `EarlyNFL_*` in the draft stage's `LeavingPlayer`.
- **Post-draft save proves it:** exactly those ~2,694 seniors moved to TeamIndex 255 after
  the draft; nobody else left for the NFL.

**Recommendation:** source from the **DRAFT stage** (not leaving), pool = **all
graduating seniors + the 270 early declarers ≈ 2,900+**. That's an order of magnitude
more than 224 — plenty for a 400-player draft class *and* a 400-player second pool.
The 6,758 TeamIndex-255 players are NOT a clean signal (mostly accumulated recruits/
freshmen across cycles — 4,479 are freshmen).

---

## 2. Root cause: "280 lb WR who looks like a DT"

Two independent things, both confirmed:

1. **Weight/height math is correct.** CFB stores weight with a −160 offset; Madden uses
   the *same* −160 offset. CFB WRs read 180–209 lb, DTs 279–306 lb — all correct — and the
   write step's `slot.Weight = p.Weight − 160` round-trips right. So the *number* is fine
   for transferred players.
2. **Body model is never transferred → they render as whatever was in the slot.** The
   write step sets `Height` and `Weight` but **never `CharacterBodyType` or
   `CharacterVisuals`**. Madden builds the on-field model from `CharacterBodyType`
   (Standard / Muscular / Heavy / Thin) + the visuals blob — so a WR dropped into a slot
   that held a Heavy lineman keeps the lineman's build. Confirmed in a written franchise:
   a "184 lb, body=Thin DT" and a "233 lb WR" — position/weight updated, body untouched.

So most of the "look like DTs" is the **missing body-type transfer**, and any genuinely
absurd ones (a real 280 lb WR) are **leftover Madden-generated rookies** in the ~218
slots we never overwrote (see §4 — the duplicates problem).

---

## 3. Roadmap: skin tone · body type · height/weight · heads

Field names are **identical** across both games (`GenericHeadAssetName`, `PLYR_ASSETNAME`,
`PLYR_GENERICHEAD`, `PLYR_PORTRAIT`, `CharacterBodyType`, `CharacterVisuals`), so reading/
writing is mechanically trivial — the challenge is the *values*.

### Phase A — Body type (biggest visual win, easy)
- **Transfer `CharacterBodyType` CFB → Madden.** Shared values: Standard / Muscular /
  Heavy / Thin match 1:1; CFB's extra `Freshman` → map to Standard (or Thin by weight).
- Distribution in the save: Muscular 6,814 · Standard 4,588 · Heavy 2,386 · Freshman
  2,142 · Thin 465 — a real spread we're currently throwing away.
- **Validation:** a transferred WR should read Standard/Thin, not the slot's old Heavy.

### Phase B — Skin tone (already shipped — verify only)
- Both encode the skin digit (`Generic_..._6_3` / `gen_6_...`). App already extracts CFB
  skin and picks a same-skin Madden head. Keep; just re-verify against the new saves.

### Phase C — Height/Weight (verify, don't re-derive)
- Math is correct; the reported bug was the body model, not the numbers. Add a guard/test
  that a written player's Madden height/weight equals the CFB source (catch any future
  offset regression), and confirm the [65..82] / [160..415] clamps aren't distorting
  outliers.

### Phase D — Generic heads ("keep them similar")
- **Different libraries, not shared IDs.** CFB: `Generic_0877_P_T0042_H_6_3`. Madden:
  `gen_6_B_G_03`. You cannot copy a CFB head string into Madden and get the same face.
- What *is* possible: match on **skin digit (exact)** + best-effort on the **head/hair
  category letter** (CFB `H/M/T` vs Madden `B/M/H/BM/BMT`), picking the nearest Madden
  generic head instead of a random same-skin one. Marginal improvement over today.
- **True face-scan transfer is not feasible** for dynasty players: ~15% of CFB players
  have a scan asset (`PLYR_ASSETNAME`), but Madden's draft slots have **0** scans and the
  scan libraries are unrelated games' assets. Only real prospects scanned identically in
  both titles could match — generated players never will.

---

## 4. Two transfer targets: roster (current) vs. draft-class file

**Discovery: a Madden draft-class export is a totally different format.** It starts with
the same `FBCHUNKS` wrapper but its payload is **JSON**, tagged `Madden-26-RL10-8802649`
(vs a full save's binary `College-27-RL1-...`). That's why `madden-franchise` throws
"incorrect header check" — it tries to decompress binary tables and hits raw JSON.

**What the draft-class file contains (`CAREERDRAFT-2028`, 402 players):**
- A ~1.7 MB **JSON visuals array** — per player: `bodyType`, `genericHeadName`,
  `skinTone`, and a full `loadouts` array (the `CharacterBodyType` slot, tattoos, gear,
  helmet, gloves, shoes…). This is the *readable* form of `CharacterVisuals`.
- A ~230 KB **binary tail** holding the player *stats* (names, positions, ratings,
  height, weight — e.g. names "Colton", "Vasek" appear there).

**Why Option 2 is worth it — it fixes three problems at once:**
- **Duplicates (your earlier report):** Madden's in-game "Import Draft Class" **replaces
  the entire class**, so there are no leftover Madden rookies — the dup problem disappears.
- **Body/faces:** the JSON visuals give us **direct, readable control** over body type,
  head, and skin tone (unlike the franchise path, where `CharacterVisuals` is an opaque
  bit-string we can't safely edit).
- **Full class size:** it already carries ~402 players.

**Feasibility / risk (this is the "had bugs before" path):**
- `madden-franchise` does **not** read/write this hybrid format. Two approaches:
  - **B1 (recommended): patch an existing export in place.** Start from a real
    Madden-generated `CAREERDRAFT` file (already 402 valid players, correct structure) and
    overwrite only the fields we want — names/pos/ratings/height/weight in the binary tail,
    `bodyType`/`genericHeadName`/`skinTone` in the JSON — preserving the file skeleton.
    Lowest risk; we never synthesize the format from scratch.
  - **B2: full parse/emit** of the FBCHUNKS + JSON + binary tail. More control, much more
    risk, and the binary tail needs the `RL10-8802649` schema decoded.
- The two options aren't exclusive: **keep the roster write as-is** (Option 1, works
  today) and add the draft-class export as **Option 2** behind a target selector.

### Suggested sequencing
1. **Phase A (body type on the roster path)** — cheap, immediately fixes "look like DTs"
   for the current, working transfer.
2. **Fill the full class** (source seniors + declarers, write all 442 slots) — kills the
   duplicate leftover-rookies on the roster path.
3. **Option 2 (draft-class file, B1 patch-in-place)** — the bigger effort; deliver the
   cleaner import path + readable visuals once A and the sourcing change are proven.

---

## 5. Identifying the graduated pool & the departure "year" signal *(new research)*

**Row index = stable identity across saves.** Verified 500/500 same player at the same
Player-table row across the draft-stage and post-draft saves — so a player can be tracked
year-to-year by row number (this is already the app's `rowIndex` canonical identity).

**The departure signature** (what changes when a senior leaves, draft stage → post-draft):
- `TeamIndex` → **255**
- `PLYR_CONSECYEARSWITHTEAM` → **0** (reset on leave)
- `PrevTeamIndex` → **the team they just left** (a valid real team)
- `SchoolYear` stays `Senior`; **all ratings/bio/ExperiencePoints stay intact** — a
  graduated player at 255 keeps his full stats, so **yes, we can read everything.**

**There is no explicit "year they left" field** (`YearsPro`, `CareerYear`, `SeasonsPlayed`
are all null for CFB players). But two clean ways to get *this year's* class:

- **Best — catch them at the DRAFT STAGE, still on-team:** `SchoolYear == Senior` + valid
  `TeamIndex` = the 2,489 graduating this year, unambiguously (no 255-pool guessing). Plus
  the 270 official `EarlyNFL` declarers. ≈ **2,760 clean, this-year draft-eligible.** This
  is what the app's synthesized/exit mode already mostly does.
- **In a post-draft / draft-week save:** `SchoolYear == Senior` + `TeamIndex == 255` +
  **valid `PrevTeamIndex`** isolates graduates cleanly — 2,615 of 2,694 (97%). Contrast
  Freshmen at 255: only 13% have a valid prev team → that's the accumulated recruit/
  generated junk (4,481 of them) to ignore.
- **Perfect isolation** (if ever needed): diff two consecutive saves by row index — whoever
  *newly* moved to 255 left this year. Needs two files.

**Takeaway:** don't mine the raw 255 pool. Extract at the draft stage (on-team seniors +
`EarlyNFL` declarers). The official `LeavingPlayer` list (270 → 224 after validation) is
just the game's *projected-drafted* subset — that's the whole reason the class caps at
224. Merge it with all graduating seniors and the pool is ~2,760; take the top 400.

## 6. Draft-class exporter — file structure & approach *(new research)*

A Madden draft-class export (`CAREERDRAFT-2028`, 402 players) is a hybrid inside the
`FBCHUNKS` wrapper:
- **JSON visuals block (~88% of the file):** per player — `bodyType`, `genericHeadName`,
  `skinTone`, `outfitType`, **`blends` (`barycentricBlend`/`baseBlend` = face morph)**, and
  a full `loadouts` array across 37 `slotType`s (CharacterBodyType, shoulderpads, helmet,
  gloves, shoes, tattoos, visor, facepaint…). Trivially parseable/editable.
- **Binary stats tail (~12%, ~571 bytes/player):** names, an asset-name token
  (`VasekColton_662_71`), and packed ratings/position/height/weight, with `1PLACEHOLDER`
  markers for empty slots. This is the `Madden-26-RL10-8802649` schema — a *reduced*
  draft-prospect record, not the full franchise Player table.

**Your "blank file, copy & export" idea is the right one** — it's the low-risk B1 path:
1. Ship (or have the user point at) a **template** draft-class export with N valid slots.
2. **Copy it**, then patch per player: JSON visuals (bodyType/head/skinTone/blends — easy)
   + the binary stats fields (name/pos/ratings/H/W — the hard part).
3. User imports via Madden's **"Import Draft Class"** → replaces the whole class (no
   leftover rookies → duplicates gone; full body/face control via the JSON).

**The one hard dependency:** `madden-franchise` can't open this hybrid (it hits the raw
JSON and throws "incorrect header check"). So the binary-tail patching needs either
(a) the RL10 draft schema decoded so we can locate each field's bytes, or (b) a
draft-class-capable library/tool. The JSON half is easy; the binary half is the risk and
the source of the "bugs in the past." **Recommend prototyping the binary-tail edit on a
copied template first, in isolation, before wiring any UI.**

Face **shape** (blends) is transferable *in the draft-class file's* JSON — but only if we
have a source: CFB's *franchise* `CharacterVisuals` is an opaque 32-bit string
(`00100000111111…`), not the JSON-blend form, so we can't read CFB face morphs. So even
via the draft file, we'd control body type + head + skin tone (good) but not the exact
CFB face shape (we'd keep the template's blends).

---

## Bugs & adjustments found while digging *(log)*

1. **Body type / model never transferred** (main visual bug). Write step sets Height/Weight
   but not `CharacterBodyType` — players keep the slot's old build ("WRs look like DTs").
   Fix is easy: `CharacterBodyType` is a clean shared field (Standard/Muscular/Heavy/Thin;
   map CFB `Freshman`→Standard). *Do not* try to decode the franchise `CharacterVisuals`
   bit-string — read the dedicated field instead.
2. **Class (~224) < Madden draft slots (442)** → ~218 leftover Madden-generated rookies =
   the "duplicates." Fixed by filling the full class (source seniors) or by the draft-class
   import path.
3. **Default leaving-auto mode uses only the 270 official list**, missing ~2,489 seniors —
   the real reason the class is small. Sourcing change (seniors + declarers).
4. **`positionCaps` mergeConfig bug (still open from prior session):** `mergeConfig` only
   copies keys present in the *default* section, and `positionCaps` ships sparse
   (`{K,P,LS}`), so a Class Cap set on any other position is silently dropped on
   save/generate. Fix: merge the union of default+saved keys for flat sparse sections.
5. **`extractSkinToneFromVisuals` is effectively dead code for CFB:** it parses
   `CharacterVisuals.RawData` as JSON, but the CFB franchise stores it as a bit-string, so
   the fallback never succeeds. Harmless (head-asset extraction covers skin tone), but it's
   a misleading path — either remove it or note it clearly.
6. **Weight/height clamps** (`Math.max(160,…)`, `[65..82]`) will floor genuinely light/short
   specialists (e.g., a 150 lb kicker → 160). Minor; worth a look if specialist bodies matter.
7. **Transfer_* pollution** in the leaving-stage `LeavingPlayer` (2,093 transfers) — already
   known/documented; reinforces "use the draft stage, not the leaving stage."

---

## Open questions before building
- **UFL / second 400:** vanilla Madden 26 has no UFL container (teams = 32 NFL + AFC/NFC
  + "Free Agents"). Second pool would land in the Free-Agent pool, or a specific roster/
  league mod you'd need to provide. Decide the destination before scoping.
- **Draft-class file target Madden year:** the export is tagged `Madden-26-RL10-8802649`;
  confirm the schema tag matches the user's Madden build before writing.
- **Exporter template:** do we bundle a blank/template draft-class file, or have the user
  export a fresh one from their Madden to guarantee a matching schema tag?

---

# IMPLEMENTATION ROADMAP (detailed — processes & how)

## Where changes land: the 3-stage pipeline
Everything flows through three stages in `lib/pipeline.js` (unchanged shape):
```
  EXTRACT (extractLeavingPlayers)   read CFB save  -> departed-player rows
     |    reads Player fields, decodeWeight(+160), skin from head asset
  CALIBRATE (calibratePlayersPowerCurve)  rows -> generated class (Madden_* ratings,
     |    Age/Height/Weight, dev traits, combine, EstMaddenOverall)
  WRITE (writeCareerFile)           class -> Madden franchise (overwrites Draft slots)
```
Each phase below states which stage(s) it touches. Config defaults live in `lib/defaults.js`;
UI in `renderer/`; IPC in `main.js`.

**Validation harness (reused by every phase):** the three CFB stages
(`DYNASTY-DRAFTSTAGE` = source of truth, `DYNASTY-PLAYERSLEAVINGSTAGE`, `DYNASTY-POSTDRAFTRESULTS`)
+ a scratch Madden franchise (`CAREER-*` copy) + a draft-class template (`CAREERDRAFT-*`).
Golden rule: **always write to a COPY**, re-open it, assert field-by-field, then eyeball in-game.

---

## Phase 1 — Body-type transfer (fix "WRs look like DTs")   *[EXTRACT + CALIBRATE + WRITE]*   ✅ DONE
**Value:** the single biggest visual bug; small, self-contained. Done first.

**Pre-build finding that simplified the plan:** the enum-mapping step originally planned
turned out to be unnecessary. Pulled both games' real `Player` schemas directly —
**`CharacterBodyType`'s full 17-member enum is byte-identical between CFB27 and Madden
26**, including all 5 real values (`Standard`/`Thin`/`Muscular`/`Heavy`/`Freshman`). Madden
itself has 24 real players on `Freshman` (verified against a real franchise), so it's not
a CFB-only value needing translation — it's a pure passthrough, no mapping function needed.

**What shipped:**
1. **Extract:** added `'CharacterBodyType'` to `CFB_BIO_FIELDS` in `lib/pipeline.js` — every
   extracted row now carries the source player's real body type.
2. **Calibrate:** both engines' row construction (`calibratePlayersV1` and
   `calibratePlayersPowerCurve`) now carry `CharacterBodyType: player.CharacterBodyType ||
   'Standard'` through unchanged (fallback to Madden's own schema default, never
   undefined/null, so the write step never gets an unsafe enum value).
3. **Write:** `writeCareerFile`'s slot loop now sets `slot.CharacterBodyType = p.CharacterBodyType`
   (guarded, with a `bodySet` counter surfaced in the write log next to skin tones).

**Height/Weight clamp revisit — checked, no change needed.** Queried real CFB K/P weight
data directly: range is 160–249 lb across 793 kickers/punters, **zero under 160**. The
existing `Math.max(160,...)` floor never clips real data, so it was left as-is (avoided an
unjustified change).

**Validation — the critical spike, run for real:**
- Unit level: `test/bioFields.spec.js` (new, 16 assertions) locks the passthrough for all 5
  body-type values + the missing-value fallback + Height/Weight fidelity, for both engines.
- **End-to-end, on a copied real Madden save** (never the original): extracted the real
  `DYNASTY-DRAFTSTAGE` (224 players) → generated a class → wrote it into a scratch copy of
  a real `CAREER-*` franchise → reopened the copy fresh from disk.
  - First pass matched by name and found 3/231 "mismatches" — investigated and confirmed
    they were **name-collision artifacts** (the same save has duplicate names across its
    442 slots, already documented in the duplicates research), not real bugs.
  - Re-validated using the exact positional slot order `writeCareerFile` itself uses (no
    name ambiguity possible): **224/224 exact matches, zero mismatches.** The write path is
    confirmed byte-correct.
- **Still outstanding (needs YOUR eyes, not mine):** confirmed the *field* writes correctly;
  have not confirmed the *visual* result in-game (whether Madden's rendering actually uses
  `CharacterBodyType` over the slot's old `CharacterVisuals` blob, or something else wins).
  **Action for you:** load the written franchise copy in Madden and check a transferred
  WR/DT visually. If bodies still look wrong despite the field being set correctly, that
  points at `CharacterVisuals` (or another field) overriding it, and Phase 5's draft-class
  JSON path — where `CharacterBodyType` is a real loadout slot, not a competing bit-string
  — becomes the more promising route for a full fix.

**Risk realized:** Low. The enum-identity discovery removed the only real unknown in the
data model; the remaining risk (does Madden's renderer honor the field) is a rendering
question outside anything testable from the save file alone.

---

## Phase 2 — Fill the full class + kill duplicates   *[EXTRACT / population + WRITE]*   ✅ DONE
**Value:** removes the leftover-Madden-rookie duplicates AND unlocks the full class in one
change. They're the same fix: fill (or clear) every Draft slot.

### What shipped
- ✅ **`population.mode` default flipped `legacy -> exit`** in `lib/defaults.js`.
- ✅ **Shortfall warning added** to `writeCareerFile` (not slot-clearing — per the gate below,
  clearing was never validated as Madden-safe, so the shipped fix is visibility: if the class
  is smaller than the target save's Draft-slot count, log exactly how many slots will keep
  their original Madden rookie, naming the fix (raise Class Size). Deliberately does NOT
  attempt to blank/clear those slots.
- ✅ **UI toggle:** not added (still config-only, `legacy` reachable via a hand-edited config
  or imported preset). Deferred, not blocking.
- ✅ **Dev-trait count inflation:** left as-is (no re-tune) — noted, not acted on.

### Validated (real saves, not just unit-level)
- `mergeConfig(null).population.mode === 'exit'`.
- `DYNASTY-DRAFTSTAGE` in exit mode → **2,535-player pool**, **0** `Transfer_*` leaks, 500-player
  generated class → **0** duplicate identities.
- **Season-scoping proof** (the deeper validation, using `DYNASTY-DATATESTDRAFT` +
  `DYNASTY-DATATESTYEAR1` + the main dynasty's `DYNASTY-POSTDRAFTRESULTS`, cross-referenced by
  stable Player-table row index): **0** extracted players were already gone at season start
  (no prior-year contamination), **0** were sitting at TeamIndex 255 at extraction time (all
  on real rosters), and **2,535/2,535** extracted players actually moved to TeamIndex 255
  post-draft (every single one really left — 0 false positives). Exit mode is proven to grab
  *only* this-season leavers, by construction and by direct save-file evidence.
- 135 existing regression assertions (`powerCurve.spec.js` + `bioFields.spec.js`) unaffected.

### Still open (carried to a later pass, not blocking)
- The Madden-tolerance spike for cleared/emptied Draft slots (only matters if `classSize`
  ever drops below a save's slot count — with the exit-mode pool at 2,535 and default
  `classSize` 500, this is far from the common case, but not impossible if a user lowers it).
- `main.js`'s duplicate hardcoded `'legacy'` fallback (`configStore.load().population?.mode ||
  'legacy'`) should read from `DEFAULT_CONFIG` instead of re-hardcoding — noted, not fixed.
- No permanent regression test locks the shortfall-warning behavior itself (validated
  manually in both directions, not in the suite).

### What already exists (verified in code)
- **Sourcing is DONE.** `lib/rosetta/population.js` `buildExitSelection` already builds the
  exact union: Regime A = `EarlyNFL_*` declarers first (carrying their real `ProjectRound`),
  then all rostered `Senior`s (`isFbsTeam`), deduped by row, transfers excluded via an
  **allowlist** (`EARLY_NFL_LEAVE_TYPES`). Confirmed output = 2,535 (2,489 seniors + 46
  declaring underclassmen). Exit and legacy feed the *same* hydration loop, so calibrate/
  write need no change from sourcing.
- **The write's rank→slot mapping is correct.** Madden's 442 slots = 224 real picks
  (rounds 1–7 ×32) + 218 UDFA slots (`PLYR_DRAFTROUND==63`), no nulls. The write sorts slots
  by (round, pick) so UDFA (63) sorts last, and `projectDraftClass` assigns ranks 1–224 →
  rounds 1–7, 225+ → UDFA. Rank 1 → pick 1.1, rank 225 → first UDFA slot. Sound.
- **`projectDraftClass` trims to `classSize`, not 224.** No hidden 224 cap; `positionCaps`
  ({K:3,P:5,LS:3}) only *skip* capped positions and keep adding others up to `classSize`.

### The actual work (small)
1. **Flip the default:** `population.mode` `legacy -> exit` in `defaults.js`. Consider
   surfacing it as a UI toggle (currently internal) so users can fall back.
2. **Guarantee the slot fill (the one real new bit):** with a big pool, `classSize` (default
   500) ≥ slot count (442) → all slots fill → no leftovers. But if `classSize` < slot count
   (user lowers it, or a save has more slots), the extra slots keep Madden's originals →
   dupes come back. **Fix:** in `writeCareerFile`, after the fill loop, **clear every Draft
   slot our class didn't fill** (blank/placeholder) so no Madden-generated rookie survives.
   Spike first: confirm Madden tolerates emptied/placeholder draft slots on import (it may
   not — if so, instead force `classSize >= detected slot count` and never leave partials).
3. **Dev-trait scaling decision:** dev traits are a *percentage of the class*. A ~442-player
   class ≈ doubles the Star/Superstar COUNT vs the old ~224 (2% Superstar → ~9 not ~4). The
   weighted draw still concentrates them at the top (UDFAs get low weight), so the *spread*
   is fine, but decide whether to keep the % (more elites) or re-tune to hold absolute
   counts. **User decision.**

### Validation process
- Extract `DYNASTY-DRAFTSTAGE` (exit) → assert pool ~2,535, **0 `Transfer_*`**, 0 dup ids.
- Generate a class ≥ slot count → write to a **Madden copy** → re-open → assert **every**
  Draft slot has a CFB `College`, **0** duplicate name pairs, and rank 1 landed at pick 1.1.
- Edge stages: `DYNASTY-PLAYERSLEAVINGSTAGE` (exit must still exclude the 2,093 transfers) and
  `DYNASTY-POSTDRAFTRESULTS` (seniors already at 255 → exit under-fills → must warn, not
  silently ship a short class).

### Bugs / risks this addition can introduce
1. **`classSize` < slot count → dupes return** (leftover Madden rookies). The #2 fix above is
   mandatory, not optional. This is the single biggest regression risk.
2. **Clearing draft slots may corrupt the import** — Madden might expect exactly N valid draft
   prospects. Spike the "empty slot" behavior; the safe fallback is "always fill ≥ N."
3. **Post-draft / late-stage saves under-fill** — seniors have moved to 255, so
   `scanRosteredSeniors` returns few; Regime C is unimplemented. Must detect (few on-team
   seniors + no EarlyNFL) and warn the user to use a draft-stage save.
4. **Dev-trait count inflation** (item 3 above) — behavior change users will notice.
5. **Default flip is broad** — `legacy` was the shipped default; `exit` is less battle-tested.
   Keep `legacy` selectable; validate exit across all three save stages before flipping.
6. **Over-aggressive `positionCaps`** could trim the class below the slot count → dupes (see
   #1). Ties into the `positionCaps` merge bug (Phase 3) — fix that alongside.
7. **`ProjectRound` sanity** — exit carries `safe(entry,'ProjectRound')` from EarlyNFL entries;
   verify these are real 1–7 values, not the `63` null-marker, before trusting `roundBonus`.
8. **UFL-as-second-profile implication (decision #1):** two draft profiles need the pool to
   supply NFL (~442) **+** UFL (~400) = ~842 ranked players. Pool (2,535) is plenty, but
   `classSize` must be ≥ ~842 (or generate the two profiles as separate top-N slices) once the
   UFL profile lands. Phase 2 (NFL only) just needs ≥ slot count, but rank deeply enough now.

**Risk:** Low-medium overall; the slot-fill guarantee (and its Madden-tolerance spike) is
the crux.

---

## Phase 3 — Bug fixes (batch)   *[config + EXTRACT]*   ✅ DONE (revised scope)
All three original items turned out different in practice than assumed — re-investigated
each against real save data rather than fixing on spec.

1. **`positionCaps` mergeConfig bug — SKIPPED, by explicit user decision.** The user does not
   want Class Cap available on positions outside K/P/LS in the first place, so the "bug"
   (a cap on another position silently not persisting) doesn't affect their intended use.
   Verified separately that K/P/LS themselves work correctly (survive `mergeConfig`, enforced
   at generation). No action taken; this is a deliberate non-fix, not an oversight.
2. **Weight/height clamps — investigated, NOT a real issue.** Checked all 2,535 real players
   in the exit-mode pool (including all specialists) against the `[65,82]` inch / `[160,415]`
   lb clamps: **0 players hit either boundary**. K/P specifically ranged 163–249 lb, comfortably
   clear of the 160 floor. The "150 lb kicker gets floored" scenario from the original research
   was theoretical, not observed. No change made — didn't want to alter a threshold with zero
   evidence it's causing harm.
3. **`extractSkinToneFromVisuals` — real finding, comment fixed (not deleted).** Investigated
   at scale (600 real players) and found the function's own rationale comment was **factually
   wrong for the current CFB27 809/0 schema**: it claimed `CharacterVisuals.RawData` "wasn't
   reliably decodable as JSON... came back as a raw bit view for every player checked." In
   fact `JSON.parse` succeeds **100%** of the time (450/450 sampled) and the blob carries a
   `skinTone` key (~33% of the time) and sometimes a raw-integer `bodyType` (confirmed
   consistent with the `CharacterBodyType` field added in Phase 1 — 2=Muscular, 1=Thin,
   3=Heavy, 4=Freshman — once decoded; an apparent "0/96 mismatch" on first pass was just an
   invalid string-vs-integer comparison in the investigation script, not a real discrepancy).
   **What's still true:** the function is practically unreached, because the primary head-asset
   extraction never failed once across 600 real samples — so it remains a genuine defensive
   fallback, just one whose own justification was describing the wrong reality. Fixed the
   comment to state what's actually true; left the function and its (unreached) call site
   otherwise unchanged.

**Outcome:** no functional code changes this phase — one comment correction. All three
original assumptions were checked against real data before touching anything; two were
non-issues, one was a documentation bug rather than the dead-code / merge-logic issue
originally suspected. `npm test` unaffected (135/135, unchanged from Phase 2).

---

## Phase 4 — Generic-head "keep similar"   *[EXTRACT + CALIBRATE + WRITE]*   ✅ DONE
**Original assumption (wrong): "marginal, different libraries, no shared IDs, defer."**
Re-investigated at scale before accepting that framing, and it didn't hold up.

### The real finding
`GenericHeadAssetName`'s outer wrapper naming genuinely differs between the games (CFB:
`Generic_NNNN_P_TNNNN_X_skin_v`; Madden: `gen_skin_letters_letters_v`) — but **CFB's
`PLYR_GENERICHEAD` field (a completely different field from `GenericHeadAssetName`'s own
trailing letter) shares the EXACT SAME taxonomy as Madden's own `PLYR_GENERICHEAD`/
`GenericHeadAssetName`.** Verified at scale, not assumed:
- **100% vocabulary overlap** on both letter segments across 4,337 real CFB and 2,082 real
  Madden samples — every facial-hair-combo (B/M/H/T and combinations) and every hairstyle-
  category code (N/BD/G/S/MG/...) that appears in one game appears in the other. Zero
  CFB-only or Madden-only codes.
- Within Madden, `GenericHeadAssetName === 'gen_' + PLYR_GENERICHEAD` **97.8%** of the time —
  they're the same code, just prefixed.
- Within CFB, `GenericHeadAssetName`'s own trailing letter and `PLYR_GENERICHEAD`'s facial-
  hair code are **unrelated** — CFB's `GenericHeadAssetName` suffix even uses a `D` category
  that never appears anywhere in `PLYR_GENERICHEAD`'s vocabulary. Different dimensions of the
  same asset, not the same code restated (this is why the original assumption, based on
  `GenericHeadAssetName` alone, concluded "no shared IDs").
- Coverage against a real save: **98% exact skin+facialHair+hairstyle match available, 2%
  falls back to skin+facialHair-only, 0% total misses.**

### What shipped
- ✅ **EXTRACT:** `PLYR_GENERICHEAD` captured once (reusing the existing read already used
  for skin-tone extraction) and carried onto the row.
- ✅ **CALIBRATE:** threaded through both engines' row construction (`PLYR_GENERICHEAD:
  player.PLYR_GENERICHEAD || ''`), parallel to `SkinTone`.
- ✅ **WRITE — the actual bug fix:** `pickValidHead`/`setSkinTone` previously matched against
  the **overwritten Madden slot's own original head** (`safe(slot, 'GenericHeadAssetName')`)
  — i.e., whatever Madden-generated rookie used to occupy that slot, which has nothing to do
  with the CFB player being written in. Rewrote it to match against the **CFB player's own**
  `PLYR_GENERICHEAD`, tiered: exact skin+facialHair+hairstyle → skin+facialHair-only →
  skin-only (previous behavior, for a player with no parseable category) → no match.
- ✅ CSV round-trip confirmed free (same dynamic-column mechanism as Phase 1's
  `CharacterBodyType`).

### Validated (real save, full pipeline, not simulation)
Extracted the real draft-stage save (exit mode) → generated a 500-player class → **wrote to
a copy of a real Madden franchise** → re-opened the written file and checked every one of the
442 filled Draft slots against the source CFB player's actual `PLYR_GENERICHEAD`:
- **406/442 (92%) exact skin+facialHair+hairstyle match**
- **6/442 (1%) facial-hair-pattern match** (hairstyle-category differs)
- **30/442 (7%) correctly fell back to skin-only** — every one of these had CFB
  `PLYR_GENERICHEAD === "NoHead"` (a legitimate CFB sentinel meaning no customized head was
  ever set for that player, not a bug), and in every sampled case the fallback still landed
  the correct skin digit.
- **0 genuine failures** — 100% of players got at least a skin-correct head; 93% additionally
  kept their real facial-hair pattern; 92% got an essentially exact category match (only the
  fine-grained variant number differs, which is expected — that's a sub-style pick within
  the matched category, not something meant to carry over 1:1).
- 135 existing regression assertions unaffected.

**Outcome:** this was NOT marginal — it was the wrong assumption from insufficient data at
research time. Re-investigating before accepting "defer" turned it into one of the more
impactful, fully-validated fixes in this whole effort.

---

## Phase 5 — Draft-class file exporter (2nd transfer target)   *[new module + WRITE + UI]*   — DETAILED, GATED PLAN
**Value:** a portable file Madden imports via its own "Import Draft Class" that (a) replaces
the WHOLE class (duplicates structurally impossible — no leftover-rookie problem at all),
(b) gives authoritative body/head/skin/gear via readable JSON (better than the roster path's
opaque bit-string), and (c) carries ~402 players natively.
**Risk: HIGH — the "bugs before" path.** This section is deliberately gated so we fail fast
and cheap. **Do 5a→5b in isolation before ANY UI, field-mapping, or class-emit work.**

> **NOTE (2026-07-10): the gates 5a/5b PASSED and the priorities changed — see
> "PHASE 5 RESTRUCTURE" immediately below, which now governs.** The original gated plan (kept
> intact after this block for history) treated the draft-class file as a risky *second* path
> behind the roster write. It is no longer second: it is the **main export path.** The
> historical text below remains accurate as a record of how we got here.

---

## PHASE 5 RESTRUCTURE — draft-class file is the MAIN export path (2026-07-10, GOVERNING)

### Decision
The `CAREERDRAFT-*` draft-class file becomes the **primary** way the app exports a class. The
existing roster-write path (writing CFB players directly into franchise Draft slots) is
demoted to a fallback/compat option. Rationale, now that 5a/5b are proven:
- Replaces the whole class → **duplicates are structurally impossible** (the roster path's
  original sin).
- We can set **correct faces** (face-ID catalog), **position/height/weight/age** natively.
- It is Madden's own designed channel for sharing a class — the cleanest, most robust import.
- Trade-off accepted: the user does one extra manual step in-game ("Import Draft Class") vs the
  app silently writing the franchise file. Worth it for a clean class.

### The unlock: the import → read-roster mapping loop (user-provided capability)
The one thing that blocked full field mapping — the draft-class file's packed binary struct
(ratings, dev trait, jersey, overall, college, archetype) — is now solvable **definitively**,
not by guessing. The loop:
1. We emit a `CAREERDRAFT-*` **probe** file: known landmark fields left correct, every *unknown*
   byte set to a distinct, recognizable **sentinel** value, on a few distinctively-named players.
2. **User imports it into a real franchise and runs/sims the draft** so the prospects become
   rookie `Player` rows (exactly where the roster path writes today).
3. We **open that franchise save with `madden-franchise`** (fully schema-readable, unlike the
   draft-class file) and read each probe rookie's every field. Whichever field holds sentinel
   value *V* identifies the byte offset we wrote *V* to. One import maps a whole batch of fields.
This is why we stop *guessing* offsets from distributions (which already burned us once: offset
70 "dev trait" was actually **Age** — 20-23 were ages, not tiers). Every remaining field gets
ground-truthed through this loop.

### Field-mapping status (the 200-byte per-player binary struct) — COMPLETE ✅
**The loop worked on the first import.** User imported `CAREERDRAFT-mapprobe`, it appeared in the
franchise roster (no draft-sim needed), and reading the 3 Probe rookies + correlating all 399
non-probe imported players against the template mapped everything essential in one shot.
| Field | Offset | Status | Notes |
| --- | --- | --- | --- |
| First/Last name | 0–~37 | ✅ | string, null-padded (`setBinaryName`) |
| Age | 70 | ✅ | raw byte |
| Height | 71 | ✅ | raw inches |
| Weight | 72 | ✅ | raw byte + 160 |
| Position | 74 | ✅ | `PositionE` enum — **CFB shares it, direct copy** |
| Archetype | 75 | ✅ | `PlayerType` enum — **CFB & Madden 69/69 identical, direct copy** |
| Jersey # | 76 | ✅ | raw byte |
| Draft pick | 78–79 | ✅ | u16 (projection) |
| Draft round | 80 | ✅ | raw byte, 63 = undrafted (projection) |
| ~55 ratings | 82–138 | ✅ | raw byte each; **validated 199/200** on real players; also fills `OriginalXRating` |
| Overall rating | — | ✅ derived | Madden **recomputes** OVR from the ratings on import — we don't set it |
| Dev trait | 140 | ✅ | `TraitDevelopment` enum — **CFB shares it, direct copy** (0=Normal…4=Hidden) |
| Face-ID | 146–147 | ✅ | u16; skin-tone catalog (`lib/faceCatalog.js`) |
| Body/head/skin | JSON | ✅ | `bodyType` confirmed applied on import (varies correctly in franchise) |
| College | 32-bit ref | ⏳ deferred | a reference/ID (not a simple enum); cosmetic — needs a CFB→Madden college map |
| misc (66,68,69,81,121,141) | — | — | minor/unknown; left at template defaults (portrait/backstory refs likely) |

**Big simplifications discovered:** CFB 27 and Madden 26 share the **same schema enums** for
Position, Archetype (`PlayerType`), and Dev trait (`TraitDevelopment`) — 69/69 identical
archetypes, identical dev-trait tiers — so those three fields copy over with **zero translation**.
And Overall is recomputed by Madden, so we never have to compute it.

### BUILT this pass (all loop-confirmed, tested — `lib/draftClassFile.js`)
`getAge/setAge` (70), `getJersey/setJersey` (76), `getArchetype/setArchetype` (75),
`getDevTrait/setDevTrait` (140, by value or name), `RATING_OFFSETS` (55 ratings 82–138) +
`getRatings/setRatings`, plus `TRAIT_DEVELOPMENT_ENUM` and `DRAFT_ROUND_OFFSET`. +21 tests
(range validation, exact-offset writes, enum round-trips, "only the given fields change"). Suite
now 270 assertions, all green. **No more mapping probes needed — the struct is understood.**

### Remaining work, reprioritized (functionality first, UI later per user)
- **5c-map — DONE.** Full offset→field table + setters landed and tested.
- **5d — full-class emit.** Given the existing pipeline's generated CFB class, overwrite all
  402 template slots: name, position, H/W, age, ratings, dev trait, face-ID (skin-tone match),
  bodyType/head JSON. Handle count: template is fixed at 402 → take the top 402 by projection;
  if the class has <402, decide leftover-slot policy (blank/duplicate-safe filler). Parse-back
  test: re-read the emitted file, assert every field matches the source class, 0 dupes.
- **5e — in-game validation.** Import a full real class; confirm names/positions/sizes/ratings/
  dev traits/faces all correct, no corruption, 402 present.
- **5f — integration + UI (later).** Make draft-class export the default action in the pipeline
  (`lib/pipeline.js`), roster-write kept as an option; a transfer-target selector in the UI;
  the UFL second-profile plugs in here (Phase 6). Output filename defaults to `CAREERDRAFT-*`.

## 5d — full-class emit — DETAILED PLAN (2026-07-10; not yet coded)

### Contract
`buildDraftClassFile(generatedClass, options) -> Buffer` (or throws). Starts from the bundled
template, overwrites all 402 slots with the generated CFB players, returns the finished
`CAREERDRAFT-*` bytes. Pure function of (class, options); writes no files itself (the UI/IPC layer
in 5f does the save dialog + `CAREERDRAFT-` filename).

### Decision 1 — class size (LOCKED by user)
- The template is **exactly 402 slots**. Take the **top 402 by draft projection** (`DraftRank`
  ascending; the class is normally ~400–520 so this just trims the tail).
- **If the class has FEWER than 402 players → throw and produce NOTHING.** No partial file, no
  leftover template players, no silent filler. A single hard error: e.g.
  `"Draft class has N players; a Madden draft class needs exactly 402. Raise Class Size / widen
  the source pool and regenerate."`

### Decision 2 — draft round (LOCKED by user: set it)
Set the projected round at **offset 80** from `ProjectRound` (1–7 direct; undrafted/beyond →
**63**, the observed "undrafted" sentinel). Also set the paired **draft pick** u16 at 78–79 from
`DraftPick` for a consistent "Round R, Pick P" projection. (Needs new `setDraftRound`/`setDraftPick`.)

### Ordering & slot assignment
Place player rank *i* into template slot *i* (projection order: our #1 → slot 0), because the
file's record order = the in-game draft-board rank (verified: template slot 0 = board rank 1).
Names must fit each slot's allocation — **verify the name field is a uniform fixed allocation**
(~16 bytes first / ~22 bytes last, marker `PLACEHOLDER` at a fixed offset). If uniform, placement
is free; if not, **truncate an over-long name to the slot's allocation and log a warning** (never
error over a name — only the <402 case errors).

### Per-field write recipe (per slot)
All BINARY writes use the already-built, loop-confirmed, same-length setters:
| Field | Source (generated player) | Setter |
| --- | --- | --- |
| First/Last name | `FirstName`/`LastName` | `setBinaryName` (truncate to fit) |
| Position | `CFB_Position` (string) | `setPosition` (shared enum, direct) |
| Archetype | **CFB `PlayerType`** ⚠️ new extraction | `setArchetype` (shared enum, direct) |
| Age / Jersey | `Age` / `Jersey` | `setAge` / `setJersey` |
| Height / Weight | `Height` / `Weight` | `setHeight` / `setWeight` |
| Dev trait | `TraitDevelopment` (name) | `setDevTrait` |
| Draft round / pick | `ProjectRound` / `DraftPick` | `setDraftRound` / `setDraftPick` (new) |
| 54 ratings | `Madden_*` | `setRatings` (maps `Madden_X`→`X`) |
| Face | `SkinTone` | `createFaceAssigner().assign(skinTone)` → `setFaceId` |
| Overall | — | **not set** (Madden recomputes from ratings) |

### ⚠️ The one real gap — body type needs a JSON edit (gate 5d.0)
Every field above is a same-length BINARY write (validated). **Body type is the exception:** it
lives in the JSON (`"bodyType":"Heavy"` + a `"Heavy_BodyType"` loadout item), and the 5 values
have different lengths, so writing it **changes the JSON blob length** — which we have NOT
validated (5b only proved *same-length* edits import). Head/skin JSON are **inert at import**
(the face comes from the face-ID), so **we only need to write `bodyType`**, nothing else in JSON.
Plan, in order:
1. **First, cheaply check for a BINARY body-type byte** (offsets 148–159 are unprobed; also
   re-check the existing franchise correlation data for `CharacterBodyType`). If one exists, set
   it and the JSON problem disappears entirely.
2. If body type is JSON-only: use **padding-compensation** — each record is `JSON + null-padding
   + 200-byte binary`; grow/shrink the null padding to keep the **record's total length
   constant** when the JSON changes length, so every downstream offset stays put (needs enough
   padding slack; most slots have plenty). This is far safer than a full re-serialize.
3. **Gate 5d.0 (one in-game test):** emit a template with one player's `bodyType` changed via
   padding-compensation, import, confirm the body type changed and nothing else broke. Only after
   this passes do we wire body type into the full emit. (If it fails, fall back: leave body type
   at the template slot's value — worse fidelity, but everything else still lands.)

### New code needed (beyond the existing setters)
- `setDraftRound` (offset 80, 1–7 or 63), `setDraftPick` (u16 78–79).
- `PlayerType` extraction added to the pipeline's CFB read (raw value; shared enum → direct).
- Body-type writer (binary byte if found, else padding-compensated JSON) — pending 5d.0.
- `buildDraftClassFile(generatedClass, options)` itself + reconcile the 54 pipeline ratings vs
  55 offsets (`setRatings` already ignores unknowns / leaves unmapped offsets at template value,
  so a mismatch like LongSnap↔no-offset is handled gracefully).

### Determinism & tests
- Deterministic given (class, seed): projection order + the face assigner's by-call-order spread.
- **Parse-back test:** `buildDraftClassFile(class)` → re-parse the output → assert every player's
  name/position/age/H/W/jersey/dev-trait/round/all-ratings/skin-tone match the source, and 0
  duplicate identities. Add a <402 error test and an over-long-name truncation test.
- Then **5e**: import a full real generated class in-game; confirm all 402 present with correct
  names/positions/sizes/ratings/dev-traits/faces, no corruption.

### Risk summary
| Risk | Handling |
| --- | --- |
| Body type = JSON, length-changing | gate 5d.0 (binary byte first, else padding-compensation) |
| Archetype not yet extracted | add `PlayerType` to CFB extraction (direct copy) |
| Over-long names vs slot allocation | truncate + warn (verify allocation uniformity first) |
| Ratings count 54 vs 55 | `setRatings` handles gracefully |
| <402 players | hard error, no output (per user) |

---

### (Historical) original gated plan follows — superseded by the RESTRUCTURE above

### What we actually know about the format (byte-level, verified against all 4 real exports)
Re-verified against all four real files (`CAREERDRAFT-2028/2029/2030/2031`), including two
different schema tags (`RL10-8802649` and `RL9-8734108`) — this superseded and corrected a
couple of the original single-file guesses below.
- Container: `FBCHUNKS` magic; version `01 00`.
- Header layout (all fixed offsets, identical across all 4 files): 3 opaque `u32`s at
  0x0A/0x0E/0x12 (byte-identical across every sample — carried verbatim, still unresolved,
  but since they never vary they clearly aren't a per-export checksum of file content); 5
  `u16` date-ish fields at 0x16..0x1F (year is always 2026 in every sample; the rest vary
  per export and are presumed month/day/hour/minute of the export, not confirmed); one more
  opaque `u16` at 0x20 that was ORIGINALLY guessed to be a schema-tag length prefix (it
  happened to equal 36 in the first sample) — **that guess was wrong**, disproven once a
  second sample had `05`/`53`/`49` there while the tag block start/end never moved. It's
  opaque, not structural.
- **The schema-tag block is a FIXED 36 bytes** at 0x22..0x46, holding the tag string
  (null-padded) with **the last 4 bytes of that same block repurposed as the `u32` player
  count** (`402` in every sample, at fixed offset 0x42). Byte 0x46 is always the `{` that
  starts player 0's JSON. None of this depends on the u16 at 0x20.
- **Per-player record (this was the big correction from the original single-file pass):**
  each player is **one JSON blob + zero-byte padding + a fixed 200-byte binary struct**, in
  that order — NOT a separate contiguous "binary stats tail" at the end of the file as
  originally guessed. The 200-byte struct (FirstName, LastName, a `<n>PLACEHOLDER` marker,
  packed rating bytes, and a `LastFirst_id1_id2` asset token, e.g. `FasusiMichael_257_519`)
  belongs to the JSON blob immediately BEFORE it, not the one after — proven by checking
  that player 0's binary struct (`Michael Fasusi`, Heavy, skin 6) matches player 0's JSON
  (`bodyType:"Heavy", skinTone:6`) exactly, and the file's dangling final 200-byte struct
  (`Colton Vasek`) has no JSON after it because it belongs to the LAST player's JSON, not a
  403rd one. Player count stays a clean 402 with this pairing; the earlier "~230KB tail"
  read was really 402 of these 200-byte structs, just misattributed to the wrong player and
  to a single contiguous block instead of interleaved with the JSON.
- JSON visuals hold: `bodyType`, `genericHeadName`, `skinTone` (some players omit one of
  these keys entirely rather than sending a null — expected, not a parse error), `blends`
  (face morph), `loadouts` (gear slots, including a `CharacterBodyType` slot type).
- **`madden-franchise` cannot open it** ("incorrect header check" — it tries to zlib-inflate a
  chunk that's actually raw JSON). So we hand-parse; no library shortcut.

### Core strategy — patch a BUNDLED template IN PLACE (decision #2, REVISED)
**Decision #2 changed (user request):** the app must NOT ask the user to export a draft-class
file. Instead the full valid structure is **bundled inside the app** and patched in place, so
building a class is a single click with no export step. Implemented:
- `data/draftClassTemplate.bin.gz` — a real, byte-perfect-round-tripping export captured and
  gzipped (1.95 MB → 85 KB). Ships with the app (it's in package.json `build.files` via
  `data/**/*`).
- `lib/draftClassTemplate.js` — inflates + parses it into a **fresh** model per call (callers
  mutate the model when patching, so no shared mutable state).
- `tools/bakeDraftClassTemplate.js` — regenerates the bundled asset from any real export;
  refuses to bake anything that doesn't byte-perfect round-trip. This is the escape hatch if
  the bundled template ever needs to match a different Madden build's schema tag (see risk 5).
We treat the template's 402 slots as fixed and **overwrite only the fields we can fill**,
leaving non-fillable sections (gear loadouts, blends, anything CFB lacks) at the template's
values. We do NOT synthesize the format from scratch or change the player count — "build it
from within the app" means patch the bundled base, not hand-author every byte (which would be
reckless given the still-opaque packed-rating/gear/blend/header bytes).
- **Strongly prefer same-byte-length in-place edits** (pad/truncate strings to the field's
  existing length; keep each JSON blob's byte length stable by not growing values). This
  sidesteps offset/length/checksum fixups almost entirely — the single biggest risk reducer.
- Full re-serialize with offset+checksum fixup is the fallback ONLY if same-length proves
  insufficient; it's much riskier and 5a must have fully decoded the header for it.

### Gated sub-phases — each is a hard STOP-if-fails gate
**5a — Decode + byte-perfect round-trip (READ ONLY, no edits). ✅ DONE — PASSED.**
Built `lib/draftClassFile.js`: parses the header, the fixed 36-byte schema/player-count
block, and all 402 JSON+gap+binary player records per file, storing every field as a raw
byte slice so re-serialization is a pure concatenation (no re-encoding risk).
**Result: `verifyRoundTrip()` returns byte-identical on all 4 real exports** — 2028, 2029,
2030, and 2031, spanning both schema tags seen so far. `Buffer.compare(original, reemitted)
=== 0` on every one, full 1,954,750 bytes each.
Permanent regression coverage added at `test/draftClassFile.spec.js` (25 assertions, runs via
`npm test`) using a synthetic fixture built to the same shape, so the suite doesn't depend on
a real save living outside the repo. It locks in: the round-trip itself, per-player field
decoding, the corrected JSON→binary pairing, that a stray `0x7b` byte inside a binary struct
can't be mistaken for the next player's JSON start (this exact false-positive happened during
manual investigation with a naive `indexOf('{')`), and two error paths (bad magic, truncated
file).
🚦 *Gate: PASSED. Header and per-player framing are understood well enough to reproduce the
file byte-for-byte on every real sample tried. Proceed to 5b.*

**5b — Single same-length edit → IMPORT IN MADDEN (make-or-break). Code ready, awaiting your
in-game test — this is the one step that needs a human at the console.**
Added to `lib/draftClassFile.js`: `setJsonFieldSameLength` (swaps a JSON value without
changing that player's blob length by even one byte), `setBinaryName` (renames within a
name's existing null-padded allocation, same idea), and `make5bTestEdit` (applies both to one
player and re-serializes the whole file). `bodyType` swaps use `Standard`/`Freshman`/
`Muscular` — verified all three are exactly 8 characters, so swapping among them can't shift
anything downstream even before accounting for the gap's slack.
Also added `tools/phase5bTestEdit.js`, a standalone script (not part of the shipped app) that
**by default starts from the app's bundled template** (no file needed — this is the realistic
test, since the shipped exporter builds from that same template), auto-picks a player whose
bodyType is one of those three, applies the edit, and writes the result to your Desktop as
`DRAFTCLASS-phase5b-test`. It byte-diffs its output against the source and prints every
differing range, so you can see exactly what changed before importing anything. (Pass a file
path to test a specific real export instead of the bundled template.)
**Ran it against the bundled template just now:** output is the same 1,954,750 bytes, and the
diff is **exactly 2 ranges** — 8 bytes for the bodyType swap, 11 bytes for the lastName marker
— nothing else in the file differs. That's the file this gate needs tested.
**What's left for this gate — needs you:** run `node tools/phase5bTestEdit.js` (no arguments),
then import the `DRAFTCLASS-phase5b-test` file it writes to your Desktop into Madden via
"Import Draft Class" and confirm (a) Madden accepts it (not rejected as corrupt) and (b) the
edited player's body type and last name show up changed, with nothing else in the class
visibly broken. **This also implicitly tests the bundled template's schema tag against your
current Madden build (risk 5)** — if it imports clean, the baked-in template is build-compatible
and no per-user export is ever needed.
🚦 *Gate: ✅ PASSED (real in-game import). Madden accepted the file — not rejected as corrupt —
and the edited player showed up correctly (rank 9, "B. PHASE5BTEST", LT, North Dakota State,
the renamed Beau Johnson). This clears the make-or-break gate: **no blocking checksum,
same-length edits survive import, and the bundled RL10 template's schema tag is compatible
with the user's current Madden build (risk 5 cleared for this build).** The whole draft-class
export path is viable.*

### Faces finding (surfaced by the 5b import — belongs to 5c)
The imported class showed **lots of missing faces.** Investigated:
- **NOT our bug:** byte-perfect round-trip means our file ≡ the real `CAREERDRAFT-2028`, so
  the same faces would be missing importing that file directly. We stripped nothing.
- **NOT a build mismatch:** ruled out — RL10 (template) and RL9 (other exports) share
  essentially the same head vocabulary (174/183 heads overlap; the 9 that don't are just
  unsampled, same pattern, in-range variants; per-category variant ceilings are identical).
- **Root cause — the export stores generic heads ONLY, zero face-scan data.** Confirmed:
  402/402 players have a `genericHeadName` (`gen_<skin>_<facial>_<hair>_<variant>`), but
  **0/402 have any facial `blends`/morph data** (the only `blends` in the file are on the
  `Shoulderpads` loadout, i.e. pad shape, not faces). These are real 2026 prospects (Fasusi,
  Sanders, Griffin…) who in Madden carry *scanned* likenesses; the draft-class export drops
  the scan and keeps only a generic head → the real face is gone on import. A Madden format
  limitation, not something we caused.
- **Why this is fine for the feature:** CFB players don't have NFL face scans either — they
  use these same generic heads (`PLYR_GENERICHEAD`, mapped in Phase 4). Writing generic heads
  is native to the format and exactly what our exporter does; our players have no scan to lose.
- **Probe 1 (`tools/phase5cFaceTest.js`) — RESULT: faces are NOT driven by our edits, and NOT
  driven by the generic head.** Changed 6 players' skin/head (same-length) and imported.
  Observed (draft rank = index+1): faces present at ranks 5,7,8; MISSING at ranks 1,2,3,4,6.
  Two decisive facts:
  1. **Edits don't cause it** — unedited rank 4 (Boireau) is faceless, while edited ranks 7,8
     render fine. So writing skin/head neither breaks nor creates faces.
  2. **The head doesn't cause it** — rank 4 (Boireau, no face) and rank 5 (Johnson, face) carry
     the *identical* head `gen_7_BMH_GS_005`. Same head, opposite result → the differentiator
     is the player's IDENTITY, not the head asset.
  The faceless set is exactly the marquee real 2026 prospects (Fasusi/Sanders/Griffin/Boireau/
  Carr); the faced set isn't. Strong hypothesis: **Madden blanks a prospect whose NAME matches
  a real cyberface it can't resolve in the import context, and otherwise falls back to the
  (rendering) generic head.** A single-byte flag search over the 200-byte struct found 44
  "separators" but they're small-sample noise (e.g. two of them are literally the last-name
  initial) — not a reliable flag with only 8 labels.
- **Probe 2 (`tools/phase5cNameTest.js`) — RESULT: name is NOT the cause.** Renamed the 4
  faceless marquee players to fake names (Fasusi→"Zeb Qwolt", etc.) keeping heads/skins; all 4
  stayed faceless in-game. Hypothesis rejected. (Bonus: this import gave 3 more labels —
  faceless now confirmed at ranks 9,10 too — sharpening the flag search below.)
- **Probe 3 (byte-flag search, 10 labels) — RESULT: FOUND the gate.** With faced={idx 4,6,7}
  and faceless={0,1,2,3,5,8,9}, exactly one offset both separates the groups AND behaves like
  a flag across all 402: **the 16-bit little-endian face/portrait ID at binary offset 146-147.**
  - Faced players: face-ID ≈ **3700-4100** (byte 147 ∈ 13-16).
  - Faceless players: face-ID ≈ **15800-15925** (byte 147 ∈ 61-62).
  - Population: 216/402 in the "faced" band, 185/402 in the "faceless" band, 1 outlier — clean
    bimodal. Every other "separating" offset had 25-200+ distinct values (ratings/noise).
  - **Decisive:** Boireau (faceless) and Johnson (faced) share `genericHeadName gen_7_BMH_GS_005`
    but differ in this field → *this binary face-ID, not the JSON head, gates rendering.*
  Added `setBinaryBytes`/`getFaceId`/`setFaceId` (offset 146) to `lib/draftClassFile.js` (+9
  tests). This is very likely a portrait/cyberface slot ID: the marquee prospects point at real
  scan slots (~15.8k) absent in the import context → blank; generic-generated players point at
  the ~3.9k generic band → render.
- **Probe 4 (`tools/phase5cFlagTest.js`) — RESULT: CONFIRMED. The face-ID at 146-147 is the gate.**
  All four fixed players (Fasusi byte147→15, Sanders byte147→14, Griffin face-ID→3763, Boireau
  face-ID→3763) now **render faces** in-game; the two untouched controls (Carr, B.Johnson)
  correctly stayed blank. Every flavor of the edit worked — a bare high-byte flip, a full
  face-ID copy — so setting this field into the render band is all it takes.
- **Face-ID data model (analysis over all 402) — it's a 2-band MODE selector, decoupled from
  appearance:**
  - **Render band ≈ 3347-4287** (216 players, byte147 13-16) → generic face shows.
  - **Blank band ≈ 15804-15988** (185 players, byte147 61-62) → waits on an absent cyberface.
  - **Same head → many face-IDs** (`gen_7_BMH_GS_005` → {3763,3360,3762,3468}); face-IDs are
    also shared across different heads (137 distinct IDs over 216 players). → face-ID ≠ head.
  - **Face-ID does NOT track skin** — every skin digit 1-8 spans nearly the full render band.
  ⇒ Interim model (⚠️ SUPERSEDED by Probe 5 + the Correction below): guessed the look came from
  the JSON. It does NOT — the face-ID itself is the face. Kept here only as the research trail.
- **Probe 5 (`tools/phase5cLookTest.js`) — RESULT: the JSON is IGNORED; the face-ID IS the look.**
  Ranks 1 & 2 got the SAME face-ID (3855) but opposite JSON skins (1 vs 8) — **both rendered
  dark, identical.** So `genericHeadName`/`skinTone` in the draft-class JSON do NOT drive the
  imported face; the face-ID (offset 146-147) fully determines appearance. (The earlier
  "decoupled from head/skin" analysis was right for a different reason than assumed: the JSON
  is just inert metadata at import — the face-ID is a Madden face-DB/portrait slot.)
- **Probe 6 (`tools/phase5cSkinTest.js`) — RESULT: a copied face-ID reproduces its DONOR's
  face.** Rank 1 ← a light-head donor's face-ID 4061 rendered LIGHT; rank 2 ← a dark-head
  donor's 3763 rendered DARK. So face-IDs are copyable and carry a real face.
- **CORRECTION — head-based matching was WRONG; skin tone is the only reliable key.** Digging
  further disproved the "match by generic head" plan I'd started:
  - **The template's generic-head string is NOT a reliable descriptor of the face-ID's real
    face.** The head-skin digit agrees with a face-ID's actual skin only **34%** of the time
    (measured on face-IDs appearing ≥2× in the template). The skintest only worked because I
    happened to pick donors whose *other* label — the JSON `skinTone` — matched.
  - **The JSON `skinTone` field IS reliable: 94%** self-consistent per face-ID, and **93%
    identical across all 4 builds** (99% within ±1 tone). So `skinTone` is the trustworthy
    label of a face-ID's skin.
  - **Face-IDs are build-relative indices**, so a catalog must come from the *same* file we
    ship as the template (an ID only reliably renders with its own file). The face-ID number
    also carries **no skin structure** (corr −0.18), so we can't invent IDs — only use observed
    ones with a known `skinTone`.
  ⇒ **Final model: match CFB skin tone → a catalog face-ID of that tone. Reliable on skin
  (the dominant visual factor); we do NOT attempt to match facial features (no reliable signal).**
- **BUILT (Phase 5c face system):**
  - `tools/bakeFaceCatalog.js` → `data/faceCatalog.json` (ships): skin tone → render-band
    face-IDs, harvested from the bundled template, keyed by the reliable `skinTone` (mode per
    ID). 137 face-IDs: per tone 1:13 2:25 3:5 4:7 5:12 6:32 7:43.
  - `lib/faceCatalog.js` → `createFaceAssigner()`: `assign(skinTone)` picks the least-used
    face-ID in that tone's pool (nearest-tone fallback), spreading to limit cloning,
    deterministic by call order. `test/faceCatalog.spec.js` (+13 assertions).
  - **Validated on a real class (top-420 by OVR from `DYNASTY-DRAFTSTAGE`): 100% exact
    skin-tone match, 3.1 players/face — essentially Madden's own native rate (~2.9), worst-case
    reuse 6.** So faces are no clonier than vanilla Madden, every player correct-skin.
- **Possible later fidelity gains (not needed for v1):** pool the 4 exports keyed by `skinTone`
  (225 IDs, better spread — pending an in-game check that RL9 IDs render in the user's build);
  or catalog more face-IDs' true skins by observation. Feature-level matching would require a
  reliable face descriptor we don't currently have.

### 5c continued — binary field mapping: Position SOLVED
Moved on to the rest of the 200-byte binary struct (position, ratings, height, weight,
archetype, dev trait, college). Instead of pure statistical guessing, used the 5 known
positions from the user's real scouting screenshots (ranks 1-10: OT,OT,DT,DT,DT,QB,QB,IOL,OT,CB)
to search for a byte offset that's internally consistent per known position AND distinct
across positions. **Offset 74 was the only match.**
- **Ground truth confirmed by querying a REAL Madden franchise save's schema directly**
  (`madden-franchise` on `CAREER-DRAFTSTAGE`, no export/diff needed): the `Position` field's
  real `PositionE` enum gave authoritative numeric values. All 5 known labels matched exactly:
  QB=0, LT=5 (the game shows generic offensive tackles as "OT"), LG=6 (shown as "IOL"), DT=12,
  CB=16. Full 71-member enum captured (all real position codes 0-34; 35-38 are franchise-mode
  manager roles; 63 is `Invalid_`).
- **CFB's own `Position` enum uses the IDENTICAL numeric values** (checked against a real CFB
  dynasty save's schema) — so a CFB player's raw Position value writes into this byte with
  **zero translation needed.**
- **Whole-population sanity check: all 402 template players decode to a real, sane position
  value** (0/402 unknown/invalid), with a shape that looks like an actual draft class — WR
  most common (52), CB second (41), specialists rarest (3 each for FB/K/P).
- **Built:** `POSITION_OFFSET`/`POSITION_ENUM`/`POSITION_NAME_TO_VALUE`/`getPosition`/
  `setPosition` in `lib/draftClassFile.js` (single same-length byte write, same pattern as
  face-ID). +12 tests in `draftClassFile.spec.js` (get/set, ground-truth enum values, error
  paths) and +6 in `draftClassTemplate.spec.js` (all 10 known ground-truth players, full-402
  no-unknowns check, realistic-shape check). Suite: 224 assertions, still all green.
### 5c continued — Height and Weight SOLVED
Mined 3 more ground-truth values already sitting in the user's screenshots (never explicitly
asked for, just present in the scouting-card UI): Beau Johnson 297lb/6'5", Jericho Johnson
342lb/6'3", Malik Washington 231lb/6'4". Searched every offset for an exact or constant-offset
match against these three:
- **Offset 71 = Height, raw inches, no transform** (77/75/76 matched exactly).
- **Offset 72 = Weight, encoded as `raw byte + 160`** (182+160=342, 71+160=231, 137+160=297 —
  all exact). This is the SAME "-160 raw storage" convention this app already decodes for CFB's
  own `Weight` field (see `test/bioFields.spec.js`'s comment on it) — a nice internal-consistency
  signal that the encoding guess is right, not coincidental.
- **Whole-population validation:** 0/402 template players fall outside a realistic human range
  (60-90in, 140-400lb), and per-position averages are exactly what real football body types look
  like — offensive line (LT/LG/C/RG/RT) all ~305-316lb & 76-78in, cornerbacks ~187lb & 72in,
  quarterbacks ~210lb & 74in medium build.
- **Built:** `HEIGHT_OFFSET`/`WEIGHT_OFFSET`/`WEIGHT_RAW_ADJUST`/`getHeight`/`setHeight`/
  `getWeight`/`setWeight` in `lib/draftClassFile.js` (single same-length byte writes, same
  pattern as face-ID/position, with range validation). +9 tests in `draftClassFile.spec.js`,
  +6 in `draftClassTemplate.spec.js` (3 ground-truth pairs + population sanity + OL-vs-CB
  weight cross-check). Suite: 248 assertions, still all green.

### 5c status — what's solved vs. still open
**Solved and tested:** bodyType/genericHeadName/skinTone (JSON, Phase 4), face (face-ID,
skin-tone catalog), Position, Height, Weight.
**Still open — dev trait, college, archetype, individual `Madden_*` ratings.** An early
statistical guess at dev trait (offset 70, raw values 20-23) does not cleanly map to Madden's
real `TraitDevelopment` enum (0-3) in a way that produces a sane distribution (the naive
`value-20` mapping would make "Star" the MOST common tier and "Normal" the rarest, backwards
from every real draft class) — **not reported as solved, to avoid an overclaim.** The pattern
that cracked Position/Height/Weight was finding ground truth already visible in screenshots and
searching for a matching byte; that technique is exhausted for now (no further known values are
visible in the screenshots taken so far). Two ways forward, either works:
(a) more screenshots showing dev trait / college / a specific rating value for known players
(cheap, same technique, just needs the right screen open in-game), or
(b) the original 5c plan: edit one field in Madden's own in-game draft-class editor, re-export,
byte-diff the two files (slower but doesn't need new screenshots, works for any field at once).

### User requirements captured (2026-07-10)
- **Output filename must start with `CAREERDRAFT-`** — Madden's Import Draft Class browser keys
  on it. All Phase 5 tools now write `CAREERDRAFT-*`; the shipped exporter (5f) must default its
  save name to `CAREERDRAFT-<something>`.
- **Auto-generated face goal:** the exported player's face should be **close to that player's CFB
  auto-generated face** — i.e. transfer the CFB `PLYR_GENERICHEAD` (→ `gen_` head, Phase 4) +
  skin tone into the draft-class JSON, with the face-ID set to the "renders" band so it actually
  shows. This is the 5c face plan, pending Probe 4's confirmation that the head drives the look.

**5c — Field mapping (JSON + binary).** Only after 5b passes. Map every field we write:
- JSON per player: `bodyType`, `genericHeadName`, `skinTone` — **we already produce all three**
  (`CharacterBodyType`, `PLYR_GENERICHEAD`→`gen_` head, `SkinTone` from Phases 1 & 4).
- Binary per player: FirstName, LastName, Position, all `Madden_*` ratings, Height, Weight,
  archetype, dev trait, college. Offsets found by **diffing** (edit one field in Madden's own
  draft-class editor, re-export, byte-diff the two files) — slow but reliable — or by decoding
  the `RL10` schema if obtainable.
- Establish **player alignment**: JSON record i ↔ binary record i ↔ our class rank i, and
  handle the `1PLACEHOLDER` empty slots.

**5d — Full-class emit + parse-back test.** Given our generated class + the template, write all
402. Re-parse the output and assert every field matches; 0 dupes.

**5e — Import validation (real Madden, in-game).** Import the full file; confirm all 402 present,
correct stats/bodies/faces, no corruption, no duplicates. Visual check.

**5f — UI + IPC.** Add a **transfer-target selector**: "Write to franchise roster" (today,
default) vs "Export draft-class file". Export uses only a **save dialog** (where to write the
output) — **no template-import step**, since the app builds from its bundled template. Never
touches their franchise. This is also where the **UFL second profile** (decision #1) plugs in —
same exporter, sourced from the next rank slice. (Optional: expose the `bakeDraftClassTemplate`
refresh as a hidden/advanced action only if risk 5 ever bites.)

### Risks & mitigations (ranked)
1. **Integrity checksum in the header/wrapper** → weaker risk than assumed: the 3 opaque
   header `u32`s came back **byte-identical across all 4 real exports** despite very
   different player content, which is evidence AGAINST any of them being a per-file content
   checksum (a real checksum would differ when the class differs). Still not proven safe —
   5b's real-Madden import is the actual test; recompute if it turns out one IS sensitive to
   content. If un-recomputable, path is blocked.
2. **Variable-length fields** (names, JSON tokens) → prefer same-length in-place (pad/truncate);
   only do full offset fixup as a fallback.
3. **Per-record JSON framing** (padding/length-prefix/directory) → 5a's round-trip proves it.
4. **Fixed player count (402)** → we overwrite existing slots, never add/remove; align the class
   to the template's count (drop the tail; ~402 ≈ the 400 target anyway).
5. **Schema-tag / Madden-build mismatch** → the bundled template carries a fixed schema tag
   (`Madden-26-RL10-8802649`). If Madden validates that against the running build, a mismatch
   could reject the import. Mitigation: the 5b import test tells us directly whether the
   bundled tag is accepted; if not, `tools/bakeDraftClassTemplate.js` re-bakes the bundled
   asset from a fresh export in one command (and, longer-term, we could bundle multiple
   templates keyed by tag, or test whether the tag itself is safely patchable). This is the
   one real cost of the "no user export" decision — surfaced honestly, mitigated, not blocking.
6. **Unknown binary field layout** → diff-based reverse-engineering (reliable, just tedious).

### Fallback / exit criteria (say it plainly up front)
If 5a or 5b fails, we **keep the roster-write path** — Phases 1–4 already made it good (real
bodies, 92%-accurate heads, full class, no dupes when filled) — mark the draft-file path
blocked, and revisit only if a draft-class-capable parser appears. **The two paths coexist**;
the roster write stays the default, the draft-file export is the opt-in cleaner import. Nothing
about Phase 5 regresses what already works.

### Effort shape
5a–5b are small but decisive (a few focused spikes) — **the go/no-go lives here.** 5c is the
grind (binary field mapping by diffing). 5d–5f are mechanical once 5a–5c hold.

---

## Phase 6 — Second ~400 ("UFL")   *[decision-gated; WRITE]*
**Blocked on a decision:** Madden 26 has no UFL. Options:
- **Free-Agent pool** (only native bucket): source ranks ~N+1..N+400 from the same pool
  (or undrafted seniors), write as `ContractStatus:'FreeAgent'` onto the Free-Agents team.
  Process: find writable free-agent/empty Player rows (or the delete-excess-FA path), fill
  them like draft slots minus the draft-scouting bits. Medium-high risk (creating/finding
  rows vs. overwriting existing Draft slots).
- **User-provided UFL roster/mod:** we'd need that file to map its slots.
Defer until the destination is chosen; do last.

---

## Recommended sequence & gates
```
  1. Body type (+H/W guard)   --spike in-game gate--   quick, high value
  2. Fill full class          --0 dupes / all slots--  removes duplicates, unlocks 400
  3. Bug batch                (interleave)             positionCaps etc.
  4. Head similarity          (optional)               defer
  5. Draft-class exporter     --5a/5b hard gates--     big; the clean import path
  6. Second 400 (UFL)         --needs destination--    last
```
**Decision gates before any code:** (1) UFL destination *(locked: an additional draft
profile)*; (2) exporter template source *(RESOLVED: bundled inside the app — no user export;
`data/draftClassTemplate.bin.gz` + `lib/draftClassTemplate.js`, re-bakeable via
`tools/bakeDraftClassTemplate.js`)*; (3) confirm the bundled template's schema tag imports on
the user's build — folded into the 5b import test.
**Spike gate inside Phase 1:** does `CharacterBodyType` alone drive the model? Its answer
also raises/lowers Phase 5's priority.
