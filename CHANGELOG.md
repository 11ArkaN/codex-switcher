# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

## [2.1.3] - 2026-03-16

### Added

- New `switch-main <profile>` command to switch the account used by `main` through profile-based auth swapping.
- Interactive menu action to switch the `main` profile account using the same swap behavior.

### Fixed

- Fixed pricing extraction to read the current official OpenAI pricing payload, restoring cost totals for current GPT-5 Codex models such as `gpt-5.3-codex`, `gpt-5.1-codex`, and `gpt-5-codex`.
- `switch-main` now also updates user `CODEX_HOME` on Windows, so running plain `codex` in a new terminal follows the selected `main` account.
- `switch-main` now preserves `main` threads/settings by swapping auth artifacts (`auth.json`, `cap_sid`) instead of swapping whole profile home directories.

### Removed

- Removed the `path` command and the interactive "Add codex-switcher to PATH" menu option.

## [2.1.1] - 2026-03-05

### Fixed

- Fixed live pricing parsing to correctly include GPT-5 Codex rows (for example `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`).
- Fixed model normalization/matching so versioned and annotated model IDs resolve to real pricing data (including `gpt-5.4`).
- Improved pricing fetch reliability with retry logic to reduce transient all-`n/a` results.

## [2.1.0] - 2026-03-01

### Added

- Public release scaffolding for GitHub: CI, issue templates, PR template, contributing guide, code of conduct, and security policy.
- Usage views for per-model, per-day, and per-month token cost reporting.
- Runtime pricing fetch from OpenAI pricing docs with in-memory cache and fallback behavior.

### Fixed

- Corrected GitHub repository URLs in package.json and README badges to match actual account.

## [2.0.0] - 2026-03-01

### Added

- React + Ink interactive CLI rewrite.
- Profile-based `CODEX_HOME` switching.
- Multi-profile commands for login, run, spawn, status, path setup, and usage analysis.
