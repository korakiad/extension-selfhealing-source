# PLAN — CDP port-based discovery (Mode C) + drop Mode A

> **Iter#7 (2026-05-22)** — addresses Codex reviewer's iter#6 REQUEST_CHANGES (J1-J2). Fixes: §3.7 normalizer entry's signature aligned with §3.2's optional-payload return (J1); all `recordChromeSelection` call snippets in §3.14 and §3.18 explicitly `await` with try/catch + diagnostic log on rejection (J2).
>
> Iter#6 (2026-05-22) — addressed I1-I4. Fixes: `normalizePausePayload` return type changed to `{payload?, diagnostics}` so absent-Memento-key reads no longer require a fabricated payload (I1); store file paths corrected to existing `extension/src/pause-store.ts` and `qa-debug-mcp/src/pause-store.ts` (I2); §3.12 `qa_discover_chromes.inputSchemaJson` ports constraints aligned with §3.11.0 (I3); `source: 'agent' | 'extension-ui' | 'auto'` added to `recordChromeSelection` + `ChromeSelection` payload to feed §3.4 log (I4).
>
> Iter#5 (2026-05-22) — addressed H1-H6. Fixes: `recordChromeSelection` now async returning `ChromeSelection` payload `{session_id, port, cdp_ws_url, page_titles}`; `onChromeSelected` fires with that payload AFTER persistence so session-manager never re-reads stale state (H1, H2); `onChromeDeselected` event formally added to PauseStore interface; both MementoPauseStore and InMemoryPauseStore implementations called out (H3); `normalizePausePayload(raw)` returns `{payload, diagnostics: string[]}` — caller logs (no extension imports inside pause-store-types) (H4); `JsonSchemaProp` extended with `'array'` + `items` field; tool-contracts touch point added (H5); concrete updates to live `ARCHITECTURE.md:101` and `PLAN-mcp-cdp-wire.md` deprecation banner (H6).
>
> Iter#4 (2026-05-22) — addressed G1-G10. See `git log` for iter#4 diff.

## Problem

Consumer org's QA workflow does not match either of the two paths qa-hooks currently supports:

- **Mode A** (`qa-hooks.ts:47-130`) — monkey-patches `wdio.remote()` to capture the returned browser into a module-scope singleton `currentBrowser`. Requires the user's spec/framework to invoke `wdio.remote(...)` through the `webdriverio` namespace AFTER qa-hooks' `--require`-time patch installed on the same module instance.
- **Mode B** (`qa-hooks.ts:425-426`) — hardcoded `ws://localhost:9222` fallback, overridable via `QA_DEBUG_CDP_WS_URL`. Requires the full WS URL including the per-session browser UUID, which the user has no stable way to know.

Consumer setup that breaks both:

1. Consumer `package.json` does NOT declare `webdriverio` as a direct dep. Transitive dep under closed-source `@company/custom-framework`. npm hoists to `consumer/node_modules/webdriverio/`. `require.resolve('webdriverio')` from `~/.vscode/extensions/qa-debug.../mocha-hooks/dist/` throws `MODULE_NOT_FOUND` → silent early-return at qa-hooks.ts:77 → Mode A patch never installs.
2. Mocha is wired via consumer `package.json`'s `mocha: { file: "./node_modules/@company/custom-framework/xxx.js", ... }`. Framework file loads at mocha `addFile` time — AFTER `--require` hooks ran. Patch timing race.
3. Framework starts Chrome itself with `--remote-debugging-port=22135` AND `--remote-debugging-port=22136` BEFORE specs run, then attaches wdio sessions via `goog:chromeOptions.debuggerAddress`. wdio is connecting to a pre-launched chrome.
4. Mode B's default `ws://localhost:9222` is the wrong port AND wrong URL shape (no per-session UUID).

Net effect: every pause publishes a `cdp_ws_url` that points at nothing — or, worse, at an unrelated `:9222` chrome the user happens to have open. Both failure paths are silent (no startup log explaining Mode A fell through to Mode B default).

## Goal

Pause-publish a **dialable** `cdp_ws_url` for the failing test's chrome — but ONLY after the chrome has been concretely selected (auto-selected when discovery is unambiguous, user-selected via runtime-gated tool otherwise). The user must not need to edit specs, `.mocharc`, the framework, chrome launch flags, OR any default workspace setting. Conforms to [[feedback-transparent-use]].

## Approach — Chrome DevTools target discovery + runtime-gated selection

Three coupled parts:

1. **Discovery via HTTP `/json/version`**. qa-hooks probes a hard-coded default port list `[22135, 22136]` (overridable via `QA_DEBUG_CDP_PORTS` env — F1 safety valve) in parallel, builds `available_chromes` array, includes in pause payload.

2. **Runtime-gated selection via `qa_select_chrome(session_id, port)` tool**. PausePayload carries `available_chromes[]` + `selected_cdp_port: number | null`. `cdp_ws_url` is a DERIVED field (not stored on wire) — null until selection completes. **mcpProvider.setPaused is gated on selection** (§3.18) — playwright-mcp is not registered against any endpoint until the user's selection commits.

3. **Two askUser surfaces**: agent path via chat (`qa_select_chrome` tool from Copilot) + extension UI path via input box / QuickPick at pause receipt. Both write to the same pause-store API (`recordChromeSelection`); the store fires a "selection committed" event that session-manager subscribes to in order to register playwright-mcp.

The two-surfaces model closes the engagement gap noted in [[chat-panel-engagement-gap]] — QA can recover from "no chromes found" purely through extension UI without opening Copilot Chat.

## Confirmed Chrome invariants (verified against Chromium 120+)

