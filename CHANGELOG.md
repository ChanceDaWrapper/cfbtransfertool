# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-08-05

### Changed
- **Coordinator hires (OC/DC) are now restricted to the coach hiring window,
  same as head coaches already were.** Previously only a head-coach hire was
  blocked outside Madden's own coach hiring/demand-release window (or CFB's
  carousel period) -- an offensive or defensive coordinator could move any
  time. Both games' own hiring systems don't work that way, so coordinators
  now go through the identical check. "Allow head-coach hires outside the
  hiring window" in Coach Settings still overrides it, for all three positions
  under one toggle (now labeled "Allow coach hires outside the hiring window").
- The resulting message now reads "This is the wrong week to use this tool
  for a coach hire" instead of naming Madden's calendar specifically, since
  the same check runs against whichever save (Madden or CFB) the coach is
  actually landing in.

### Added
- **A safety check that refuses to write to a save it doesn't fully recognise.**
  This changes nothing today -- it passes silently on every save tested -- and
  exists purely so a future College Football title update can't quietly damage
  someone's dynasty. Before a transfer or a repair touches anything, the save is
  checked for the tables and fields the operation is about to use. If something
  load-bearing is gone, you get a plain message naming exactly what's missing
  and confirming nothing was written, instead of either a meaningless internal
  error or -- much worse -- a silently wrong result. That second case is the
  real reason this exists: a missing field doesn't crash anything, it just reads
  as blank, so (for example) if the coach Level field ever disappeared, every
  coach in the league would look unemployed and the tool would act on that
  without a single warning.
- The check deliberately distinguishes what actually matters from what doesn't.
  Anything the app already handles gracefully -- coach portraits, talent trees,
  pending contract offers -- only produces a note and the transfer still runs,
  since a safety check that blocks valid saves would be worse than none at all.

### Fixed
- **Dice Roll was too hard on quarterbacks and running backs specifically.**
  Measured against Power Curve on the same college pool (the only fair
  comparison, since both engines convert identical players): QB came out at a
  median of 59 against Power Curve's 66, and HB at 60 against Power Curve's 68
  -- both meaningfully behind every other position, which already matched
  Power Curve without any adjustment (DT: 68 vs 68). The cause is that most of
  what actually decides a QB's or HB's overall (Awareness, throw accuracy,
  vision, elusiveness) was taking Dice Roll's full, unscaled class penalty,
  same as every other rating -- QB's Speed/Acceleration/Agility/Change-of-
  Direction get a gentler flat cut and Throw Power is now physical (see
  below), but nothing covered the rest. Power Curve already solved this
  exact problem for these same two positions years ago (its own tuning table
  discounts QB and RB below its 1.0 baseline, with a note recording that RBs
  specifically "were coming in way too low" under its original values) --
  Dice Roll just never got the equivalent. It now dampens those ratings for
  QB and HB the same way, tuned to land at Power Curve's own median: QB now
  67 (was 59), HB now 69 (was 60), with HB's ceiling rising from 72 to 81.
- **Throw Power was dropping too much for quarterbacks.** It was falling
  through to the same full-penalty treatment as a mental rating, purely
  because nothing had ever classified it -- arm strength is a physical trait,
  and the app already treats it that way everywhere else (Power Curve, the
  general ratings list). It's now dampened the same as Strength/Stamina/
  Jumping: a typical class roll used to take a 90 arm to 79, a bad roll to
  69; now the same rolls give 87 and 85.
- Checked and confirmed clean, not touched: **defensive tackle strength**
  was already being treated as a physical trait (it's been in that list since
  Dice Roll shipped) and already matches Power Curve closely on real Madden
  numbers (median 84 vs 85, min 73 vs 75) -- no change needed there.

### Investigated, not reproduced
- **Kickers, punters and long snappers not appearing in a generated class.**
  CFB 27 itself has no Long Snapper position at all in its player data --
  there is nothing to draw one from, in any engine. Kickers and Punters do
  exist in the college pool and, on every save and engine/league combination
  tested here, several make a generated 402-player class (typically 5-8
  combined, some inside the actual 7-round draft). If you're still seeing
  zero, the likely difference is a smaller Class Size setting or a Position
  Cap set to 0 -- let me know your exact settings or send a save and this
  can be looked at directly.

