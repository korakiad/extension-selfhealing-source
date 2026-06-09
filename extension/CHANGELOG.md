# Changelog

All notable changes to **QA Debug Companion** are recorded here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/).

`0.0.6-beta.N` builds are pre-releases on the way to the `0.0.6` stable cut. The
in-extension update checker only surfaces **stable** releases, so QAs on a beta
stay quiet until `0.0.6` ships.

## 0.0.6-beta.0

Sharpens the visual element picker for complex, deeply-nested UIs and makes its
output framework-agnostic. Also ships the held-browser MCP hardening (for a QA
who already runs their **own** `@playwright/mcp`) and the scoped pause chat that
were staged but not yet released.

### Added
- **Element picker now captures full frame + ancestor context.** `qa_pick_element`
  resolves the *entire* iframe ancestry of the picked node as `frameChain` — an
  ordered outer→inner list of each `<iframe>`'s own selector, handling arbitrarily
  nested and cross-origin (out-of-process) frames — plus `ancestors`, the DOM
  ancestor chain within the frame (crossing shadow-DOM boundaries). Together they
  let a robust, scoped locator be built even when the clicked element has no stable
  hook of its own; a `:nth-of-type(n)` positional fallback (`nthOfType`) covers
  fully anonymous nodes as a last resort.

