# Releasing QA Debug Companion

This repo uses a **two-repo split**. Nothing about this is guessable — read this before cutting anything.

| Repo                                    | Role                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `korakiad/extension-selfhealing-source` | **Source.** The git `origin` of this checkout. Work lands on feature branches here. Has **no** GitHub releases.                                                          |
| `korakiad/extension-selfhealing`        | **Release repo.** Every `gh release` (and its attached `.vsix`) lives here. `extension/package.json#repository.url` points here, and that is what ships inside the vsix. |

## Version source of truth

`extension/package.json#version` is **the** version. Nothing else is:

- Root `package.json` is pinned at `0.0.0` and is **never bumped** (it's a private workspace root; bumping it created skew in the past).
- The vsix filename comes from `${npm_package_version}` of `extension/package.json` via the `package` script.
- Stable releases (no `-beta.N` suffix) are what the in-extension update checker surfaces to QAs via `/releases/latest`. Betas don't prompt anyone.

## Cutting a release

1. **Check what's already published** — the latest committed beta may already be released:

   ```sh
   gh release list --repo korakiad/extension-selfhealing
   ```

   If your version is taken, bump again. (This burned us once: beta.17 was already live, the fix shipped as beta.18.)

2. **Bump + changelog** in one commit touching only these two files:
   - `extension/package.json` → new `version`
   - `extension/CHANGELOG.md` → new entry at the top
   - Commit message: `chore: bump version to <version>`

3. **Validate** — this is the same gate CI runs:

   ```sh
   pnpm validate
   ```

4. **Build the vsix**:

   ```sh
   pnpm --filter ./extension run package
   ```

   Output lands at `extension/qa-debug-companion-<version>.vsix` (the `--out ../` in the script is relative to `extension/_vsix-staging/`, so it ends up in `extension/`, **not** the repo root).

   `prepare-vsix.mjs` aborts the build if the staged tree is missing any runtime file (extension bundle, mcp-proxy, the four mocha-hooks dist files) or if any shipped manifest/readme/changelog references `extension-selfhealing-source`. If it aborts, fix the cause — don't bypass it.

5. **Publish** to the release repo (note: `--repo` is the release repo, not origin):

   ```sh
   gh release create v<version> \
     --repo korakiad/extension-selfhealing \
     --prerelease \
     --title "v<version> — <one-line summary>" \
     --notes "<paste the CHANGELOG entry body>" \
     extension/qa-debug-companion-<version>.vsix
   ```

   Drop `--prerelease` only for stable cuts — that's the switch that makes every installed extension prompt QAs to update.

6. **Push source**: commit(s) + tag go to `origin` (the `-source` repo), on the feature branch you're working on.

## Rules that are easy to violate

- Release notes, README, and anything inside the vsix must never reference the `-source` repo or any non-public path. Step 4's guard catches the vsix; release notes you write by hand — re-read them.
- Don't hand-edit `extension/package.json#languageModelTools` — it's generated from `tool-contracts/src/tools.ts` (`pnpm --filter ./extension run gen:lm-tools`); the build's `--check` fails on drift.
- esbuild does not typecheck. `pnpm build` succeeding means nothing about types — `pnpm validate` (or `pnpm typecheck`) is the real gate.
