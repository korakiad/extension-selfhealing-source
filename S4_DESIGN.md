# S4 Design — Extension activation, provider gating, UI commits

> Companion to `ARCHITECTURE.md` v5.1 (APPROVED 2026-05-21) and `SLICE_PLAN.md` v5 §S4. Subject to Ralph-loop reviewer pass before any code lands. Standing rules from `ARCHITECTURE.md` §0 apply: every capability claim cites either repo-local source (file:line) or a WebFetched URL on the platform's own domain; agentic-design claims cite Anthropic-owned sources only.
>
> Status: **Iteration #3 draft 2026-05-21**, applies reviewer #2 findings (3 polish-class issues mislabeled "blocking" + 9 non-blocking). Iteration #2 applied reviewer #1's 6 blockers + 11 non-blockers + closed Q1–Q6. Change tags: **[R#2-Bn]** / **[R#2-NBn]** = iteration-2 fixes (preserved); **[R#3-Bn]** / **[R#3-NBn]** = iteration-3 fixes (this iteration).
>
> Scope: S4 only — extension activation, McpServerDefinitionProvider gating, Mocha child + Chrome lifecycle, Test Explorer integration, UI-committed propose verbs, retry respawn. **Not in scope:** SKILL.md body (S5), real-agent E2E (S6).

---

## 0. Sources

### Capability sources (per ARCHITECTURE v5 §0.1)

