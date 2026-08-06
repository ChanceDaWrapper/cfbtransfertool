# Coach Fidelity — making a transferred coach look and read correctly

Companion to [`COACH_CAROUSEL_ROADMAP.md`](COACH_CAROUSEL_ROADMAP.md). That
document covers *moving* a coach; this one covers whether the moved coach
**presents** correctly in-game — face, portrait, level, archetype, abilities.

**Status: working end to end, verified in-game.** Marcus Freeman transfers from
Oregon to the Giants and renders in Coach Central as *Level 49, Offensive Guru,
28 abilities unlocked, 7 playsheets, with a rendered face*. Remaining work is
polish, not mechanism.

---

## 1. AUDIT — verified in-game (2026-07-22)

Coach Central, after starting the franchise from `CAREER-FREEMANFACE`:

| Element | Result |
|---|---|
| Name / team | **Marcus Freeman — New York Giants** ✅ |
| Level | **49** ✅ (wrote 48 — see §1.1) |
| Archetype | **Offensive Guru** ✅ |
| Abilities unlocked | **28** (7 playsheets) ✅ |
| Ability breakdown | Personnel 3.6 / Offensive 60.7 / Scout 28.6 / Development 7.1 ✅ |
| Face | renders ✅ (likeness is not Freeman — §2.1) |
| Approval rating | 50% (Madden-only concept, default) ✅ |
| Displaced incumbent | D. Canales → free agency ✅ |
| Save stability | loads, playable ✅ |

### 1.1 Level display is data + 1 — confirmed twice

`Coach.Level = 11` → Canales displays **12**. `Coach.Level = 48` → Freeman
displays **49**. A consistent +1 offset, observed on both an untouched coach
and a written one, so it's a display convention (1-indexed), not a bug.

**Action:** if a specific displayed level is wanted, write `targetLevel - 1`.
Currently unhandled — `levelScale.js` writes the mapped level directly, so
displays land one higher than intended. Low severity, one-line fix, but it
should be a deliberate decision rather than an accident.

---

## 2. Two earlier conclusions were WRONG — corrected here

### 2.1 "DUMMY ARCHETYPE / Level 1" — **superseded: the setup screen DOES resolve**

Originally this said the setup/Customize screen (`Offline ▸ NFL Preseason
Roster ▸ <team> ▸ Customize`) never resolves a mid-franchise coach and always
falls back to "DUMMY ARCHETYPE / Level 1", so only Coach Central was trusted.

**That is now known to be too strong.** Shannon Archer, placed on the Jets by
the current build, renders on that exact setup screen with a real archetype
(**Development Wizard**), **Level 25**, and real abilities (Island Kings,
Practician CB/S, Angry Runner, Mr. Dream). The earlier "DUMMY ARCHETYPE"
Freeman screenshot came from an older build (`CAREER-FREEMANFACE`); whatever it
was missing, a fully-written coach — archetype + level + XP + a private talent
tree — now resolves correctly on **both** screens.

**Reconciliation left open:** re-open the current Giants/Bears/Jets coaches on
the setup screen. If all three read correctly (as Archer does), §2.1 closes as
"resolves when the data is complete." Coach Central remains the gold standard,
but the setup screen is no longer assumed broken.

### 2.2 The talent tree is PROVEN, not unproven — **reverse of the earlier call**

I previously wrote that the 219-row deep clone "changed the display not at all"
and recommended defaulting it off. That was wrong, and wrong because I judged it
on the setup screen.

In Coach Central the clone is plainly doing the work:
- **28 abilities unlocked** — exactly the 28 gameday talents cloned from McVay
- **7 playsheets** — exactly the 7 playsheet talents cloned
- The four-way breakdown **sums to precisely 28** (Personnel 1, Offensive 17,
  Scout 8, Development 2), confirming the displayed abilities *are* the cloned
  talent rows

Without the clone, a coach has no abilities at all. `talentTree.js` is
**load-bearing** — `config.skipTalentTree` should stay off by default.

---

## 3. Solved mechanisms

### 3.1 Portrait is deterministic from the head asset

Verified **93/93, zero exceptions**:

```
Portrait = <N> + 308      where the head asset is coachhead_M_<N>_HS
```

### 3.2 Head lives in two places that must agree

`Coach.GenericHeadAssetName` and the `CharacterVisuals` JSON `Head` loadout
(`PlusHead`) are identical in **93/93** coaches. Written as a pair.
[`appearance.js`](lib/carousel/appearance.js) reads a donor blob from the live
save (so apparel item names are never invented), swaps the head, and writes a
**private** `CharacterVisuals` row (1,809 free).

