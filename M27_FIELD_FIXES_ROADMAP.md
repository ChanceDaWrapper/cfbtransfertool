# M27 Field Fixes -- Roadmap (0.3.1)

**Status: Phase 2 FIXED and fully verified. Phase 1's reported crash turned out
to be the FILE NAME, not file content -- see the correction at the top of that
section; the separate ability-block defect that investigation uncovered is
fixed regardless.** Written 2026-08-10 from community reports on the first
public M27 build (0.3.0); fixes landed the same day.

**This roadmap ships as 0.3.1.** 0.3.0 is already in the field, so it is frozen:
nothing below is a change to it. Two 0.3.1 items are already built and sitting
in the tree unreleased -- the QB/HB/S rating tuning and user-added players (both
2026-08-10) -- and they go out in the same build as the fixes below.

One correction to carry: the 0.3.0 changelog claims M27 ability values are
"carried over from a position-matched pro". That is wrong (see Phase 1). The
0.3.0 entry is left as the historical record of what shipped; state the
correction plainly in 0.3.1's entry rather than editing a released version's.

The headline finding: **0.3.0's M27 export has a real defect**, and it is not
the one that was guessed. The first field report of a failed M27 import is also
the first real-world test this feature has ever had -- see Phase 1.

Two items from the same feedback round are already **done** and need no work:
adding a specific player by hand (shipped 2026-08-10, `lib/customPlayers.js`)
and the QB/HB/S rating tweaks (shipped 2026-08-10, `diceRoll.js`).

---

## Phase 1 -- M27 draft class boots to main menu on import (P0)

### RESOLVED, BUT NOT BY THIS -- read this before trusting the analysis below

**The crash was the FILE NAME (confirmed by Chance, 2026-08-10). Nothing in
the binary content caused it.** The ability-block analysis below is kept
because the defect it found is real and worth having fixed -- 8.9%
position-match is not defensible on its own terms -- but it was NOT the cause
of the boot-to-main-menu, and this section originally claimed it was.

Recording the mistake rather than quietly deleting it, because the reasoning
that produced it looks sound and will look sound again next time: the symptom
(works from the weekly agenda, fails from Draft Class -> Edit) was read as
"the failing screen renders more player detail, so the bad data must be in the
detail fields." That inference was plausible, testable, and wrong. A
same-content file under a different name behaves differently, which no
content-level hypothesis can explain -- and that discriminator was available
from the start, since SCJGaming's own report said EA-downloaded files worked
in the same path. Content and naming were never separated before diving into
the binary.

**Lesson for the next field report: reproduce the boundary before theorising
about the payload.** Ask what differs between the working and failing case
that is not inside the file.

### The (real, unrelated) defect this investigation did find

**FIXED 2026-08-10.** `draftClassFile.js`
gained `getAbilityBlock`/`setAbilityBlock` (a raw copy of the struct's entire
undocumented tail past offset 202 -- deliberately not five individual u16
setters; the 30-ish bytes past the five known values are unexplored and could
carry more of the same kind of position-correlated data, so the whole span is
copied rather than guessed at field-by-field). `draftClassExporter.js`'s
`applyPlayer` now copies that block from the SAME position-matched donor
equipment already uses, right before the gear-writing block. Verified on a
real 224-player class: 224/224 (100%) of exported players now carry a block
that traces back to a donor of their own position, versus 20/224 (8.9%)
before. New regression assertion in `test/draftClassTargets.spec.js` pins
this against the real bundled M27 template as ground truth; sabotage-verified
(reverting the fix drops the same fixture from 389/389 to 27/389). Full
existing suite (draftClassM27.spec.js, draftClassExporter.spec.js,
draftClassTargets.spec.js) still green -- nothing about slot order, draft
rank, or M26 changed; M26 has no such region and the new functions are a
verified no-op there.

**Report.** SCJGaming: selecting the import file from **Draft Class -> Edit**
kicks back to the main menu without importing. The same file imports fine from
the weekly agenda's **"select the rookies"** tab. EA-downloaded draft class
files work in the failing path. So the file is readable, but something in it
breaks the screen that renders full player detail.

**Confirmed defect: M27 ability blocks belong to the wrong position.**

