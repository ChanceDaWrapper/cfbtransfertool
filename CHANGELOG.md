# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- `npm test` regression suite (115 assertions) locking engine fidelity against
  the original model spec's worked examples, the shipped/tuned defaults, every
  phase's own behavioral proof (global strength, category reclassification,
  position/rating flat drops and caps, per-position exceptions), and dev-trait
  invariance to rating-conversion tuning.

### Changed
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
- The Rating Categories page's "modified" indicator dot never lit up for a
  *global* reclassification (per-position overrides were unaffected).

## [0.2.0] - 2026-07-08

Merges in the draft-simulation half of [cfb2madden](https://github.com/seanpdwyer7/cfb2madden)
(see NOTICE.md for full credit) while keeping this project's rating
conversion engine as the source of truth for player ratings. Full rationale
and subsystem-by-subsystem comparison in MERGE_PLAN.md.

### Added
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

### Changed
- Upgraded the `madden-franchise` dependency to a vendored 4.3.0 and the CFB
  read path to the full CFB27 809/0 schema (Core+Football+Franchise),
  unlocking real Team/SeasonStats/CareerStats tables.

## [0.1.0] - 2026-07-08

### Added
- Initial release of CFB Transfer Application
- GUI for transferring draft classes from EA SPORTS College Football 27 to Madden NFL 26 franchise saves
- Draft class mapping and calibration system
- Position calibration and quantile calibration support
- Configuration and defaults system
- Draft data pipeline processing
- Windows NSIS installer build support

