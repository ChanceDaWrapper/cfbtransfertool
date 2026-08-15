# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-08-14

### Added
- **The NFL/UFL and Madden 26/27 pickers are now switches, not radio dots.**
  Reported as hard to tell apart, and fairly: they were a small dot next to dim
  grey text, with the chosen and unchosen options near-identical at a glance.
  Picking the wrong one is expensive — a class built for the wrong game, or the
  wrong league's tier — so the current choice is now a filled blue pill inside a
  dark track, readable across the room.
  - The colour is a slightly deeper blue than the app's standard accent on
    purpose: white text on the standard accent measures 3.71:1, below the 4.5:1
    minimum for text this size. The shipped fill measures 5.29:1. Since the whole
    point was legibility, a fill that failed that bar would have missed it.
  - Keyboard and screen-reader behaviour is unchanged — these are still real
    radio buttons, still tabbable, with the focus ring drawn on the pill.
- **"Save to saves folder" — a one-click export that skips the Windows Save
  dialog.** Reported from the field: on a PC where Documents lives in OneDrive,
  pressing Save produced Windows' own *"File not found. Check the file name and
  try again."* — on a folder the same dialog had just listed, with files and
  sizes showing. That error comes from Windows before Pipeline gets involved, so
  there was no way to work around it from inside the app; the export was simply
  unreachable on that machine. The new button writes the file directly into the
  Madden saves folder Pipeline already found, names it for you following Madden's
  own naming rule, and never overwrites an existing class — it counts up instead.
  - The cause is OneDrive's "Files On-Demand": the folder's details are stored
    locally (so it browses normally) while the contents are not, so Windows' file
    picker fails to validate a path in it. Setting the folder to "Always keep on
    this device" also fixes it, if you would rather keep using the dialog.
- **Clearer errors when a file can't be written.** "EBADF: bad file descriptor,
  write" now reads as an explanation with things to try — an online-only OneDrive
  folder, a disconnected drive, or Madden holding the file open — and always
  names the path it tried, so a screenshot is enough to diagnose it.

### Changed
- **Impact Blocking now compresses as a light technical rating instead of a
  heavy one.** It's the only blocking rating treated this way, on purpose:
  run/pass/lead blocking are technique — hand placement, footwork, leverage,
  picking up a stunt — which is exactly what a rookie lineman has least of.
  Impact blocking is the finishing hit once he's already engaged, and that
  carries into the NFL far better. Measured on a 240-player class, the rating
  comes across about 7 points higher, which Madden recomputes as roughly +1.7
  overall for a fullback, +1.4 a center, +1.1 a left guard, +0.9 a right
  guard and +0.3 a tight end. No other position's overall reads this rating,
  so nobody else moves in game.
  - Note the Draft Class page's Est. Overall column won't show this — that
    estimate is anchored to the player's college overall and absorbs the
    change. The exported ratings are what differ, and Madden recalculates
    overall from those when you import.
  - You can put it back on the Rating Categories page (set Impact Blocking to
    Technical (Heavy)); a value you set yourself is never overwritten.
- **The app installs about 1 MB smaller.** The original "V1" rating engine and
  its two calibration data files have been removed. V1 was unreachable — the
  engine picker has only ever offered Power Curve and Dice Roll, and the app
  rewrote any other saved choice back to Power Curve on startup — but its
  reference data shipped in every install regardless. Nothing you can select
  in the app has changed.
- **Tight ends settled at half a boost.** After the back-and-forth in 0.3.1
  (boost → too high → removed → too low), tight ends now sit exactly halfway
  between, and your saved settings are brought forward automatically.

### Fixed
- **The two draft-class writers now share one implementation of Madden 27's
  hidden ability block.** The exporter and the M26↔M27 converter each had
  their own copy of that logic, and they disagreed about the block's shape —
  one treated it as the whole record tail, the other as six specific bytes.
  Measured across three real M27 exports and 388 donor/target pairs, both
  produced byte-identical results, so nothing was actually broken; they agreed
  only because of what the data happens to look like today. They now share one
  implementation, so a future game patch can't make them silently diverge.