Only the 83 generic `coachhead_M_####_HS` assets are assignable — the other 11
are licensed likenesses (`ReidAndy`, `TomlinMike`, …) plus `MustBeUnique`.

### 3.3 Talent tree cloning

Four levels deep: `Coach → Talent[] → Talent → TalentTier[] → TalentTier`.
~219 rows per coach; verified fully private (zero row overlap with the donor).
Shares only bit-1 static asset references (`TalentInfo`, goals); deep-clones
everything in-save. Donor = nearest level with a matching archetype.

### 3.4 XP → Level

`StaffLevelTuning` is a **static asset table (16465), outside the save**, so
thresholds aren't readable — but live pairs give **XP ≈ 2000 × Level**,
matching `probe09`'s fit (R² = 0.9972) already used by `levelScale.js`.

The XP-auto-level idea turned out to be unnecessary: writing `Level`, `XP` and
a talent tree together produces the correct display immediately, with no
progression tick required.

---

## 4. Remaining work

### 4.1 Face / skin tone — **SOLVED** (automatic tone matching works)

Skin tone is baked into the head asset, so matching tone means choosing the
right head. That mapping is now **derived by measurement**, not guesswork.

**The source: the MyFranchise companion app.** It ships every coach portrait as
a PNG inside its `app.asar` (`<portraitId>--coachportraits.png`). Because
`Portrait = headAssetNumber + 308` was already proven (93/93, zero exceptions),
each head asset maps to exactly one portrait.
[`probe18-portrait-tones.js`](research/probe18-portrait-tones.js) decodes each
PNG (dependency-free), samples the central face region, keeps warm skin-like
pixels (`R>G>=B`, discarding near-black hair/shadow and near-white
cap/background), takes the interquartile mean, computes luma, and maps it onto
the 1–8 scale.

**The catalog is 200 heads, not 83.** probe18 measured only the heads that
happened to be *in use* in one save — a sample mistaken for the catalog.
[`probe19-full-portrait-catalog.js`](research/probe19-full-portrait-catalog.js)
walks the whole asar: 385 coach portraits, ids 1–508, and the block 309–508 is
**dense with zero gaps** → assets 1–200. That matches the in-game Generic Heads
browser's ~200 male faces, and the save independently corroborates the top of
the range (a live DC wears `coachhead_M_0200_HS`).
[`probe20-build-tone-map.js`](research/probe20-build-tone-map.js) regenerates
the map over all 200, holding the luma anchors fixed so previously-validated
assets can never silently shift.

Supply per tone roughly **2.4×**'d — the scarce dark tones benefited most:

| tone | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| was (in-save only) | 4 | 11 | 16 | 12 | 18 | 6 | 11 | 5 |
| now (full catalog) | 11 | 27 | 36 | 26 | 38 | **21** | **26** | **15** |

**Validated against every independently-known point — 6/6:**

| asset | derived | independent ground truth |
|---|---|---|
| 0033 | 7 | the game itself wrote `skinTone: 7` for a created coach |
| 0097 | 8 | Thomas Peters — observed clearly dark in-game |
| 0057 | 7 | Roy Walker — observed dark |
| 0047 | 2 | rendered as "a white guy" in a live test |
| 0034 | 3 | Garrett Pratt — observed light |
| 0056 | 5 | Chad Masters — observed olive/medium |

**Coverage is complete.** All 8 CFB tones have matching Madden heads, so every
CFB coach with a readable tone gets an exact match. Verified end-to-end: a CFB
tone-8 head coach transferred and automatically received asset `0113` (tone 8,
exact) with no configuration.

`appearance.js` now selects over the **catalog**, not just in-save heads, and
prefers the 117 heads nobody is wearing — so transferred coaches stop
duplicating existing faces. Catalog-only heads have no `CharacterVisuals` row of
their own and borrow an in-save donor's blob for apparel, exactly as unused
heads already did. The `grantAppearance` report carries `headConfirmedInSave`
so an inferred name is always distinguishable from an observed one.

**Inferred names are real — verified in-game, all three.**
[`probe21-catalog-head-writetest.js`](research/probe21-catalog-head-writetest.js)
placed three coaches wearing three *never-observed* heads into `CAREER-HEADTEST`,
and all three render as real, correctly-toned faces:

| team | coach | head | tone | confirmed |
|---|---|---|---|---|
| Giants | Mike Anthony | `0039` | 8 (darkest) | ✅ |
| Bears | Dave Aranda | `0110` | 7 | ✅ |
| Jets | Shannon Archer | `0084` | 6 | ✅ |

None of these assets was ever observed on a live coach — their names were
inferred from the portrait art alone. Three-for-three validates the approach:
the other 114 inferred heads are good and the **full 200-head catalog stands**.

