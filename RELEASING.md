# Releasing

This project publishes to npm as `codex-switcher-11arkan`.

## One-time setup

1. Configure repository secrets:
   - `NPM_TOKEN` with publish access to the package.
2. Ensure repository metadata in `package.json` points to your GitHub repository.
3. Keep token handling secret-safe:
   - Never commit `.npmrc` auth tokens.
   - Use GitHub Actions secret storage only.

## Release checklist

1. Update `CHANGELOG.md`.
2. Bump version in `package.json`.
3. Run:
   - `npm install`
   - `npm run release:check`
4. Commit and push to `main`.
5. The publish workflow runs automatically and publishes if the version is new.

## Manual fallback

If needed, publish manually:

```powershell
npm run build
npm publish --provenance
```
