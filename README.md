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

## Getting Started

### First Time Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/ChanceDaWrapper/cfbtransfertool.git
   cd cfbtransfertool
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the application**
   ```bash
   npm start
   ```

### Basic Workflow

1. **Prepare your saves**
   - Have your College Football 27 dynasty at the Draft Stage (after declaring/transfer portal closes)
   - Have your Madden NFL 26 franchise loaded to the pre-draft period
   
2. **Load your CFB save**
   - Open the app and select your College Football 27 dynasty save file
   - The app will extract all leaving players from the LeavingPlayer table

3. **Review and configure**
   - Preview the detected players and their ratings
   - Adjust Position Weights, Physical Attributes, or Dev Trait distribution as needed
   - Check the estimated Madden Overall Rating against the CFB Overall

4. **Generate the draft class**
   - Click "Generate" to create calibrated Madden ratings
   - Review the output one more time

5. **Write to your Madden save**
   - Select your Madden NFL 26 franchise save
   - Click "Write to Madden" to inject the draft class into the real rookie slots

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

## Advanced Usage

### Understanding the Calibration

- **Position Calibration**: Maps physical attributes (Speed, Strength, etc.) to Madden's scale while preserving relative position strengths
- **Quantile Calibration**: Uses statistical quantile mapping to match skill ratings against real Madden distributions, ensuring top college prospects rank appropriately among NFL rookies
- **Overall Formula**: Per-archetype regression models approximate Madden's proprietary Overall Rating formula

### Customization Options

The app exposes three levels of customization:

1. **Position Weights** — Adjust how much each position contributes to the overall draft class
2. **Physical Attributes** — Fine-tune the multipliers for speed, strength, and other base attributes
3. **Advanced Settings** — Control dev trait distribution targets (X-Factor %, Superstar %, Star %)

### Troubleshooting

- **"No leaving players found"** — Confirm your CFB27 save is at the Draft Stage; the game hasn't finalized departures until that point
- **"Invalid save file"** — Ensure you're selecting the actual franchise/dynasty save, not a cloud or backup copy
- **Ratings seem too high/low** — Check your Position Weights and Physical Attribute settings; regenerate and preview before writing
- **Draft class won't write** — Verify your Madden 26 franchise isn't in preseason; the rookie slots don't exist yet

### Performance Notes

- Processing a full dynasty (100+ players) typically takes 2–5 seconds
- Writing to the Madden save requires file I/O and may take 1–3 seconds
- Larger save files (high-schema Madden franchises) may take longer to parse

## Known Limitations

- **Windows only** — Currently requires Windows due to Electron and file path handling
- **Single franchise at a time** — The app writes to one Madden save per operation
- **Overall formula approximation** — Madden's true formula is proprietary; the fitted model is accurate for typical prospects but may diverge for edge cases
- **No cross-year persistence** — Settings are saved per session but not tied to specific dynasty/franchise pairs

## Contributing

Found a bug or have a feature request? Open an issue on GitHub. Pull requests welcome!

Before submitting:
- Test your changes against both current-gen saves (CFB27/Madden26)
- Verify calibration data still loads correctly
- Keep UI changes compatible with Windows NSIS installer builds

## License

MIT -- see [LICENSE](LICENSE).