**Selection precedence** in [`appearance.js`](lib/carousel/appearance.js):
1. `config.coachHeadAsset` — explicit head, always wins
2. `config.coachSkinTone` — explicit tone
3. **automatic** — read from the CFB coach's own head name
4. seeded fallback

### 4.1b The CFB side — 230 coaches have no tone to read

`cfbSkinTone()` is **exact on all 493 head names** in the sample dynasty: 263
parsed, zero false positives on `Unique_*` names, zero `Generic_*` missed. But
the other 230 use `Unique_*` heads — authored likenesses of **real, named
people** (`Unique_C_ArandaDave_458` is Dave Aranda) — which encode no tone
anywhere. They are also exactly the coaches anyone wants to move: Day, Freeman,
Sarkisian, Smart, Lanning, Kiffin, Riley, Swinney.

**Four routes were tried and closed** (probes 22–25):

| route | result |
|---|---|
| Scrape CFB portraits like Madden's | **No CFB art exists on disk.** MyFranchise is Madden-only; Mini MyDynasty's folder is empty. |
| Extract from the game install | Frostbite `.cas`/`.toc` archives, all coaches pointing at one packed library (`library_icons_brt`). Needs a Frostbite toolchain — a project, not a grab. |
| Infer from another Coach field | Ranked all 136 fields by mutual information against the 263 labelled coaches. Every high scorer is high-cardinality (`Name`, `AssetName`, `Portrait`) — memorisation, not signal. |
| Infer from the `Portrait` id | Not tone-banded; per-tone ranges overlap almost completely. The `Unique_` trailing number isn't the portrait id either (0 of 230 match). |

**So tone is supplied, not derived.** [`data/cfbCoachTones.json`](data/cfbCoachTones.json)
takes hand overrides keyed by head asset name, and
[`tools/listUntonedCoaches.js`](tools/listUntonedCoaches.js) ranks who's missing
by position then level, so the ~20 coaches that matter are a short sitting.
Nothing auto-populates it — guessing a real person's appearance from their name
would be unreliable and inappropriate.

**Unmapped coaches still transfer.** Rather than a uniform draw over Madden's
head art (which would inherit *that* art's distribution), an unknown coach gets
a tone sampled from how CFB actually distributes tones — measured from the 263
labelled coaches in the save. The population stays sane even when individuals
are guesses, and `grantAppearance` returns **`toneWasGuessed`** so a guess is
never mistaken for a match.

Verified end to end (probe26): a `Generic_*` coach matched tone 1 exactly with
zero config; Freeman came back `guessed=true`; adding an override flipped him to
a real match.

**Dead ends, recorded so they are never retried:** the `CoachFace` tone-banded
namespace — and we now know *why* it failed: MyFranchise's own
`genHeadPortrait.json` maps exactly those `<tone>_<facialHair>_<hair>_<variant>`
names to portrait ids in the 3000–4300 range, i.e. it is the **player** head
namespace, which is why it never resolved for a coach; the
`CharacterVisuals` `skinTone` key (a
descriptor the game writes, does not drive rendering); CFB head indices (a
different numbering system entirely); and the in-game browser's `Head <N>`
labels (catalog positions, **not** asset ids — browser "Head 031" is asset
`0033`). `ROSTER-*` files also can't help: different container, unopenable.

### 4.1c Bug fixed — silent wrong-team placement

Found while verifying the head test in-game: the Jets kept their incumbent
(Aaron Glenn) while the new coach was stranded on another team.
`findMaddenTeam` matched `teamIndex` **OR** `teamName` independently and
returned whichever hit first in table order. The probe passed a stale
`teamIndex 25` (actually the Commanders) alongside `"Jets"`, and 25 matched
first — so the coach silently landed on the Commanders and the Jets never
changed. Giants/Bears only worked by luck of row order.

Fixed: when both are given they must resolve to the **same** team or it throws;
either alone still works. Re-ran the test resolving by name only — all three
teams now hire correctly, both pointers agree, and the displaced incumbents
(Canales, Daboll, Glenn) move to free agency. Regression test added
(`carouselPlaceOnTeam`). This is a pipeline-integrity fix: any caller that ever
passed a `teamIndex` disagreeing with its `teamName` would have corrupted the
placement.

### 4.2 Ability count reads 28/25 (112%)

Cosmetically odd but **probably correct**. The breakdown spans four trees
(Personnel/Offensive/Scout/Development) while the "/25" denominator appears to
be the archetype's own core count — so exceeding it is expected for a coach with
cross-tree abilities. Real coaches likely show the same: Tomlin carries 33
gameday talents at L49, Shanahan 31 at L43.

**Confirm by** opening Coach Central on Tomlin or Shanahan. If they also exceed
100%, this is normal and needs no fix. If they don't, trim cloned trees to the
archetype cap.

### 4.3 Level +1 offset (§1.1)

Decide whether to write `targetLevel - 1` so the displayed level matches the
intended mapping.

### 4.4 Stale team loadout — ✅ fixed 2026-07-25

The Giants' `GamedayLoadout` slot4 referenced the *previous* coach's talent
row (`4112:794`). Fixed: `clearStaleTeamLoadouts` (`lib/carousel/
placeOnTeam.js`) clears any `Talent` reference left in the destination team's
`GamedayLoadout`/`PlaysheetLoadout`/`WearAndTearLoadout` slots on a HeadCoach
placement — see `COACH_TRANSFER_AUDIT.md` §9.5 for the mechanism and
verification.

### 4.5 Coordinators are untouched

Coach Central shows the Giants' existing staff (Garrett Pratt L8 OC, Roy Walker
L13 DC, Adam Montalvo L37 Trainer). Only the head coach transfers today. Moving
a full staff — or letting a hired HC bring coordinators — is unbuilt.