- **Dev traits can no longer be written from the wrong vocabulary.** A
  player's college performance tier and the Madden dev trait this app assigns
  are stored in the same place but named differently by each game, and only
  the college names existed in code — which is how 0.3.1's mismatched-dev-trait
  bug happened in the first place. Both are now named, and either can be used
  by name to get the right result.

### Internal
- `npm test` now runs every spec and reports all failures together, instead of
  stopping at the first one. It also discovers spec files automatically, so a
  new test can't sit in the repo looking covered while never running.

## [0.3.1] - 2026-08-12

### Added
- **Add your own players to a draft class.** On the Generate Class page you can
  now type in players who aren't in your dynasty — a name, a position, and a
  college overall. They're added to the prospect pool and then treated exactly
  like everyone else: ranked against the real prospects, converted by whichever
  rating engine you've picked, and given a dev trait the same way. So a player
  lands where their talent actually puts them rather than at a slot they were
  handed, and they show up in the exported draft-class file like any other pick.
  - The overall you enter is a **college** overall, and college ratings always
    convert downward — so enter it higher than the Madden rating you're aiming
    for, generate, and check the Draft Class page (added players are tagged
    there) to see where they landed.
  - Their build, archetype and rating shape are copied from the closest real
    player at the same position in your own dynasty, so a custom safety is
    shaped like a safety instead of being invented from one number. If nobody
    at that position is leaving, the app says so instead of guessing.
  - In UFL mode the card warns that a highly-rated added player will be pulled
    into the NFL tier and won't appear in your UFL class at all — UFL generates
    the tier below the NFL cut.

### Documentation
- **Name your exported draft-class file with letters, numbers and dashes only.**
  Spaces or punctuation in the name can make Madden bounce you back to the main
  menu when importing — the file saves fine and may even import from the weekly
  agenda's "select the rookies" screen, while failing from Draft Class → Edit.
  This is now called out on the Export card itself and in both HOWTOs. The app
  does not rename your file for you; renaming someone's export behind their back
  is worse than telling them the rule.

### Fixed
- **A player's dev trait in the exported file now matches the one Pipeline
  assigned and shows on the Draft Class page.** The exporter was writing each
  player's own CFB college performance tier into the dev trait byte instead of
  the Madden dev trait Pipeline actually rolled for them — so a player listed
  as Star in Pipeline could come in as Superstar in-game (or any other
  mismatch), entirely independent of what the app displayed or the Dev Trait
  percentage targets were set to. The percentage targets now actually control
  what lands in the file.
- **Tight end tuning, twice in one day.** A fix for tight ends landing too low
  (capping around 62) added a strong leniency boost; once the rest of that
  day's tuning was accounted for, that boost turned out to be too generous
  (class averaging in the high 70s), so it was removed entirely — which
  overcorrected the other way (mid 60s). It's now reintroduced at half its
  original strength, splitting the difference.
- **Rating tuning updates now actually reach you.** Position weights are saved
  with your settings, so an updated default was being silently overruled by
  whatever your config already had — meaning a fix could ship and change nothing
  for anyone who had opened the app before. Your saved values are now brought
  forward automatically when they're still on a previous default. Anything you
  deliberately changed yourself is left exactly as you set it.
- **Players now keep their own face from College Football instead of being given
  a stranger's.** Madden's head assets use the same names College Football does,
  just with a `gen_` prefix — so a CFB player's actual head can be carried
  straight across. About 70% of a class now keeps its real face; the rest still
  fall back to a same-skin-tone substitute, as before.
  - This also fixes skin tones that survived the portrait fix below. Swapping in
    a "same tone" head is not actually skin-neutral: a skin-5 offensive tackle
    was coming out pale because the tone-5 head he was handed renders lighter
    than his own. Using his real head removes the guesswork entirely.
  - Applies to both Madden 26 and Madden 27 exports.