M27's per-player record carries a 5-value ability/trait block at binary offsets
202-210 that M26 has no equivalent for. The exporter never writes it -- it is
inherited from whichever template player originally occupied that slot. Slots
are filled in **draft order** (`draftClassExporter.js`, the `fillCount` loop),
and the position-matched donor that exists in that loop is used *only* for gear.

Measured on a real generated class (DYNASTY-DRAFTSTAGE, 224 players):

```
slots where written position == template slot position:  20/224  (8.9%)
players inheriting another position's ability block:    204/224  (91.1%)
  slot 0: wrote QB into a RT slot     <- the #1 overall pick has tackle abilities
  slot 2: wrote WR into a LT slot
  slot 4: wrote WR into a QB slot
  slot 7: wrote CB into a QB slot
```

This fits the symptom precisely: the edit screen renders ability cards, the
agenda rookie list does not.

**Note for the changelog:** 0.3.0 currently claims these values are "carried
over from a position-matched pro". That is wrong -- they are carried from the
slot occupant, which is position-matched only by coincidence. Correct the
wording whatever the fix turns out to be.

**Ruled out by measurement (do not re-investigate):**

- *Archetype values.* We write archetypes absent from the game's own export in
  **both** M26 (10 values) and M27 (9 values). M26 imports fine in the field,
  so "absent from the template" is demonstrably not fatal.
- *College indices.* Same argument -- 5 out-of-template indices in M27, and M26
  behaves the same way while working.

**Work:**

1. Fill slots position-aware: for each generated player, choose a template slot
   whose original position matches, instead of slot `i`. This fixes abilities,
   and makes the existing gear donor redundant since the slot itself becomes the
   donor.
2. If (1) can't always match (a class with more QBs than the template has QB
   slots), decide the fallback explicitly -- nearest position group, or zero the
   ability block. Zeroing is safe only if a zeroed block is valid in M27;
   `test/draftClassM27.spec.js` already proves the block survives a write cycle,
   so extend it rather than writing a new harness.
3. Re-test with SCJGaming, who has offered to retest at his next class import.
   **This cannot be verified locally** -- no Madden 27 here.

**Risk if skipped:** the flagship 0.3.0 feature is unusable through the path
most people will try first.

---

## Phase 2 -- Position caps are silently ignored (P1)

**FIXED 2026-08-10, fully verified.** `positionCaps`' default now includes
every position (blank `''` for anything without a shipped default, meaning no
cap), instead of only `{ K, P, LS }`. That was the entire bug: `mergeInto`
merges an object-valued tuning key by iterating the DEFAULT's own sub-keys, so
a position absent from the default could never survive a save/reload. Verified
end to end -- a WR cap of 10 now actually produces 10 WRs in a generated class
(was 50, identical to no cap at all). New regression section in
`test/config.spec.js` pins this at the exact layer it lived in; sabotage-
verified (reverting the default back to 3 keys fails the new assertion
immediately).

**Report.** StayPlation: caps set, still getting ~80 WRs.

**Root cause found, and it is NOT the M27 restructure.** `mergeInto` in
`lib/defaults.js` merges a config object by iterating **the target's existing
sub-keys**:

```js
for (const subKey of Object.keys(target[key])) {   // <- target, not saved
  if (sv[subKey] === undefined) continue;
  ...
}
```

Any sub-key absent from the DEFAULT is therefore dropped. The default
`positionCaps` is `{ K: 3, P: 5, LS: 3 }`, so **a cap on any other position is
discarded** -- on save, and again at generate time. Reproduced:

```
user sets        : {"K":3,"P":5,"LS":3,"WR":10,"CB":8}
after mergeConfig: {"K":3,"P":5,"LS":3}              <- WR/CB gone
generated class  : WR 50 with no cap, WR 50 with a cap of 10   (identical)
```

This predates the M27 work by a long way; the restructure is not implicated.

**Blast radius is exactly one setting.** Every other tuning key either has a
closed default set (all 22 positions present, e.g. `positionStrength`,
`positionValue`, `positionExtraDrop`) or is nested one level deeper, where
`mergeInto` does a full spread and user keys survive. Verified:

```
positionCaps.WR               *** DROPPED ***
powerCurve.ratingCategory     SURVIVES
powerCurve.categoryOverrides  SURVIVES
powerCurve.ratingTweaks       SURVIVES
```