---

## 5. Build order

| # | Work | Cost | Why |
|---|---|---|---|
| 1 | Confirm 4.2 on Tomlin/Shanahan | 30s | May close the issue with zero code |
| 2 | Level +1 decision (4.3) | 1 line | Makes mapped level match displayed level |
| ~~3~~ | ~~Repoint team loadout slots (4.4)~~ | ✅ done | Correctness |
| 4 | Skin-tone catalog (4.1) | largest | Biggest visible-quality win |
| 5 | Coordinator/staff transfers (4.5) | large | New capability, not polish |

---

## 6. Research index

| probe | question answered |
|---|---|
| [`probe13-talent-system.js`](research/probe13-talent-system.js) | talent tree structure; tree size vs level |
| [`probe14-talent-feasibility.js`](research/probe14-talent-feasibility.js) | clone headroom, team-loadout linkage, 4-level nesting |
| [`probe15-level-tuning.js`](research/probe15-level-tuning.js) | `StaffLevelTuning` is static/out-of-save; live XP↔Level curve |
| [`probe16-coach-appearance.js`](research/probe16-coach-appearance.js) | head/portrait/visuals relationship; the +308 rule; catalog |
| [`probe18-portrait-tones.js`](research/probe18-portrait-tones.js) | measures skin tone from the shipped portrait art (in-save heads) |
| [`probe19-full-portrait-catalog.js`](research/probe19-full-portrait-catalog.js) | the catalog is assets 1–200; asar manifests; player vs coach head namespaces |
| [`probe20-build-tone-map.js`](research/probe20-build-tone-map.js) | regenerates `data/coachHeadTones.json`, re-validating the 6 ground truths |
| [`probe21-catalog-head-writetest.js`](research/probe21-catalog-head-writetest.js) | do inferred (never-observed) head names render? **writes a save** |
| [`probe22-cfb-coach-appearance.js`](research/probe22-cfb-coach-appearance.js) | CFB coach appearance schema; Generic_* vs Unique_* split; visuals blob contents |
| [`probe23-find-cfb-portraits.js`](research/probe23-find-cfb-portraits.js) | is there CFB portrait art anywhere on disk? (no) |
| [`probe24-cfb-tone-signals.js`](research/probe24-cfb-tone-signals.js) | does any CFB field predict tone? (no — all high scorers are high-cardinality) |
| [`probe25-transfer-bug-audit.js`](research/probe25-transfer-bug-audit.js) | structural audit of the transfer: silhouette flag, gender, portrait spaces, schema collisions, capacity |
| [`probe26-cfb-tone-endtoend.js`](research/probe26-cfb-tone-endtoend.js) | proves match / guess / override all work. **writes a save (cleans up)** |

## 7. Modules

| module | role | status |
|---|---|---|
| [`appearance.js`](lib/carousel/appearance.js) | head + portrait + private visuals row | ✅ working |
| [`talentTree.js`](lib/carousel/talentTree.js) | 4-level deep tree clone | ✅ **proven load-bearing** |
| [`validate.js`](lib/carousel/validate.js) | pre-write schema validation (offset-int aware) | ✅ |
| [`listUntonedCoaches.js`](tools/listUntonedCoaches.js) | ranks CFB coaches needing a tone override | ✅ |
| [`timing.js`](lib/carousel/timing.js) | head-coach hiring-window gate | ✅ |
| [`placeOnTeam.js`](lib/carousel/placeOnTeam.js) | Mode B placement, displacement, both pointers | ✅ |
| [`movement.js`](lib/carousel/movement.js) | who moves and why (desirability × willingness) | ✅ proposals only |
