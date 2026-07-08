# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

### Added

#### Core Features
- Initial release of CFB Transfer Application
- Full pipeline for converting College Football 27 leaving players to Madden NFL 26 draft prospects
- Intelligent rating calibration system for accurate cross-game player mapping

#### UI & UX
- Desktop GUI built on Electron for Windows
- Real-time draft class preview before writing to save
- Tunable configuration interface with three levels of customization
  - Position Weights adjustment
  - Physical Attributes calibration
  - Advanced settings (dev trait distribution)
- File dialogs for easy save file selection
- Estimated Madden Overall display alongside CFB Overall for sanity-checking

#### Technical Implementation
- **Rating Calibration Engine**
  - Position-based physical rating calibration (`position_calibration.json`)
  - Quantile-mapping for skill ratings against real Madden distributions (`quantile_calibration.json`)
  - Per-archetype Overall formula approximation via ridge regression (`overall_formula.json`)
  
- **Data Pipeline** (`lib/pipeline.js`)
  - Direct extraction from CFB27's `LeavingPlayer` table
  - Player metadata enrichment from college_lookup.json
  - Multi-step rating transformation and validation
  - Safe writing to Madden's Player and DraftPlayer records with round/pick preservation

- **IPC & File Handling** (`main.js`, `preload.js`)
  - Secure main-to-renderer communication via contextBridge
  - Zstd compression support for Madden save file parsing
  - Atomic file I/O with proper error handling

- **Configuration System** (`lib/configStore.js`, `lib/defaults.js`)
  - User settings persistence across sessions
  - Comprehensive default configuration with metadata (labels, descriptions, ranges)
  - Runtime-adjustable parameters without restart

#### Data & Calibration
- College football player database (`college_lookup.json`)
- Draft class veteran reference data (`real_draft_classes_veteran.json`)
- Real Madden player-derived calibration curves
  - Ridge regression models for Overall calculation
  - Cross-validation tested for accuracy

#### Build & Distribution
- Windows NSIS installer support via electron-builder
- Automated build pipeline (`npm run build`)
- Source-only repository (built artifacts in `.gitignore`)

### Known Limitations (v0.1.0)
- Windows only (Electron, file path handling)
- Single franchise per operation
- Overall formula is a statistical approximation, not Madden's actual proprietary formula
- No multi-year persistence or dynasty-specific settings storage
- Requires CFB27 save at Draft Stage (post-declaration, pre-draft)
- Requires Madden 26 franchise outside preseason (rookie slots must exist)

### Testing
- Tested against current-gen saves (EA SPORTS CFB27 and Madden NFL 26)
- Calibration validated against 100+ real Madden player ratings
- File I/O tested with large franchise saves (400+ MB+)

### Technical Notes
- Uses `madden-franchise` library for save file parsing
- Uses `@toondepauw/node-zstd` for Madden save compression
- Custom CFB27 schema overrides in `schema/` for LeavingPlayer extraction
- Ridge regression model fitted via Python (scikit-learn); included as JSON for runtime use
