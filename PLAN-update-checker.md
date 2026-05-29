# PLAN — In-Extension Update Checker

Self-update flow for the manually-distributed `qa-debug-companion` vsix. Polls the public GitHub mirror for the latest **stable** release, notifies the QA when a newer version exists, and offers a one-click "Install & Reload" that downloads the vsix and hands it to VS Code's `workbench.extensions.installExtension` command.

## 1. Goal / non-goals

**Goal.** Eliminate the "QAs silently sit on stale vsix" failure mode by surfacing newer stable releases in the VS Code notification area with a one-click install path.

**Non-goals (Phase 1).**
- No beta channel. Per user decision, the feed is stable-only — QAs on `0.0.5-beta.N` will not be notified about newer betas, only about the eventual `0.0.5` stable (or anything semver-greater).
- No silent auto-install. User always confirms.
- No telemetry, no rollout staging, no signature/hash verification beyond what `installExtension` itself does. GitHub releases are the trust root.
- No background scheduling beyond a per-activation throttle. We piggyback on `onStartupFinished`; no `setInterval`.

## 2. Source of truth

- **Endpoint.** `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`
  - `owner/repo` is derived at runtime by parsing `context.extension.packageJSON.repository.url` (strip protocol + `.git`). Currently resolves to `korakiad/extension-selfhealing`.
  - The `/releases/latest` endpoint excludes prereleases server-side — exactly the stable-only behavior we want, no client-side filtering needed.
- **Response shape (only fields we read).** `{ tag_name: string, name: string, html_url: string, body: string, assets: [{ name, browser_download_url, size, content_type }] }`.
- **Asset selection.** First asset whose `name` matches `/^qa-debug-companion-.*\.vsix$/i`. If zero or multiple match → log + abort silently.
- **Rate limit.** Anonymous GitHub API = 60 req/hr/IP. Throttle below.

## 3. Module layout

One new module + minimal wiring changes. No new dependencies (use Node 18+ `globalThis.fetch`).

```
extension/src/
  update-checker.ts        ← new; the whole feature
  extension.ts             ← +1 call inside activate()
  commands.ts              ← +1 command registration
extension/package.json     ← +1 command, +1 config schema entry
```

## 4. Contracts (signatures only — bodies live in the implementation)

### `update-checker.ts`

```ts
export interface UpdateCheckerDeps {
  context: vscode.ExtensionContext;
  channel: vscode.OutputChannel;           // existing audit channel
  installedVersion: string;                // context.extension.packageJSON.version
  repoSlug: { owner: string; repo: string }; // derived from packageJSON.repository.url
}

export interface UpdateCheckerHandle {
  /** Throttled. Safe to call on every activation. Non-blocking; never throws. */
  runBackgroundCheck(): Promise<void>;
  /** Untrothled. Surfaces "up to date" / "offline" / "no release yet" feedback. */
  runManualCheck(): Promise<void>;
  dispose(): void;
}

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateCheckerHandle;
```

Internal helpers (file-local, no exports):

- `parseRepoSlugFromPackageJson(pkgJsonRepoUrl: string): { owner; repo } | undefined`
- `fetchLatestRelease(slug, signal): Promise<LatestRelease | NetworkError>` — wraps `fetch` with 5s timeout via `AbortController`. Always returns; never throws.
- `compareSemver(a: string, b: string): -1 | 0 | 1` — strips leading `v`, handles `-beta.N` prerelease ordering per semver §11. Required because we will *not* offer to "downgrade" a QA running `0.0.5-beta.8` to stable `0.0.4`.
- `downloadVsix(asset, destPath, signal): Promise<void>` — streams asset to `context.globalStorageUri/updates/<filename>`. 60s timeout. Validates `Content-Length` matches `asset.size`.
- `installAndPromptReload(vsixUri: vscode.Uri): Promise<void>` — calls `workbench.extensions.installExtension` then shows "Reload Window" notification.

### Throttle / dedup state (in `context.globalState`)

| Key                                    | Type     | Purpose                                                                 |
| -------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `qa-debug.updateCheck.lastCheckedMs`   | number   | Skip background check if `now - last < INTERVAL_MS` (default 6h).        |
| `qa-debug.updateCheck.dismissedTag`    | string   | If user clicked "Skip this version", suppress notification until a different `tag_name` shows up. |

Manual command ignores both keys.

## 5. Data flow

```
activate()
  └─ createUpdateChecker(...)         (constructed, registered for dispose)
  └─ void handle.runBackgroundCheck() (fire-and-forget, no await)

runBackgroundCheck():
  if disabled-by-setting                    → return
  if (now - lastCheckedMs) < INTERVAL_MS    → return
  set lastCheckedMs = now
  release ← fetchLatestRelease(slug)        (5s timeout; offline → log + return)
  if compareSemver(release.tag, installed) <= 0  → return
  if release.tag === dismissedTag           → return
  asset ← pick vsix asset                   (none → log + return)
  showNotification(release, asset)          (see §6)

runManualCheck():            // same body, ignore lastCheckedMs + dismissedTag,
                             // and surface explicit feedback for the "no newer"
                             // and "offline" branches
```