- **A dynasty could load forever after transferring coaches in from Madden.**
  Not a crash -- the loading screen simply never finished. CFB keeps a
  league-wide job-security RANKING that is a complete, unique ordering of the
  employed coaches: every number from 1 to however many coaches there are, used
  exactly once, with unemployed coaches parked outside it. A transfer broke it
  from both ends at once. The arriving coach was promoted out of a free-agent
  slot still carrying the "not employed" placeholder, and the coach they
  replaced was fired still holding a real position in the ordering -- so the
  ranking ended up with holes where the departing coaches used to be and
  several new coaches sharing a number that isn't in the list at all. Anything
  walking that ordering has nothing to stop on. Measured on the save that would
  not load: four transfers left ranks 84, 161, 230 and 288 belonging to nobody.
  The arriving coach now inherits the standing of the coach whose job they took,
  which keeps the ordering complete -- and is what a real hiring does anyway.
- **The repair tools now find and fix this too, and no longer stop at the first
  clean check.** Both `FixCoachCrash` and `tools/repairTransferredCoaches.js`
  used to give up the moment the contract-goal check came back empty, which is
  precisely why they reported "no damaged coaches found" on a dynasty that was
  plainly broken -- the two faults are independent and this save had only the
  second one. They now check both, report both, and repair whichever is present.
- `FixCoachCrash` will no longer write a partly-repaired save. If any problem
  can't be fixed it writes nothing and says so, rather than producing a file
  that looks repaired, still fails, and is in a state neither the original
  damage nor a clean repair produces.
- **Draft-class equipment was wrong for most players, and quarterbacks were
  wearing gloves.** The exporter never wrote equipment at all -- it filled the
  template's 402 slots in draft-rank order and each player silently inherited
  whatever the real player who happened to occupy that slot was wearing.
  Measured on a real class: 91% of players ended up in another position's gear.
  Quarterbacks came off worst, because the template is 90.5% gloved overall
  while 25 of its 26 genuine QB slots correctly wear none -- so 43 of 48
  generated quarterbacks got someone else's gloves, and linebacker cages and
  receiver two-bar facemasks landed wherever the draft order put them.
  Equipment is now written per player: gear comes from a slot that actually
  played that position, and each player's OWN college equipment is carried
  across on top wherever Madden has the same item. Measured after the fix:
  quarterbacks in gloves down to 4% (the rate among real NFL quarterbacks in
  the template), every player position-matched, and 65% of all gear slots now
  holding the player's real college item.
- Equipment that exists in College Football but not in Madden is no longer a
  problem either way: the two games share most of a gear namespace but not all
  of it (about 69% of a dynasty's distinct assets carry over -- 90%+ on
  facemasks, gloves and sleeves, far less on college-specific kit like inner
  pants and jersey styles). Anything Madden doesn't have keeps the
  position-matched item instead of being written blind. The known-good list
  lives in `data/maddenGearAssets.json` and is regenerated by
  `tools/bakeMaddenGearAssets.js` against a Madden save.
- Faces, hair and tattoos are deliberately left alone by all of the above --
  they share the same underlying structure as equipment, but the exporter
  already assigns heads and skin tone together, and overwriting them from the
  college save would desync the draft-board portrait from the in-game model.
- **Dice Roll produced classes that were far too weak.** On a real 402-player
  class it returned a median overall of 59 with only THREE players at 70 or
  better; Power Curve returned 67 and 116 from the same save. The cause was the
  class-strength table: every tier was a penalty between -15% and -25%, so
  there was no roll that left a class intact, and because the penalty scales
  with each player's own overall it worked out to roughly x0.78 on everyone. A
  college 91 was needed to reach a Madden 70, and a Madden 80 needed a college
  103 -- unreachable, so the engine had a hard ceiling near 72. The tiers are
  retuned (now -15% to -10%) so Dice Roll reproduces Power Curve's real
  baseline: median 67, 115 players at 70+. Half of this was already known --
  the UFL profile was corrected for the same reason and the table itself was
  explicitly left for later; this is that rework, and it reaches NFL too.
- **The overall shown in the app didn't match what Madden computed on import.**
  Dice Roll derived its displayed overall from the roll arithmetic alone,
  without reading a single converted rating, so it missed the position tier
  cuts, the quarter-strength physical treatment and the floor under low
  ratings -- and overstated the real result by about 6 points, in the direction
  that hides a problem. It now scores the ratings actually being exported, so
  the number on screen is the number Madden will read. (This is the same
  mis-reading that caused the UFL tier to be tuned wrong twice.)

### Changed
- A Dice Roll class-strength roll now swings a class about 5 overall points
  from Very Weak to Very Strong, down from about 10. One uncontrollable die
  roll should colour a class, not decide it. Forcing a specific tier in
  settings still works and still matters.

## [0.2.2] - 2026-08-03

