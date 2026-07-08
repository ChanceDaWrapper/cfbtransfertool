# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

