# Codex Switcher (React + Ink)

Interactive CLI to run `codex` with isolated `CODEX_HOME` profiles so multiple accounts can stay signed in and usable at the same time.

[![CI](https://github.com/11ArkaN/codex-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/11ArkaN/codex-switcher/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/codex-switcher-11arkan.svg)](https://www.npmjs.com/package/codex-switcher-11arkan)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

## Stack

- React
- Ink
- TypeScript
- Node.js

## Install

```powershell
npm install
```

## Install from npm

```powershell
npm install -g codex-switcher-11arkan
codex-switcher
```

## Build

```powershell
npm run build
```

## Start interactive CLI

```powershell
# runs the Ink UI menu
npm run dev

# or after build
node dist/index.js
```

## Production usage

```powershell
codex-switcher
codex-switcher usage --period month
```

## Core commands

```powershell
# list profiles
node dist/index.js list

# add profiles
node dist/index.js add work
node dist/index.js add personal

# login each profile
node dist/index.js login work
node dist/index.js login personal

# run codex in this terminal
node dist/index.js run work

# run codex in parallel (new terminal window)
node dist/index.js run work --new-window
node dist/index.js spawn personal -- chat

# login status for all profiles in one list
node dist/index.js status

# model-wise token + cost breakdown from local Codex session data
node dist/index.js usage
node dist/index.js usage work

# period views
node dist/index.js usage --period day
node dist/index.js usage --period month
node dist/index.js usage main --period month
```

## Automatic main profile detection

On startup, if `main` is missing, the app checks default `CODEX_HOME` (`%USERPROFILE%\.codex` unless `CODEX_HOME` is already set).
If that location is already logged in, it auto-registers as profile `main`.

## Add to PATH automatically

After building, run:

```powershell
node dist/index.js path add
```

This adds the project launcher directory to **user PATH** on Windows.

It also creates a launcher at:

- `%APPDATA%\CodexSwitcher\bin\codex-switcher.cmd`

Then in a new terminal you can use:

```powershell
codex-switcher
```

## Data locations

- Profile definitions: `%APPDATA%\CodexSwitcher\profiles.json`
- Default profile homes: `%USERPROFILE%\.codex-switcher\profiles\<profile-name>`

## Development

```powershell
npm install
npm run typecheck
npm run build
npm run release:check
```

## CI and release automation

- CI runs on every push/PR via `.github/workflows/ci.yml`.
- npm publish runs automatically on push to `main` when `package.json` version is unpublished. Requires `NPM_TOKEN` secret.

## Contributing and policies

- See [CONTRIBUTING.md](CONTRIBUTING.md)
- See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- See [SECURITY.md](SECURITY.md)
- See [CHANGELOG.md](CHANGELOG.md)

## Notes

- Multiple Codex sessions are supported simultaneously via `--new-window` / `spawn`.
- Profile storage is lock-protected to avoid concurrent write corruption.
- `usage` shows rows per model with `input`, `cached input`, `output`, `total` tokens, `thread count`, and estimated USD cost.
- Cost uses standard API text-token pricing fetched at runtime from OpenAI docs: [Pricing](https://developers.openai.com/api/docs/pricing).
- Pricing is cached locally in-memory (success: 6h, fetch failure: 5m retry window).
- If a model is missing from the local pricing map, its row is still shown but cost is `n/a`.
- In interactive mode, profile creation uses typing; login/open/remove now use selectable profile lists.
- In interactive mode, `Usage` opens a submenu with model view, daily cost view, and monthly cost view.