### Fixed
- **The 0.2.1 bowl-week crash fix was incomplete -- this closes the actual
  cause.** A Madden→CFB transfer lands the arriving coach on a free-agent
  shell and promotes them to employed, but several values only make sense for
  someone WITHOUT a job. The clearest: `CurrentContractExpectation` was left
  at the enum's "no contract goal" value, which zero employed coaches in a
  healthy dynasty ever carry -- and advancing past bowl week is exactly when
  the game asks every employed coach whether they met their goal.
- A second, separate defect in a different table: other schools' pending
  contract offers to that free-agent shell were never updated, so an employed
  coach could end up carrying offers with no source school attached -- a
  shape the carousel never produces on its own and chokes on when it runs at
  season rollover.
- Both are fixed on every future transfer, and `tools/repairTransferredCoaches.js`
  now repairs an already-damaged dynasty completely (0.2.1's version only
  attached missing season/career records, which was necessary but not enough).

### Changed
- Repairing a save no longer touches `ContractLength`/`ContractYearsRemaining`.
  An earlier pass "fixed" these too, but the reasoning didn't hold up: it
  treated a merely-uncommon-in-one-save contract length as invalid and
  shortened four real coordinators to 1-year deals for no real reason.
  Contract terms are an intentional part of every transfer, not free-agent
  leftovers, and are left alone.

## [0.2.1] - 2026-08-01

### Fixed
- **Dynasties crashed when advancing past bowl week after a Madden to CFB
  coach transfer.** Arriving coaches were placed into an empty coaching slot
  but never given the season and career records every employed CFB coach
  has, so the game crashed the moment it tried to close out the season. The
  save looked completely fine until you advanced. Transfers now build those
  records properly. Nothing to do with transferring during bowl weeks --
  that was always allowed and always fine.
- **Coach faces could not be applied at all, on any save.** Coach appearance
  data is Zstandard-compressed, and decompressing it needs a newer Node than
  the app shipped with -- so every attempt failed with "could not read a
  donor CharacterVisuals blob" and blocked the whole transfer. The saves were
  never at fault. Updated the app's runtime (Electron 32 to 37), and faces now
  apply correctly.
- A face that still can't be applied no longer blocks the transfer, since it
  is purely cosmetic: the coach moves with the correct job, level, contract
  and abilities, keeps the destination slot's existing face, and the app
  tells you it did so.
- The appearance system also now skips an unusable donor and tries the next
  one, rather than giving up on the first.
- Errors from reading appearance data are now reported instead of being
  silently discarded -- the discarding is what hid the real cause above.
- A transferred coach could occasionally end up with a noticeably smaller
  ability set than intended, if the real coach used to build their tree
  happened to be missing one specific ability category.
- A newly hired head coach's team could still show one of the previous
  coach's equipped abilities in a couple of rare cases.
- A very small number of CFB coaching slots could receive a coach with no
  ability tree at all; that landing spot is no longer offered.

### Added
- `tools/repairTransferredCoaches.js` -- repairs a dynasty already damaged by
  an older build, so a save that crashes on advance can be recovered instead
  of restarted. Dry-run by default; writes to a new file, never in place.
- `tools/diagnoseCoachVisuals.js` -- a read-only report explaining why a
  given Madden save's coach appearance data can't be read.

## [0.2.0] - 2026-07-27

### Added
- **Coach Carousel.** Move coaches between your CFB dynasty and your Madden
  franchise, either direction. Auto-propose scores who's realistically likely
  to move and pairs them to the most vulnerable jobs, or pick exactly who
  goes where yourself. Every move is a reviewable plan before anything is
  written. Faces are matched by skin tone automatically, and a full talent
  tree comes with every hire.
- **UFL draft classes.** A second, independent draft class -- the tier just
  below your NFL cut -- for a UFL roster mod, guaranteed to never share a
  player with the NFL class. Works under both rating engines.
- **Dice Roll**, a second rating-conversion engine alongside Power Curve:
  rolls a class-wide strength plus a bust/gem roll per player, for a less
  predictable, more real-feeling class.
- **Settings import/export**, whole-app or per-league, with a preview of
  what a file would change before you apply it.
- **Per-league settings** -- NFL and UFL now keep fully independent configs.
- **UFL Overall Boost** -- optional extra lift for the UFL class, off by
  default.

### Fixed
- Coach skin-tone overrides now actually save (previously failed silently in
  the installed app).
- Sidebar no longer loses menu items in a shorter window.

### Changed
- Installer no longer bundles 50+ MB of research/asset extraction output.
- Sidebar reorganized: Coach Carousel added to the nav, Build Class moved
  above Class Results, settings-file buttons tucked into a collapsible
  section.