| # | Invariant | Source |
|---|-----------|--------|
| C1 | Chrome with `--remote-debugging-port=N` serves `http://localhost:N/json/version` returning `{ webSocketDebuggerUrl: "ws://<host>:<N>/devtools/browser/<UUID>", ... }`. Browser-level (not page-level). Stable for the chrome process lifetime. | DevTools Protocol Target discovery; `chromedevtools.github.io/devtools-protocol/#endpoints` |
| C2 | `--remote-debugging-pipe` (alternative) does NOT serve HTTP. User confirmed framework uses `port`, not `pipe`. Out of scope. |
| C3 | `--remote-debugging-port` without explicit address binds 127.0.0.1; `--remote-debugging-address=0.0.0.0` is the only case requiring normalization. Existing helper at `qa-hooks.ts:271-279`. |
| C4 | Chrome restart serves `/json/version` with a fresh UUID. Mode C self-heals because the fetch happens per pause. |
| C5 | playwright-mcp's `browser_connect` accepts a browser-level `ws://.../devtools/browser/<UUID>` directly. |
| C6 | `/json/list` returns array of pages with `id`, `title`, `url`, `type`, `webSocketDebuggerUrl`. Used here to surface `page_titles` for the user-facing picker. |
| C7 | Chrome's CDP allows multiple concurrent clients per port. **VERIFIED 2026-05-22** via `fixture-tests-wdio/spike/cdp-coexistence.spec.js` — 4 spike steps all PASSED on Chromium (headless=new): wdio attach via debuggerAddress + puppeteer-core via /json/version coexist cleanly; puppeteer active `Page.goto` does NOT crash wdio's session; wdio resumes via `browser.url()` and `browser.$('body').isExisting()` after puppeteer activity; chrome stderr clean of CDP-channel error patterns. Implementation Task #3 unblocked. | CDP transport spec + spike verdict |

## Pre-implementation spike (blocks §"Touch points")

C7 above is load-bearing. Before any implementation begins, verify wdio + playwright-mcp coexistence empirically.

### Spike location (G9)

Runs as a script under `fixture-tests-wdio` package — the package that owns `chrome-launcher` (per §3.15) and `webdriverio` devDeps. Concrete:

- File: `fixture-tests-wdio/spike/cdp-coexistence.spec.js`
- Script: `fixture-tests-wdio/package.json` adds `"spike": "mocha spike/cdp-coexistence.spec.js"`
- Devdeps `chrome-launcher` (added per §3.15) and `puppeteer-core` (NEW addition; needed for the second CDP attacher in the spike) used.

### Spike scope

The spike test:

1. Launches a real Chrome via `chrome-launcher` with `--remote-debugging-port=22135` (no automation framework involved).
2. Connects wdio in attach mode (`debuggerAddress: 'localhost:22135'`), opens an HTML fixture page (use site/index.html from existing fixture), leaves the session alive (simulates the mid-pause wdio-session-not-disposed state).
3. Via `puppeteer-core.connect({ browserWSEndpoint: <ws from /json/version> })`, sends:
   - Read command: `Page.captureSnapshot` (or DOM.getDocument).
   - Active command: `Page.navigate` to a different URL on the same fixture site.
4. Resumes the wdio session: issues `browser.url(...)` and asserts no `session closed` / `target not found` / `invalid session id` errors thrown.
5. Captures Chrome log output via `--enable-logging --v=1` and asserts no CDP-channel errors in the log.

### Decision gates (simplified — G6)

- **Pass** (no errors, both puppeteer-core commands observed, wdio resumes cleanly, chrome log clean): proceed with PLAN. Update C7 to "verified" with spike artifact path. Implementation Task #3 unblocks.
- **Fail or Partial-Fail** (any wdio resume error, OR any chrome CDP-channel error, OR puppeteer-core active command throws): PLAN cannot ship as designed. A new CR is required to address the constraint — either (a) force wdio session disposal before pause publish (violates transparent-use), or (b) block playwright-mcp at the MCP gate during pause (defeats most of the value). The reserved §3.17 in iter#3 is DELETED — there is no in-PLAN contingency for partial-pass because VS Code's MCP gate registers a whole MCP server (server-level), not individual tools. Cannot ship a "read-only playwright-mcp" mode without redesigning the gate.

### Spike deliverables

- Spike script committed at `fixture-tests-wdio/spike/cdp-coexistence.spec.js`.
- Console transcript of all 5 steps.
- Chrome `--v=1` log snippet (or full log file).
- Decision-gate verdict written into this PLAN's C7 row + spike artifact paths recorded.

**Implementation does not start until the spike verdict is recorded as "Pass".**

## Decision

Five coupled changes:

1. **Drop Mode A entirely.**
2. **Mode C as primary** with hard-coded defaults `[22135, 22136]` + env override `QA_DEBUG_CDP_PORTS`.
3. **Runtime-gated chrome selection** via new tool `qa_select_chrome(session_id, port)`. PausePayload's `cdp_ws_url` is derived only after selection. **MCP playwright-mcp registration is gated on selection** (§3.18 — moves `mcpProvider.setPaused` out of pause-receipt path).
4. **Two askUser surfaces**: agent chat + extension input box/QuickPick at pause receipt.
5. **`QA_DEBUG_CDP_WS_URL` env DELETED entirely** — no implicit `ws://localhost:9222` fallback, no explicit escape hatch (G1). The session-manager line at `extension/src/session-manager.ts:218` that injects this env is removed. Users who set it externally see a one-time startup warning (extension/src/extension.ts activate hook).

## Contracts

### 3.1 Hard-coded port defaults + env override

```ts
// qa-hooks.ts (top of file)
const DEFAULT_CDP_PORTS = [22135, 22136] as const;

function effectiveCdpPorts(): readonly number[] {
  const env = process.env.QA_DEBUG_CDP_PORTS?.trim();
  if (!env) return DEFAULT_CDP_PORTS;
  const tokens = env.split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = tokens.map((s) => Number(s));
  const valid: number[] = [];
  const invalid: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const n = parsed[i];
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
      valid.push(n);
    } else {
      invalid.push(tokens[i]);
    }
  }
  if (invalid.length > 0) {
    // G1 partial-invalid case — warn but don't drop valid entries
    process.stderr.write(
      `[qa-hooks] WARN QA_DEBUG_CDP_PORTS contained invalid entries [${invalid.join(', ')}]; using valid subset [${valid.join(', ')}]\n`,
    );
  }
  return valid.length > 0 ? valid : DEFAULT_CDP_PORTS;
}
```

Log effective list at first afterEach:
```
[qa-hooks] CDP discovery: effective ports [22135, 22136] (default)
[qa-hooks] CDP discovery: effective ports [22137, 22138] (from QA_DEBUG_CDP_PORTS)
[qa-hooks] CDP discovery: effective ports [22135] (from QA_DEBUG_CDP_PORTS partial — invalid entries warned above)
```

