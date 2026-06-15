# QA Debug Companion for Mocha + Copilot — Architecture v5.14

> **STATUS UPDATE (2026-06-09):** playwright-mcp collision avoidance + token-scoping agent landed. When a QA runs their **own** `@playwright/mcp` (no `--cdp-endpoint`), VS Code's two collision mechanisms broke us: **(A)** a clashing registration *label* let the user's `mcp.json` server (collection order 200) outrank ours (extension, 300) and silently *disable* our CDP server; **(B)** both report the same hardcoded `serverInfo.name` "Playwright", so the model saw two indistinguishable `browser_*` toolsets and could inspect a fresh empty browser. Fix: register under the unique label **`qa-debug-cdp`** (kills A) + front the real `@playwright/mcp --cdp-endpoint` with a thin stdio proxy (`extension/src/mcp-proxy.ts`) that rewrites the `initialize` `serverInfo.name`→`qa-debug-cdp`, so tools surface as `mcp_qa-debug-cdp_browser_*` (kills B); the SKILL steers to `qa-debug-cdp` and warns off any other `browser_*` server. The CDP download-shim is unaffected (it sits a layer below). **Token:** a contributed `qa-debug` custom agent (`extension/agents/qa-debug.agent.md` via `contributes.chatAgents`, `when: qa-debug.paused`) scopes the pause chat via a `tools:` allowlist (`qa-debug-cdp/*` + the qa verbs + built-in groups), excluding the QA's playwright-mcp and other MCP/extension tools from the LM request; `commands.ts` enters it with `chat.open({ mode: 'qa-debug' })`. Source-verified mechanics in `reference-vscode-mcp-collision-mechanics`.
>
> **STATUS UPDATE (v5.16, 2026-05-30):** This document's header is v5.14; later feature work post-dates it. This file plus `extension/CHANGELOG.md` are now the record — the per-feature `PLAN-*.md` working docs were retired once their work landed. Where older sections below disagree with this update on the tool surface, this update wins. Concretely: the live qa-debug verb set is **{ qa_get_failure_context, qa_discover_chromes, qa_select_chrome, qa_pick_element }** — the verdict verbs `qa_request_give_up` / `qa_propose_mark_passed` / `qa_propose_abort_suite` were **removed 2026-05-31** (a pause is now a pure inspection hold — no verdict to commit; the QA re-runs from Test Explorer ▶ or ends the run with Stop), as were the older `qa_request_retry` / `qa_propose_close_browser` (still referenced in §3.2 / §3.4 / §6 below). The browser model is **Mode C** (test-framework-owned Chrome discovered via CDP port probe), not the Mode A/B in older sections.