- **Madden 27 skin tones are fixed — profile pictures now match the player.**
  Every Madden 27 export was giving players a headshot belonging to a different,
  unrelated prospect, so a player's 3D model had the right skin while the
  portrait next to it often didn't. Only about 1% of players happened to line up
  by luck; it's now 100%.
  - Cause: Madden 27 moved the portrait ID two bytes, and this app assumed it
    had moved four, like every other field did. So it read the portrait from a
    field that isn't the portrait, wrote a meaningless value back into that
    field, and never touched the real one — leaving each player with whatever
    headshot the template slot they replaced happened to carry.
  - Madden 27 pairs every generic head with exactly one portrait (verified: 188
    heads, 188 portraits, a perfect one-to-one match). Exports now use EA's own
    pairing, so the headshot always belongs to the face being used.
  - Madden 26 exports are completely unaffected — that field never moved there.
- **The bundled Madden 27 template is now built from a current-build export**
  (schema tag `9081279`, was `9074430`), so exported files match what Madden 27
  writes today rather than an earlier patch. Slightly more face and equipment
  variety comes with it. Confirmed against three separate real M27 exports that
  the file structure did not change between those builds, and that nothing the
  previous template used has been removed from the game.
- **Madden 27 players now get abilities that match the position they actually
  play.** M27's per-player file record carries a block of five extra values
  with no Madden 26 equivalent. 0.3.0's changelog described these as "carried
  over from a position-matched pro," but that was never actually implemented --
  they were really just whatever was left over from the template slot each
  generated player happened to overwrite, matching that player's real position
  only 8.9% of the time on a real class (a quarterback could end up carrying a
  right tackle's block). They're now explicitly copied from the same
  position-matched donor equipment already uses, verified 100% position-matched
  on the same class. Madden 26 exports are unaffected; that file format has no
  such block to begin with.
- **Position caps were silently ignored for every position except Kicker,
  Punter, and Long Snapper.** Setting a cap on, say, Wide Receiver had no
  effect and a class would still come out with far more WRs than requested.
  The three positions that shipped a default cap were the only ones that could
  ever hold a user-set value in storage -- every other position's cap was
  discarded the moment the config was saved. Fixed at the storage layer so
  every position can now hold a cap; this predates Madden 27 entirely and was
  not part of the M27 restructure.

### Changed
- **Dice Roll is now a luck layer on top of Power Curve, not a separate engine.**
  Picking Dice Roll runs the same conversion Power Curve does — so a player's
  ratings still reflect how he actually plays — and then slides each player up
  or down a little, producing steals and busts instead of one predictable list.
  - The slide is even-handed: a class averages out to the same strength as a
    Power Curve class. Previously Dice Roll applied its own separate cut on top
    of the conversion, so even the best possible roll still made a player worse.
  - About 40% of players come out exactly where Power Curve put them, most of
    the rest move a point or two of overall, and a handful swing the full ~5.
    Top of the board moves most, the deep class least — but never nothing, so a
    late-round steal is still possible.
  - Speed and agility barely move. A bust doesn't get slower; he fails to
    develop technique and awareness.
  - **Every rating setting now applies to both engines.** Position weights and
    the rating curves are shared, so tuning a position fixes it everywhere
    instead of needing the same change made twice in two places.
  - The Rating Translation and Rating Categories pages now stay visible when
    Dice Roll is selected — they were hidden before, correctly, because none of
    those dials reached the old engine. They drive it now, so hiding them would
    have left Dice Roll with nothing to tune.
  - The Dice Roll "Class Strength" and UFL "Fixed Debuff" controls are gone —
    they set a class-wide penalty that no longer exists. The remaining "Luck"
    setting controls how far players move; set it to 0 and Dice Roll produces
    exactly the same class as Power Curve.
- **Tight ends get a targeted buff.** The best tight end in a class was coming
  out around 62, against 74-78 in Madden's own draft classes. Same cause as
  receivers below, one position over. Tight ends now get more leniency than any
  other skill position, because Madden's tight end overall spreads its weight
  across four separate ratings (speed, route running, catching in traffic,
  awareness) — so an even drop across the board compounds on them harder than
  on anyone else.
- **Receivers get a small boost.** A 99-overall college receiver was coming out
  around 70 — route running was losing 19 points and awareness 33. Wide receiver
  was the only skill position with no leniency at all in its position weights,
  which made it the hardest-hit group in the class once the class-wide
  compression was deepened. Both engines now give receivers the same modest
  break every other skill position already had; the top receiver in a class
  lands around 77 instead of 74.
- **Draft classes come in about 4 overalls lower across the board.** Both rating
  engines were moved by the same amount so switching between them doesn't change
  how strong a class is. Speed and agility are deliberately untouched, so this
  doesn't undo the athleticism work — only technical and mental ratings compress
  further. Note this now sits a little below Madden's own draft classes rather
  than matching them, which is intentional: rookies come in with more room to
  develop.
- **Halfbacks no longer dominate the top of a Dice Roll class.** A class
  imported into Madden 27 put four halfbacks in the top six overall (86, 85,
  82, 81) while every other position topped out around 78-81. Halfbacks were
  getting two separate leniency bonuses stacked on top of each other; one is
  removed and the other reduced. They now land in line with receivers and
  corners in the same class. Quarterbacks were checked at the same time and
  left alone — they were already sitting where real Madden classes put them.
- **Power Curve classes are less top-heavy.** A real imported class showed
  around 15 players at 80+ overall, where Madden's own draft classes have none
  to two. Technical and mental ratings now compress a bit more across the
  board; speed and agility are untouched, so this doesn't undo the athleticism
  fix below. On the reported save the class top drops from 83 to 82 and 80+
  from 7 to 2 — inside Madden's real range.
- **Physical ratings now take only a small hit.** A 99 speed comes across as a
  97, a 90 as an 88 — a consistent light haircut rather than a real cut. The
  previous curve also quietly *raised* mid-range physicals (an 80 became an 82),
  which is why too many receivers were showing up at 90+ speed; that's gone, so
  the share of genuinely fast receivers now matches Madden's own draft classes.
- **Power Curve speed and agility are realistic again.** The fix above compressed
  a shared bucket that covered speed, acceleration, agility and jumping
  alongside strength and throw/kick power — bringing overalls down also
  crushed athleticism, so a real burner could end up with barely above-average
  speed. Speed/acceleration/agility/jumping are back to nearly their college
  value (matching real Madden 27 classes, where a good chunk of receivers and
  corners sit at 90+ speed); strength for skill positions now compresses
  separately and much harder, since a receiver's or corner's raw strength
  rating matters far less than their speed does. Linemen and defensive
  linemen are unaffected — their strength was already realistic and stays
  that way. Halfbacks pick up a little more overall compression on their own
  ball-carrying skills to keep their overall in check now that their speed is
  no longer doing that job.
- **Power Curve classes come down to the size of a real Madden rookie class.**
  College athleticism was crossing over essentially untouched — the physical
  curve was very close to a straight copy — and because Madden's overall
  formula leans hardest on speed, acceleration and agility for skill positions,
  a halfback carrying his college 95s straight over posted an 86. Physical
  ratings now genuinely compress. Calibrated against two real Madden 27 draft
  classes exported from the game itself:

  | | Madden's own classes | before | after |
  |---|---|---|---|
  | top overall | 79–82 | 88 | 81 |
  | players at 80+ | 0–2 | 17 | 1 |
  | players at 75+ | 20–26 | 84 | 20 |

  Technical, mental and speed/agility curves are all unchanged. If you had
  already tuned the physical curve yourself, your setting is kept.
- **Dice Roll classes regress further from their college ratings.** Every
  class-strength tier now cuts about 2% deeper. Because that cut scales with a
  player's own overall, it comes off the top of the class hardest -- on a real
  class the first round's key ratings fell about 1.3 points and the number of
  first-rounders at 68+ dropped from 112 to 96, while the spread between the
  first round and the late rounds held steady. Weak prospects are barely
  touched, so the class gets less top-heavy rather than uniformly worse.
- **Dice Roll position tuning.** Three positions were landing in the wrong place
  relative to the rest of a class, so technique now takes a small per-position
  adjustment: quarterbacks keep about 1 more point of it, halfbacks about 2, and
  both safeties give up about 2 more. Nothing else moves -- awareness, physical
  ratings and the speed/agility group are all untouched for these positions, and
  every other position is completely unaffected.
- **Linemen, edge rushers and quarterbacks keep more of their athleticism.** The
  flat speed/acceleration/agility/change-of-direction cut applied to the trench
  positions was the harshest rule in the engine -- it was taking 5 to 7 points
  off those groups against 2 to 3 for skill players. It's now about 2 points
  kinder in the bands where most ratings actually sit. It remains much steeper
  than the skill-position cut, which is unchanged: a 300-pound guard still
  shouldn't carry his college speed into the NFL.

## [0.3.0] - 2026-08-06

### Changed
- **Dice Roll classes come out a little weaker, and the strong players now
  land nearer the top of the board.** Two adjustments:
  - Ratings take a flat trim on top of the roll -- about 2.5 points off
    technical ratings and 3.5 off Awareness and Play Recognition, since
    rookies process slowest of all. Physical ratings and the speed/agility
    group are deliberately untouched: a college burner should still time fast.
    Weak ratings (below 50) are also left alone, so a poor rating can't be
    compounded further. In practice a class's headline ratings come down
    roughly 2-3 points.
  - Good rolls now concentrate much more at the top of the class. A first-round
    pick lands in the favourable half of the roll about 70% of the time (was
    49%), while a late pick stays near 22% -- so fewer high-rated players
    survive deep into the class. It's still a roll either way: a late-round gem
    remains possible, just rarer.
- **Kick Power is now treated as a physical rating in Dice Roll**, matching how
  every other part of the app already classifies it. It had been falling
  through to the general rule, which would have stacked the new technical trim
  onto a kicker's one defining trait.

### Fixed
- **Coach moves are now allowed at any point in the offseason.** The window
  check previously demanded both an offseason save *and* one of the game's four
  named hiring/demand-release flags being set that week. Plenty of perfectly
  sensible spots fail that second test -- a dynasty sitting at draft-results
  week is in the offseason with every flag off -- so the tool refused with
  "offseason, but outside the coach hiring/demand-release window" while the
  user was looking at their own offseason menu. The whole offseason now counts.
  An active hiring period still works on its own too, whatever week the save
  reports, so CFB's carousel (which runs at the end of the postseason, not in
  the offseason) is unaffected. In-season and preseason saves are still blocked
  unless you turn on "Allow coach hires outside the hiring window".