**Work:** either seed the `positionCaps` default with every position (blank =
no cap), or make `mergeInto` spread open-ended maps at depth 1. The first is
smaller and local; the second is more correct and prevents the next instance of
this bug. Whichever is chosen, `test/config.spec.js` needs a case that sets a
sub-key absent from the defaults and asserts it survives a round trip -- there
is no such assertion today, which is why this shipped.

---

## Phase 3 -- M27 face/portrait remapping (P2)

**ROOT CAUSE FOUND AND FIXED 2026-08-10. It was not a catalog problem.** The
guess below (catalog thinness) was wrong, and the real cause was a
single-field offset error:

* Madden 27 shifts every field after FirstName by +4 -- **except the portrait
  ID, which moves by +2**. It lives at record offset **148**, not 150.
* Found by scanning every u16 offset in M27's 244-byte record for M26's
  portrait signature (values in the 3347-4287 render band). Exactly one
  candidate: offset 148, with 329/389 in band and 188 distinct values. Offset
  150 -- where the uniform shift put it -- holds 12 distinct values in 0..13,
  obviously a different field.
* Confirmed decisively by structure: M27 pairs each generic head with exactly
  one portrait. 188 distinct heads, 188 distinct values at 148, zero heads with
  two portraits, zero portraits on two heads -- a perfect bijection. A field
  that is 1:1 with the head asset is the portrait.
* Effect of the bug: the exporter read the portrait from 150 (garbage, ~0),
  wrote ~0 back there (clobbering that small enum), and never wrote 148 at all.
  Every exported player kept whatever portrait belonged to the template slot
  they overwrote. Measured on a real class: **2/224 (0.9%)** of players had a
  portrait matching their own head. Now **224/224 (100%)**.
* Fix: `FACE_ID_OFFSET_BY_FORMAT` in `draftClassFile.js` (m26: 146, m27: 148),
  reached through the new `binary.formatKey` -- `fieldShift` alone cannot
  express a field that shifts differently from everything else.
  `catalogFromTemplate` now also drops M26's render-band filter for M27, whose
  portraits run 3350-10354 with no blank band; keeping it would have discarded
  two thirds of the catalog.
* Two new assertions in `test/draftClassTargets.spec.js`, both
  sabotage-verified. Note the fixture understates the bug (389 -> 354) because
  it cycles only 10 positions and 7 tones; the blunt "portraits must be >= 3347"
  guard is the reliable one, and it rejects offset 150 outright (0..13).

**One correction to the record:** `appearanceCatalog.js` previously claimed the
head-name digit was "verified 402/402" against M26's explicit `skinTone` field.
That is false -- they agree on **249/402 (62%)**. The head digit is the HEAD's
skin; `skinTone` is the portrait's. They are correlated, not identical, and
M26's baker already knew this (it keeps only occurrences where the two agree).
The claim has been corrected in place. It does not change M27's behaviour: M27
has no `skinTone` field at all, so the head digit is the only skin signal that
exists there.

### Catalog thinness -- CLOSED, it was never the problem (2026-08-10)

Checked against two further real M27 exports (CAREERDRAFT-TRANSFERTEST2/3).
Pooling all three files yields **196** distinct (head, portrait) pairs against
**188** from the single bundled template -- **+8, about 4%**. Per tone the gain
is 0/0/+1/+1/+2/0/+4. EA's M27 draft classes simply draw from a pool of ~196
generic heads, and one 389-player file already exposes 96% of it.

So deriving the catalog from a single template is fine, and the multi-file bake
M26 needs (its catalog spans four auto-drafts) is not warranted here. No code
change. This closes the "collect 3-4 real M27 exports and bake a catalog"
work item -- it was measured and is not worth doing.

**Three findings that came out of those files, all confirming earlier work:**

1. **The head -> portrait pairing is a GAME CONSTANT, not a per-file artifact.**
   195 heads appear in at least two of the three files; all 195 carry the
   *identical* portrait in every file, zero conflicts. Each file independently
   shows a perfect bijection (188/188, 193/193, 192/192). This is much stronger
   evidence for the offset-148 conclusion than the single file it was found on.
2. **The file format did not change across the two Madden 27 builds.** Files
   with tags `9074430` and `9081279` are both 389 players, 244-byte records,
   2673650 bytes total, portrait at 148. The parser needed nothing.
3. **The bundled template was not stale.** Zero of its 188 heads are absent from
   the newer build. Two gear items are absent from the newer *samples*, which is
   sampling noise in a 389-player file, not removal.