## [0.1.1] - 2026-07-21

### Added
- **Board Organization** setting (Advanced) with two modes:
  - **CFB Projected Rounds** (default) -- unchanged behavior, where CFB 27's
    own projected round carries significant weight.
  - **Realistic Draft Day** -- re-ranks the same selected class on talent
    alone (overall, position value, awards, production, athleticism -- no
    input from CFB's own projected round), then lets players slide down the
    board at random. Produces genuine late-round steals without the "steal"
    having to come at the cost of a first-round bust: sliding is
    one-directional, so a player falling pushes everyone below them up by a
    single slot each rather than trading places with someone else. A **Draft
    Day Chaos** dial controls how far players can fall.
  - Which players make the class is identical either way -- only where they
    land on the board changes.
- **Δ column** on the Draft Class table (shown only under Realistic Draft
  Day): how many rounds a player moved from where CFB Projected Rounds would
  have placed them. Positive/green = fell later (a steal); negative/red =
  went earlier.

### Fixed
- **Players you talked out of declaring no longer appear in the draft class.**
  When a player declares early and is then persuaded to stay, the game keeps
  their "declared" marking and only flags them separately as staying -- so
  they were still being exported as an incoming rookie despite returning to
  college for another season. They're now excluded, both from the declared
  list and from the graduating-senior scan.

  This only ever showed up after the persuade step resolves (offseason week 2
  and later). At the Draft Stage nobody has been persuaded yet, so classes
  generated there were never affected.

### Changed
- **Class Size can go well below 402 now, with a warning instead of a hard
  block.** A class smaller than 402 still exports: it fills as many of the
  file's 402 slots as it has players for, and leaves the rest as the bundled
  template's original, unconverted prospects (not blank, not duplicated).
  Go below 224 (7 full rounds) and some *drafted* rounds will include those
  unconverted fillers too, not just the undrafted tail -- the app now warns
  about this both in Advanced and on the Export step, rather than refusing to
  export at all. The technical floor is 32 (one full round).
- Confirmed the export ceiling stays exactly 402 on purpose: checked against
  four real Madden 26 draft-class exports spanning two different game builds,
  every one of them is exactly 402 players (224 drafted + a 178 UDFA tail),
  matching what Madden's own importer requires. A larger generated class still
  works fine for tuning/preview -- the export just uses the top 402 by rank.

## [0.1.0] - 2026-07-21

First public release, as **Pipeline**.

### Added
- **Draft-class file export** — builds a Madden `CAREERDRAFT-*` file directly
  from a generated class, importable in-game via *Franchise -> Manage Roster ->
  Import Draft Class*, with no franchise save required. Patches a bundled
  402-slot template with each player's name, position, archetype, age, jersey,
  height/weight, all ratings, dev trait, and draft round/pick.
- **Real colleges written into the exported draft class.** Each drafted
  player's actual CFB school is baked into the file itself, so the class
  imports with correct colleges and needs no post-import fix-up step.
- **Matching appearance on import** — skin tone and body build now follow the
  generated player rather than being inherited from whichever template
  prospect previously occupied that slot.
- **Power-Curve rating-translation engine** (now the default conversion
  engine), replacing the quantile/flat-drop model as the primary path: four
  closed-form category curves (`base = a·xᵖ` — Physical, Technical Light,
  Technical Heavy, Mental) eased by per-position strength dials, so physical
  traits barely change, skills compress moderately, and mental ratings drop
  the most. No calibration data files required; fully deterministic by default.
  Fully tunable at four independent levels:
  - **Global** — one "Overall Class Strength" dial scales every position's
    Technical/Mental compression at once (never touches Physical ratings).
  - **Category** — each of the four curves is edited as a percentage
    ("Elite rating keeps X%"), with a live preview, rather than raw points.
  - **Position** — per-position Technical/Mental/Physical strength dials plus
    a flat per-position "Extra Drop" that still moves the needle even on an
    already near-identity elite physical rating.
  - **Rating** — a **Rating Categories** page lets any rating be reclassified
    into a different bucket, globally or as a per-position exception, plus a
    per-rating flat drop and hard floor (Max Drop) on top of everything else.
- **Rating Translation** and **Rating Categories** settings pages (the latter
  repurposed from the old Physical Attributes page), all with tooltips,
  live previews, and per-value modified indicators.
- **Big WR/CB Agility + Change-of-Direction realism pass** (on by default)
  that reins in unrealistically high Agility/COD on large receivers and
  corners, scaled by frame size. Can be switched off in Advanced -> Rating
  Realism if you already run the external Agility/COD tool.
- `npm test` regression suite locking engine fidelity against the original
  model spec's worked examples, the shipped/tuned defaults, every phase's own
  behavioral proof (global strength, category reclassification, position/rating
  flat drops and caps, per-position exceptions), dev-trait invariance to
  rating-conversion tuning, and the draft-class file format/exporter.

### Changed
- Class Size now defaults to **402** and cannot be set lower — that's the fixed
  slot count of a Madden draft-class file, so any generated class can always be
  exported.
- The player pool now includes everyone leaving the dynasty (graduating seniors
  plus early declarers), not just the players already listed as officially
  declared, so draft-stage saves no longer yield a truncated class.
- `translation.strategy` now defaults to `powercurve`. The legacy quantile/
  flat-drop engine remains available as `v1` (no UI exposes it; reachable only
  by hand-editing a config file), kept dormant as a fallback/reference. The
  Two-Anchor engine (`rosetta`) is unchanged/unimplemented for live use.
- **Est. Madden Overall is now purely cosmetic.** It no longer feeds dev-trait
  weighting (which now reads a pure function of the player's real CFB Overall
  instead) — tuning any rating-conversion knob can no longer silently reshape
  who gets Star/Superstar/X-Factor. It's still shown on the Draft Class table
  and written into the Madden save as a sensible pre-recompute placeholder;
  Madden recomputes the real Overall itself once you open the player in-game.
- Retuned several shipped position-strength and rating-bucket defaults against
  real in-game Madden overalls (documented in full in `POWERCURVE_ROADMAP.md`),
  including moving BC Vision to heavier compression and folding Throw/Kick
  Power into the Physical bucket.
- Removed the Bell-Curve Squeeze and the physical-only per-rating adjustment
  table from the UI (Power Curve superseded both); Position Weights now covers
  only roster construction (Class Cap, Draft Value) — rating-toughness moved
  to Rating Translation/Categories.
- Removed the Arm/Leg Power and Copy Raw categories entirely — every
  convertible rating now compresses through one of four real buckets; there
  is no "leave untouched" option (a rating that should barely change, like
  Throw/Kick Power, now lives in Physical instead).

### Fixed
- Exported players no longer import with a mismatched appearance (a light-
  skinned player rendering with a dark-skinned model, or a quarterback built
  like a lineman).
- The app icon now renders correctly on the Windows taskbar, Start Menu, and
  desktop shortcut.
- The Rating Categories page's "modified" indicator dot never lit up for a
  *global* reclassification (per-position overrides were unaffected).

## Pre-release history

Internal builds predating the public release, under the project's former name.

### 0.2.0 - 2026-07-08

Merges in the draft-simulation half of [cfb2madden](https://github.com/seanpdwyer7/cfb2madden)
(see NOTICE.md for full credit) while keeping this project's rating
conversion engine as the source of truth for player ratings. Full rationale
and subsystem-by-subsystem comparison in MERGE_PLAN.md.

#### Added
- Declaration prediction for dynasty saves earlier than the official
  players-leaving stage, with auto-detection and a manual override in the UI.
- Career college production aggregation (season stats -> career totals),
  used by draft projection and dev-trait weighting.
- Draft projection: round/pick/scouting-profile assignment from production,
  awards, athleticism, position value, and CFB's projected round, with
  positional market saturation and round-1 positional caps. Runs on its own
  seed, fully decoupled from rating conversion (verified byte-identical
  ratings across wildly different projection settings).
- Dev-trait weighting enriched with projection signals (round, production,
  athleticism, age, awards) on top of converted overall.
- Combine and pro-day number generation from converted ratings.
- Export enrichment: `Original*` rating mirrors, commentary name IDs, a more
  robust college-name matcher, and `DraftPlayer` scouting-stage flags.
- Draft Class table: Pick/Profile/Prod/Ath columns, a Profile filter, and an
  opt-in career-stats column group.
- Advanced settings: Production Weight, Board Variance, and a Generational
  Prospect toggle for the draft-projection model.

#### Changed
- Upgraded the `madden-franchise` dependency to a vendored 4.3.0 and the CFB
  read path to the full CFB27 809/0 schema (Core+Football+Franchise),
  unlocking real Team/SeasonStats/CareerStats tables.

### 0.1.0 - 2026-07-08

#### Added
- First working build
- GUI for transferring draft classes from EA SPORTS College Football 27 to Madden NFL 26 franchise saves
- Draft class mapping and calibration system
- Position calibration and quantile calibration support
- Configuration and defaults system
- Draft data pipeline processing
- Windows NSIS installer build support
