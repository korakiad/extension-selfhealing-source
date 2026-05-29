# PLAN — CDP download-shim for attaching playwright-mcp to old Electron

Status: IMPLEMENTED (pending review) — 2026-05-29
Scope: code-level fix (lightweight PLAN, not a CR-vN doc)
Branch context: `feat/cdp-port-discovery-finish`

## Implementation notes (what landed)

- `extension/src/cdp-download-shim.ts` — the shim (`startCdpDownloadShim`),
  swallow-set `DEFAULT_SWALLOW_METHODS = ['Browser.setDownloadBehavior']`.
- `extension/src/session-manager.ts` — `bindMcpToSelection()` starts the shim on
  `onChromeSelected` and publishes `shim.httpRoot`; `stopCdpShim()` is called on
  `onChromeDeselected`, on `finalDecision`→`setIdle`, and in `dispose()`.
- `extension/package.json` — added `ws`/`@types/ws`; added setting
  `qaDebug.cdpDownloadShim.enabled` (default `true`).
- **Decisions taken** (the two open review questions): (1) **always-shim** with an
  `off` setting — not auto-detect. Rationale: the swallow is harmless for the
  read-only pause-inspection flow (no Playwright-managed downloads), and it avoids
  brittle Electron detection. (2) **swallow only `Browser.setDownloadBehavior`** —
  mirror the relay, don't mask other protocol errors. Both remain easy to revisit.
- **Verified — real E2E** (`extension/test/cdp-shim-e2e.mts`, `pnpm test:e2e:shim`):
  drives the **real `@playwright/mcp`** + **real headless Chrome** behind an
  "old-Electron emulator" proxy that rejects `Browser.setDownloadBehavior`.
  - NEGATIVE (MCP → emulator → Chrome): `browser_navigate` fails with the exact
    error `Protocol error (Browser.setDownloadBehavior): Browser context
    management is not supported.` — reproduces the user's report.
  - POSITIVE (MCP → **shim** → emulator → Chrome): shim swallows
    `setDownloadBehavior`; `browser_navigate` + `browser_snapshot` succeed and
    return the page content.
  `tsc` + esbuild green; `ws` confirmed bundled; test reaps Chrome on exit.
  Caveat: the emulator only injects the `setDownloadBehavior` rejection — a real
  old-Electron build that also rejects `Target.setAutoAttach`/`Emulation.*` would
  need those added to the swallow-set (one-line change).

## Problem

The extension attaches playwright-mcp to the held browser by launching

```
npx -y @playwright/mcp@latest --cdp-endpoint <httpRoot>
```

(`extension/src/mcp-provider.ts:58`, fed by `session-manager.ts:231`
`cdpWsUrlToHttpRoot(selection.cdp_ws_url)`).

`--cdp-endpoint` resolves to playwright-mcp's `createCDPBrowser`, which is a thin
wrapper over `chromium.connectOverCDP(endpoint, { headers, timeout, artifactsDir })`
— **no `noDefaults`**:

- `playwright-core/src/tools/mcp/browserFactory.ts:108` — the connect call; only
  passes headers/timeout/artifactsDir.

During the CDP handshake Playwright unconditionally sends
`Browser.setDownloadBehavior` to set up downloads on the default context:

- `playwright-core/src/server/chromium/crBrowser.ts:351` — `CRBrowserContext.initialize()`
  sends it **unless** `acceptDownloads === 'internal-browser-default'`.

Old Electron's embedded Chromium does not implement browser-level context
management and rejects the command:

> `Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.`

This is the same failure the user hit in a hand-written `connect_over_cdp` script.

## Why not the obvious fixes

| Candidate | Verdict |
|---|---|
| `noDefaults: true` connect option (public since Playwright **v1.60**, `docs/src/api/class-browsertype.md:227`; sets `acceptDownloads:'internal-browser-default'` at `chromium.ts:143`, which skips the command). | Correct lever for **hand-written scripts** (`connect_over_cdp(url, no_defaults=True)`), but playwright-mcp's `--cdp-endpoint` path **does not forward it** and exposes **no config field** for it. Unreachable through the MCP. |
| Pin an old `@playwright/mcp`. | `setDownloadBehavior` predates `noDefaults`; the version that fixes it is the one that *added* the option. Pinning backward removes the fix, not the command. |
| patch-package the bundled `playwright-core`. | Edits `node_modules`; breaks on `npx @latest` re-resolution. Violates the transparent-use mandate (QA installs/upgrades freely). |
| Upstream PR adding `--cdp-no-defaults`. | Cleanest long-term; pursue in parallel, but gated on merge/release. Need a local bridge now. |

## Current attach path (verified against source)

The project does **not** launch the browser — the QA's test framework does. The
companion discovers it and rebinds playwright-mcp's `--cdp-endpoint` per pause.
`chrome_owner: 'framework'` (`mocha-hooks/src/qa-hooks.ts:374`) confirms this.
(The "companion launches Chrome at `:9222`" model in `ARCHITECTURE.md` is legacy
Mode A; this branch is Mode C.)