Discovery logic in `qaAfterEachImpl`:
```
1. parallel probe each port in effectiveCdpPorts():
     GET http://localhost:<port>/json/version  (timeout 500ms, AbortSignal.timeout)
     GET http://localhost:<port>/json/list     (timeout 500ms)
   each successful probe → push to available_chromes[]
2. publish pause with:
     available_chromes (may be empty)
     selected_cdp_port: null
     chrome_owner: 'framework'     (G5 — set at publish; Mode C is always framework-owned)
```

`cdp_ws_url` is NOT on wire (derived view-side). `mode` field DELETED from wire (replaced by `chrome_owner`).

**No QA_DEBUG_CDP_WS_URL anywhere**. Extension session-manager.ts:218 removes the env injection. qa-hooks does NOT read this env. Migration startup warning per §"Migration / rollback".

### 3.2 PausePayload schema (G4 expanded migration + G5 chrome_owner lifecycle)

`mocha-hooks/src/protocol.ts` — new wire shape:

```ts
PausePayload {
  test: string,                  // unchanged
  full_title: string,            // unchanged
  file: string | null,           // unchanged
  line: number | null,           // unchanged
  error: SerializedError,        // unchanged
  started_at: number,            // unchanged
  retry_count: number,           // unchanged

  // NEW: discovery result, always present (may be empty array)
  available_chromes: Array<{
    port: number,
    ws_url: string,        // normalized 0.0.0.0→127.0.0.1
    page_titles: string[], // up to 5 from /json/list
  }>,

  // NEW: selection state, always null on publish; mutated by qa_select_chrome via pause-store
  selected_cdp_port: number | null,

  // NEW: lifecycle ownership; always 'framework' for Mode C (this PLAN's only mode)
  chrome_owner: 'framework' | 'companion',

  // REMOVED: cdp_ws_url, mode (was BrowserOwnershipMode)
}
```

`pause-store-types/src/index.ts` mirrors the wire shape PLUS keeps stored-only fields. Stored shape extends wire with: `session_id`, `failing_assertion`, `stack_trace`, `cdp_ws_url` (derived; nullable), `screenshot_path?`, `console_logs: { lines, bytes, more_at? }`, `paused_at_ms`, `max_retries_remaining`, `test_title`. All existing v5.5+ fields preserved.

`toFailureContextView` (pause-store-types/src/index.ts:105) computes derived `cdp_ws_url`:
```ts
const selected = active.selected_cdp_port == null
  ? null
  : active.available_chromes.find((c) => c.port === active.selected_cdp_port);
const cdpWsUrl = selected?.ws_url ?? null;
// View carries cdp_ws_url even when null — agent's tool description reads this signal.
```

`FailureContextView` interface (line 59-76 today) — `cdp_ws_url: string | null` (was non-null). `available_chromes` + `selected_cdp_port` ADDED to view so tool description's 3-branch logic can read them.

### Migration normalization (G4 expanded)

Three pre-upgrade stored-pause shapes coexist in `MementoPauseStore`. `normalizePausePayload(raw: unknown): PausePayload` in pause-store-types/src/index.ts runs before zod parse. Migration table:

| Pre-upgrade shape detected | Normalization rule |
|---|---|
| `{ ..., mode: 'A', cdp_ws_url: <ws://...> }` | Parse port from `cdp_ws_url` (regex `ws://[^:/]+:(\d+)/`). Result: `available_chromes: [{ port: <parsed>, ws_url: <original>, page_titles: [] }]`. `selected_cdp_port: <parsed>`. `chrome_owner: 'framework'`. Strip `mode` field. Preserve ALL other fields (`full_title`, `console_logs.bytes`, `max_retries_remaining`, `screenshot_path`, `failing_assertion`, `stack_trace`, etc.). |
| `{ ..., mode: 'B', cdp_ws_url: 'ws://localhost:9222/...' }` | Same parse rule. `chrome_owner: 'companion'`. (No companion in Mode C scope, but legacy reader preserves the value so propose_close_browser's "companion" branch handles it correctly during retention period.) |
| `{ ..., cdp_ws_url: 'ws://...' }` (no `mode` field, v5.1 or earlier) | Same as `mode === 'B'` branch (default to companion-owned). |
| `{ ... }` with `available_chromes` already present | No migration needed; already new shape. |
| Anything else (no `cdp_ws_url` AND no `available_chromes`) | `available_chromes: []`, `selected_cdp_port: null`, `chrome_owner: 'framework'`, derived `cdp_ws_url: null`. View label: "stale pause — re-run test". |

Normalizer is defensive: NEVER throws. If `cdp_ws_url` parse fails (no port match), fall through to "anything else" branch.

**H4 — pure-package contract** (I1 return-type fix):
```ts
normalizePausePayload(raw: unknown): { payload?: PausePayload; diagnostics: string[] }
```
- `raw == null` (or `undefined`, or empty) → returns `{ payload: undefined, diagnostics: [] }`. Signals "no active pause" — NOT an error. Caller treats undefined as "no pause to surface". This is the common branch on first Memento read before any pause has occurred.
- `raw` present + matches new shape → returns `{ payload: <typed>, diagnostics: [] }`. No migration needed.
- `raw` present + matches a legacy shape → returns `{ payload: <migrated>, diagnostics: [<migration notes>] }`.
- `raw` present + malformed (no migration branch matches AND zod parse would fail) → returns `{ payload: undefined, diagnostics: [<corruption notes>] }`. Caller logs and treats as no active pause (stale/corrupt entry; user re-runs test).

Function is pure: NO logger imports, NO side effects, NO throws. The MementoPauseStore reader (`extension/src/pause-store.ts`) and the InMemoryPauseStore reader (`qa-debug-mcp/src/pause-store.ts`) each wire their own logger to consume `diagnostics`.

### 3.3 propose_close_browser refactor (G5 chrome_owner branching)

`extension/src/lm-tools/propose-close-browser.ts:62-72` — branch on `active.chrome_owner`:

```
if (active.chrome_owner === 'framework') → decline with reason "framework owns lifecycle; close via your framework's teardown"
if (active.chrome_owner === 'companion') → proceed with proposal flow (existing semantics for legacy migrated pauses)
```

Note: under Mode C (this PLAN's only mode), `chrome_owner` is always `'framework'`. The `'companion'` branch exists ONLY to handle migrated legacy `mode:'B'` pauses on disk. After all legacy pauses are resumed/cleared, the companion branch becomes dead code — deletion deferred to a future PLAN.

`qa-debug-mcp/src/server.ts` (stdio path) — mirror the same `chrome_owner === 'framework'` decline branch where the existing Mode A branch lives.

`extension/src/chat-participant.ts:75` — Mode A note → framework-owner note.

`tool-contracts/src/tools.ts:231` — `qa_propose_close_browser.description` Mode A note → framework-owner note.

### 3.4 Diagnostic logging mandate

qa-hooks emits to stderr at first afterEach (cached after first emit per process):

```
[qa-hooks] CDP discovery: effective ports [<list>] (default | from QA_DEBUG_CDP_PORTS)
[qa-hooks] CDP discovery: probe results — found N chromes at ports [<found list>], failed at [<failed list>]
[qa-hooks] CDP discovery: WARN no chromes responded — extension and agent must askUser for ports
```

Per-port WARN on probe failure:
```
[qa-hooks] WARN /json/version probe failed for port=22135: <error>; marking unavailable
```

Extension Output Channel emits selection events:
```
[session-manager] chrome selection committed: session=<id> port=22135 source=agent|extension-ui|auto
[session-manager] mcpProvider.setPaused endpoint=<http_root> port=22135
```

## Touch points

### 3.5 mocha-hooks/src/qa-hooks.ts

| Lines | Action |
|---|---|
| 47-130 | Delete `installWdioPatch` IIFE + `currentBrowser` state + `WdioBrowserLike` interface. |
| New top-of-file | Add `DEFAULT_CDP_PORTS` const + `effectiveCdpPorts()` helper + `probeChromePort(port, timeoutMs)` helper + v5.16 banner. |
| 403-426 | Replace Mode A/B branching with: probe `effectiveCdpPorts()`, build `available_chromes`, set `selected_cdp_port: null`, set `chrome_owner: 'framework'`. |

### 3.6 mocha-hooks/src/protocol.ts

| Lines | Action |
|---|---|
| 19-20 | DELETE `BrowserOwnershipMode` enum. |
| 22-50 | Replace `cdp_ws_url` + `mode` fields with `available_chromes` + `selected_cdp_port` + `chrome_owner`. |

### 3.7 pause-store-types/src/index.ts

| Lines | Action |
|---|---|
| 18-24 | Replace `BrowserOwnershipMode` jsdoc with `chrome_owner: 'framework' | 'companion'` type. |
| 26-48 (PausePayload) | Match wire shape per §3.2 — drop `cdp_ws_url`, drop `mode`, add `available_chromes`, `selected_cdp_port`, `chrome_owner`. Keep ALL v5.5+ fields. |
| 59-76 (FailureContextView) | `cdp_ws_url: string | null`. Add `available_chromes`, `selected_cdp_port` for tool branching. |
| 105+ (toFailureContextView) | Compute derived `cdp_ws_url` per §3.2. |
| New export | `normalizePausePayload(raw: unknown): { payload?: PausePayload; diagnostics: string[] }` per migration table §3.2 (J1 — optional payload represents absent-Memento-key + malformed-entry cases). Pure function — caller logs diagnostics (H4). |
| New PauseStore type | `type ChromeSelectionSource = 'agent' \| 'extension-ui' \| 'auto';` and `interface ChromeSelection { session_id: string; port: number; cdp_ws_url: string; page_titles: string[]; source: ChromeSelectionSource; }` — resolved selection passed through events AND returned from `recordChromeSelection`. The `source` field feeds the §3.4 diagnostic log (I4). |
| New PauseStore method | `recordChromeSelection(sessionId: string, port: number, source: ChromeSelectionSource): Promise<ChromeSelection>` — validates port in `available_chromes`, persists selection (awaits Memento `update` on MementoPauseStore; immediate on InMemoryPauseStore), fires `onChromeSelected` AFTER persistence resolves, then returns the ChromeSelection. Callers pass `'agent'` from LM/MCP tool path, `'extension-ui'` from QuickPick/InputBox path, `'auto'` from session-manager's length===1 auto-select. Callers MUST await before reading derived state. |
| New PauseStore method | `replaceAvailableChromes(sessionId: string, chromes: AvailableChrome[]): Promise<{ cleared: boolean }>` — used by `qa_discover_chromes`; awaits persistence; clears `selected_cdp_port` AND fires `onChromeDeselected(sessionId)` IFF the prior selection's port is not in the new list (G7, H3). Returns `{ cleared: true }` when selection was cleared. |
| New PauseStore event | `onChromeSelected(callback: (selection: ChromeSelection) => void): Disposable` — fires with full resolved selection payload (H1) including `source`. session-manager subscribes (per §3.18) and uses event payload directly. |
| New PauseStore event | `onChromeDeselected(callback: (sessionId: string) => void): Disposable` (H3) — fires when `replaceAvailableChromes` clears a stale selection. session-manager subscribes and unregisters `mcpProvider` for that session. |
| Implementations | EXISTING files modified (I2): `extension/src/pause-store.ts` (MementoPauseStore class — uses `vscode.EventEmitter`, awaits `Memento.update`) AND `qa-debug-mcp/src/pause-store.ts` (InMemoryPauseStore class — Node `EventEmitter`, synchronous persist). NO new parallel files. Async fire-after-persist contract identical between the two impls. |

### 3.8 extension/src/lm-tools/propose-close-browser.ts

| Lines | Action |
|---|---|
| 14-29 | Rewrite header to reference runtime-gated selection contract. |
| 62-72 | Branch on `active.chrome_owner === 'framework'` (replaces `mode === 'A'`). |

### 3.9 qa-debug-mcp/src/server.ts

Apply equivalent `chrome_owner` decline branch where Mode A branch lives. ALSO register `qa_discover_chromes` and `qa_select_chrome` tools (mirror the LM-tool implementations against the same `pauseStore` interface).

### 3.10 extension/src/chat-participant.ts

| Lines | Action |
|---|---|
| 75 | Mode A note → framework-owner note. |

### 3.11.0 tool-contracts/src/tools.ts — JsonSchemaProp extension (H5)

Current `JsonSchemaProp` interface at `tool-contracts/src/tools.ts:25-29` supports only scalar `'string' | 'number' | 'boolean'`. New `qa_discover_chromes` tool needs `ports: number[]` (array of integers). Extend the interface:

```ts
export interface JsonSchemaProp {
  type: 'string' | 'number' | 'boolean' | 'array';
  enum?: string[];
  description?: string;
  // NEW for array type — required when type === 'array'
  items?: { type: 'string' | 'number' | 'boolean'; minimum?: number; maximum?: number };
  // NEW for array type — element count bounds
  minItems?: number;
  maxItems?: number;
}
```

The JSON-schema output passed to MCP clients now correctly describes `{type: 'array', items: {type: 'number', minimum: 1024, maximum: 65535}, minItems: 1, maxItems: 8}`. Zod schema on the same tool already enforces the same constraints via `z.array(z.number().int().min(1024).max(65535)).min(1).max(8)` — keep both in sync.

### 3.11 tool-contracts/src/tools.ts — existing tool updates

| Tool | Action |
|---|---|
| `qa_propose_close_browser` | Description Mode A note → framework-owner note. |
| `qa_get_failure_context` | Description rewritten per §3.13 (runtime-gated 3-branch). |
| All `qa_propose_*` and `qa_request_*` | NO optional `cdp_port` param (reverses iter#2 spec). Tools read `selected_cdp_port` from active pause; if null and the tool needs a browser, surface `BROWSER_NOT_SELECTED` error. (Currently only propose_close_browser needs the browser at all; other tools are decision/proposal flow and don't connect to chrome.) |

### 3.12 NEW tool: `qa_discover_chromes` (G3 session_id, G7 rediscovery, G8 readOnly)

```ts
export const qa_discover_chromes: QaToolDef<{ session_id: string; ports: number[] }> = {
  name: 'qa_discover_chromes',
  description:
    'Re-probes a user-supplied list of ports for active Chrome CDP endpoints, then replaces the ' +
    'current pause\'s available_chromes with the result. ' +
    'Use when qa_get_failure_context.available_chromes is empty (defaults unreachable) OR when ' +
    'the previously-selected Chrome appears dead (e.g., playwright-mcp returns "target closed"). ' +
    'Callers MUST ask the user for the port list — do NOT guess or scan. ' +
    'Side-effects on the active pause: REPLACES available_chromes; CLEARS selected_cdp_port IFF ' +
    'the prior selection\'s port is not present in the new list. Callers must call qa_select_chrome ' +
    'after this tool to commit a selection. ' +
    'Idempotent: calling twice with same ports yields same available_chromes result. ' +
    'Returns: { available_chromes: [{port, ws_url, page_titles}, ...] }. ' +
    'Errors: NO_ACTIVE_PAUSE (session_id stale); INVALID_PORT (any port outside 1024-65535); ' +
    'NO_CHROMES_FOUND (none of the supplied ports responded — re-ask the user or surface the framework launch failure).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Active pause session_id from qa_get_failure_context.' },
      ports: {
        type: 'array',
        items: { type: 'number', minimum: 1024, maximum: 65535 },
        minItems: 1,
        maxItems: 8,
        description: 'Integer port numbers (1024-65535).',
      },
    },
    required: ['session_id', 'ports'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    ports: z.array(z.number().int().min(1024).max(65535)).min(1).max(8),
  }),
  annotations: {
    readOnlyHint: false,         // G8 — mutates pause-store
    destructiveHint: false,
    idempotentHint: true,        // same ports → same result
    openWorldHint: true,         // HTTP fetches localhost; outside qa-debug closed world
  },
};
```

### 3.12.5 NEW tool: `qa_select_chrome` (G3 session_id)

```ts
export const qa_select_chrome: QaToolDef<{ session_id: string; port: number }> = {
  name: 'qa_select_chrome',
  description:
    'Commits the chosen Chrome from available_chromes as the pause\'s active browser. ' +
    'After this tool returns, qa_get_failure_context will surface cdp_ws_url populated with the ' +
    'selected chrome\'s URL, and the extension/agent will register playwright-mcp against it. ' +
    'Until this commits, cdp_ws_url is null and playwright-mcp is NOT registered. ' +
    'If available_chromes.length === 1 you may select that port without asking the user. ' +
    'If length >= 2, ask the user which chrome (use page_titles for context) and call with their pick. ' +
    'Idempotent within a pause: calling twice with different ports replaces the selection and ' +
    're-registers playwright-mcp at the new endpoint. ' +
    'Returns: { cdp_ws_url, page_titles }. ' +
    'Errors: NO_ACTIVE_PAUSE; INVALID_PORT (port not in current available_chromes — call qa_discover_chromes first if framework rev\'d ports).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Active pause session_id from qa_get_failure_context.' },
      port: { type: 'number', description: 'Port from available_chromes[].port (the user\'s pick).' },
    },
    required: ['session_id', 'port'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    port: z.number().int().min(1024).max(65535),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
```

Implementation surface:
- `extension/src/lm-tools/select-chrome.ts` — validates port in `pauseStore.getActivePause(session_id).available_chromes`, calls `pauseStore.recordChromeSelection(session_id, port, 'agent')`, returns ws_url + page_titles.
- `extension/src/lm-tools/discover-chromes.ts` — same pattern; calls `pauseStore.replaceAvailableChromes(session_id, probed)` then computes whether selection was cleared.
- `qa-debug-mcp/src/server.ts` — mirror both.
- Shared helper `extension/src/lm-tools/probe-ports.ts` exports `probePorts(ports: number[]): Promise<AvailableChrome[]>` — used by LM tool, MCP tool, and extension UI command (§3.14).

### 3.13 `qa_get_failure_context` description — runtime-gated branching

Rewrite description in `tool-contracts/src/tools.ts`:

> When invoking this tool, inspect the returned `available_chromes` array AND `selected_cdp_port`:
>
> - If `selected_cdp_port` is non-null AND `cdp_ws_url` is non-null: selection is already committed (likely by extension auto-select or extension UI button). You may pass `cdp_ws_url` to `playwright-mcp:browser_connect`. No selection action needed.
> - If `selected_cdp_port` is null AND `available_chromes.length === 1`: call `qa_select_chrome(session_id, available_chromes[0].port)` — no user confirmation needed.
> - If `selected_cdp_port` is null AND `available_chromes.length >= 2`: STOP and ask the user in chat which Chrome to use. Surface `page_titles` per option (e.g., "Port 22135 (Login page) or 22136 (Dashboard)?"). Then call `qa_select_chrome` with their pick.
> - If `selected_cdp_port` is null AND `available_chromes.length === 0`: STOP and ask: "I couldn't find Chrome at the default debug ports. What port(s) does your test framework launch Chrome on?" Call `qa_discover_chromes(session_id, [user-ports])`; loop back into this branching with the updated state.
>
> Runtime gate: until selection commits, `cdp_ws_url` is null AND the extension has NOT registered playwright-mcp. Calling `playwright-mcp:browser_connect` with a null URL or before registration will fail. The instructions above are the path through the gate.

### 3.14 askUser flow — extension input box / QuickPick at pause receipt

Per §3.18 ordering, session-manager subscribes to pause-store's selection event and gates `mcpProvider.setPaused` on that event. The pause-status-bar / notification UI surface SELECTS the user before that event fires:

`extension/src/session-manager.ts` (after pause receipt at line ~290):

```ts
// Branch on available_chromes.length to decide selection UX
if (stored.available_chromes.length === 1) {
  // Auto-select — fires onChromeSelected, mcpProvider.setPaused via §3.18
  try {
    await this.deps.pauseStore.recordChromeSelection(sessionId, stored.available_chromes[0].port, 'auto');
  } catch (err) {
    appendInfo(this.deps.channel, `[session-manager] auto-select failed session=${sessionId}: ${(err as Error).message}`);
    // Pause still surfaces via status-bar; user can retry via [Select Chrome] action.
  }
  appendInfo(channel, `[session-manager] auto-selected single chrome port=${stored.available_chromes[0].port}`);
} else {
  // length 0 or >=2 — wait for user via extension UI or agent
  appendInfo(channel, `[session-manager] pending chrome selection (${stored.available_chromes.length} candidates)`);
}
this.deps.pauseStatusBar.show(sessionId);
```

`extension/src/pause-status-bar.ts` — render branches on selection state at command-trigger time:

| State at pause | Status-bar button | Click action |
|---|---|---|
| selection committed (auto or prior) | "Paused at <test_title>" | (no action; informational) |
| available_chromes.length >= 2, no selection | "Select Chrome" | command `qa-debug.selectChrome` → QuickPick with `{label: 'Port 22135', detail: 'Login page'}` items → `await pauseStore.recordChromeSelection(sessionId, port, 'extension-ui')` (wrapped in try/catch — on rejection, surface `vscode.window.showErrorMessage` and keep status-bar action available for retry) |
| available_chromes.length === 0, no selection | "Enter Chrome ports" | command `qa-debug.enterChromePorts` → InputBox `prompt: 'Chrome debug ports (comma-separated)', placeholder: '22135, 22136'` → call shared `probePorts(parsed)` → `pauseStore.replaceAvailableChromes` → retry status-bar branching |

New extension command ids: `qa-debug.selectChrome`, `qa-debug.enterChromePorts`. Both registered in extension/src/extension.ts activate hook.

### 3.15 Fixture tests — chrome-launcher dep + spike location

`fixture-tests-wdio/package.json` — add devDependencies:

```json
"devDependencies": {
  "@types/mocha": "^10.0.10",
  "@types/node": "^22.10.0",
  "chrome-launcher": "^1.0.0",    // NEW (fixture chrome launch)
  "chromedriver": "^148.0.4",
  "mocha": "^10.7.3",
  "puppeteer-core": "^21.0.0",    // NEW (spike second CDP attacher)
  "webdriverio": "^8.40.6"
}
```

Add scripts entry:
```json
"scripts": {
  "test": "mocha",
  "spike": "mocha spike/cdp-coexistence.spec.js"
}
```

Fixture changes:
- Existing `wdio.remote()` specs at `fixture-tests-wdio/specs/*.js` → before(all) hook launches chrome at port 22135 via chrome-launcher, then wdio attaches via `debuggerAddress`.
- Second variant: launches chrome at 22135 + 22136 (multi-chrome path).
- Third variant: launches chrome at 23000 (outside defaults; askUser path).
- Spike file `fixture-tests-wdio/spike/cdp-coexistence.spec.js` per §"Pre-implementation spike".

### 3.16 ARCHITECTURE.md / CR docs / live PLAN docs (H6)

| File | Line | Action |
|---|---|---|
| `ARCHITECTURE.md` | 101 | Replace `cdp_ws_url: process.env.QA_DEBUG_CDP_WS_URL ?? 'ws://localhost:9222',` with the new shape: discovery via `effectiveCdpPorts()` produces `available_chromes`; `cdp_ws_url` derived after `qa_select_chrome` commits. Cite this PLAN. |
| `PLAN-mcp-cdp-wire.md` | top of file | Add deprecation banner: "Superseded by `PLAN-cdp-port-discovery.md` (2026-05-22). `QA_DEBUG_CDP_WS_URL` references in this file no longer reflect production code path." |
| `PLAN-mcp-cdp-wire.md` | 63, 71 | NB-only — leave the historical wording but the banner makes the supersession clear without rewriting paragraphs the iter#5 reviewer can re-verify. |
| `ARCHITECTURE-CR-v5.2.md` through `v5.14.md` | top of each | Banner pointing to this PLAN: "Mode A and the wdio.remote() monkey-patch described here are removed in `PLAN-cdp-port-discovery.md` (2026-05-22)." |
| `ARCHITECTURE-CR-v5.16-cdp-discovery.md` | — | Full CR DEFERRED until after implementation + smoke per [[feedback-ralph-loop-scope]] (code-level fix → PLAN, full CR after). |

§3.1 claim "no `QA_DEBUG_CDP_WS_URL` anywhere" now holds for production code AND live (non-historical) doc paths after these edits. Historical CR-v5.2 etc. retain their original wording behind the deprecation banner — that's documentation history, not live spec.

### 3.17 (deleted in iter#4)

Partial-pass spike contingency removed per G6 — VS Code MCP gate doesn't filter individual tools, so "read-only playwright-mcp" mode isn't implementable in scope.

### 3.18 NEW — mcpProvider gate refactor (G2 load-bearing)

Current code path that must change (`extension/src/session-manager.ts:277-289`):

```ts
// BEFORE (current):
connection.handle(METHOD.pausePublish, async (raw) => {
  const wire = WirePausePayload.parse(raw);
  const sessionId = `s4-${randomUUID()}`;
  const stored = wireToStored(wire, sessionId);
  await this.deps.pauseStore.setActivePause(stored);
  await vscode.commands.executeCommand('setContext', 'qa-debug.paused', true);
  await refreshPausedTestIdsContext(this.deps.pauseStore);
  const mcpEndpoint = cdpWsUrlToHttpRoot(wire.cdp_ws_url);   // ← derives from wire (no longer there)
  this.deps.mcpProvider.setPaused(mcpEndpoint);              // ← fires too early
  ...
});

// AFTER:
connection.handle(METHOD.pausePublish, async (raw) => {
  const wire = WirePausePayload.parse(raw);                  // wire shape per §3.2 — no cdp_ws_url
  const sessionId = `s4-${randomUUID()}`;
  const stored = wireToStored(wire, sessionId);              // stored.cdp_ws_url derived → null at this point
  await this.deps.pauseStore.setActivePause(stored);
  await vscode.commands.executeCommand('setContext', 'qa-debug.paused', true);
  await refreshPausedTestIdsContext(this.deps.pauseStore);
  // mcpProvider.setPaused NOT called here — gated on selection
  // Auto-select if length===1 OR rely on user via §3.14
  if (stored.available_chromes.length === 1) {
    try {
    await this.deps.pauseStore.recordChromeSelection(sessionId, stored.available_chromes[0].port, 'auto');
  } catch (err) {
    appendInfo(this.deps.channel, `[session-manager] auto-select failed session=${sessionId}: ${(err as Error).message}`);
    // Pause still surfaces via status-bar; user can retry via [Select Chrome] action.
  }
  }
  ...
});

// Constructor wires the event subscriptions once. NEVER re-reads active.cdp_ws_url —
// uses event payload directly per H1/H2.
constructor(deps) {
  ...
  this.deps.pauseStore.onChromeSelected((selection: ChromeSelection) => {
    const mcpEndpoint = cdpWsUrlToHttpRoot(selection.cdp_ws_url);
    this.deps.mcpProvider.setPaused(mcpEndpoint);
    appendInfo(
      this.deps.channel,
      `[session-manager] mcpProvider.setPaused endpoint=${mcpEndpoint} port=${selection.port} session=${selection.session_id}`,
    );
  });

  this.deps.pauseStore.onChromeDeselected((sessionId: string) => {
    // Stale chrome (e.g., killed mid-pause); unregister playwright-mcp until reselection.
    this.deps.mcpProvider.clearPaused();   // MCPProvider gains clearPaused() — adjust if shape differs
    appendInfo(
      this.deps.channel,
      `[session-manager] mcpProvider.clearPaused (selection cleared by replaceAvailableChromes) session=${sessionId}`,
    );
  });
}
```

Selection events fire from EXACTLY ONE pair of places:
- `recordChromeSelection` AFTER awaited persistence → fires `onChromeSelected(payload)`
- `replaceAvailableChromes` when prior selection's port is not in new list, AFTER awaited persistence → fires `onChromeDeselected(sessionId)`

Both LM tool path AND extension UI path reach the same methods. Event payloads carry all data session-manager needs; session-manager NEVER reads `active.cdp_ws_url` or other derived state — fixes the race window where Memento `update` was queued but not yet visible via `get` (H2).

`mcpProvider.setPaused` is ALSO called on re-selection (different port for the same pause): the second `recordChromeSelection` awaits persistence, fires a fresh `onChromeSelected(new_selection)` → session-manager re-registers at new endpoint. Implementor verifies `MCPProvider.setPaused` is idempotent under repeated calls with different endpoints; if not, adds the necessary unregister-before-register sequence inside `MCPProvider`. Same applies to `clearPaused` — implementor adds this method to `MCPProvider` class if not already present.

## Sequence diagram

```
T0   User → click "Run Test" in Test Explorer
T1   Extension spawn mocha child (env has QA_DEBUG_CDP_PORTS if override set; QA_DEBUG_CDP_WS_URL no longer injected)
T2   mocha boot: --require qa-hooks → addFile(framework) → framework spawns chrome :22135, :22136
                                     → wdio.remote attaches via debuggerAddress
T3   Specs run
T4   Test FAIL → afterEach
─────────────────────────────────────── qa-hooks Discovery
T5   parallel probe effectiveCdpPorts() via /json/version + /json/list
T6   build available_chromes, selected_cdp_port: null, chrome_owner: 'framework'
T7   pause.publish IPC → extension  [BLOCK on decision.await]
─────────────────────────────────────── extension session-manager (§3.18)
T8   setActivePause(stored) — cdp_ws_url derived to null
T9   if available_chromes.length === 1 → recordChromeSelection immediately (auto)
                                       → onChromeSelected fires → mcpProvider.setPaused
T10  pause-status-bar shows correct UI per §3.14 table
─────────────────────────────────────── selection (either path)
                            PATH A (extension UI)                    PATH B (agent chat)
T11A  User clicks status-bar button       T11B  User opens Copilot Chat
T12A  QuickPick or InputBox surfaces       T12B  Agent → qa_get_failure_context
T13A  User picks port / enters ports        T13B  Agent reads available_chromes, selected_cdp_port
T14A  → pauseStore.recordChromeSelection    T14B  Branch per §3.13:
       (or replaceAvailableChromes for       len 1 → qa_select_chrome auto
        InputBox path, then auto-select      len ≥2 → ask user → qa_select_chrome
        on length===1)                       len 0 → ask user → qa_discover_chromes → loop
T15A onChromeSelected fires                 T14B-end onChromeSelected fires
─────────────────────────────────────── post-selection (single funnel)
T15   mcpProvider.setPaused(http_root)
T16   playwright-mcp registered against http_root
T17   Agent → playwright-mcp browser_connect → ATTACH HERE
T18   browser_snapshot / browser_navigate / browser_console_messages / ...
T19   User + agent decide → qa_request_retry / qa_request_give_up / qa_propose_*
T20   decision.await resolves → afterEach returns → mocha next test
```

## Open questions

### Q1 — RESOLVED (iter#2) — multi-port array + runtime-gated selection
### Q2 — HTTP fetch timeout
500ms default. Reviewer: confirm or propose 200ms.
### Q3 — RESOLVED (iter#3) — subsumed by Pre-implementation spike
### Q4 — RESOLVED (iter#3) — normalizeCdpWsUrl applied to every available_chromes entry
### Q5 — RESOLVED (iter#3, hardened iter#4) — runtime-gated selection via qa_select_chrome + mcpProvider gate refactor (§3.18)
### Q6 — RESOLVED (iter#3, simplified iter#4) — spike Pass/Fail only; Partial folded into Fail
### Q7 — RESOLVED (iter#3) — QA_DEBUG_CDP_PORTS env override

## Migration / rollback

- Wire-breaking: `PausePayload` shape changes per §3.2. Mocha child + extension parent ship as one vsix; no version skew possible.
- On-disk: pre-upgrade `MementoPauseStore` entries handled by `normalizePausePayload` per §3.2 migration table. Three migration branches cover legacy A, legacy B/no-mode, and missing-field cases.
- Env: `QA_DEBUG_CDP_WS_URL` env var DELETED. Touch `extension/src/session-manager.ts:218` to remove the injection. Touch `extension/src/extension.ts` activate to warn ONCE if the env was set in `process.env` at startup ("`QA_DEBUG_CDP_WS_URL` no longer honored; set `QA_DEBUG_CDP_PORTS` instead").
- Rollback: revert PLAN's commits. New shape's extra fields are dropped (legacy zod schema rejects extras as strict — implementer verifies and adds `.passthrough()` if strict mode catches the extras during rollback round-trip).

## Diagnostic deliverable (CR §4 test plan)

Six smoke paths.

**Path 1 — Single-chrome happy**
1. Fixture launches chrome at port 22135 only.
2. Trigger deterministic-fail test.
3. Output Channel: `[qa-hooks] CDP discovery: probe results — found 1 chromes at ports [22135], failed at []`.
4. PausePayload wire: `available_chromes.length === 1`, `selected_cdp_port: null`, `chrome_owner: 'framework'`.
5. Extension auto-selects on receipt (§3.18 inline auto-select). pause-store: `selected_cdp_port: 22135`.
6. session-manager logs: `[session-manager] mcpProvider.setPaused endpoint=http://127.0.0.1:22135 port=22135`.
7. Agent's `qa_get_failure_context` shows `cdp_ws_url` populated, attaches via playwright-mcp.

**Path 2 — Multi-chrome via agent**
8. Fixture launches chrome at 22135 + 22136.
9. PausePayload `available_chromes.length === 2`, no auto-select.
10. mcpProvider.setPaused NOT called yet (verify Output Channel absence).
11. Agent → `qa_get_failure_context` → produces chat message with both ports + page_titles.
12. User reply with one port → agent calls `qa_select_chrome(session_id, port)`.
13. session-manager logs setPaused for chosen port.
14. playwright-mcp attaches.

**Path 2b — Multi-chrome via extension QuickPick**
15. Same setup as path 2.
16. User clicks `[Select Chrome]` status-bar BEFORE opening chat.
17. QuickPick shows both options with page_titles in `detail`.
18. Pick → pause-store updated → setPaused fires.
19. User opens chat → `qa_get_failure_context.cdp_ws_url` already populated.

**Path 3 — Empty-chromes via input box**
20. Fixture launches chrome at port 23000 only.
21. PausePayload `available_chromes === []`.
22. Status bar shows `[Enter Chrome ports]` button at pause receipt.
23. User clicks → input box prompts → user enters "23000".
24. Extension calls shared `probePorts([23000])` → result has 1 entry.
25. Auto-selection → setPaused fires.

**Path 4 — Chrome dies mid-pause (G7 rediscovery semantics)**
26. Path 1 setup + steps 1-7 (chrome selected, playwright-mcp attached).
27. After agent attaches, kill chrome process while pause is held (`kill -9 <pid>`).
28. Agent's next `browser_snapshot` fails (playwright-mcp surfaces "target closed").
29. Agent (per error response) re-issues `qa_get_failure_context` → returns `cdp_ws_url` STILL populated with stale UUID (selection state unchanged). Agent reads response + the failed playwright-mcp call → recognizes staleness.
30. Agent calls `qa_discover_chromes(session_id, [22135])` to re-probe.
31. Result `available_chromes === []` (chrome dead). `replaceAvailableChromes` triggers G7 selection clear since prior port 22135 not in new list. `onChromeDeselected` fires.
32. session-manager unregisters playwright-mcp.
33. `qa_get_failure_context` now returns `cdp_ws_url: null`, `available_chromes: []`.
34. Agent enters askUser path (§3.13 length===0 branch).
35. Verify pause does NOT crash extension; pause-store integrity preserved; agent path recovers.

**Path 5 — Invalid ports to qa_discover_chromes (F8 NEW iter#3, refined iter#4)**
36. Path 3 setup + step 20.
37. Agent calls `qa_discover_chromes({ session_id, ports: [22, 99999] })` (both invalid: < 1024 and > 65535).
38. Zod validation fails at tool input parse → tool returns `INVALID_PORT` error to agent.
39. Agent reads error → re-asks user with clarification "ports must be 1024-65535".

**Path 6 — Multiple test failures (G10 falsifiable)**
40. Fixture: 3 deterministic-fail tests, chrome at 22135 + 22136.
41. Run all 3 sequentially (no parallel).
42. Assertions:
    - Exactly 3 `pause.publish` IPC envelopes observed in session-manager log (`[session-manager] pause.publish received session=s4-<uuid>` × 3 distinct uuids).
    - Each pause has independent `available_chromes`, `selected_cdp_port` cleared between pauses (verify via Output Channel dumps).
    - No single Test identity (mocha Test object, identified by `full_title`) produces more than 1 pause within its own attempt (proves WeakSet dedupe at qa-hooks.ts:44-45 works).
    - Audit log contains exactly 3 `PAUSE` entries with distinct session_ids.
    - Resume each pause (`qa_request_give_up`) before the next fires; no cross-pause state leakage.

Implementer attaches:
- Output Channel transcripts per path
- Chat transcripts (paths 2, 3, 4, 5)
- Status-bar screenshots (paths 2b, 3)
- playwright-mcp connection state (paths 1, 2, 2b, 3, 4)
- session-manager logs showing mcpProvider.setPaused timing relative to selection (paths 1, 2, 2b, 3, 4)
- Spike artifact (§"Pre-implementation spike") with `Pass` verdict

Conforms to [[verify]] mandate.