**Action taken:** the bundled M27 template was re-baked from TRANSFERTEST2 so it
carries the current schema tag (`9081279`) and the slightly larger asset pool.
Verified after the swap on a real class: portraits 224/224 matched to EA's
pairing, ability blocks 224/224 position-matched, tones 219/224 (the 5 being
tone-8 falling back to 7, which is correct). Full suite green. The previous
template is not in git -- a backup was kept at `/tmp/m27template.backup.gz` for
the session, and re-baking from any real export regenerates it, so this is
reversible if a real import ever disagrees.

Original analysis follows.

**Reports.** Mike Lowe: "the terrible Madden profile pics don't match for race,
but players seem accurate when you go in and edit them." Chance's own note: M27
renamed some face assets, so they need remapping.

**What is already known** (from `research/probe50-likenessParity.js`,
`probe51-faceParity.js`, run 2026-08-10):

- M27's face-part vocabulary is the same *scheme* as CFB's
  (`Head_Face_Tone##_Set##`, `Head_hair_*`), and CAF characters share it exactly.
- Dynasty players -- the ones this app converts -- do **not** use CAF faces.
  They use preset heads (`Generic_0046_C_T0045_T_4_3_item` in CFB), and Madden's
  preset vocabulary is unrelated. Synthesis from Madden's own catalog is the
  only option, which is what the app already does.
- For M27 the catalog is derived live from the bundled M27 template
  (`catalogFromTemplate`), which is deliberately conservative: heads that exist
  in M27 but not in that single template file are never offered.

So the portrait mismatch is most likely **catalog thinness plus the separate
portrait field**, not a broken mapping. Before writing code, bake a proper M27
appearance catalog from several real M27 auto-drafts the way
`data/appearanceCatalog.json` was built for M26 (4 files) -- the current M27
path has exactly one source file.

**Work:** collect 3-4 real M27 draft-class exports, bake an M27 appearance
catalog, then re-check skin-tone/portrait agreement the way the M26 catalog was
validated (402/402 head-digit-to-tone correlation).

---

## Phase 4 -- Spreadsheet / online-dynasty import path (P3)

**Report.** akaMich: online CFB dynasties can't be read by the tool, but if the
data can be got into a spreadsheet by other means, could the tool take it from
there? He has offered to help and is comfortable in spreadsheets.

**This is closer to done than it looks.** `loadDepartedCsv` already exists in
`pipeline.js` and is already wired to the "Load CSV" button. Its hard
requirement is only four columns:

```
FirstName, LastName, Position, OverallRating
```

Everything else is optional -- and the custom-player work shipped today proves
a sparse row can be completed from a position-matched donor rather than
rejected.

**Open question that decides the scope:** whether Madden's side works for
*online* franchise at all. The draft-class file is imported through the game's
own UI, so it likely does, but nobody has confirmed it. Ask before building.

**Work:** document the exact column names (a README section plus a downloadable
template CSV), make missing rating columns fall back to donor completion instead
of erroring, and give akaMich the template to test against a real online dynasty.
Low effort, and it answers a question that has now been asked more than once.

---

## Closed -- no work needed

- **Tattoos / likeness carry-over (Sturmie).** Dead end, and not for the
  expected reason. Full scan of a CFB 27 dynasty: **zero tattoo slots across
  12,506 characters.** The M27 franchise *does* have four (`LeftArmTattoo`,
  `RightArmTattoo`, `LeftLegTattoo`, `RightLegTattoo`). The destination can
  receive them; the source has nothing to give, so no amount of matching M27
  tattoo assets from a modder changes it. Equipment, by contrast, already
  carries over -- 70.7% of CFB asset names appear verbatim in M27.
- **NIL / recruited players (DonaldJ80).** Already works; both are ordinary
  players in the dynasty save. Answered in chat, no code implied.

---

## Suggested order

1. **Phase 2** first, despite being P1. The root cause is understood, the fix is
   small and local, and it is the only item that can be fully verified here
   without a copy of Madden 27.
2. **Phase 1** next, and ship it with Phase 2 so there is one build to retest.
   Its verification depends on someone else's machine, so it should go out early
   in a retest cycle rather than late.
3. **Phase 3** once real M27 export files can be collected.
4. **Phase 4** after confirming online franchise import is even possible.