### Fixed
- **playwright-mcp collision with a QA's own server.** Previously, if the QA had
  their own `@playwright/mcp` configured, VS Code could either (A) silently
  **disable** our CDP-attached server (a clashing registration label let the
  user's `mcp.json` server outrank our extension-contributed one), or (B) present
  the agent two indistinguishable `browser_*` toolsets (both report the hardcoded
  `serverInfo.name` "Playwright"). The agent could then inspect a freshly-launched,
  empty browser instead of the held failing one.

### Changed
- **Element picker output is framework-neutral.** The picker no longer emits a
  Playwright-shaped locator string. It returns raw DOM facts plus plain CSS
  selectors; the agent reads the consumer project's own tests to build the final
  locator in whatever framework and selector convention that project actually uses
  (Playwright, WebdriverIO, Selenium, a custom wrapper — discovered, not assumed).
- **Held browser now registers as `qa-debug-cdp`.** A unique registration label
  removes the disable-collision, and a thin stdio proxy (`mcp-proxy`) fronts the
  real `@playwright/mcp --cdp-endpoint`, rewriting the reported `serverInfo.name`
  so the agent sees a distinct `mcp_qa-debug-cdp_browser_*` tool namespace. The
  qa-debug skill now steers to `qa-debug-cdp` and warns off any other `browser_*`
  server. The CDP download-shim is unchanged (it sits a layer below).

### Added
- **`qa-debug` custom agent** (`contributes.chatAgents`, available only while a
  test is paused). The pause chat switches into it automatically; its `tools:`
  allowlist scopes the session to `qa-debug-cdp` + the qa-debug verbs + the
  built-in tool groups, excluding the QA's own playwright-mcp and unrelated
  MCP/extension tools from the request — fewer tool schemas per turn (lower token
  use) and no mis-pick.

## 0.0.5 — 2026-06-05

First **stable** release of the 0.0.5 line. It rolls up every `0.0.5-beta.N`
change listed below (Chrome auto-discovery + pure-inspection pause, the native
element picker, stop-button Ctrl-C parity, the in-extension update checker, and
the Electron/OpenFin attach fixes) and adds:

### Added
- **Configurable test-file discovery (`qaDebug.testMatch`).** The Test Explorer
  is no longer locked to `build/dist/**/*.spec.js`. Point discovery at your own
  compiled-output folders and suffixes with a glob — or a list of globs — and the
  tree follows. Set it in **User** settings and the project repo stays untouched.
  The default now covers compiled tests under `{build,dist}/{e2e,test,tests}/`
  (any `.js`, including unsuffixed files) plus `*.{spec,test,e2e}.js` anywhere
  under `build`/`dist`, so plain `.js` tests and alternate suffixes are found with
  no per-project configuration. Changing the setting re-scans the tree instantly.
- **Refresh (↻) button in the Test Explorer** re-scans test files on demand.

## 0.0.5-beta.18 — 2026-06-02

### Internal
- Repository cleanup with **no QA-facing behavior change** — the tool surface,
  UI, and runtime behavior are identical to beta.17. Removed dead code left over
  after the verdict verbs were dropped (the unused proposal layer and the
  `PAUSE_ALREADY_RESOLVED` error code), retired the per-feature `PLAN-*.md`
  working docs and the `archive/` directory (`ARCHITECTURE.md` is now the single
  source of truth), and scrubbed dangling citations to those deleted design docs
  from code comments and the package READMEs.

## 0.0.5-beta.17 — 2026-06-02

### Fixed
- **Step 0 Option B ("I'll tell you the fix") no longer auto-edits your spec.**
  Picking B used to make the agent infer its *own* fix and apply it to the file.
  B now means *"I describe, you apply"*: the agent first asks you for the root
  cause and the exact change you want, then applies **only** what you dictated —
  it won't guess a fix or touch anything you didn't ask for. The ambiguous
  *"I'll just edit"* wording that caused this was removed from the Step 0 labels
  and checklist.

## 0.0.5-beta.16 — 2026-06-02

### Changed
- **Pause guidance consolidated into the `qa-debug` skill.** The prefilled pause
  prompt no longer duplicates the investigation workflow — it now carries just
  the per-pause failure data and hands off to the skill, which owns the
  Step 0 → ground → select-Chrome → inspect → propose flow as the single source
  of truth. This removes drift between the prompt and the skill. The skill's
  Step 0 (the *"let me find the root cause"* / *"you already know it"* either/or)
  was hardened so it reliably opens the investigation, and the prompt wording was
  aligned so it doesn't accidentally skip that question.

### Fixed
- **The `@qa-debug` card no longer claims `playwright-mcp` is attached before a
  Chrome is selected.** It now reflects selection state — the live-browser tools
  become available once a Chrome is picked, matching how registration actually
  works.

## 0.0.5-beta.15 — 2026-06-02

### Added
- **Visual element picker via Chrome's native inspector (`qa_pick_element`).**
  During a pause you can have the agent arm Chrome's own "inspect element"
  cursor in the held browser — hover to highlight, click once, anywhere — and it
  returns the clicked element's attributes plus a suggested locator. Because the
  hit-test runs in the browser process, it reaches elements inside **cross-origin
  iframes, shadow DOM / web components, and canvas overlays** that a page-script
  picker can't. The `/identify-element` skill now routes to this tool.

### Removed
- The old page-script element picker (injected via `browser_evaluate`) plus its
  manual playground and mock eval — fully superseded by `qa_pick_element`.

## 0.0.5-beta.14 — 2026-06-01

### Added
- **Chrome auto-discovery + selection (CDP port probe).** The companion now
  probes the test framework's Chrome DevTools endpoint, surfaces the discovered
  browsers (with page titles, tab count, and a best-effort runtime label), and
  lets you pick which one `playwright-mcp` attaches to — via the Test Explorer UI
  or the new `qa_discover_chromes` / `qa_select_chrome` agent tools. When the
  default debug ports come up empty you can supply the framework's ports directly.

### Changed
- **A pause is now a pure inspection hold — the verdict verbs are gone.** The
  `mark-passed`, `give-up`, and `abort-suite` tools were removed: there is no
  pass/fail verdict for the agent to commit. You investigate the held browser,
  the agent proposes a source/spec fix, and you re-run from Test Explorer ▶ (a
  fresh pause arrives if it still fails) or end the run with **Stop**. The test
  stands at its natural Mocha outcome.
- **Chat prompt opens straight into a clear choice.** On a pause the agent now
  asks one focused either/or — *"let me find the root cause"* vs *"you already
  know it, I'll just make the edit"* — as a selectable popup, instead of an
  open-ended free-text question.
- **Agent verifies `playwright-mcp` is actually reachable** before investigating,
  and tells you to enable/install it if the `browser_*` tools aren't visible —
  rather than silently falling back to reading source.

### Internal
- Collapsed the three byte-identical CDP port-probe copies into a single shared
  module, and made the `languageModelTools` block in `package.json` a derived
  artifact generated from the `tool-contracts` SSOT (with a build-time drift guard).

## 0.0.5-beta.13 — 2026-05-29

### Fixed
- **Stop / Cancel Suite now tears down the whole run, like Ctrl-C.** The Test
  Explorer stop button and the status-bar "Cancel Suite" action sent `SIGTERM` to
  only the mocha process. That left the browser the framework launched (Electron /
  OpenFin / Chrome) orphaned and still running, and could hang indefinitely when
  the framework's own signal handler blocked on the paused browser — so the button
  looked dead. The run is now spawned in its own process group, and cancellation
  sends a Ctrl-C-equivalent `SIGINT` to the entire group (mocha + the app it
  launched + any worker), escalating to `SIGKILL` after a short grace window if
  anything ignores it. Windows uses `taskkill /T /F`. Only the run's own process
  group is ever signalled — the editor and unrelated processes are untouched.

## 0.0.5-beta.12 — 2026-05-29

### Added
- **Runtime classification + multi-tab orientation.** An Electron/OpenFin app
  exposes many windows and webviews on a single CDP endpoint, and `playwright-mcp`
  does not define which one it attaches to — so a snapshot could land on the wrong
  window. The pause now reports `tab_count` and a best-effort `runtime` label
  (`chrome` / `electron` / `openfin` / `unknown`). When `tab_count > 1`, Copilot
  lists tabs with `browser_tabs` and lands on the page under test before
  snapshotting, instead of guessing. Behavior keys on `tab_count`, not the label
  (an app can override its User-Agent).

## 0.0.5-beta.11 — 2026-05-29

### Fixed
- **Leaked VS Code environment into the app under test.** The extension host runs
  with `ELECTRON_RUN_AS_NODE=1`; that was being copied verbatim into the spawned
  mocha child and cascaded into the Electron/OpenFin app the test framework
  launches (e.g. Refinitiv Workspace), booting it in Node mode — no window, no
  `--remote-debugging-port`, so CDP discovery found nothing. The child environment
  is now scrubbed the way VS Code scrubs its own (`ELECTRON_*`, `VSCODE_*`,
  `NODE_OPTIONS`, `LD_PRELOAD`, …); `PATH` and the IPC channel are preserved.

## 0.0.5-beta.10 — 2026-05-29

### Added
- **CDP download-shim for old Electron.** `playwright-mcp`'s `--cdp-endpoint` path
  always sends `Browser.setDownloadBehavior` during the handshake, which old
  Electron / embedded Chromium rejects ("Browser context management is not
  supported") — failing the first `browser_*` tool call. An in-process shim now
  fronts the held browser and swallows that one command. On by default
  (`qaDebug.cdpDownloadShim.enabled`); harmless for normal Chrome.
- **Cancel a running suite.** New "QA Debug: Cancel Running Suite" command, a
  status-bar **Cancel Suite** button, and a Test Explorer stop icon — recover from
  a wrong-fixture run without waiting for mocha to fail.
- **User guide** for non-technical QAs (`docs/QA-DEBUG-USER-GUIDE.md`).

### Fixed
- **Slimmer `.vsix`.** Stopped bundling `test/`, runtime `.playwright-mcp/` trace
  snapshots, and TypeScript sources into the package.
- **Wrong attach guidance.** Every agent-facing surface told the model to "attach
  via the `browser_connect` tool" — which does not exist. With `--cdp-endpoint` the
  browser auto-attaches on the first `browser_*` call, so the guidance now starts
  with `browser_snapshot` (no attach step).

## 0.0.5-beta.9 — 2026-05-27

### Added
- **In-extension update checker (stable channel).** Polls the releases page on
  activation (6h throttle) and offers **Install & Reload** when a newer *stable*
  release ships. `compareSemver` treats `0.0.4 < 0.0.5-beta.N < 0.0.5`, so betas
  never get a spurious downgrade prompt. Manual check via "QA Debug: Check for
  Updates"; escape hatch `qaDebug.updateCheck.enabled` (default on).

## 0.0.5-beta.8 — 2026-05-27

### Added
- **`identify-element` skill** and a reworked investigation flow: Copilot asks for
  direction first (Step 0), **proposes rather than edits** by default, and pulls
  network/console only on demand — cutting the HMR / dev-telemetry noise that
  drowned the signal.

### Changed
- **Two-stage commit** for the mark-passed / give-up / abort-suite verbs: propose
  and ask, then commit on a second turn.

## 0.0.5-beta.7 — 2026-05-26

### Fixed
- Resolve the mocha working directory to the project root, not the spec's parent
  directory.

## 0.0.5-beta.6 — 2026-05-26

### Fixed
- `--grep` alternation now includes the top-level suite title, so single-test runs
  match reliably.

## 0.0.5-beta.5 — 2026-05-26

### Fixed
- Marker patch no longer keys off `instanceof Test`; added a trace flag for
  diagnosis.

## 0.0.5-beta.4 — 2026-05-26

### Fixed
- The grep marker is formatted as ` [<text>]` and stripped from IPC test titles.

## 0.0.5-beta.3 — 2026-05-26

### Fixed
- `--no-timeouts` plus an opaque-marker grep for consumer-friendly runs (a long
  human pause no longer trips mocha's timeout).

## 0.0.5-beta.2 — 2026-05-26

### Added
- Mocha child `stdout`/`stderr` is piped to a dedicated **"QA Debug Mocha"** output
  channel.

## 0.0.5-beta.1 — 2026-05-26

### Fixed
- Dropped leftover companion-owned Chrome (Mode B residue).

## 0.0.5-beta.0 — 2026-05-26

### Changed
- **Mode C only.** Finished the CDP port-discovery migration: dropped Mode A (the
  `wdio.remote()` monkey-patch) and Mode B (hardcoded `ws://localhost:9222`
  fallback). The browser is framework-owned and discovered per-pause via
  `/json/version`. Consumers never edit specs, `.mocharc`, or browser launch.

### Removed
- **The retry surface.** Removed the `qa_request_retry` and
  `qa_propose_close_browser` verbs — re-running after a fix is the user's action
  (Test Explorer ▶ Run), and Chrome is framework-owned. The agent verb set is now
  get-failure-context, discover/select-chrome, propose-mark-passed,
  propose-abort-suite, and request-give-up.

## 0.0.4 — 2026-05-22

### Fixed
- Scope Test Explorer discovery to `{build,dist}/**/*.spec.js`.

## 0.0.3 — 2026-05-22

### Fixed
- Resolve mocha via `require.main` so the shipped bundle binds to the user's own
  mocha install.

## 0.0.2 — 2026-05-22

### Fixed
- Ship `@qa-debug/mocha-hooks` under `node_modules/` inside the `.vsix`; activation
  fix.

## 0.0.1 — 2026-05-22

- First internal pre-release.