0. **Browser pre-exists (framework-owned).** The test framework (wdio/Playwright)
   launches Chrome with `--remote-debugging-port` on **22135/22136**
   (`DEFAULT_CDP_PORTS`, override via `QA_DEBUG_CDP_PORTS`) — `qa-hooks.ts:25`.
1. **Discover at pause** (test process, injected `afterEach`). Probes each port's
   `http://localhost:<port>/json/version` → `webSocketDebuggerUrl` (normalize
   `0.0.0.0`→`127.0.0.1`) + `/json/list` titles → `available_chromes:
   [{port, ws_url, page_titles}]` (`qa-hooks.ts:335-340`, `probe-ports.ts`).
   Holds the test (`this.timeout(0)` + heartbeat) and publishes over IPC:
   `c.request(pausePublish, payload)` (`qa-hooks.ts:371`).
2. **Select** (extension + agent). `qa_select_chrome(session_id, port)` →
   `pauseStore.recordChromeSelection` validates the port, sets `cdp_ws_url` =
   chosen `ws_url`, fires `onChromeSelected` (`select-chrome.ts:32`,
   `pause-store.ts:145`).
3. **Rebind the MCP** (extension). `session-manager.ts:231` subscriber:
   `httpRoot = cdpWsUrlToHttpRoot(cdp_ws_url)` → `mcpProvider.setPaused(httpRoot)`
   → fires `onDidChangeMcpServerDefinitions`.
4. **Launch the MCP** (VS Code). `mcp-provider.ts:55` returns one definition:
   `npx -y @playwright/mcp@latest --cdp-endpoint <httpRoot>`. Idle → `[]`, so the
   MCP exists only during a pause.
5. **Actual connect** (playwright-mcp). On the agent's **first `browser_*` call**
   (e.g. `browser_snapshot`), playwright-mcp lazily runs
   `chromium.connectOverCDP(httpRoot)` and attaches. **This is the single connect
   chokepoint — and where the old-Electron `setDownloadBehavior` failure occurs.**

```
framework Chrome :22135 ──/json/version──▶ qa-hooks probe ──IPC──▶ extension
                                                                      │
                                                qa_select_chrome (agent picks port)
                                                                      │
                                  setPaused(http://host:22135) → MCP launched w/ --cdp-endpoint
                                                                      │
            first browser_* call → playwright-mcp connectOverCDP(http://host:22135) → attached
```

Pinned runtime fact: `npx @playwright/mcp@latest` currently resolves to
**0.0.75**, advertising **23 tools** (no `browser_connect`, no storage/verify/
tracing/pdf tools — those are newer-main or `--caps`-gated). Verified live via
`tools/list`.

## Design — in-process CDP download-shim

A tiny HTTP+WS proxy, owned by the extension host, sits between playwright-mcp
and the real (Electron) CDP endpoint. It reproduces the *effect* of
`noDefaults` by swallowing `Browser.setDownloadBehavior` — exactly what
playwright-mcp's own extension relay already does:

- `playwright-core/src/tools/mcp/cdpRelay.ts:264` — `case 'Browser.setDownloadBehavior': return {};`

The MCP is published the **shim's** http root instead of the raw endpoint, so
nothing about the launch command, MCP version, or QA config changes. Transparent
per [[feedback-transparent-use]].

### Responsibilities

1. **HTTP discovery passthrough.** Serve `GET /json/version` (and `/json/list`)
   by fetching the same from the target and rewriting `webSocketDebuggerUrl`'s
   host:port to the shim's own. This is the same `/json/version` probe shape the
   codebase already speaks (`extension/src/lm-tools/probe-ports.ts:57`).
2. **WS bridge.** On a client WS connection, dial the target's current
   `webSocketDebuggerUrl` and pipe frames both directions verbatim.
3. **Swallow.** For client→target frames whose `method` is in the swallow-set,
   do **not** forward; synthesize `{ id, result: {} }` back to the client.
   - Default swallow-set: `Browser.setDownloadBehavior` (the reported blocker).
   - Extensible to the other commands `noDefaults` suppresses if old Electron
     also rejects them: `Emulation.setFocusEmulationEnabled`,
     `Emulation.setEmulatedMedia` (colorScheme/reducedMotion/forcedColors/contrast).
     Kept out of the default set until observed failing — minimal mirror of the
     relay, which swallows only `setDownloadBehavior` and fakes `Browser.getVersion`.

### Contracts (structure only — see source when in doubt, per [[feedback-plan-style]])

New module `extension/src/cdp-download-shim.ts`:

```
export interface CdpShimOptions {
  targetHttpRoot: string;        // http://host:port of the real (Electron) endpoint
  swallowMethods?: string[];     // defaults to ['Browser.setDownloadBehavior']
  host?: string;                 // bind host, default 127.0.0.1
}

export interface CdpShim {
  readonly httpRoot: string;     // http://127.0.0.1:<assignedPort> — publish THIS to the MCP
  stop(): Promise<void>;         // closes server + any live bridges; idempotent
}

export function startCdpDownloadShim(opts: CdpShimOptions): Promise<CdpShim>;
```