> Status: **v5.14 LANDED 2026-05-22** — qa-debug verbs migrated from in-extension MCP server to VS Code Language Model Tool API (iter#2 APPROVE-with-polish). Driver: target organization disallows enabling MCP in VS Code; for a single-host single-language single-owner stack the LM Tool API is the right primitive. Affected sections: §2 (architecture decision), §3.2 (tool surface — same verbs, new host), §3.4 (gating model — `when`-clause replaces `onDidChangeMcpServerDefinitions` for qa-debug; playwright-mcp branch survives), §3.5 (audit log prefix), §5 (tech stack). Unchanged: §3.1 qa-hooks IPC, §3.3 chatSkills/SKILL.md mechanism, §3.6 qa-reporter.
>
> Change tags: **[R1#n]** = iteration-1 blockers (preserved). **[R2#n]** = iteration-2 follow-ups (preserved). **[R3#n]** = iteration-3 follow-ups (preserved). **[R4#n]** = v4→v5 follow-ups (preserved). **[R5#n]** = v5 polish (preserved). **[R14#n]** = v5.14 LM Tool API migration (this iteration).

## 0. Engineering rules (standing) [R4#A]

These rules govern how this document evolves across Ralph-loop iterations. Reviewers MAY reject any §3.x prescription that violates them.

- **0.1 Capability claims require citation.** A claim about Mocha, VS Code, MCP SDK, Playwright MCP, Anthropic Skills, Anthropic API, or any other platform requires *either* (i) a citation to installed source under `node_modules/` with file path + line number, *or* (ii) a WebFetched URL on the platform's own domain (`code.visualstudio.com`, `modelcontextprotocol.io`, `docs.claude.com`, etc.). Training-time priors are not sufficient.
- **0.2 Agentic-design claims require Anthropic sources only.** Critiques and prescriptions about how agents should behave, tool design, human oversight, Skill engagement, context engineering, etc., must cite Anthropic-owned domains (per [[reference-anthropic-agentic-docs]]). VS Code / MCP spec / Mocha source is *not* acceptable for agentic-design claims; only for capability claims (rule 0.1).
- **0.3 Lessons from prior iterations (don't relearn them).**
  - **v3→v4 lesson:** `chatSkills` contribution schema does not have a `when` clause. Engagement is description-driven per Anthropic Skills semantics. Verified via `code.visualstudio.com/docs/copilot/customization/agent-skills`.
  - **v4→v5 lesson:** Mocha v10 `Runner#fail` emits `EVENT_TEST_FAIL` synchronously **before** `Runner#hookUp(afterEach)`. State mutation in `afterEach` cannot retract the emitted failure event or decrement `Runner#failures`. Verified via `node_modules/.../mocha@10.8.2/lib/runner.js:825-828` and lib/context.js:80-86.

## 1. Problem and user

- **User**: QA engineers who use GitHub Copilot Chat in VS Code 100%. They write E2E web tests with **Mocha** as the test runner and an external browser launcher (their own helper, headed Chrome).
- **Pain today**: when a test fails, the browser is killed by teardown, so the QA cannot inspect or discuss the failure with the agent. The fallback is a manual repro loop with logging sprinkled around.
- **Goal**: when a Mocha test fails, hold execution at the failure point, keep the browser alive, and surface a full Playwright toolset attached to that same live browser to the Copilot agent. The QA converses with Copilot until the issue is understood, then chooses **Retry**, **Mark Passed** (human-only commit), or **Give Up**.

## 2. Architecture decision: VS Code Extension + Language Model Tools + narrowed MCP gate [R14#A]

The system ships as a single VS Code extension that:

1. Owns the Mocha lifecycle (spawn / observe / hold-on-fail / continue).
2. Owns the browser lifecycle (launch headed with `--remote-debugging-port=9222`, never closes on fail).
3. **Contributes the six `qa_*` verbs as `languageModelTools` in `package.json` and registers them on activation via `vscode.lm.registerTool` (extension/src/lm-tools/). Visibility is gated per-tool by `when: "qa-debug.paused"`. The MCP server boundary previously used for these verbs has been removed.** [R14#A]
4. **Continues to publish `playwright-mcp` (an external, third-party MCP server we do not own) via `McpServerDefinitionProvider` during pause; the provider's server list is narrowed from v5.6's `[playwright-mcp, qa-debug]` to `[playwright-mcp]` only.** [R14#A]
5. Surfaces a `qa-debug` Skill via the `chatSkills` contribution point, **always loaded**. Engagement is **description-driven** per Anthropic Skills semantics (`platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`) — the SKILL.md `description` is what Claude matches against the user turn. The `qa-debug.paused` VS Code context key, previously proposed in this architecture as a `chatSkills.when` gate (a field that does not exist in the contribution schema), is **repurposed**: it gates UI command enablement / Test Explorer button visibility AND `languageModelTools` visibility (since v5.14). The VS Code `chatSkills` contribution schema documents only `path` (pointing directly at the SKILL.md file per the page's canonical example); it does not have a `when` field. [**R3#A**]

### Why an extension (not a standalone MCP + scaffolded `.vscode/mcp.json`)

- `cdpEndpoint` of the paused browser is known only at runtime; a static config cannot rebind per failure. `registerMcpServerDefinitionProvider` is the only API that supports per-session re-binding for **playwright-mcp** (the remaining MCP server in v5.14+; see §3.4 [R14#A]).
- LSP-aware edits, Test Explorer UI, and debug session control are first-class only inside an extension.
- Workspace trust, secret storage, and the `chatSkills` contribution point require extension context.

### Why LM Tool API (not in-extension MCP server) for qa-debug verbs [R14#A]

v5.6 hosted the qa-debug verbs as an in-extension MCP server over Streamable HTTP loopback. v5.14 replaces that with first-party `vscode.lm.registerTool` because qa-debug exercises **none** of MCP's portability-protocol benefits (cross-host, cross-process, cross-runtime, community-installed, uniform capability discovery). Practical consequences: no HTTP transport, no bearer token, no `@modelcontextprotocol/sdk` dependency in the extension bundle, and policy-clean for organizations that disallow enabling MCP in VS Code.

### Phase 1 scope explicitly excludes

- chrome-devtools-mcp (deferred to phase 2).
- Parallel mocha mode (`--parallel`).
- Multi-window / multi-context Playwright sessions.

## 3. Components

```
┌──────────────────────────────────────────────────────────────┐
│ VS Code Extension (TypeScript)                               │
│                                                              │
│  ┌───────────────┐   spawn   ┌──────────────────────────┐    │
│  │ Session Mgr   │──────────▶│ mocha (child_process)    │    │
│  │               │           │  --require qa-hooks.js   │    │
│  │ pause-store   │◀──IPC─────│                          │    │
│  │ (durable)     │           └──────────────────────────┘    │
│  └───┬───────┬───┘                                           │
│      │       │ launch                                        │
│      │       ▼                                               │
│      │   ┌──────────────────────┐                            │
│      │   │ Chrome :9222         │  ← held on fail            │
│      │   └──────────────────────┘                            │
│      │                                                       │
│      │ on pause: open MCP gate                               │
│      │ on release: close gate, unregister                    │
│      ▼                                                       │
│  vscode.lm.registerMcpServerDefinitionProvider               │
│      │                                                       │
│      ├─▶ playwright-mcp   (cdpEndpoint=ws://:9222)           │
│      └─▶ qa-debug         (stdio, owned by extension)        │
│                                                              │
│  chatSkills contribution: qa-debug SKILL.md (always loaded; │
│  engagement is description-driven; qa-debug.paused context  │
│  key gates UI commands only) [R3#A]                         │
└──────────────────────────────────────────────────────────────┘
                       ▲
                       ▼
                  Copilot Chat (agent mode)
```

### 3.1 Mocha root hook plugin (`qa-hooks.cjs`) [R4#B]

```js
afterEach(async function () {
  if (this.currentTest.state !== 'failed') return;

  // Disable Mocha's runnable timeout for this hook — pause.publish + decision.await
  // is a human-paced debugging flow. User .mocharc timeouts (10-15s) are sized for
  // test-body assertions, not for inspecting a paused browser. Heartbeat below is
  // the real liveness watchdog. See "Why disable the hook timeout?" paragraph.
  this.timeout(0);

  // v5.16 — Mode C. Probe effectiveCdpPorts()
  // ([22135, 22136] default, overridable via QA_DEBUG_CDP_PORTS) per pause
  // via GET /json/version + /json/list. The pause publishes available_chromes
  // + selected_cdp_port: null + chrome_owner: 'framework'; cdp_ws_url is a
  // derived view-side field after qa_select_chrome / extension UI commits.
  const sessionId = await ipc.publishPause({
    test: this.currentTest.title,
    file: this.currentTest.file,
    line: this.currentTest.err?.stack?.match(/:(\d+):/)?.[1],
    error: serializeError(this.currentTest.err),
    available_chromes: await probeChromePorts(effectiveCdpPorts()),
    selected_cdp_port: null,
    chrome_owner: 'framework',
    started_at: Date.now(),
    retry_count: this.currentTest.currentRetry(),
  });

  const decision = await ipc.awaitDecision(sessionId, {
    heartbeatMs: 5_000,
    onAbandoned: 'give_up',     // hook resolves locally as { kind: 'give_up', reason: 'abandoned', by: 'hook' }
  });

  // The hook does NOT mutate test.state / test.err / parent.retries / currentTest.retries.
  // Mocha's `Runner#fail` emits EVENT_TEST_FAIL synchronously before this hook runs
  // (see lib/runner.js:825 → :828 in mocha@10.8.2). Outcome translation lives in the
  // `qa-reporter` reporter (§3.6), which subscribes to EVENT_TEST_FAIL and produces the
  // human-facing tally tri-state (passed / failed / marked-passed). [R4#B]
  //
  // The hook's sole job is: publish pause, await decision with heartbeat, IPC-acknowledge
  // the decision so the reporter can correlate by session_id and PauseStore can update UI.

  if (decision.kind === 'retry') {
    return;
  }
  // mark_passed and give_up: no mocha-side state change; the reporter renders the tri-state
  // outcome from the IPC decision payload via `last_proposal_status` and the session log.
});
```

The pause is published to the extension's durable `pause-store` (`Memento`-backed, keyed by `sessionId`). Mocha is never exposed to the agent as a long-blocking tool call.

**Why no state mutation?** [R4#B] Mocha v10's `Runner.prototype.fail` (lib/runner.js:423–465) synchronously sets `test.state = STATE_FAILED`, increments `Runner#failures`, and emits `EVENT_TEST_FAIL` at line 464. In `Runner#runTests`'s `self.runTest` callback (lines 800–836), `self.fail(test, err)` is invoked at line 825 — *before* `self.hookUp(HOOK_TYPE_AFTER_EACH, next)` at line 828. By the time `afterEach` runs, the failure event has already been broadcast to all attached reporters and `Runner#failures` is already incremented. State mutation cannot retract either side effect. Additionally, `this.retries(999)` inside `beforeEach` is a no-op because `Context.prototype.retries(n)` mutates `this.runnable()._retries`, and `this.runnable()` inside `beforeEach` returns the *hook*, not the upcoming test (lib/context.js:80–86; lib/runner.js:487/494). The Mocha-canonical way to enable retries from a hook is `this.currentTest.retries(n)`, which we deliberately do *not* use — the reporter handles tri-state outcomes without depending on retry budgets at all.

**Why no native mocha retries?** [R4#B] Even with `this.currentTest.retries(N)` set in `beforeEach`, the retry branch (lib/runner.js:814–823) creates `clonedTest = test.clone()` and `tests.unshift(clonedTest)` *before* `hookUp(afterEach)` runs at line 823. `Test.prototype.clone()` (lib/test.js:71–83, line 75) snapshots `this.retries()` at clone time; mutating the source test's `_retries` in `afterEach` does not propagate to the queued clone. For deterministic-failure tests, this means: with retries enabled, mocha loops the clone until the budget is exhausted; the hook cannot intercede. We therefore do *not* enable mocha's native retries. The `retry` decision is honored by the **extension** (S4), which re-invokes mocha against the same test file via `--grep <test title>` in a fresh child process — the held browser at `:9222` persists across child-process restart because the extension owns the Chrome lifecycle independently of the mocha lifecycle (see §3.4 / S4). In the S2 fake-oracle flow, the oracle simulates this by tracking the retry decision in its session ledger and emitting a follow-up mocha child invocation.

**Why disable the hook timeout?** Mocha's runnable timeout (default 2000ms; here 10s for `fixture-tests`, 15s for `fixture-tests-wdio`) is sized for test-body assertions, but the `afterEach` runnable here blocks on a human-paced decision (engineer inspects the paused browser via CDP, chooses `mark_passed` / `retry` / `give_up`). Leaving the timeout enabled lets Mocha kill the hook mid-debug, which causes the child to exit, the wdio session to be destroyed in cleanup, and the held Chrome window to close — defeating the entire pause-for-debug flow. `this.timeout(0)` disables only this hook's timeout (per Mocha v10 docs §timeouts). The liveness guarantee is preserved by the heartbeat protocol: the extension parent emits a `heartbeat` notification every `HEARTBEAT_MS` (5s); the hook abandons locally as `{ kind: 'give_up', reason: 'abandoned', by: 'hook' }` after `MAX_MISSED_HEARTBEATS` (3) consecutive intervals without one. The watchdog therefore tracks *parent liveness*, not user think-time — a user can take an arbitrary amount of time inspecting the browser as long as the extension process is alive and sending heartbeats.

**Why no `require.cache` invalidation in the retry branch?** [R5#A, v5.1] Since the retry runs in a different Node process (the `--grep` respawn child), in-process `require.cache` invalidation has no addressable target — the retry-process module cache starts empty by construction, so there is nothing for the original-process hook to invalidate. The hook therefore performs no in-process invalidation step. A future Phase 2 in-process retry mechanism (not in current scope) would re-introduce a need for cache invalidation — see the mandatory Phase 2 follow-up tracked in the `mocha-hooks/README.md` "Phase 2 follow-up" block for the evidence chain.

### 3.2 `qa-debug` MCP — tool surface

All tools are prefixed `qa_` under server `qa-debug`. **Agent-facing FQN is `qa-debug:qa_*`** per Skills best-practices format `<server>:<tool>` (`platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`). The page's two worked examples (`BigQuery:bigquery_schema`, `GitHub:create_issue`) reflect each server's self-registered name; we follow the same rule and use `qa-debug:qa_*` and `playwright-mcp:browser_*` because that is what `@playwright/mcp` self-identifies as and what we register `qa-debug` under via `vscode.lm.registerMcpServerDefinitionProvider`. The legacy double-underscore form `mcp__qa-debug__qa_*` is Claude-Code-internal logging/permission shape and is NOT used in author-facing Skill content. [**R3#B**] Tool descriptions follow third-person voice per Anthropic Skills authoring guidance [**R2#NB1**].

```yaml
- name: qa_get_failure_context
  description: |
    Returns the currently paused Mocha failure as a structured payload.
    Idempotent and safe to call multiple times. Returns null when no pause
    is active. Callers should invoke this first upon entering a debugging
    session to ground subsequent investigation. Also surfaces the verdict
    of any in-flight mark-passed proposal via `last_proposal_status`.    # [R2#Q1]
  params:
    session_id: string (optional; defaults to active)
    response_format: 'concise' | 'detailed'
  returns:
    test_title, file, line, failing_assertion,
    stack_trace: { frames: <=50 inline, more_at: resource_uri? },        # [R2#Q3]
    cdp_ws_url, screenshot_path?,
    console_logs: { lines: <=100 inline (<=8KB), more_at: resource_uri? },# [R2#Q3]
    paused_for_ms, retry_count, max_retries_remaining,
    last_proposal_status: 'none' | 'awaiting_human' | 'accepted' | 'rejected'
  errors:
    NO_ACTIVE_PAUSE — no test is currently paused
    SESSION_NOT_FOUND — sessionId does not match any pause

- name: qa_request_give_up
  description: |
    Stops retrying the paused test, marking it as a final failure. Mocha
    proceeds to the next test. `reason` is surfaced to the human inline.
    Reversible only by re-running the suite.                             # [R2#Q4]
  params:
    session_id: string
    reason: string

- name: qa_propose_mark_passed
  description: |
    Proposes marking the paused test as passed. Does NOT commit — surfaces
    a confirmation button to the human. Callers should reserve this for
    environmental flake signals, not for assertion failures against
    production code paths. After calling, the next correct step is to
    stop and report the proposal in chat; the verdict will surface via   # [R2#Q1]
    `qa_get_failure_context.last_proposal_status`.
  params:
    session_id: string
    rationale: string  # the human reads this verbatim; be specific
  returns:
    proposal_id, status: 'awaiting_human'

- name: qa_propose_abort_suite
  description: |
    Proposes aborting the remaining mocha suite. Does NOT commit —          # [R2#Q5]
    surfaces a confirmation button to the human. Destroys remaining
    test work for the current run.
  params:
    session_id: string
    rationale: string
  returns:
    proposal_id, status: 'awaiting_human'
```

The committing verbs `qa_commit_mark_passed`, `qa_commit_abort_suite` exist in IPC and are wired **only** to UI buttons. They are **not** exposed as MCP tools [**R1#1, R2#Q5**].

**On the absence of a retry verb (post-drop-retry).** Re-running after a fix is the user's action via Test Explorer ▶ Run, not an agent-callable verb. The pause + MCP gate stay attached after a proposed fix so the user can use playwright-mcp freely to verify, then commits a terminal verb (`mark_passed`, `give_up`) or re-runs the test row directly. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the rationale and the deletion record.

**On the absence of a close-browser verb.** Chrome is owned by the test framework (Mode C — `chrome_owner === 'framework'`). The companion does not destroy a Chrome it does not own; framework teardown (e.g., `browser.deleteSession()` for wdio) handles disposal at end-of-suite.

playwright-mcp tools (`browser_snapshot`, `browser_click`, `browser_evaluate`, etc., ~25 of them) are loaded as-is from `@playwright/mcp`. They register only while a pause is active — see §3.4.

### 3.3 `qa-debug` SKILL.md — procedural knowledge layer

Registered via the VS Code `chatSkills` contribution point. The contribution shape is (matching the canonical example on `code.visualstudio.com/docs/copilot/customization/agent-skills`, page dated 5/20/2026):

```json
{ "contributes": { "chatSkills": [ { "path": "./skills/qa-debug/SKILL.md" } ] } }
```

`path` points directly at the `SKILL.md` file. The `chatSkills` schema documents `path` only — no `id`, no `when`. (The page contains contradictory prose elsewhere about a "directory containing a SKILL.md", but its package.json registration section and worked example both use the file path.) [**R3#A**]

Engagement is **description-driven**: Claude matches the SKILL.md `description` against the user turn (per `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` and `code.claude.com/docs/en/skills`). The SKILL.md description is therefore the load-bearing engagement signal and must include both *what* the Skill does and *when* to use it — specifically, that it engages when a Mocha test is currently paused at a failure with a held browser available for live inspection.

The `qa-debug.paused` VS Code context key gates **UI affordances only** — Test Explorer button visibility, command enablement, status-bar indicators. It does not gate Skill engagement.

Content (frontmatter description in third person per R2#NB1; body in imperative voice — third-person voice in Skills best-practices is scoped to the description field):

- Step 1 (always): call `qa-debug:qa_get_failure_context` (concise) to ground the investigation.
- Decision tree:
  - Timeout → `playwright-mcp:browser_snapshot` + `playwright-mcp:browser_console_messages`.
  - Selector-not-found → `playwright-mcp:browser_snapshot` + `playwright-mcp:browser_evaluate` with `document.querySelectorAll(...)`.
  - Value mismatch → `playwright-mcp:browser_evaluate` reading the asserted value live; compare to expected.
- Guardrail: callers must not invoke `qa-debug:qa_propose_mark_passed` when the failing assertion's value is derived from production code paths. Mark-passed is reserved for environment/flake signals.
- Output style: agents should produce a one-line conclusion first, then evidence.
- After calling any `qa_propose_*` tool, the agent should pause and report in chat; verdicts surface via `qa-debug:qa_get_failure_context.last_proposal_status`.

### 3.4 Tool gating & lifecycle [R14#A — split between LM Tool API and MCP provider]

**qa-debug verbs (LM Tool API):**

- On extension activation: `registerQaDebugLmTools` registers the six tool classes via `vscode.lm.registerTool` (extension/src/lm-tools/index.ts). The registrations are always live across activations.
- Visibility is per-tool, controlled by the `when: "qa-debug.paused"` clause on each `languageModelTools` contribution in `extension/package.json`. VS Code re-evaluates the when-clause against current context keys when building the agent-mode tool list each request.
- `LanguageModelToolInformation` carries `{ name, description, inputSchema, tags }` only (vscode.d.ts:21126-21146); no `when` field reaches the model. The clause is a discovery filter, never a runtime gate. Once `invoke` is dispatched, the call runs to completion regardless of subsequent context-key changes; the tool body returns `NO_ACTIVE_PAUSE` via `pauseStore.getActivePause()` if the pause was cleared between dispatch and execution.
- No `lm.onDidInvokeTool` event exists (vscode.d.ts:20779-20813); per-tool audit logging happens via `appendInfo` from inside each tool's `invoke` (extension/src/lm-tools/base.ts).

**playwright-mcp (MCP provider — preserved from v5.6):**

- On extension activation: the `McpServerDefinitionProvider` is registered with an empty server list.
- On pause publish: provider returns `[playwright-mcp(cdpEndpoint=ws://:9222)]`; `onDidChangeMcpServerDefinitions` fires.
- On release: provider returns `[]`; change event fires again.

**Combined surface:**

- Tool count cap during pause: ~25 (playwright) + 6 (qa-debug) = ~31. Zero at idle. The Tool Search Tool threshold analysis from v5.6 is preserved verbatim — total during-pause tool count is unchanged, token-budget triggers unchanged, deferral to Phase 2 unchanged. [**R3#A** companion note, **R3#C**]
- The `qa-debug` SKILL itself is *not* gated through MCP. Skill engagement is **description-driven** per Anthropic Skills semantics (see §3.3); the `qa-debug.paused` VS Code context key gates UI affordances AND `languageModelTools` visibility (since v5.14). [**R3#A**, **R14#A**, replaces R2#Q2 framing]

### 3.5 IPC, pause-store, and observability

- **IPC**: JSON-RPC 2.0 envelopes over one of two transports. v5.18 task-terminal mode (the extension's only mode): the extension runs mocha as a VS Code task (`ProcessExecution` in a dedicated terminal) and is therefore NOT its parent — it listens on a per-run named pipe (win32) / tmpdir unix socket (POSIX) and qa-hooks dials back to the path in `QA_DEBUG_IPC_ENDPOINT`, speaking NDJSON lines (`ndjsonSocketTransport`). Legacy/oracle mode: Node's built-in `ipc` channel (parent spawns mocha child with `stdio: [..., 'ipc']`; both ends use `process.send` / `process.on('message')`) [R4#C]. Either way the mocha child's stdout/stderr stay clean for human-readable mocha output and the `qa-reporter` (§3.6) — in task mode they render directly in the QA's terminal. Heartbeat every 5s; the hook resolves locally as `{ kind: 'give_up', reason: 'abandoned', by: 'hook' }` after 3 missed heartbeats per `onAbandoned: 'give_up'`.
- **Pause-store**: `Memento` (extension-global state) keyed by `sessionId`. Survives Copilot Chat restart but not VS Code restart (intentional for phase 1).
- **Observability** [**R2#Q4**]: every decision `reason` / `rationale` is rendered inline in
  - the chat notification (e.g., *"Agent requested retry — reason: 'selector updated to .new-class'"*),
  - the Test Explorer failure annotation,
  - the extension's audit log channel,
  - the `qa-reporter` stdout summary at end-of-run (§3.6).
- **Cancellation**: if the extension shuts down with an active pause, the next mocha tick after timeout treats the pause as abandoned per `onAbandoned`.

### 3.6 `qa-reporter` Mocha reporter [R4#B]

The `qa-reporter` is a Mocha reporter packaged alongside the hook (`@qa-debug/mocha-hooks/qa-reporter`). It is the **single source of truth for human-facing outcome rendering** — stdout summary, Test Explorer state, audit log channel. Mocha's built-in reporters (`spec`, `dot`, `json`, etc.) are not used in QA-debug runs; `mocha --reporter @qa-debug/mocha-hooks/qa-reporter` is the canonical invocation.

**Subscribed events (Mocha v10 names):**
- `EVENT_RUN_BEGIN` — initialize tally.
- `EVENT_TEST_BEGIN` — log session start.
- `EVENT_TEST_PASS` — render `✓` and increment passed count.
- `EVENT_TEST_FAIL` — *intercept and defer*. Do not increment failed count yet; instead correlate with PauseStore by `(file, title)` and wait for the IPC decision to land. The hook's `decision.await` round-trip is already complete by the time `EVENT_TEST_FAIL` fires (because afterEach ran first; see §3.1), so the reporter can look up the decision synchronously via the shared in-process PauseStore (S3+/S4) or via a final-decision IPC message from the oracle (S2).
- `EVENT_TEST_RETRY` — render retry annotation (only for any future native-retry use; not used by Phase 1 directly).
- `EVENT_TEST_END` — render the final outcome per the tri-state below.
- `EVENT_RUN_END` — render summary tally.

**Tri-state outcome rendering:**
- `passed` — test fn returned cleanly. Count as passed in the tally and exit code.
- `failed` — test fn threw; decision was `give_up` (or no decision recorded, e.g., for tests that fail outside the QA-debug session). Count as failed in the tally and exit code.
- `marked-passed` — test fn threw; human committed `qa_propose_mark_passed` via UI. Rendered as `✓ marked-passed by <user>: <rationale>` in stdout AND in the Test Explorer annotation. **CI exit-code semantics:** marked-passed tests do *not* decrement `process.exitCode`; the run exits non-zero whenever `failed + marked-passed > 0`, unless the explicit `--qa-treat-marked-as-passing` reporter option is set. This preserves CI-conservatism: a freshly-failed test reported as marked-passed by a human reviewer in interactive QA still shows up as a build-breaking signal in headless CI, unless the team opts in to the relaxed semantics.

**Why the reporter and not state mutation?** See §3.1's "Why no state mutation?" paragraph — the reporter is the architecturally clean alternative because it consumes Mocha's documented event surface rather than mutating internal state that `Runner#fail` has already broadcast to all subscribers.

**Reporter does not bypass propose/commit gates.** The reporter only renders outcomes that have *already* been committed (or rejected) through the §3.2 propose/commit verbs. The reporter is read-only with respect to PauseStore.

**Reporter is for humans, not for the agent.** Verdicts back to the agent flow through `qa-debug:qa_get_failure_context.last_proposal_status` (§3.2) — high-signal structured data per `anthropic.com/engineering/writing-tools-for-agents`. The reporter's stdout is human-facing noise the agent must not poll. [R4#D]

**Reporter↔hook coordination in S2** [R4#E]: the in-process PauseStore is not available (the oracle is a separate child of the parent shell, not the in-process extension). The S2 fake oracle correlates by emitting a `final_decision(session_id, kind, by, reason)` IPC notification immediately after the `decision.await` response; the reporter subscribes to that notification via the same IPC channel and uses it to render the tri-state outcome before `EVENT_RUN_END`. S4 simplifies this: the extension's in-process PauseStore is queried directly.

## 4. Failure-pause loop (sequence)

1. User clicks Run in Test Explorer or invokes `@qa run` in chat.
2. Extension launches Chrome `:9222`, then `mocha --require qa-hooks.cjs --reporter @qa-debug/mocha-hooks/qa-reporter` [R4#B].
3. Test `T` fails → mocha's `Runner#fail` emits `EVENT_TEST_FAIL` (the reporter intercepts and defers tri-state rendering); afterEach hook publishes pause with a new `sessionId`.
4. Extension opens the MCP gate (registers playwright-mcp + qa-debug); SKILL.md is already loaded and Claude's description-match engages it on the next user turn that mentions the failure (Skill engagement is description-driven, not gated by a `when` clause — see §3.3). The `qa-debug.paused` context key concurrently enables the Test Explorer commit buttons. [**R3#A**]
5. Chat notification: *"Test T failed at line 42. Browser held at :9222. Ask anything."*
6. Agent flow:
   - Call `qa_get_failure_context` (concise) to ground.
   - Use `browser_snapshot`, `browser_evaluate`, etc., to investigate.
   - Edit files via Copilot's built-in edit tools when warranted.
7. Closing turn:
   - For code-bug / test-bug: agent proposes the fix in chat and hands back — the user re-runs via Test Explorer ▶ Run after applying the edit. No agent-callable retry verb.
   - For env-flake / structural / cross-repo ambiguity: agent calls `qa_propose_mark_passed` / `qa_propose_abort_suite` / `qa_request_give_up` with a rationale.
8. On decision: hook's `decision.await` returns; hook publishes a `final_decision` IPC notification to the reporter; extension closes the MCP gate; provider returns `[]`. The reporter renders the tri-state outcome (passed / failed / marked-passed) at `EVENT_TEST_END`.

## 5. Concrete tech stack [R14#A]

- **Language**: TypeScript (extension + qa-debug-mcp stdio CLI for evals + new shared @qa-debug/tool-contracts package).
- **MCP SDK**: `@modelcontextprotocol/sdk` — present only in `qa-debug-mcp/` (stdio CLI for evals harness) and `evals/` (consumer). **Removed from `extension/`** as of v5.14.
- **VS Code APIs**:
  - `vscode.lm.registerTool` + `contributes.languageModelTools` — qa-debug verbs (new in v5.14)
  - `vscode.lm.registerMcpServerDefinitionProvider` + `onDidChangeMcpServerDefinitions` — playwright-mcp branch only (since v5.14)
  - `chatSkills` contribution point (schema: `{ path: "<path-to-SKILL.md>" }` only — no `when`, no `id`; engagement is description-driven, see §3.3) [**R3#A**]
  - `vscode.tests.*` (Test Controller)
  - `vscode.tasks.*` or raw `child_process.spawn`
  - `vscode.debug.*` (phase 2)
- **Workspace packages:**
  - `@qa-debug/tool-contracts` — shared spec records + error taxonomy. Consumed by extension (LM tool classes) and qa-debug-mcp (stdio MCP CLI). New in v5.14 — extracted from `qa-debug-mcp/src/{errors,tools}.ts`.
  - `@qa-debug/qa-debug-mcp` — stdio MCP CLI for evals harness. No longer consumed by `extension/` since v5.14.
- **Mocha**: `^10.7` (verified against `mocha@10.8.2` runner.js capabilities per [R4#A] rule). `--require` for root hooks, `--reporter @qa-debug/mocha-hooks/qa-reporter` for tri-state outcome rendering (§3.6). [R4#B]
- **Playwright MCP**: `@playwright/mcp` configured via JSON with `browser.cdpEndpoint`.

## 6. Status

v2 was APPROVED by Reviewer #2. v3 applied R2#NB1, R2#NB2, and answers to R2#Q1–Q5. v3 was treated as implementation-ready, but a Ralph-loop iteration #2 surfaced four mismatches with current published guidance:

- **R3#A** — VS Code `chatSkills` schema has no `when` field; engagement is description-driven per Anthropic Skills semantics. §1, §3.3, §3.4, §5 updated; `qa-debug.paused` context key repurposed to UI-affordance gating only.
- **R3#B** — MCP FQN form in §3.3 switched from `mcp__server__tool` (Claude-Code-internal) to `server:tool` (Skills best-practices format).
- **R3#C** — `qa_wait_for_pause` removed from §3.2; description-driven engagement makes the long-poll redundant. Tool count cap in §3.4 dropped from ~32 to ~31.
- **R3#D** — historical: `qa_propose_close_browser` was kept behind a UI commit gate; the verb was dropped entirely when retry was removed (Chrome is framework-owned under Mode C), so the defense no longer applies.

**v4 APPROVED by Ralph-loop reviewer #4 on 2026-05-20.** v5 was triggered during S2 implementation when mocha v10's `Runner#fail` event-emission order was empirically verified against runner.js source — making §3.1's state-mutation pattern unworkable. Reviewer iteration #1 returned APPROVE-with-polish (recommending Option A custom reporter) on 2026-05-20:

- **R4#A** — Added §0 "Engineering rules" with the capability-claim-citation requirement (rule 0.1) and the agentic-design-source restriction (rule 0.2). Codifies the lesson from v3→v4 (chatSkills schema) and v4→v5 (mocha runtime).
- **R4#B** — Adopted Option A: dropped state-mutation lines from §3.1; added §3.6 `qa-reporter` Mocha reporter as the single source of truth for human-facing outcome rendering. Tri-state tally (passed/failed/marked-passed) with CI-conservative exit-code semantics. Mocha tech stack updated to `^10.7`.
- **R4#C** — IPC clarified in §3.5: JSON-RPC envelopes carried over Node's `ipc` channel (stdio[3]), not over mocha's stdin/stdout. This keeps mocha's stdout free for the reporter and matches the implementation in `mocha-hooks/src/protocol.ts`.
- **R4#D** — §3.6 explicitly separates human observation surface (reporter stdout) from agent observation surface (`qa_get_failure_context.last_proposal_status`) per `anthropic.com/engineering/writing-tools-for-agents` (Sep 11 2025) high-signal principle.
- **R4#E** — §3.6 covers reporter↔hook coordination in S2 (oracle emits `final_decision` IPC notification) vs S4 (in-process PauseStore query). Lands as a bullet at the end of §3.6.

**v5 APPROVED by Ralph-loop reviewer #5 on 2026-05-20.** Iteration #1 returned APPROVE-with-polish (5 non-blocking items); iteration #2 returned APPROVE clean (3 cosmetic doc sweeps flagged, swept inline, "do not warrant a third iteration"). Implementation may resume against v5 §3.1 / §3.6 contracts.

**v5.1 APPROVED by Ralph-loop reviewer #6 on 2026-05-21.** Scope: §3.1 retry branch only — removed the `invalidateRequireCache(file)` call after S2 implementation found it is a no-op in the v5 `--grep` respawn retry flow (mocha-hooks/README.md "Phase 2 follow-up" block carries the evidence chain). Iteration #1 returned APPROVE-with-polish (4 non-blocking items addressing doc bidirectional cross-reference, README evidence retention, citation swap to Skills "Old patterns" idiom, and §3.1 addressable-target prose); iteration #2 returned APPROVE clean. Mandatory Phase 2 follow-up tracked in the mocha-hooks/README.md "Phase 2 follow-up" block — restoring cache invalidation is a hard prerequisite for any future in-process retry mechanism.

- **R5#A** — Removed `invalidateRequireCache(this.currentTest.file)` from §3.1 retry branch (pseudocode + qa-hooks.ts). Added the "Why no `require.cache` invalidation in the retry branch?" paragraph in §3.1 documenting the addressable-target framing and pointing to the Phase 2 follow-up.

**v5.14 APPROVED by Ralph-loop reviewer on 2026-05-22** (iter#2). Scope: §2, §3.2 host (verb contracts unchanged), §3.4, §3.5 audit prefix, §5 tech stack. Driver: target organization disallows enabling MCP in VS Code; LM Tool API is the right primitive for a single-host, single-language, single-owner verb set. Iteration #1 reviewer returned REVISE-with-blockers (B1 unenumerated `QaToolError` production import; B2 `qa-debug:` occurrence miscount + missed `commands.ts:171` + `playwright-mcp:` colon-form survival unclarity; B3 propose/commit→`prepareInvocation` collapse lacked canonical-surface decision + lost-race semantics). Iteration #2 reviewer returned APPROVE-with-polish (4 cosmetic items, all swept inline). Q-A through Q-H resolved; Q-G (`qa-debug-mcp` package rename) deferred to v5.8.

- **R14#A** — qa-debug verbs migrated from in-extension MCP server (HTTP loopback, `@modelcontextprotocol/sdk`) to VS Code Language Model Tool API (`vscode.lm.registerTool` + `contributes.languageModelTools`). New workspace package `@qa-debug/tool-contracts` carries shared spec/errors. `extension/src/qa-debug-server.ts` deleted; `mcp-provider.ts` narrowed to playwright-mcp only; six `extension/src/lm-tools/*.ts` classes added. propose/commit split collapsed to `prepareInvocation` confirmation chips for the three asset-destructive verbs, with the Test Explorer commit button preserved as the canonical human-initiated surface (dual-surface, both writing through `DecisionRouter.commit`; lost-race inherits v5.6 `PAUSE_ALREADY_RESOLVED`). Audit log prefix changed from `[qa-debug-mcp]` to `[qa-debug-lm]` for the in-extension path; the stdio MCP CLI keeps the old prefix on its own audit surface.
