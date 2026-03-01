# Contributing

Thanks for contributing to Codex Switcher.

## Development Setup

1. Use Node.js 20 or newer.
2. Install dependencies:
   - `npm install`
3. Build the project:
   - `npm run build`
4. Run interactive mode locally:
   - `npm run dev`

## Pull Request Guidelines

- Keep PRs focused and scoped.
- Update docs when behavior changes.
- Ensure `npm run build` passes.
- Use clear commit messages.

## Reporting Issues

Use GitHub Issues and include:

- Expected behavior
- Actual behavior
- Steps to reproduce
- OS + Node version

## Release Process

Before creating a release:

1. Update `CHANGELOG.md`.
2. Ensure `package.json` version is correct.
3. Run `npm run release:check`.
4. Create a GitHub release/tag.