- **A blocked coach move now reports the save's actual season flags** in the
  error text, so a screenshot is enough to tell what stopped it.

### Added
- **Madden 27 draft-class export.** Pipeline can now build a draft class for
  Madden 27 as well as Madden 26. Pick the game on the Export card -- the two
  file formats are not interchangeable, so the choice decides the whole file:
  its slot count (402 for M26, 389 for M27), its schema tag, and its internal
  record layout. Your pick is remembered, and the save dialog defaults to that
  game's own Saves folder.
  - Madden 27 widened the per-player record (200 -> 244 bytes) and the first-name
    field (17 -> 21), which shifts every following field by 4 bytes. Both games
    are now read and written through one code path that adapts to whichever it
    is looking at, detected from the file's own schema tag.
  - M27's per-player ability/trait block -- five values M26 has no equivalent
    for -- is carried over from a position-matched pro rather than invented, so
    every exported player has plausible values for their position instead of a
    blank slot.
  - Faces and equipment are validated against the game being exported to, using
    a real export of that game as the reference for what it actually ships. No
    Madden 26-only asset can end up in a Madden 27 file (or the reverse), which
    would otherwise show up in-game as a missing item or a broken face.
  - Skin tone still lands correctly on Madden 27 even though its files no longer
    store it as a separate value: it is carried by the head itself, which the
    exporter picks to match.

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
