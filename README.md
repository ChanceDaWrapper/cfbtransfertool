# CFB Transfer

A desktop app (Windows, Electron) that takes the players leaving your **EA
SPORTS College Football 27** dynasty and turns them into the incoming rookie
draft class of a **Madden NFL 26** franchise save -- ratings recalibrated to
Madden's scale, dev traits assigned, and written straight into the real
career file (teams, rounds, and picks kept intact).

Not affiliated with or endorsed by EA Sports. Built for personal/community
use against your own local save files.

## What it does

1. **Reads who's leaving college** straight from the game's own
   `LeavingPlayer` table (populated at the offseason "Draft Stage" of a
   dynasty) -- the same data the game itself uses to run the real draft.
2. **Calibrates every rating to Madden's scale.** Physical ratings (Speed,
   Strength, etc.) get a light, per-position calibrated drop; skill ratings
   (Awareness, coverage, blocking, route running, ...) are quantile-mapped
   onto real Madden rating distributions, so a top prospect lands near the
   top of Madden's real rookie range instead of just getting a flat
   percentage knocked off.
3. **Estimates what Madden's own Overall Rating would be** for the
   calibrated ratings, fit per-archetype from real Madden player data (see
   [Data & calibration](#data--calibration) below) -- shown next to the CFB
   overall so you can sanity-check the class before writing it.
4. **Assigns dev traits** (Normal/Star/Superstar/X-Factor) with configurable
   target shares of the whole class, so X-Factor stays rare and Star doesn't
   take over the roster.
5. **Writes into your Madden save**: rewrites the real incoming-rookie
   slots in place (same teams/rounds/picks Madden already assigned), syncing
   both the Player record and the separate `DraftPlayer` scouting record the
   draft-class UI reads from.

Every setting above is tunable from the app (Position Weights, Physical
Attributes, Advanced) -- generate once, look at the Draft Class table, tweak,
regenerate, and only write to your franchise once you're happy with it.

## Requirements

- Windows
- A College Football 27 dynasty save at the **players-leaving / Offseason
  Draft Stage** (the one point in a dynasty where the game has finalized
  who's declaring)
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
data/               Calibration reference data (see below) -- required at runtime
schema/             CFB27 save-file schema override for madden-franchise
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

## License

MIT -- see [LICENSE](LICENSE).