- Port `0` for OS-assigned; read back the actual port for `httpRoot`.
- Bind `127.0.0.1` only (never expose the proxy off-box).
- One target per shim instance; lifecycle is 1:1 with a pause selection.

### Wiring (single insertion point)

`extension/src/session-manager.ts` `onChromeSelected` (currently lines 230–237):

- Today: `setPaused(cdpWsUrlToHttpRoot(selection.cdp_ws_url))`.
- New: start a shim against that http root, then
  `setPaused(shim.httpRoot)`. Store the shim handle on `SessionManager`.

`onChromeDeselected` / idle (lines 239–246) and any teardown path:

- `await shim.stop()` before/after `clearPaused()`; null the handle.
- Replacing a selection stops the prior shim before starting the new one
  (mirror the existing select/deselect funnel discipline noted at
  `session-manager.ts:224`).

No change to `mcp-provider.ts` — it still publishes one http root; it just
happens to be the shim's.

### Tool-surface note (verified against playwright-mcp tool list)

playwright-mcp has **no `browser_connect` tool**. With `--cdp-endpoint`, the
server connects itself **lazily on the first `browser_*` call** (e.g.
`browser_snapshot`). The `connectOverCDP` + `Browser.setDownloadBehavior`
handshake therefore fires at that first tool call — so against old Electron the
error surfaces on the first `browser_*` invocation, not on any attach step. This
makes `--cdp-endpoint` the single chokepoint and confirms the shim insertion
point above.

**Independent prompt bug (out of this PLAN's scope, flag for a follow-up):**
`extension/src/commands.ts:200,206,217,250` instruct the agent to "attach via the
playwright-mcp `browser_connect` tool using the cdp_ws_url" — that tool does not
exist and the `cdp_ws_url` is never consumed by any tool (the launch arg already
wired it). After `qa_select_chrome` commits, the browser is already attached; the
prompt should tell the agent to call `browser_snapshot` directly. Fix separately.

### Gating: only shim when needed

Connecting to real Chrome `:9222` does **not** need the shim (Chrome supports
the command). To avoid a needless hop:

- Option A (simple, safe): always shim. The swallow is a no-op for Chrome
  (Chrome accepts `setDownloadBehavior`, but the shim intercepts before forward,
  so downloads fall back to browser default for *all* targets — a behavior
  change for Chrome downloads). ⚠️ Not free.
- Option B (preferred): shim only when the target is detected as
  download-management-incompatible. Detection candidates:
  - probe `/json/version` `Browser` string (Electron UA / old Chromium build),
    extending `probe-ports.ts` which already reads `/json/version`; **or**
  - a config/setting `qa-debug.cdpDownloadShim: "auto" | "always" | "off"`.

  Open question — see Review prompts. Leaning B/auto with an `off` escape.

## Out of scope

- The hand-written-script fix (`no_defaults=True`) — documented separately; no
  code here.
- A standalone CLI proxy + Claude Code skill for using playwright-mcp against
  Electron *outside* the companion. Same core module could be re-exported behind
  a `bin` later; not built now.
- Download *capture* through the shim (the relay's known gap, playwright-mcp
  issue #1396). The shim makes attach succeed; it does not make Playwright-managed
  downloads work — same tradeoff as `noDefaults`.

## Verification

1. Unit: feed a recorded `Browser.setDownloadBehavior` frame → assert no forward,
   synthesized `{id,result:{}}` returned; assert all other frames pass through.
2. Integration: launch old Electron with `--remote-debugging-port`, point a real
   `npx @playwright/mcp --cdp-endpoint <shim.httpRoot>` at it, confirm the **first
   `browser_*` call** (`browser_snapshot` / `browser_navigate`) succeeds with no
   `setDownloadBehavior` error. (There is no `browser_connect` tool — the connect
   happens lazily on that first call.)
3. Regression: Chrome `:9222` path still attaches; existing fixture pause flow
   unaffected.

## Review prompts (for the adversarial pass — [[feedback-ralph-loop-scope]])

1. **Always-shim vs detect (Option A/B).** Is the extra localhost hop + the
   Chrome-download behavior change acceptable to avoid detection complexity? What
   does `/json/version` actually return for the target Electron version — is
   detection reliable?
2. **`/json/version` host rewrite correctness.** Does Playwright's
   `urlToWSEndpoint` re-read `/json/version` on the shim mid-session if the UUID
   rotates? Does the shim need to track UUID rotation, or re-dial per WS connect?
3. **Lifecycle races.** Selection replaced mid-attach: is stop-before-start
   enough, or can the MCP hold a dead bridge? Does VS Code reuse the MCP process
   across `onDidChangeMcpServerDefinitions` fires (relevant to shim port stability)?
4. **Swallow-set scope.** Swallow only `setDownloadBehavior`, or pre-emptively
   the full `noDefaults` set? Risk of masking a real protocol error by faking
   `{}` for a command the target *would* have handled.
5. **Should this just be an upstream PR instead?** Cost/benefit of carrying the
   shim vs landing `--cdp-no-defaults` in playwright-mcp and pinning to it.
