# Third-Party Credits

This project's rating-conversion engine (position/quantile calibration,
regression-based Overall estimation, the configuration UI) was originally
built for **cfbtransfertool**. In 2026 it was merged with **cfb2madden**
(https://github.com/seanpdwyer7/cfb2madden by Sean Dwyer, MIT License) to add
draft declaration prediction, draft projection, combine generation, and
export enrichment, without changing how ratings themselves are calculated.

Neither project treats the other as a fork or dependency going forward --
this is a one-time merge of two independently-developed converters into one
codebase, credited here per both projects' MIT licenses.

## Components adapted from cfb2madden

- **`vendor/madden-franchise-4.3.0.tgz`** -- a newer build of the
  `madden-franchise` save-parsing library than was available on npm at merge
  time, vendored from cfb2madden's own copy.
- **`data/schemas/CFB27_809_0.gz`** -- the full CFB 27 save-file schema
  (Core+Football+Franchise, major version 809), vendored from cfb2madden.
  Unlocks the real `Team`/`SeasonStats`/`CareerStats` tables used for school
  names and career production.
- **`data/commentary_lookup.json`** -- last-name -> in-game announcer ID
  lookup (~7,700 entries), copied from cfb2madden.
- **Draft declaration prediction** (`extractLeavingPlayers`'s synthesized
  fallback in `lib/pipeline.js`) -- predicting who's likely to declare from
  Junior/Senior rosters on dynasty saves earlier than the official
  players-leaving stage, adapted from cfb2madden's approach.
- **Draft projection** (`projectDraftClass` and related scoring in
  `lib/pipeline.js`) -- production/awards/athleticism percentile scoring,
  positional market saturation, round-1 positional caps, and the
  floor/ceiling scouting profile classification, adapted from cfb2madden's
  `convert.mjs`, then rewired to run on its own seed so it can never affect
  a player's ratings (see Phase 4 in `MERGE_PLAN.md`).
- **Combine/pro-day number generation** (`combineNumbers` in
  `lib/pipeline.js`), adapted from cfb2madden's `convert.mjs`.
- **College name matching** (`normalizeSchool`/`buildCollegeMatcher` in
  `lib/pipeline.js`) -- the normalize-then-alias-then-containment matching
  strategy is adapted from cfb2madden; the underlying 488-entry
  `data/college_lookup.json` binary-ID table is cfbtransfertool's own and was
  kept as-is (cfb2madden's equivalent CSV carried the same data and wasn't
  duplicated).
- Tuning magnitudes for position draft value and the draft-order scoring
  weights (`draftValue` in `lib/defaults.js`) mirror values proven out in
  cfb2madden.

## Not adapted (evaluated and rejected)

- cfb2madden's `CharacterVisuals.json.skinTone` write for rookie visual
  transfer -- verified against real Madden save data that generated rookie
  slots don't carry a `skinTone` property at all (skin tone is baked into
  the equipped head asset's name instead), so this write is a no-op on
  4.3.0. cfbtransfertool's existing head-asset-swap approach was kept.
- cfb2madden's `Colleges.csv` -- identical data to cfbtransfertool's existing
  `data/college_lookup.json` in a different format; not duplicated.

See `MERGE_PLAN.md` for the full subsystem-by-subsystem comparison and
rationale behind every merge decision.

## cfb2madden license

```
MIT License

Copyright (c) 2026 Sean Dwyer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
