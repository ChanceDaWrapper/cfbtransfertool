# CFB Transfer

A desktop app (Windows, Electron) that takes the players leaving your **EA
SPORTS College Football 27** dynasty and turns them into the incoming rookie
draft class of a **Madden NFL 26** franchise save -- draft order projected,
ratings recalibrated to Madden's scale, dev traits and combine numbers
assigned, and everything written straight into the real career file.

Not affiliated with or endorsed by EA Sports. Built for personal/community
use against your own local save files.

## What it does

1. **Figures out who's declaring for the draft.** At the official
   players-leaving / Offseason Draft Stage, it reads the game's own
   `LeavingPlayer` table directly -- the same data the game itself uses to
   run the real draft. On an earlier save, it predicts the class instead
   (every Senior, plus Juniors who clear a draft-worthy bar), so you don't
   have to wait for that one specific week to try the tool. Auto-detects
   which mode applies, with a manual override if you want to force one.
2. **Projects where each player will be drafted** -- round, pick, and a
   scouting profile (Generational / Complete / High Floor / High Ceiling /
   Balanced) -- from career production, awards, an athletic-measurables
   profile, position value, and CFB's own projected round, with positional
   market realism (a hard cap on how many QBs/RBs/etc. go in round 1). This
   **only decides draft order, never ratings** -- see
   [Draft projection vs. rating conversion](#draft-projection-vs-rating-conversion).
3. **Calibrates every rating to Madden's scale.** Physical ratings (Speed,
   Strength, etc.) get a light, per-position calibrated drop; skill ratings
   (Awareness, coverage, blocking, route running, ...) are quantile-mapped
   onto real Madden rating distributions, so a top prospect lands near the
   top of Madden's real rookie range instead of just getting a flat
   percentage knocked off.
4. **Estimates what Madden's own Overall Rating would be** for the
   calibrated ratings, fit per-archetype from real Madden player data (see
   [Data & calibration](#data--calibration) below) -- shown next to the CFB
   overall so you can sanity-check the class before writing it.
5. **Assigns dev traits** (Normal/Star/Superstar/X-Factor) with configurable
   target shares of the whole class, weighted by converted overall, draft
   round, production, athletic upside, age, and awards -- so the best
   players have the best odds at Superstar/X-Factor, but who actually gets
   one still varies every time you regenerate.
6. **Generates combine and pro-day numbers** (40 time, bench, vertical/broad
   jump, 3-cone, shuttle) from each player's converted ratings.
7. **Writes into your Madden save**: rewrites the real incoming-rookie
   slots in place (same teams/rounds/picks Madden already assigned), syncing
   the Player record (ratings + `Original*` mirrors, college, commentary ID)
   and the `DraftPlayer` scouting record (rank, grade, combine/pro-day
   numbers, scouting-stage flags) the draft-class UI reads from.

Every setting above is tunable from the app (Position Weights, Physical
Attributes, Advanced) -- generate once, look at the Draft Class table, tweak,
regenerate, and only write to your franchise once you're happy with it.

### Draft projection vs. rating conversion

These are two deliberately independent systems that both happen to run on
the same player pool:

- **Rating conversion** answers *"what ratings should this player have?"*
- **Draft projection** answers *"where should this player be drafted?"*

A player's converted ratings depend only on that player's own college stats
and identity (plus the global seed) -- never on the draft board, so changing
projection settings (Position Value, Board Variance, etc.) reorders the
class without ever touching a single rating.

## Requirements

- Windows
- A College Football 27 dynasty save. Most accurate at the
  players-leaving / Offseason Draft Stage (the one point in a dynasty where
  the game has finalized who's declaring); earlier saves work too via
  declaration prediction, just with more uncertainty the further out you are.
- A Madden NFL 26 franchise save that is **not** in the preseason (the
  incoming rookie class doesn't exist yet during preseason)

## Running from source

```bash
npm install
npm start
```

## Building the installer

```bash
npm run build
```

Produces an NSIS installer under `dist/` via `electron-builder`. The
built installer itself isn't part of this repo -- only the source is.

## Project layout

```
main.js            Electron main process -- IPC handlers, file dialogs, save/load
preload.js         contextBridge -- the only surface the renderer can call into main with
lib/
  pipeline.js       The actual CFB -> Madden conversion pipeline (extract, calibrate, write)
  defaults.js       Every tunable default + UI metadata (labels, descriptions, ranges)
  configStore.js    Reads/writes the user's saved settings
renderer/
  index.html        UI markup
  renderer.js       UI logic -- talks to main only through the preload bridge
  style.css
data/               Calibration reference data + lookups (see below) -- required at runtime
schema/             Legacy CFB27 schema override (Franchise namespace only)
vendor/             Vendored madden-franchise 4.3.0 tarball (see NOTICE.md)
```

## Data & calibration

`data/position_calibration.json`, `data/quantile_calibration.json`, and
`data/overall_formula.json` are built from real Madden player data (not
included in this repo -- see `.gitignore`), so ratings and Overall estimates
are calibrated against how the actual game rates real players rather than a
guessed formula. `data/overall_formula.json` in particular is a set of
per-archetype linear formulas (ridge regression, validated by held-out
cross-validation against real players) approximating Madden's own Overall
calculation -- Madden's true formula is proprietary, so this is a fitted
approximation, not a decompiled original.

`data/schemas/CFB27_809_0.gz` is the full CFB 27 save schema used to read
the dynasty save (Team/SeasonStats/CareerStats tables, needed for school
names and career production). `data/college_lookup.json` and
`data/commentary_lookup.json` map college names and player last names to the
binary IDs Madden's save format expects.

## License

MIT -- see [LICENSE](LICENSE). This project incorporates code and data from
other MIT-licensed projects -- see [NOTICE.md](NOTICE.md) for full credit.