## 6. Notification UX

`vscode.window.showInformationMessage` with three buttons:

```
QA Debug Companion 0.0.6 is available (you're on 0.0.5-beta.8).
[Install & Reload]   [View Release Notes]   [Skip this Version]
```

Button semantics:

- **Install & Reload** — `downloadVsix` (with progress notification via `withProgress`) → `installExtension` → second notification "Reload to finish updating" with `[Reload Window]`.
- **View Release Notes** — `vscode.env.openExternal(Uri.parse(release.html_url))`. Does *not* mark as dismissed.
- **Skip this Version** — persist `release.tag_name` to `dismissedTag`. Suppresses re-notification for that exact tag; a newer tag re-notifies.

Failure during download or install → `showErrorMessage` with `[Open Release Page]` fallback to the manual install path.

## 7. `package.json` additions

```jsonc
{
  "contributes": {
    "commands": [
      { "command": "qa-debug.checkForUpdates",
        "title": "QA Debug: Check for Updates",
        "category": "QA Debug" }
      // ... existing commands
    ],
    "configuration": {
      "title": "QA Debug Companion",
      "properties": {
        "qaDebug.updateCheck.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Check GitHub for a newer stable release on startup."
        }
      }
    }
  }
}
```

## 8. Wiring change in `extension.ts`

After the audit channel is created (around current line 35), before any workspace-dependent setup:

```ts
const updateChecker = createUpdateChecker({
  context,
  channel,                                // existing audit channel
  installedVersion: context.extension.packageJSON.version,
  repoSlug: parseRepoSlugFromPackageJson(context.extension.packageJSON.repository?.url),
});
context.subscriptions.push(updateChecker);
void updateChecker.runBackgroundCheck();  // fire-and-forget
```

`registerCommands` (in `commands.ts`) gains one entry that calls `updateChecker.runManualCheck()`. To avoid threading the handle into `RegisterCommandsDeps`, register the manual-check command directly in `extension.ts` next to the constructor — same pattern as `qa-debug.smokeTestMessageRetention` (extension.ts:241-246).

## 9. Error / edge-case matrix

| Condition                                  | Background check               | Manual check                                |
| ------------------------------------------ | ------------------------------ | ------------------------------------------- |
| `repository.url` missing/unparseable       | Log to audit channel, return.  | Same + `showWarningMessage`.                |
| Network offline / timeout / non-2xx        | Log, return.                   | Log + `showWarningMessage("Couldn't reach GitHub")`. |
| `/releases/latest` 404 (no stable yet)     | Log, return.                   | `showInformationMessage("No stable release published yet")`. |
| Latest tag ≤ installed                     | Return (silent).               | `showInformationMessage("You're on the latest version")`. |
| Latest tag === `dismissedTag`              | Return (silent).               | Re-notify anyway (manual = explicit intent).|
| No matching vsix asset                     | Log, return.                   | Log + `showErrorMessage`.                   |
| Download size mismatch                     | Discard temp file + error notification with [Open Release Page]. |
| `installExtension` rejects                 | Same.                                                       |

All "log" entries follow the existing `appendInfo(channel, "[update-check] ...")` convention.

## 10. Known consequence of the stable-only choice

Today: installed `0.0.5-beta.8`, latest stable `0.0.4` → check correctly suppresses (semver: `0.0.4 < 0.0.5-beta.8 < 0.0.5`). This means **no QA on beta will receive any notification until you cut `0.0.5` stable**. If that's later than expected, betas will continue to ship invisibly. Two ways forward when that becomes a problem:

1. Cut stable on the cadence the QAs need updates at.
2. Re-open the channel question (Phase 2) and add `qaDebug.updateCheck.channel: 'stable' | 'beta'` — the checker already isolates channel logic to the `fetchLatestRelease` URL (`/releases/latest` vs `/releases?per_page=1`) and the semver compare, so this is a small follow-up, not a rework.

## 11. Out of scope / deferred

- Background polling beyond the on-activation tick. If users keep their window open for days, they won't see new releases until next launch. Acceptable for QA workflow (window restarts are frequent).
- VSIX signature verification — `installExtension` is the trust boundary.
- Telemetry on update adoption.
- Rollback / pin-version UX.

## 12. Files touched (summary)

- `extension/src/update-checker.ts` — new (~200 lines incl. helpers).
- `extension/src/extension.ts` — ~8-line block after audit channel creation; one command registration.
- `extension/package.json` — one `command`, one `configuration` property.

No changes to `mocha-hooks/`, `qa-debug-mcp/`, or `tool-contracts/`.