VS Code TypeScript API surface — direct quotes from `node_modules/.pnpm/@types+vscode@1.120.0/node_modules/@types/vscode/index.d.ts` (the resolved version pinned in the workspace via `node_modules/.pnpm/`). **[R#2-B3]** S4 raises `extension/package.json`'s `engines.vscode` floor from `^1.95.0` to `^1.120.0` so the engines declaration matches the cited type surface verbatim per ARCH §0.1. Rationale: WebFetched VS Code release notes for v1.101 (May 2025), v1.103 (Jul 2025), v1.106 (Oct 2025), v1.110 (Feb 2026), and v1.120 (May 2026) do not surface the `McpServerDefinitionProvider` API in their release-note bodies, so we cannot identify the actual landing version from release notes alone. The d.ts at 1.120.0 is the proven floor where the API exists; relaxing it requires a follow-up verification pass against the actual API-landing release notes and can be done post-S4. (Open follow-up tracked in §13 footnote.)

- **ExtensionContext / Memento** — vscode.d.ts:8420–8460 (`subscriptions: { dispose }[]`, `globalState: Memento & { setKeysForSync }`, `workspaceState: Memento`) and :8587–8624 (`Memento.get<T>(key, default?)`, `Memento.update(key, value): Thenable<void>`; "value must be JSON-stringifyable" vscode.d.ts:8615 verbatim).
- **TestController** — vscode.d.ts:18451–18582 (`createTestRun(request, name?, persist?)`, `createTestItem(id, label, uri?)`, `createRunProfile`, `invalidateTestResults`, `dispose`).
- **TestRun outcomes** — vscode.d.ts:18650–18743. Six methods only: `enqueued`, `started`, `skipped`, `failed(test, message, duration?)`, `errored(test, message, duration?)`, `passed(test, duration?)`. **No native tri-state for "marked-passed".** Mapping decision in §7.2.
- **TestItem** — vscode.d.ts:18796+ (`id`, `uri`, `range`, `description`, `children`, `parent`).
- **TestMessage** — vscode.d.ts:18913–18983 (`message: string | MarkdownString`, `location?: Location`, `contextValue?: string`, `stackTrace?: TestMessageStackFrame[]`, `static diff(message, expected, actual)`). The `contextValue` enables `testing/message/content` `menus` contribution which renders as "a prominent button overlaying editor content where the message is displayed" (vscode.d.ts:18940 verbatim).
- **MarkdownString** — vscode.d.ts:3012–3088. `isTrusted?: boolean | { enabledCommands }` is the gate for `[Run it](command:myCommandId)` links; "Only *trusted* markdown supports links that execute commands" (vscode.d.ts:3020–3022 verbatim). Per-command allowlist via `isTrusted.enabledCommands` is the safer form.
- **McpStdioServerDefinition** — vscode.d.ts:20427–20470 (class; `label`, `command`, `args: string[]`, `cwd?: Uri`, `env: Record<string, string | number | null>`, `version?`; constructor `(label, command, args?, env?, version?)`). "If this changes, the editor will indicate that tools have changed and prompt to refresh them" (vscode.d.ts:20457–20459 verbatim, on `version`).
- **McpHttpServerDefinition** — vscode.d.ts:20476–20505 (class; `label`, `uri: Uri`, `headers: Record<string, string>`, `version?`; constructor `(label, uri, headers?, version?)`). Editor "make[s] a POST request to this URI to begin each session" (vscode.d.ts:20484 verbatim).
- **McpServerDefinitionProvider** — vscode.d.ts:20518–20552. `onDidChangeMcpServerDefinitions?: Event<void>` is **optional**. `provideMcpServerDefinitions(token: CancellationToken): ProviderResult<T[]>` is called "eagerly to ensure the availability of servers for the language model, and so extensions should not take actions which would require user interaction" (vscode.d.ts:20525–20528 verbatim). `resolveMcpServerDefinition?(server: T, token: CancellationToken): ProviderResult<T>` is called "when the editor needs to start a MCP server" (vscode.d.ts:20536 verbatim) and may return `undefined` to cancel start.
- **`contributes.mcpServerDefinitionProviders`** — example at vscode.d.ts:20821–20831, required shape `{ id: string, label: string }`. `id` is "unique to the extension" (vscode.d.ts:20839 verbatim).
- **`lm.registerMcpServerDefinitionProvider`** — vscode.d.ts:20843, exact signature `(id: string, provider: McpServerDefinitionProvider): Disposable`. Page note (vscode.d.ts:20834–20837 verbatim): "When a new McpServerDefinitionProvider is available, the editor will, by default, automatically invoke it to discover new servers and tools when a chat message is submitted."
- **`code.visualstudio.com/api/extension-guides/ai/mcp`** — WebFetched 2026-05-21, page last-updated 5/20/2026. Confirms the manifest contribution and provider implementation pattern with `didChangeEmitter = new vscode.EventEmitter<void>()` wired to `onDidChangeMcpServerDefinitions: didChangeEmitter.event`.
- **`code.visualstudio.com/api/extension-guides/testing`** — WebFetched 2026-05-21, page last-updated 5/20/2026. Confirms `createTestRun(request)` + `run.passed/failed/end` workflow. The advanced `TestMessage.contextValue` / `MarkdownString.isTrusted` details come from vscode.d.ts not the guide.

MCP SDK — `@modelcontextprotocol/sdk@1.29.0` (the resolved workspace version) `dist/esm/server/streamableHttp.d.ts`:
- :58 `export declare class StreamableHTTPServerTransport implements Transport`.
- :62 constructor signature `constructor(options?: StreamableHTTPServerTransportOptions)`. Stateless mode example at :37–39 (`sessionIdGenerator: undefined`).
- :98 `handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void>` with comment "Handles an incoming HTTP request, whether GET or POST" verbatim. **[R#2-NB1]** the §5.4 wiring honors both GET and POST by routing the auth check before delegating to `handleRequest`.

Mocha v10.8.2:
- ARCH v5 §3.1 already cites `lib/runner.js:825/828` (emission order) and `lib/test.js:71–83` (clone semantics) — reused by S4 §6.4.
- `Mocha.prototype.grep` — `node_modules/.pnpm/mocha@10.8.2/.../lib/mocha.js:564–573`. The function first strips `/.../flag` shell wrapping (`re.match(/^\/(.*)\/([gimy]{0,4})$|.*/)`) then wraps the result in `new RegExp(stripped, flags)`. The regex-escape requirement holds regardless of whether the input arrives wrapped or unwrapped. **[R#2-NB4 / R#3-NB5]** confirmed via local source read; regex escaping in §6.4.1 is therefore real and required.

Node `child_process` — `nodejs.org/api/child_process.html` `child_process.spawn(command, args, options)` with `options.stdio = ['inherit', 'inherit', 'inherit', 'ipc']` per S2's already-working pattern in `tools/oracle.ts`. The IPC channel adapter is in `mocha-hooks/src/protocol.ts:283–305`.

Chrome `--remote-debugging-port=N` — `chromedevtools.github.io/devtools-protocol/` (CDP overview).

`@playwright/mcp` — WebFetched `github.com/microsoft/playwright-mcp` 2026-05-21. CLI flag `--cdp-endpoint <url>` accepts HTTP form `http://localhost:9222`. Package self-identifies as MCP server name `playwright-mcp`.

### Agentic-design sources (per ARCHITECTURE v5 §0.2)

- `anthropic.com/research/measuring-agent-autonomy` (Feb 18, 2026) — "oversight requirements that prescribe specific interaction patterns, such as requiring humans to approve every action, will create friction without necessarily producing safety benefits" verbatim — directly informs §8.3's policy of NOT gating `qa_request_retry` / `qa_request_give_up` through a UI commit (already cited verbatim in ARCH §3.2 R3#D).
- `anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents` (Aug 4, 2025) — read-only-vs-modification framing; "must ask for human approval before taking any actions that modify code or systems" verbatim. Informs the asymmetric gating in §8.3 (and already cited in ARCH §3.2).
- `anthropic.com/research/trustworthy-agents` (Apr 9, 2026) — Plan Mode framing ("intended plan of action up-front"); informs §8.4 propose-then-confirm UX.
- `anthropic.com/engineering/writing-tools-for-agents` (Sep 11, 2025) — supports the agent-side of §7's observation-surface split with the verbatim guidance "tool implementations should take care to return only high signal information back to agents". The corresponding human-side stdout split is not framed in that article and is justified by ARCH §3.6 R4#D's standalone engineering reasoning, not by an Anthropic citation. **[R#3-B2]** prior draft over-attributed the agent-vs-human framing to this page.
- **[R#2-B6]** removed the citation of `anthropic.com/engineering/effective-harnesses-for-long-running-agents` (Nov 26, 2025) for the "durable session state over open-ended blocking" framing. Reviewer #1 WebFetched the article and could not find that phrasing. The Memento-backed PauseStore + reduced-action-surface-on-reload reasoning in §3.5 / §11 now stands on engineering grounds without the Anthropic appeal. The article remains relevant background but is not a load-bearing citation in this spec.

### Repo-local sources

- `ARCHITECTURE.md` v5.1 (§0, §3.1–§3.6, §4 sequence) — single source of truth for *what* to build.
- `SLICE_PLAN.md` v5 §S4 — single source of truth for *order* and exit criteria S4 must meet.
- `mocha-hooks/src/protocol.ts` (`JsonRpcConnection`, `nodeIpcTransport`, `inProcBus`, `METHOD`, `FinalDecisionParams`).
- `mocha-hooks/src/qa-hooks.ts` (publishes `pause.publish`, awaits `decision.await`, emits `final_decision`).
- `mocha-hooks/src/qa-reporter.ts` (tri-state rendering via `inProcBus`).
- `mocha-hooks/README.md` "Phase 2 follow-up" block.
- `qa-debug-mcp/src/pause-store.ts` (S3 `InMemoryPauseStore` + `PauseStore` interface + `Proposal` types). `recordDecision` is `retry | give_up` only; `mark_passed` flows through `proposeAction` + a separate commit path.
- `qa-debug-mcp/src/tools.ts` (6 tool schemas; shared source-of-truth with `evals/`).
- `qa-debug-mcp/src/qa-debug-mcp.ts` (stdio MCP server bootstrap — S4 splits into library + stdio CLI per §5.3, **flagged as a breaking S3 API change [R#2-NB3]**).
- `tools/oracle.ts` (S2 spawn pattern: `child_process.spawn` with `['inherit', 'inherit', 'inherit', 'ipc']`).
- `SLICE_PLAN-CR-S4-d.md` (companion CR — formalizes the reload-mid-pause exit-criterion clarification per §11). **[R#2-B5]**

---

## 1. Scope and exclusions

### In scope for S4

Per SLICE_PLAN §S4 (a)–(g):

1. `extension/src/extension.ts` `activate()`:
   - Construct durable `PauseStore` over `ExtensionContext.globalState` (Memento).
   - Register `McpServerDefinitionProvider` returning `[]` at idle, `[playwright-mcp, qa-debug]` during pause.
   - Spawn headed Chrome with `--remote-debugging-port=9222` **on Mocha suite start** (not on activation).
   - Spawn Mocha as a child with `stdio: [..., 'ipc']` and `--require <qa-hooks>` per S2 contract.
2. On `pause.publish` from hook: store in PauseStore, flip `qa-debug.paused` context key (UI-only gate per ARCH §3.4 R3#A), re-emit `onDidChangeMcpServerDefinitions` with the two-server list.
3. On any commit: clear pause, flip context key off, re-emit `[]`.
4. UI surface: VS Code notification + Test Explorer failure annotation + three inline command links (`qa-debug.retry`, `qa-debug.markPassed`, `qa-debug.giveUp`). Inline `reason`/`rationale` rendering per ARCH §3.5.
5. Wire `qa_propose_*` MCP → PauseStore proposal → UI button → on click → IPC `decision.await` returns matching kind.
6. Wire `qa_request_retry` / `qa_request_give_up` → PauseStore → IPC immediately (no UI commit step).
7. Retry decision = respawn mocha with `--grep <test title>` in fresh child; Chrome `:9222` persists.

### Out of scope for S4 (binding)

- SKILL.md body (S5). **[R#2-NB9]** S4 ships a one-paragraph stub body so the agent's second tool call isn't unguided in S4-only runs — see §7.6.
- Real-agent E2E with Copilot Chat (S6).
- chrome-devtools-mcp.
- Mocha `--parallel`.
- Multi-window / multi-context Playwright sessions.
- VS Code Debug API (`vscode.debug.*`) — phase 2.
- VS-Code-restart pause durability — chat-restart only per ARCH §3.5.
- **[R#2-NB11]** Static spec-file pre-discovery via `TestController.resolveHandler`. Phase 1 runs the whole fixture via `qa-debug.runFixture`; per-test cherry-picking from a pre-populated tree is Phase 2 ergonomic. Lazy TestItem creation on `pause.publish` (§7.3) is sufficient.

### Phase 2 follow-ups owed by S4 (don't lose)

- In-process Mocha retry requires re-adding `invalidateRequireCache(file)` per `mocha-hooks/README.md` "Phase 2 follow-up" block and `SLICE_PLAN.md` §4 [v5.1#A]. S4's retry stays `--grep` respawn — the `SessionManager.respawnForRetry` docstring must reference these two breadcrumbs so a Phase 2 implementer doesn't silently skip the re-add.
- Chrome crash recovery (§6.3) — currently surfaces as a fresh suite invocation; agent-visible behavior tracked in §6.3 table for now; sophisticated auto-relaunch deferred.

---

## 2. Component overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (extension/src/*.ts)                          │
│                                                                      │
│  ┌────────────────┐                                                  │
│  │ Activation     │ — registers commands, context keys,              │
│  │ extension.ts   │   TestController, MCP provider, OutputChannel    │
│  └────────────────┘                                                  │
│           │ wires                                                    │
│           ▼                                                          │
│  ┌────────────────┐    pauses/decisions   ┌────────────────────────┐ │
│  │ PauseStore     │◀──────────────────────│ SessionManager         │ │
│  │ Memento-backed │                       │ owns mocha child       │ │
│  └────────────────┘                       │ owns Chrome :9222      │ │
│           │                               └────────────────────────┘ │
│           │ snapshot/proposal                       │   spawn        │
│           ▼                                         │                │
│  ┌────────────────┐                                 │                │
│  │ McpProvider    │                                 │                │
│  │ idle: []       │                                 │                │
│  │ paused: 2 defs │                                 │                │
│  └────────────────┘                                 │                │
│           │ resolveMcpServerDefinition              │                │
│           ▼                                         │                │
│  qa-debug (in-extension) ── HTTP/Streamable ──── (editor)            │
│  playwright-mcp (stdio child of editor; --cdp-endpoint)              │
│           │                                         │                │
│  ┌────────────────┐                                 │                │
│  │ TestController │ failure annotation + commit     │                │
│  │ qa-debug-tests │ buttons (testing/message/       │                │
│  │                │ content menu)                   │                │
│  └────────────────┘                                 │                │
│           │ buttons → vscode.commands.executeCommand│                │
│           ▼                                         │                │
│  ┌────────────────┐    IPC decision.await response  ▼                │
│  │ DecisionRouter │ ──────────────────▶ mocha child IPC channel      │
│  └────────────────┘                                                  │
└──────────────────────────────────────────────────────────────────────┘
                                                       ▲
                                                       │ stdio[3] = ipc
                                                       │
                  ┌────────────────────────────────────┴────────┐
                  │ mocha child process (per suite run)         │
                  │  --require qa-hooks.js                      │
                  │  --reporter @qa-debug/mocha-hooks/qa-reporter│
                  └──────────────────────────────────────────────┘
```

### Module list (planned files under `extension/src/`)

| File | Role |
|---|---|
| `extension.ts` | `activate()`/`deactivate()`; constructs and wires the rest. |
| `pause-store.ts` | `MementoPauseStore` implementing the `PauseStore` interface from the new shared workspace package (see §3.4). |
| `mcp-provider.ts` | `QaDebugMcpProvider implements vscode.McpServerDefinitionProvider`; returns `[]` or `[playwright, qa-debug]` from `provideMcpServerDefinitions(token)`. Owns the `EventEmitter<void>` firing on state change. |
| `qa-debug-server.ts` | Hosts the qa-debug MCP server in-extension over Streamable HTTP (§5). Re-imports `qaTools` from the existing `qa-debug-mcp` package; injects the Memento-backed PauseStore. |
| `session-manager.ts` | Owns Chrome and Mocha child lifecycles. Spawns Chrome on suite start; spawns mocha child with IPC; routes hook messages into PauseStore + DecisionRouter; respawns on retry. |
| `decision-router.ts` | Holds pending `decision.await` callbacks per session_id; resolved by user button clicks or `qa_request_*` MCP calls. Owns the failure-mode synthesis in §9.3. |
| `test-controller.ts` | Constructs `vscode.tests.createTestController('qa-debug-tests', ...)`; maintains `TestItem` per discovered `.spec.js`; renders tri-state outcomes per §7. |
| `commands.ts` | Implements the four `qa-debug.*` commands; each resolves to a `DecisionRouter` action. |
| `chrome.ts` | Locates a Chrome binary, spawns headed with `--remote-debugging-port=9222`, owns lifecycle. Single instance reused across all tests within one suite run. |
| `output-channel.ts` | The audit log channel (`vscode.window.createOutputChannel('QA Debug Companion')`); receives every decision with `reason`/`rationale`. |

The packaged dist is bundled via the existing `esbuild` config (`extension/esbuild.config.mjs`) — single `dist/extension.js`.

---

## 3. PauseStore (Memento-backed)

### 3.1 Interface

The `PauseStore` interface already exists in `qa-debug-mcp/src/pause-store.ts:48–61` (read/propose-set/verdict-poll/recordDecision). S4 implements a Memento-backed version. The interface is extracted into a shared workspace package so both `qa-debug-mcp/` (S3 in-memory stub for evals + tooling) and `extension/` (S4 durable) consume the same contract.

```
@qa-debug/pause-store-types   (new workspace package — interface + types only)
  ├── PauseStore                (interface, unchanged)
  ├── PausePayload              (from S3)
  ├── Proposal, ProposalKind    (from S3)
  └── FailureContextView, toFailureContextView()
```

### 3.2 Memento key layout

Per `vscode.Memento.update` semantics (vscode.d.ts:8615 verbatim: "value must be JSON-stringifyable"), all timestamps stay as `number` (epoch ms). The S3 `PausePayload` and `Proposal` are already number-typed, so no change.

```
qa-debug.pause.active      → PausePayload | undefined
qa-debug.pause.proposal    → Proposal | undefined  (one proposal per active pause; replaced on new propose)
```

`Memento.update(key, undefined)` cleanly removes (vscode.d.ts:8617–8618 verbatim: "using `undefined` as value removes the key from the underlying storage"). `setKeysForSync` is **NOT** called — pauses are per-machine debugging state, not user preferences.

### 3.3 MementoPauseStore behaviors

| Method | Memento operations |
|---|---|
| `setActivePause(p)` | `globalState.update('qa-debug.pause.active', p)`; clear proposal. The SessionManager (not the store) then flips the context key and fires the MCP change event. |
| `getActivePause(sessionId?)` | Read `qa-debug.pause.active`; throw `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` per `qa-debug-mcp/src/errors.ts`. |
| `proposeAction(kind, rationale)` | Read active pause, construct `Proposal`, `globalState.update('qa-debug.pause.proposal', proposal)`. Returns proposal. |
| `pollProposal(sessionId)` | Read `qa-debug.pause.proposal`. Used by `qa_get_failure_context.last_proposal_status`. |
| `recordDecision(sessionId, kind, reason)` | For `retry` / `give_up`: **[R#3-B1a]** clears the proposal slot (`globalState.update('qa-debug.pause.proposal', undefined)`) atomically with the decision record. Reason: an `qa_propose_mark_passed` followed immediately by `qa_request_retry` would otherwise leave an orphan proposal that `qa_get_failure_context.last_proposal_status` returns as `awaiting_human` for a pause that can no longer accept a commit. Clearing on decision close lets the next pause start with `last_proposal_status: 'none'`. Active pause is cleared by the SessionManager *after* the IPC round-trip completes (so the hook can correlate via `inProcBus` for the reporter). |
| `clearActivePause()` | `globalState.update('qa-debug.pause.active', undefined)` and `globalState.update('qa-debug.pause.proposal', undefined)`. |

The store is **pure storage** — does not flip context keys, does not fire events, does not talk to the SessionManager. This separation lets the store be unit-testable against a fake Memento (a `Map<string, any>`) without VS Code.

### 3.4 Workspace package extraction (mechanics)

Add a new package `pause-store-types/` at repo root:
- `package.json`: `"name": "@qa-debug/pause-store-types"`, exports the interface + types + the pure `toFailureContextView` function.
- `pnpm-workspace.yaml`: add the new directory.
- `qa-debug-mcp/package.json` + `extension/package.json` add `"@qa-debug/pause-store-types": "workspace:*"`.
- Move `qa-debug-mcp/src/pause-store.ts:1–61` (interface, types, `toFailureContextView`) into the new package. Keep `InMemoryPauseStore` class in `qa-debug-mcp/src/`.

**[R#3-NB3]** The S4 PR description must explicitly enumerate the outside-`extension/` files this refactor touches (`qa-debug-mcp/src/pause-store.ts`, `qa-debug-mcp/package.json`, `evals/src/stub-mcp.ts` and any other S3-import-affected file, `pnpm-workspace.yaml`) so the diff isn't surprising to a reader expecting an extension-only slice.

### 3.5 Reload-mid-pause behavior

On `activate()`, the SessionManager reads `globalState.get('qa-debug.pause.active')`. If non-null: a pause was active when VS Code reloaded. The mocha child is gone (child processes die with their parent extension host). The held Chrome process is also gone. The `decision.await` promise on the dead child no longer matters.

S4 surfaces this with a *reduced-action-surface* UI on activate (Give Up enabled; Retry / Mark Passed disabled because the held browser and the running mocha child are both gone). Concrete behavior in §11.

This deviates from a literal read of SLICE_PLAN §S4 (d) "pause re-bound on activation; gate re-opens." The deviation is documented in companion CR `SLICE_PLAN-CR-S4-d.md`. **[R#2-B5]** The CR (not this spec's open questions) is the governance instrument that authorizes the deviation.

The engineering motivation is straightforward: live-binding a Memento-survived pause to a dead mocha child is not implementable (we cannot resurrect the child's process state). Auto-relaunching Chrome and re-running the failing test would generate a *different* pause than the one in Memento, making the persisted payload misleading. The implementable behavior is: keep the audit trail intact, offer the human a clean way to close out the stale pause.

---

## 4. McpServerDefinitionProvider

### 4.1 Manifest contribution

Add to `extension/package.json` `contributes`:

```json
{
  "mcpServerDefinitionProviders": [
    {
      "id": "qa-debug.mcp-servers",
      "label": "QA Debug Companion MCP Servers"
    }
  ]
}
```

Per vscode.d.ts:20821–20831 example (`cool-cloud-registry.mcp-servers` / `Cool Cloud Registry`). The same `id` passes to `lm.registerMcpServerDefinitionProvider('qa-debug.mcp-servers', provider)` per vscode.d.ts:20839 ("The ID of the provider, which is unique to the extension" verbatim).

Note: the existing `extension/package.json` does **not** contain this contribution — S4 adds it together with the engines bump from §0.

### 4.2 Provider implementation **[R#2-B2]**

```ts
// extension/src/mcp-provider.ts
import * as vscode from 'vscode';

type State = 'idle' | { kind: 'paused'; cdpHttpEndpoint: string };

export class QaDebugMcpProvider implements vscode.McpServerDefinitionProvider {
  private state: State = 'idle';
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  constructor(
    private readonly qaDebugUri: vscode.Uri,
    private readonly qaDebugToken: string,
  ) {}

  setPaused(cdpHttpEndpoint: string): void {
    this.state = { kind: 'paused', cdpHttpEndpoint };
    this.emitter.fire();
  }

  setIdle(): void {
    this.state = 'idle';
    this.emitter.fire();
  }

  // Signature matches vscode.d.ts:20533 verbatim — CancellationToken required.
  provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.McpServerDefinition[] {
    if (this.state === 'idle') return [];
    return [
      new vscode.McpStdioServerDefinition(
        'playwright-mcp',
        'npx',
        ['-y', '@playwright/mcp@latest', '--cdp-endpoint', this.state.cdpHttpEndpoint],
      ),
      new vscode.McpHttpServerDefinition(
        'qa-debug',
        this.qaDebugUri,
        { 'X-Qa-Debug-Token': this.qaDebugToken },
      ),
    ];
  }

  resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): vscode.McpServerDefinition {
    return server; // no credential mutation needed; both servers are local
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
```

Sources backing this:
- `vscode.EventEmitter<void>` + `.event` pattern — confirmed by the worked example on `code.visualstudio.com/api/extension-guides/ai/mcp`.
- `McpStdioServerDefinition` constructor `(label, command, args?, env?, version?)` — vscode.d.ts:20469.
- `McpHttpServerDefinition` constructor `(label, uri, headers?, version?)` — vscode.d.ts:20504.
- `provideMcpServerDefinitions(token: CancellationToken)` signature — vscode.d.ts:20533 verbatim. **[R#2-B2]** prior draft omitted the parameter.
- "extensions should not take actions which would require user interaction" — vscode.d.ts:20527 verbatim. Our implementation is a pure read from `this.state`; no I/O. ✓

### 4.3 Gating semantics in practice

| Event | Action |
|---|---|
| Extension activate | Register provider with `state = idle`; `provideMcpServerDefinitions` returns `[]`. |
| `pause.publish` from hook | `setPaused(cdpHttpEndpoint)`; provider next returns 2 defs; editor re-discovers and calls `resolveMcpServerDefinition` if the agent issues a tool call. |
| Any decision committed | `setIdle()`; next call returns `[]`; editor drops the now-absent servers. |
| Extension deactivate | `provider.dispose()` releases the emitter; the `Disposable` returned from `registerMcpServerDefinitionProvider` is in `context.subscriptions` and runs on extension deactivate. |

For `playwright-mcp` the editor manages the child process. For `qa-debug` (HTTP-hosted, see §5), the server stays running in-extension; `setIdle` just makes it un-discoverable, and active sessions complete naturally.

### 4.4 Version field semantics

The `McpStdioServerDefinition.version` field per vscode.d.ts:20457–20459: "If this changes, the editor will indicate that tools have changed and prompt to refresh them." We omit `version` from both definitions because **set membership** changes, not the tool surface within a server. The `onDidChangeMcpServerDefinitions` event triggers re-discovery; `version` would prompt user-visible refresh dialogs on no-op changes.

---

## 5. qa-debug MCP hosting transport

### 5.1 The constraint

S3's `qa-debug-mcp/src/qa-debug-mcp.ts` is a stdio MCP server. If the extension registered it as `McpStdioServerDefinition(label='qa-debug', command='node', args=[<dist path>])`, the editor would spawn it as a child of the editor, **not** of the extension. That child would have no IPC path to the extension's Memento-backed PauseStore — every `qa_*` tool call would dead-end.

### 5.2 Choice: HTTP-hosted in-extension

Rationale (purely capability/engineering — no agentic-design citation needed; reviewer Q4 confirmed no Anthropic-owned source on transport choice exists for editor-host scenarios):
1. **Single-process ownership.** The PauseStore is the extension's `Memento`; hosting the MCP server in the extension eliminates cross-process coordination.
2. **VS Code supports it.** `McpHttpServerDefinition` is a first-class definition type with a constructor exactly fit to this use case (vscode.d.ts:20476–20505).
3. **MCP SDK supports it.** `@modelcontextprotocol/sdk@1.29.0` ships `StreamableHTTPServerTransport` (`dist/esm/server/streamableHttp.d.ts:58`).
4. **No port-discovery brittleness.** Bind to `127.0.0.1:0`, read the assigned port, construct `vscode.Uri.parse('http://127.0.0.1:<port>/mcp')`, pass to `McpHttpServerDefinition`. The port lives only for the extension session.
5. **Loopback security.** **[R#2-NB2]** Localhost binding alone does not authenticate cross-process clients (the same defense as a Unix-socket UID-checked listener would). We add a per-extension bearer token in `McpHttpServerDefinition.headers` (e.g., `{ 'X-Qa-Debug-Token': crypto.randomUUID() }`) and require it in the server middleware. **[R#3-NB8]** The token is regenerated each `hostQaDebugMcp` call (i.e., per extension activation, never persisted to Memento or any disk) — the extension host is the only legitimate holder. This is justified by capability scope (the editor is the only client that holds the URL+port+token tuple at runtime) rather than an external authority citation.

The S3 stdio binary at `qa-debug-mcp/dist/qa-debug-mcp.js` is retained for evals + MCP Inspector smoke (it already works with `InMemoryPauseStore`). The extension consumes the *library* surface of `qa-debug-mcp` (`tools.ts`, the `McpServer` factory) plus the new `MementoPauseStore`.

### 5.3 Library re-export from `qa-debug-mcp/` **[R#2-NB3]**

Split `qa-debug-mcp/src/qa-debug-mcp.ts` into:
- `qa-debug-mcp/src/server.ts` — exported factory `createQaDebugServer({ pauseStore }): { mcpServer, register(transport) }`.
- `qa-debug-mcp/src/bin/stdio.ts` — the current stdio CLI; consumes `server.ts` + `InMemoryPauseStore` + stdio transport.

**[R#2-NB3] Breaking change flag:** the existing exported `createQaDebugServer(store: PauseStore)` (positional, in `qa-debug-mcp/src/qa-debug-mcp.ts:24`) becomes `createQaDebugServer({ pauseStore })` (options object). Migration: `evals/src/engagement.ts` and any other in-tree callers update to the options form in the same commit that makes the change. The change is internal to the workspace; no external consumers.

### 5.4 Concrete transport wiring **[R#2-NB1, R#2-B4 prep]**

```ts
// extension/src/qa-debug-server.ts (sketch — exact imports verified at impl time)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createQaDebugServer } from '@qa-debug/qa-debug-mcp/server';

export async function hostQaDebugMcp(pauseStore: PauseStore): Promise<{
  uri: vscode.Uri; token: string; dispose: () => Promise<void>;
}> {
  const token = randomUUID();
  const { mcpServer } = createQaDebugServer({ pauseStore });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);

  const httpServer = createServer(async (req, res) => {
    // Auth wraps both GET and POST per streamableHttp.d.ts:98 verbatim
    // ("Handles an incoming HTTP request, whether GET or POST"). This avoids
    // silently 401-ing the SSE GET stream while permitting the POST init path.
    if (req.headers['x-qa-debug-token'] !== token) {
      res.statusCode = 401;
      res.end();
      return;
    }
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address() as { port: number };
  const uri = vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`);

  return {
    uri,
    token,
    // [R#3-B3] Close transport BEFORE httpServer because the transport may still
    // be writing to httpServer's ServerResponse on open SSE streams; closing
    // httpServer first would leave the transport writing into a dead socket.
    // Both close methods are awaited per streamableHttp.d.ts:90 `close(): Promise<void>`.
    dispose: async () => {
      await transport.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
```

`McpHttpServerDefinition.headers` carries the token (vscode.d.ts:20489–20491: "Optional additional heads included with each request to the server" verbatim).

---

## 6. SessionManager (mocha child + Chrome lifecycle)

### 6.1 Responsibilities

- Spawn Chrome at Mocha **suite start** (single Chrome per suite invocation; reused across all tests per SLICE_PLAN §S4 (a) [Q5]).
- Spawn Mocha child with `child_process.spawn('node', ['<mocha-bin>', '--require', '<qa-hooks>', '--reporter', '<qa-reporter>', ...specs], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })`.
- Construct `JsonRpcConnection` (from `mocha-hooks/src/protocol.ts:137`) wrapping the child's IPC channel via `nodeIpcTransport(child)`.
- Register handlers:
  - `pause.publish` → `PauseStore.setActivePause`, flip context key, call `mcpProvider.setPaused(cdpHttp)`, surface UI.
  - `decision.await` → enroll in `DecisionRouter` keyed by `session_id`; do NOT resolve immediately.
  - `heartbeat` (server-pushed): forwarded silently; presence-only signal.
  - `final_decision` (notification from hook after decision resolves): clear pause, `mcpProvider.setIdle()`, flip context key off, dispatch to `TestController`.
- On retry decision: spawn a new mocha child with `--grep <test title>`; keep Chrome alive.
- On abandoned (hook resolves locally after 3 missed heartbeats per `mocha-hooks/README.md`): the hook's `final_decision` notification carries `by: 'hook'` and `reason: 'abandoned...'`. Treated as `give_up` for UI.
- **[R#2-B4]** On `child.on('exit', ...)` with any pending `DecisionRouter` callback for the active session: synthesize `{ kind: 'give_up', reason: 'mocha child exited unexpectedly (no final_decision)', by: 'hook' }` and resolve. See §9.3.

### 6.2 Suite start trigger

The S4 entry point for "run a fixture" is `qa-debug.runFixture`. The command:
1. Spawns Chrome (idempotent — if already running, reuse).
2. Calls `controller.createTestRun(request)`; `request` is constructed from user-clicked TestItems if invoked from the Test Explorer "run" gutter, or from a hard-coded full-fixture include if invoked from the command palette.
3. Spawns the mocha child.
4. Wires IPC.

Test Explorer "run" gutter is wired by `createRunProfile(label, kind, runHandler, isDefault)` per vscode.d.ts:18489. One profile is registered with `kind = TestRunProfileKind.Run`, `isDefault = true`.

### 6.3 Chrome lifecycle rules [Q5]

| State | Rule |
|---|---|
| Suite starts | Spawn Chrome if not already up. |
| Test fails → pause active | Chrome stays. |
| Decision committed (retry / mark_passed / give_up / hook-abandoned / mocha-crash-synthesized give_up) | Chrome stays — next test may pause too. |
| Mocha exits cleanly, no outstanding pause | Tear down Chrome. |
| Mocha exits with outstanding pause | Chrome stays; the dead mocha child no longer matters. The next user-driven `qa-debug.runFixture` reuses Chrome. |
| Extension deactivate | Tear down Chrome. |
| **[R#2-NB6] Chrome crashes (renderer OOM, kernel kill, etc.)** | The child's `exit` event fires inside the extension; SessionManager null-checks Chrome on next `pause.publish` and respawns it lazily on the next suite invocation. The currently-active pause's `cdp_ws_url` is **stale** — playwright-mcp tool calls against it will return CDP-connection errors, which the agent observes via the natural playwright-mcp error path. We do not auto-relaunch Chrome mid-pause because the live browser state (DOM, console) is the asset under inspection — relaunching would silently mask the loss. **Sophisticated mid-pause recovery is Phase 2.** |

The active-pause condition uses `PauseStore.getActivePause()` from the Memento at the time of mocha exit.

### 6.4 Mocha respawn for retry **[R#2-NB4 cite + Phase 2 breadcrumb]**

```ts
// session-manager.ts — sketch
async respawnForRetry(pause: PausePayload): Promise<void> {
  // Held Chrome at :9222 persists across respawn — extension owns it independently
  // of mocha lifecycle. Per ARCHITECTURE v5.1 §3.1 retry-branch reasoning:
  // a fresh Node process starts with empty require.cache so no in-process
  // invalidation is needed. Phase 2 in-process retry would re-introduce that
  // need — see mocha-hooks/README.md "Phase 2 follow-up" block + SLICE_PLAN §4
  // for the bidirectional cross-reference chain. Do NOT silently change to
  // in-process retry without that re-add.
  await this.killCurrentMochaChild();
  const escapedTitle = escapeRegex(pause.test_title); // §6.4.1
  this.spawnMochaChild({ grep: `^${escapedTitle}$`, specs: [pause.file] });
}
```

#### 6.4.1 Mocha `--grep` regex escaping

`Mocha.prototype.grep(re)` accepts string or RegExp; a string is ultimately wrapped in `new RegExp(stripped, flags)` after the `/pat/flag` shell-wrapping strip step (verified against `node_modules/.pnpm/mocha@10.8.2/.../lib/mocha.js:564–573`). Therefore test titles containing regex metachars `( ) [ ] * + ? | \ . $ ^ { }` must be escaped before being passed via `--grep`. **[R#3-NB5 / iter#3 polish]** Concrete escape (canonical metacharacter-class polyfill — same expression as Lodash's `_.escapeRegExp` source; valid against the ECMA-262 RegExp grammar metacharacter set): `str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. Future relaxation: ES2025 ships `RegExp.escape()` as a builtin (`tc39.es/proposal-regex-escaping/`); when the runtime floor permits, replace the polyfill with the builtin. The `^...$` anchors prevent prefix collisions among similar titles.

### 6.5 Mocha exit code handling

The qa-reporter (already in `mocha-hooks/src/qa-reporter.ts`) writes the CI-conservative tally to stdout and sets `process.exitCode` per ARCH §3.6. The mocha child's stdout is inherited (`'inherit'` in stdio[1]). The extension does **not** parse stdout for outcomes — outcomes flow through IPC `final_decision`. Stdout is human-display only, matching ARCH §3.6 R4#D's split.

---

## 7. Test Explorer integration

### 7.1 TestController construction

```ts
const controller = vscode.tests.createTestController('qa-debug-tests', 'QA Debug Companion');
context.subscriptions.push(controller);

controller.createRunProfile(
  'Run',
  vscode.TestRunProfileKind.Run,
  (request, token) => runHandler(request, token),
  /* isDefault */ true,
);
```

`createTestController(id, label)` signature from vscode.d.ts:18286. The `id` must be globally unique per vscode.d.ts:18454.

### 7.2 Tri-state mapping — **[R#2-B1] REWRITTEN**

`TestRun` exposes only `passed`, `failed`, `errored`, `skipped` (vscode.d.ts:18683–18712). There is no native "marked-passed" state, but **ARCHITECTURE v5.1 §3.6 line 273 commits us to render it as `✓ marked-passed by <user>: <rationale>` in stdout AND in the Test Explorer annotation** (verbatim). The mapping below preserves both the pass/fail-count semantics (so retries and CI exit-codes work) AND the inline visual distinction (so a marked-passed test does not silently disappear into the green tests).

**Mapping table:**

| Outcome | `TestRun` call | TestItem visible state | TestMessage attached | TestItem.description |
|---|---|---|---|---|
| `passed` (test fn returned cleanly) | `run.passed(testItem, durationMs)` | green ✓ | (no message; default) | unchanged |
| `failed` (test fn threw; `give_up` or hook-abandoned) | `run.failed(testItem, [failureMessage], durationMs)` | red ✗ | `failureMessage` carries the stack + agent's `reason` + commit-button context | unchanged |
| **`marked-passed`** (test fn threw; human committed `qa_propose_mark_passed`) | `run.passed(testItem, durationMs)` followed by `run.appendOutput(rationaleLine)` | green ✓ | **sticky `markedPassedMessage`** attached via `run.failed(testItem, [markedPassedMessage])` *before* the `passed` transition, OR (preferred since direct attachment-after-pass is not in the API) attached during the failure phase and intentionally not retracted: the message body reads `## Marked passed by <user>\n\n<rationale>\n\nOriginal failure: <one-line summary>` rendered as `MarkdownString` | `(marked passed)` |

The mechanics:
1. Test failure arrives; `run.failed(testItem, [failureMessage], failedAtMs)` is called with the failure annotation including commit buttons (per §7.4).
2. Agent calls `qa_propose_mark_passed`; UI shows the proposal.
3. User clicks "Mark Passed"; DecisionRouter commits.
4. SessionManager calls `testItem.description = '(marked passed)'`, replaces the run state by calling `run.passed(testItem, totalDurationMs)`, and `run.appendOutput(\`✓ marked-passed by user: ${rationale}\\r\\n\`)`.
5. The previously-attached `failureMessage` stays in the run results panel (TestRun's outcome history is not retracted when `passed` is called after `failed` — verified at implementation time). The persistent `failureMessage` is the inline visual distinction; the `description` is the tree-row distinction; `appendOutput` is the audit-log distinction.

Why not just `run.passed` with no further markings (the simpler v1 mapping)? Because (a) ARCH §3.6 line 273 commits us to the inline annotation, (b) CI runs may exit non-zero (per ARCH §3.6 exit-code semantics) while Test Explorer would show all-green — a known anti-pattern where headless CI and interactive UX disagree silently. Keeping the failure annotation + tree description visible closes that gap.

Why not `run.errored`? That state is documented as "couldn't be executed at all, from a compilation error for example" (vscode.d.ts:18698–18700 verbatim). Marked-passed tests *did* execute; calling `errored` would be semantically wrong.

**[R#2-B1] Implementation-time verification:** the spec assumes that calling `run.passed(testItem)` after `run.failed(testItem, [msg])` keeps the failure message in the results panel rather than retracting it. This is documented as outcome state transitions during a run (vscode.d.ts:18651 "Once created, tests that are included in the request will be moved into the queued state"; the per-test state can transition until `run.end()`). The exact retraction behavior of `TestMessage` attachments must be smoke-verified during S4 implementation against the actual VS Code 1.120+ runtime. **[R#3-NB1]** Before the S4 PR opens: the engineer writes a 20-line standalone TestController demo executing the `run.failed(testItem, [msg]) → run.passed(testItem)` transition, screenshots the Test Results panel showing whether `msg` is retained, and attaches the screenshot to the S4 PR description. This eliminates the "verified at implementation time" hedge by moving the verification *into* PR review. If retraction is observed (the failure annotation disappears on `passed`), the fallback is to keep the test in `failed` state and signal marked-passed exclusively through the `description` + `appendOutput` + qa-reporter stdout, **filing a follow-up CR to ARCH §3.6 to relax the "Test Explorer annotation" commitment to "Test Explorer description"**.

### 7.3 TestItem discovery and id stability **[R#2-NB10]**

For S4, `TestItem`s are constructed on-the-fly from IPC `pause.publish` payloads (which carry `test`, `file`, `line`). The extension does not statically discover spec files at activation — Phase 1 doesn't require a populated test tree before run.

Discovery order during a run:
1. `runHandler(request)` is called; we read `request.include` to get user-selected TestItems, or fall back to all-fixture if `include` is undefined per vscode.d.ts:18596–18599 ("This property is undefined, then the extension should simply run all tests").
2. `controller.createTestRun(request)` returns a `TestRun` instance.
3. Spawn mocha; for each `pause.publish`, lazy-create the matching TestItem if not present (under a parent file-level TestItem keyed by URI). **TestItem id formula:** `${fileUri.toString()}::${testTitle}` — stable across retry respawns so the same TestItem receives subsequent pause/decision events for the same logical test.
4. On `final_decision`, dispatch outcome per §7.2 mapping.
5. On mocha exit, `run.end()`.

`TestItem.range` is set from `pause.publish.line` so the gutter decoration lands on the right line.

### 7.4 Inline commit buttons on failure annotations

Per vscode.d.ts:18935–18957, `TestMessage.contextValue` enables the `testing/message/content` `menus` contribution which renders as "a prominent button overlaying editor content where the message is displayed" (vscode.d.ts:18940 verbatim). This is the Test-Explorer-native path for the inline Retry / Mark Passed / Give Up buttons.

Add to `extension/package.json` `contributes.menus`:

```json
{
  "menus": {
    "testing/message/content": [
      { "command": "qa-debug.retry",       "when": "testMessage == qaDebugPaused" },
      { "command": "qa-debug.markPassed",  "when": "testMessage == qaDebugPaused" },
      { "command": "qa-debug.giveUp",      "when": "testMessage == qaDebugPaused" }
    ]
  }
}
```

The constructed `TestMessage` sets `contextValue = 'qaDebugPaused'`; the `when` clause `testMessage == qaDebugPaused` matches per vscode.d.ts:18937 ("the `testMessage` property of the following `menus` contribution points"). The command handler receives `{ test, message }` per vscode.d.ts:18958–18962.

### 7.5 The TestMessage body

```ts
const md = new vscode.MarkdownString(
  `**${pause.test_title}** failed at \`${path.basename(pause.file)}:${pause.line}\`.\n\n` +
  `${pause.error.message}\n\n` +
  `_Browser held at \`${cdpHttpEndpoint}\` — ask Copilot to investigate._`
);
// We use the testing/message/content menu route for command actions (§7.4),
// NOT MarkdownString `command:` links. isTrusted therefore stays off. The
// notification surface (§8.4) likewise has no command-execution path — all
// committable actions go through the menu route, which means MarkdownString
// trust is not needed anywhere in S4. If a future slice adds notification
// command links, isTrusted must be set with an explicit `enabledCommands`
// allowlist per vscode.d.ts:3025–3030.
md.isTrusted = false;
const msg = new vscode.TestMessage(md);
msg.contextValue = 'qaDebugPaused';
msg.location = new vscode.Location(vscode.Uri.file(pause.file), new vscode.Position(pause.line - 1, 0));
msg.stackTrace = pause.stack_trace.frames.slice(0, 20).map(parseStackFrame); // §7.5.1
run.failed(testItem, msg);
```

After `final_decision`:
- `mark_passed` → §7.2 mapping (sticky failure message + `description` + `passed` transition).
- `give_up` → already `failed`; `run.appendOutput(decisionRow)` adds the audit-log row.
- `retry` → respawn mocha; same TestItem stays (per §7.3 id formula); next pause publishes again.

#### 7.5.1 Stack-frame parsing **[R#3-NB4]**

The hook publishes `stack_trace.frames` as `string[]` (per `qa-debug-mcp/src/pause-store.ts:12`) — typically V8-formatted lines like `    at TestObject.run (/abs/path/to/file.js:42:13)`. `TestMessageStackFrame` constructor (vscode.d.ts:18898–18906) takes `(label: string, uri?: Uri, position?: Position)`.

```ts
const FRAME_RE = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;

function parseStackFrame(line: string): vscode.TestMessageStackFrame {
  const m = FRAME_RE.exec(line);
  if (!m) return new vscode.TestMessageStackFrame(line); // fall back: label only
  const [, label, filePath, lineStr, colStr] = m;
  const uri = vscode.Uri.file(filePath);
  const position = new vscode.Position(Number(lineStr) - 1, Number(colStr) - 1);
  return new vscode.TestMessageStackFrame(label, uri, position);
}
```

The regex covers the parenthesized form (most common in V8). The anonymous-fn form `    at /abs/path:42:13` (no label, no parens) and the eval form (`    at eval (eval at ...)`) fall through to the label-only fallback — acceptable for S4 since the hook's `serializeError` already filters to the project's own frames in practice.

### 7.6 S4-shipped Skill stub body **[R#2-NB9]**

S5 owns the full SKILL.md body. S4 ships a *minimal one-paragraph stub body* so an S4-only smoke run doesn't leave the agent unguided after the first tool call:

```markdown
This Skill engages when a Mocha test is currently paused at a failure with a
held debugging browser available. Step 1: call `qa-debug:qa_get_failure_context`
(concise) to ground. Step 2: investigate via the held browser using
`playwright-mcp:browser_snapshot`, `browser_evaluate`, and
`browser_console_messages`. Step 3: report one-line conclusion in chat, then
either edit the test/source and call `qa-debug:qa_request_retry` with a specific
`reason`, or call `qa-debug:qa_request_give_up` if no retry is warranted.
Reserve `qa-debug:qa_propose_mark_passed` for environmental flake signals; do
not invoke it when the failing assertion's value is derived from production
code paths.

(S5 will replace this stub with the full per-failure-mode decision tree.)
```

Frontmatter from S3 stays. The full decision-tree body in S5 supersedes this stub.

---

## 8. UI commit flow (matrix)

### 8.1 Verb → commit path

| MCP verb | UI commit? | Wiring |
|---|---|---|
| `qa_get_failure_context` | No (read-only) | Direct PauseStore read in the in-extension MCP server. |
| `qa_request_retry` | No | Tool handler → `pauseStore.recordDecision(sessionId, 'retry', reason)` → `decisionRouter.commit(sessionId, 'retry', reason, 'agent')`. SessionManager respawns mocha. |
| `qa_request_give_up` | No | Same as retry but `kind: 'give_up'`. |
| `qa_propose_mark_passed` | Yes | `pauseStore.proposeAction(sessionId, 'mark_passed', rationale)`; returns `{ proposal_id, status: 'awaiting_human' }`. Test Explorer button reflects proposal; user clicks "Mark Passed" → `qa-debug.markPassed` command → DecisionRouter commits. |
| `qa_propose_close_browser` | Yes | Same shape; on commit, SessionManager tears down Chrome and closes the suite. |
| `qa_propose_abort_suite` | Yes | Same shape; on commit, SessionManager kills the mocha child and tears down Chrome. |

### 8.2 What the Test Explorer button does

Each `qa-debug.*` command handler:
1. Reads the active pause (`pauseStore.getActivePause()`).
2. If a proposal exists matching the command's kind, treat the click as committing that proposal (`reason = proposal.rationale`).
3. **[R#3-B1c, R#3+NB1 polish]** If no proposal exists for the kind (e.g., user clicks Retry / Give Up / Mark Passed without an agent having proposed), treat as a direct human request. **For `qa-debug.retry` / `qa-debug.giveUp` (reversible verbs)**: route through DecisionRouter immediately with `by: 'human'`, `reason: 'user clicked <Retry|Give Up> in Test Explorer'`. **For `qa-debug.markPassed` (cold-click, irreversible)**: prompt the user for a rationale via `vscode.window.showInputBox({ prompt: 'Why mark this test as passed?', placeHolder: 'Specific, falsifiable rationale — what makes this a real pass?', ignoreFocusOut: true, validateInput: (v) => v.trim().length === 0 ? 'Rationale required (be specific and falsifiable)' : null })` before committing. Per `vscode.d.ts:11485–11487` `showInputBox` returns `undefined` on Escape AND `''` on OK-with-empty-input — handle both: if the user cancels via Escape, the command aborts and the pause stays open; `validateInput` blocks OK-with-empty at the input level, and a defensive `if (!rationale?.trim()) return;` after the await is the belt-and-suspenders for that contract. This preserves ARCH §3.6 line 273's commitment that the marked-passed audit-log row reads `✓ marked-passed by <user>: <rationale>` with a real `<rationale>`, not a placeholder or empty string.
4. Call `decisionRouter.commit(sessionId, kind, reason, by)`. Errors (no active pause) surface as `vscode.window.showErrorMessage`.

### 8.3 Asymmetric gating — **[R#2-NB8] reference only**

The propose-vs-request asymmetry (requests commit immediately, proposes require UI confirm) is established and defended in **ARCHITECTURE v5.1 §3.2 "On `qa_propose_close_browser` reversibility [R3#D]"** with citations to `anthropic.com/research/measuring-agent-autonomy`, `anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents`, and `anthropic.com/research/trustworthy-agents`. S4 implements the asymmetry as designed; it does not relitigate. Reviewer-confirmed: the existing defense covers S4's wiring without modification.

### 8.4 Notification surface

On `pause.publish`:

```ts
vscode.window.showInformationMessage(
  `Test "${pause.test_title}" failed at ${path.basename(pause.file)}:${pause.line}. Browser held at :9222. Ask Copilot to investigate.`,
  'Open Test Explorer',
  'Open Audit Log',
).then((selection) => { /* focus the requested view */ });
```

The notification is informational (non-modal). The commit buttons live in Test Explorer, not in the notification, to avoid the framing where the human can decide from the notification alone without seeing the agent's reasoning.

### 8.5 Audit log channel

Every decision routes through `OutputChannel.appendLine` with a structured line: `2026-05-21T14:03:11Z session=<id> test="<title>" decision=<kind> by=<agent|human|hook> reason="<reason or rationale>"`. The channel persists for the session and matches ARCH §3.5's observability requirement.

---

## 9. Decision routing

### 9.1 DecisionRouter shape

```ts
type Pending = (decision: DecisionResult) => void;

class DecisionRouter {
  private readonly pending = new Map<string, Pending>();

  enroll(sessionId: string, resolve: Pending): void {
    if (this.pending.has(sessionId)) {
      // Should not happen: each pause has a unique session_id. If it does,
      // the old caller is now orphaned. Log + replace.
      this.outputChannel.appendLine(`[decision-router] overwrote pending for ${sessionId}`);
    }
    this.pending.set(sessionId, resolve);
  }

  commit(sessionId: string, kind: DecisionKind, reason: string, by: DecisionBy): boolean {
    const p = this.pending.get(sessionId);
    if (!p) return false; // single-shot: first commit wins; loser observed elsewhere via PauseStore
    this.pending.delete(sessionId);
    p({ kind, reason, by });
    return true;
  }

  abandon(sessionId: string, reason: string): boolean {
    return this.commit(sessionId, 'give_up', reason, 'hook');
  }
}
```

### 9.2 IPC wiring

When `decision.await` arrives from the hook:
```ts
connection.handle(METHOD.decisionAwait, async (params) => {
  const { session_id } = DecisionAwaitParams.parse(params);
  return new Promise<DecisionResult>((resolve) => {
    decisionRouter.enroll(session_id, (decision) => {
      stopHeartbeats(session_id); // [R#2-NB5]
      resolve(decision);
    });
    startHeartbeats(connection, session_id);
  });
});
```

**[R#2-NB5]** Heartbeats start when the await begins and stop the moment the decision resolves (either via commit or via the failure-mode synthesis below). Without `stopHeartbeats` the SessionManager would keep sending `heartbeat` notifications across the dead window between resolution and the next `pause.publish`.

### 9.3 Failure modes — **[R#2-B4 NEW SECTION; R#3-B1a/c + NB2/7 expanded]**

| Failure | Effect | Recovery |
|---|---|---|
| Mocha child exits while a `decision.await` is pending (e.g., uncaught exception, SIGSEGV) | The hook's `final_decision` never fires; the held Promise would deadlock the UI button forever. | `SessionManager` wires `child.on('exit', () => decisionRouter.abandon(sessionId, 'mocha child exited unexpectedly (no final_decision)'))` for any session_id with a pending callback. The DecisionRouter synthesizes `{ kind: 'give_up', reason: <as above>, by: 'hook' }`. **[R#3-NB2 audit-log noise note]** `by: 'hook'` is the closest existing value in `DecisionBy` (`mocha-hooks/src/protocol.ts:38`); the synthesis is a mocha-process-host event, not literally a hook decision, so the audit log will read "give_up by hook: mocha child exited unexpectedly". Adding a `'mocha-host'` value to `DecisionBy` would be a tiny protocol CR (deferred — see §13 follow-ups); for S4 we accept the conflation. **[R#3+NB3 polish]** The `clearActivePause` step on `PauseStore` flows through `§11 stale-resume` on the next activate, intentionally — there is no IPC round-trip whose completion would trigger SessionManager's normal `clearActivePause` step on the mocha-crash synthesis path. Do NOT "fix" this with an out-of-band clear that races the §11 path; the Memento survival of a stale pause is what enables §11's audit-trail-intact resume. The TestController renders the test as `failed` (per §7.2 give_up mapping). Chrome stays up per §6.3 row "Mocha exits with outstanding pause." |
| Race: agent calls `qa_request_retry` and human clicks Mark Passed within the same millisecond | Single-shot `DecisionRouter.commit` means whichever JS task scheduler runs first wins. **[R#3-NB7 framing tightened]** Two loser sub-cases: **loser-was-agent** — the agent's `qa_request_retry` reaches `pauseStore.recordDecision` (which optimistically writes `accepted_at_ms`) but its `decisionRouter.commit` finds the entry already deleted and returns `false`; the tool handler then surfaces `NO_ACTIVE_PAUSE` per §9.4. **loser-was-human** — the human click reaches the `qa-debug.markPassed` command which calls `pauseStore.getActivePause()`; if the pause has already cleared, the command surfaces `vscode.window.showErrorMessage('Pause already resolved')` and the click no-ops. **No `recordDecision` write happens on the human path** (Mark Passed flows through `proposeAction` + UI commit, not `recordDecision`). | Acceptable because (a) both verbs are commit-once semantics, (b) both loser paths surface a visible NO_ACTIVE_PAUSE to their caller (agent gets MCP error; human gets error message), (c) the actual mocha-side action matches the winner. Implementation-time refinement: emit a one-line OutputChannel note `[decision-router] race: dropped <kind> by <by> after <winning kind> by <winning by> won at <ts>`. |
| `pause.publish` arrives before SessionManager has registered its IPC handler | `JsonRpcConnection.handle` is populated synchronously in the SessionManager constructor (before mocha child spawn), so this race cannot occur in current code. Documented here as an invariant: any future refactor that splits handler-registration from spawn must preserve the order. |
| Heartbeat-cancellation interaction with retry respawn | `respawnForRetry` kills the current mocha child. The `child.on('exit', ...)` path in row 1 fires; if there is still a pending decision for the killed session (shouldn't happen, since `respawnForRetry` is called only after the decision committed), it gets the same synthesized give_up. Heartbeats are stopped per §9.2. |
| **[R#3-B1a]** Agent calls `qa_propose_mark_passed` then immediately calls `qa_request_retry` (or `qa_request_give_up`) before the human commits the proposal | The retry IPC commit resolves the hook's `decision.await`. Without explicit cleanup, the orphaned `mark_passed` proposal would sit in `qa-debug.pause.proposal` until the next `setActivePause` cleared it. During that window any `qa_get_failure_context` call returns `last_proposal_status: 'awaiting_human'` for a proposal that can never be committed (the pause it was attached to is gone). | `pauseStore.recordDecision` for `retry` / `give_up` clears the proposal slot atomically with the decision record (§3.3 row). Next `qa_get_failure_context` returns `last_proposal_status: 'none'`. The audit log records both the orphaned proposal (was-proposed-but-not-committed) and the retry decision. |
| **[R#3-B1b sketch]** VS Code reloads between Memento `setActivePause` write and SessionManager's `decision.await` IPC handler enrollment | The Memento survives; the in-process DecisionRouter is empty after activate. On reactivation, §11 stale-resume path handles this exactly like "mocha child died": Give Up enabled, Retry / Mark Passed disabled, human resolves locally. No separate code path needed. | Documented as folding into §11 stale-resume; no new row in §6.1 or §9.3 beyond this note. |

### 9.4 Single-shot commit semantics

`DecisionRouter.commit` returns `false` if no pending callback exists. Tool handlers in `qa-debug-server.ts` interpret `commit returning false` as "the pause already resolved" and respond to the agent with `NO_ACTIVE_PAUSE` via `qa-debug-mcp/src/errors.ts`. The PauseStore's own `getActivePause` throws the same error if the Memento has already cleared the pause, providing a consistent failure shape across the two paths.

---

## 10. Retry respawn flow (end-to-end)

1. Agent calls `qa-debug:qa_request_retry({ session_id, reason: "fixed selector" })`.
2. In-extension MCP server's tool handler calls `pauseStore.recordDecision(session_id, 'retry', reason)` then `decisionRouter.commit(session_id, 'retry', reason, 'agent')`.
3. `decision.await` promise resolves with `{ kind: 'retry', reason, by: 'agent' }`. Response sent back over IPC. `stopHeartbeats(session_id)` fires.
4. Hook receives response. Per qa-hooks.ts current impl: emits `final_decision({ session_id, kind: 'retry', reason, by: 'agent', test_title, test_file })` over IPC. qa-reporter (in-process via `inProcBus`) records it.
5. Hook returns from afterEach. Mocha proceeds — the test won't actually re-run (no native retries per ARCH §3.1). Mocha eventually emits `EVENT_RUN_END`; qa-reporter writes its tally; mocha child exits.
6. SessionManager observes `final_decision` BEFORE child exit, schedules `respawnForRetry(pause)`. Waits for child exit. Spawns a new mocha child with `--grep '^<escaped-title>$'` (per §6.4.1) on the same spec file.
7. Chrome `:9222` stays alive across this gap (extension owns Chrome per §6.3).
8. Second invocation: either passes (no `pause.publish`; qa-reporter records pass; TestItem stays the same per §7.3 id formula) or fails again (`pause.publish` → new sessionId, MCP gate re-opens, same TestItem updated).

---

## 11. VS-Code-reload-mid-pause flow

(Already addressed in §3.5; full sequence here.)

1. Suite is running. Test fails. `pause.publish` lands. Memento stores `qa-debug.pause.active`. Context key flipped. MCP servers registered.
2. **User reloads VS Code.** Extension host dies. Mocha child dies (it was a child of the extension host). Chrome dies (owned by the extension).
3. `activate()` runs in the new extension host. SessionManager reads `globalState.get('qa-debug.pause.active')` and finds a stale pause.
4. SessionManager:
   - Flips context key on.
   - Calls `mcpProvider.setPaused(<cdpHttp from stored payload>)` — note this is a *recorded* cdp URL with no live browser behind it.
   - Surfaces a notification: "Last suite was interrupted while a pause was active. The browser state is no longer available. Choose **Give Up** to clear, or close this notification to defer."
   - Disables Retry and Mark Passed via a `qa-debug.staleResume` context key (set true on resume, false on fresh pause). The Test Explorer menu's `when` clauses for those commands are extended to require `!qa-debug.staleResume`.
5. On user clicking Give Up: `decisionRouter.abandon(sessionId, 'resumed after VS Code reload')` synthesizes the give_up locally; PauseStore clears; context key flips off; MCP gate closes; audit log records the resumed-and-cleared event.
6. On defer: nothing happens. Next `qa-debug.runFixture` will treat the stale pause as expired and overwrite it on first new `pause.publish`.

This deviates from a literal read of SLICE_PLAN §S4 (d) "pause re-bound on activation; gate re-opens." Per **`SLICE_PLAN-CR-S4-d.md`** (companion CR), the SLICE_PLAN §S4 (d) exit criterion is reinterpreted: "re-bound" means the UI surfaces with reduced action surface (Give Up only), and "gate re-opens" means the MCP gate re-opens for read-only inspection via `qa-debug:qa_get_failure_context` (the stored payload is intact). The CR carries the engineering reasoning and the alternative considered.

---

## 12. Exit-criteria mapping (SLICE_PLAN §S4)

| SLICE_PLAN exit criterion | This design's path |
|---|---|
| F5 Extension Host: run fixture → fail → MCP gate opens (verify via `Developer: Show MCP Status` that playwright-mcp + qa-debug appear, disappear after commit) | §4.3 gating semantics + `provideMcpServerDefinitions` returning `[]`/2-element array based on state. |
| Click Mark Passed → Test Explorer renders marked-passed | §7.2 mapping: sticky failure message + `description = '(marked passed)'` + `run.passed` + `run.appendOutput` rationale. Visual distinction preserved per ARCH §3.6 line 273 commitment. |
| Retry: click Retry → extension respawns mocha child with `--grep`, Chrome stays up → second-failure pause re-opens gate | §6.4 respawn + §10 full flow. |
| Give Up: renders as failed → gate closes | §7 + §8.1 give_up path + (if mocha crashes) §9.3 synthesized give_up path. |
| VS Code Reload mid-pause: PauseStore survives Memento; pause re-bound on activation; gate re-opens | §3.5 + §11 + `SLICE_PLAN-CR-S4-d.md` (reduced-action-surface "re-bound" interpretation). |
| Chrome lifecycle: launches on suite start (not activation); stays on fail; teardown on mocha process exit when no pause outstanding | §6.3 table (incl. Chrome-crash row per §6.3 NB#6). |
| Test Explorer outcome rendering matches qa-reporter output for all three decision kinds | §7.2 mapping renders all three distinctly. Compliant with ARCH §3.6 commitment per Blocking #1 resolution. |

---

## 13. Open questions for reviewer

**Iteration #2: all Q1–Q6 from iteration #1 are resolved.** Per reviewer #1's blockers + answers:

- Q1 (reload-mid-pause) — option (A), reduced action surface. Formalized in companion CR `SLICE_PLAN-CR-S4-d.md`. Closed.
- Q2 (Streamable HTTP transport shape) — confirmed at `@modelcontextprotocol/sdk@1.29.0/dist/esm/server/streamableHttp.d.ts:58/62/98`. Pinned in §5.4. Closed.
- Q3 (marked-passed Test Explorer rendering) — option (B): sticky failure message + description + `passed` + `appendOutput`. Implemented in §7.2 with implementation-time verification footnote on TestMessage retraction behavior. Closed.
- Q4 (in-extension qa-debug MCP server vs side-channel) — HTTP-hosted in-extension is correct on capability grounds. OWASP appeal dropped per §5.2 NB#2. Closed.
- Q5 (Skill body in S4) — stub body shipped per §7.6 NB#9. Closed.
- Q6 (TestController test discovery) — lazy creation is correct; static spec-file pre-discovery promoted to §1 "Out of scope (binding)" per NB#11. Closed.

**Iteration-#3 follow-ups (not blocking S4 implementation):**

1. **VS Code engines-floor verification.** The S4 implementation pass should WebFetch the actual landing version of `McpServerDefinitionProvider` from `code.visualstudio.com/updates/v1_101` through `v1_120` release notes (5 minutes of work) before opening the S4 PR. If a lower landing version is identified, relax the `engines.vscode` floor in the same commit. If not found, the floor stays at `^1.120.0` with a `// known-good; see S4_DESIGN §13` comment in package.json. **[R#3-NB9]**

2. **`'mocha-host'` DecisionBy value.** §9.3 row 1 conflates "mocha-process-host-died" with `by: 'hook'`. A tiny protocol CR adding `'mocha-host'` to `DecisionBy` in `mocha-hooks/src/protocol.ts:38` would clean up the audit log. Out of scope for S4; deferred to a Phase-1-tail cleanup CR.

3. **Pre-S4-PR TestMessage-retraction smoke** (per §7.2 R#3-NB1) — 20-line demo + screenshot, attached to S4 PR.

---

## 14. Status

- **Iteration #1** — 2026-05-21 draft. Reviewer #1 returned REVISE with 6 blocking issues + 11 non-blocking observations + Q1–Q6 answers.
- **Iteration #2** — 2026-05-21. Applied all 6 blockers + all 11 non-blockers + closed Q1–Q6. Reviewer #2 returned APPROVE-with-polish (3 polish-class issues mislabeled "blocking" + 9 non-blocking).
- **Iteration #3** — 2026-05-21. Applied all 3 reviewer-#2-blocking polish items + all 9 non-blocking. Reviewer #3 returned APPROVE-with-polish (3 non-blocking observations) with explicit recommendation: *"the spec APPROVED ... three non-blocking items above are implementation-level guards an engineer can apply at PR time without a fourth Ralph-loop round."* Iteration-#3 polish (cold mark_passed empty-input guard, MDN citation precision, mocha-crash clearActivePause comment) applied inline. **S4_DESIGN.md APPROVED 2026-05-21.** Implementation may begin.
