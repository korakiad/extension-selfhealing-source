# ARCHITECTURE v5.14 — Change Request: replace gated dynamic MCP registration with VS Code Language Model Tool API

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> Status: **Iteration #2 (file)** 2026-05-22. Iter#1 reviewer returned **REVISE-with-blockers** (3 blockers: B1 unenumerated `QaToolError` production import from `extension/src/pause-store.ts:29`; B2 `qa-debug:` occurrence-count miscount in §3.3 + missed `commands.ts:171` prefilled-chat string + ambiguity about `playwright-mcp:` colon-form survival; B3 propose/commit→`prepareInvocation` collapse lacked an explicit canonical-surface decision and lost-race semantics). All three blockers addressed inline below; tag **[I2#n]** marks iter#2 changes. Iter#1 polish items P1–P4 also folded (Q-D, Q-F, Q-H resolved → dropped from open list; Q-E resolved by extraction commitment in §3.1/§5). Iter#1 reviewer notes preserved at §8.
>
> **Driver.** Two user-stated concerns from the 2026-05-22 session that compound:
>
> 1. **Policy:** the deploying organization disallows enabling MCP in VS Code. The current architecture (§2 "Extension + gated dynamic MCP registration") therefore cannot ship as-is for the target user.
> 2. **Right primitive:** `vscode.lm.registerTool` + the `languageModelTools` contribution point is a first-party VS Code extension surface that exposes tools to Copilot agent mode *without* an MCP server. For a single-host, single-language, single-owner stack like qa-debug — where every justification for MCP's portability protocol (cross-host, cross-process, cross-runtime, community-installed) is *not* exercised — MCP is the wrong abstraction layer.
>
> v5.14 reframes the architecture around LM Tool API for the qa-debug verbs while keeping `chatSkills` + the chat-participant + the qa-reporter + qa-hooks IPC unchanged. **playwright-mcp** remains an MCP server because we do not own it; the `McpServerDefinitionProvider` gate survives but shrinks to a single-element list.
>
> Scope: ARCHITECTURE §2 (architecture decision rewrite), §3.2 (tool surface — same verbs, new host), §3.4 (gating model — `when`-clause on tool contributions replaces `onDidChangeMcpServerDefinitions`), §3.5 (audit observability — host-side `onInvocation` callback path changes), §5 (tech stack — drop in-extension MCP server, add LM Tool API). NO changes to: §3.1 qa-hooks IPC, §3.3 chatSkills/SKILL.md mechanism (content does change — tool-reference names), §3.6 qa-reporter.
>
> **Process discipline.** Per [[feedback-research-source]] every capability claim cites `node_modules/` or `code.visualstudio.com` (verified 2026-05-22 via context7). Per [[feedback-plan-style]] this CR documents **module boundaries, type signatures, contribution-point shape, lifecycle order, deletion list** — the Implementor is expected to read the lib for body-level detail.

## 0. Sources (per ARCHITECTURE v5 §0.1 / §0.2)

### Capability sources — VS Code Language Model Tool API (§0.1)

All citations against `code.visualstudio.com` (verified 2026-05-22 via context7-resolved library `/websites/code_visualstudio_api`):

- **`vscode.lm.registerTool(name, tool): Disposable`** — `code.visualstudio.com/api/references/vscode-api` (lm namespace). *"Registers a `LanguageModelTool`. The tool must also be registered in the `package.json` `languageModelTools` contribution point. A registered tool is available in the `lm.tools` list for any extension to see. But in order for it to be seen by a language model, it must be passed in the list of available tools in `LanguageModelChatRequestOptions.tools`."* — implication: registration alone is necessary but not sufficient; the chat host (Copilot agent mode in our case) is responsible for handing the tool to the model. Copilot agent mode does this automatically for all `languageModelTools` whose `when` clause evaluates true. Confirmed at `code.visualstudio.com/api/extension-guides/ai/tools` ("Registering a Language Model Tool" section).

- **`languageModelTools` contribution point** — `code.visualstudio.com/api/extension-guides/ai/tools` ("Detailed Language Model Tool Definition"). Schema (verbatim from the page's canonical example):
  ```jsonc
  "contributes": {
    "languageModelTools": [{
      "name": "extensionPrefix_verbName",       // required; convention {verb}_{noun} per the page
      "tags": ["..."],                          // optional; tool-discovery + grouping
      "toolReferenceName": "shortName",         // optional; required iff canBeReferencedInPrompt
      "displayName": "Human-readable",          // required
      "modelDescription": "...",                // required; what the LLM reads to decide when to call
      "userDescription": "...",                 // optional; what the human reads in confirmation UI
      "canBeReferencedInPrompt": true,          // optional; enables #toolReferenceName user reference
      "icon": "$(codicon)",                     // optional
      "when": "context-key-expr",               // optional; gates visibility
      "inputSchema": { ... }                    // optional; JSON schema for invoke input
    }]
  }
  ```

- **`when` clause on `languageModelTools`** — `code.visualstudio.com/api/extension-guides/ai/tools` ("Basic Language Model Tool Configuration"): *"The 'when' clause restricts when the tool is accessible, for example, only when debugging is active."* — load-bearing for §3.4 rewrite; replaces `onDidChangeMcpServerDefinitions` as the gating mechanism. Context-key shape matches other VS Code `when` consumers (`/api/references/when-clause-contexts`).

- **`LanguageModelTool<T>` interface** — `code.visualstudio.com/api/references/vscode-api`. Two methods:
  - `invoke(options: LanguageModelToolInvocationOptions<T>, token: CancellationToken): ProviderResult<LanguageModelToolResult>` — *"The provided LanguageModelToolInvocationOptions.input has been validated against the declared schema."*
  - `prepareInvocation(options: LanguageModelToolInvocationPrepareOptions<T>, token: CancellationToken): ProviderResult<PreparedToolInvocation>` — optional; *"Can also signal that a tool needs user confirmation before running, if appropriate. Must be free of side-effects. A call to `prepareInvocation` is not necessarily followed by a call to `invoke`."*

- **`PreparedToolInvocation.confirmationMessages`** — `code.visualstudio.com/api/extension-guides/ai/tools` ("Providing Tool Confirmation Messages"). Returning a `{ title, message }` object causes VS Code to show a Continue/Cancel dialog (or in-chat chip) before `invoke` runs. **This is the native replacement for the propose/commit split in ARCHITECTURE §3.2** — see §2.3 below.

- **`LanguageModelToolResult`** = `new LanguageModelToolResult([new LanguageModelTextPart(string)])` — return shape from `invoke`. Source: the "Implementing the Tool Invoke Method" example on `/api/extension-guides/ai/tools`.

- **`vscode.commands.executeCommand('setContext', key, value)`** — `code.visualstudio.com/api/references/when-clause-contexts` ("Add Custom When Clause Context"). The mechanism we use to flip `qa-debug.paused` (already wired at session-manager.ts:268,336 per [[ARCHITECTURE-CR-v5.6.md]] §0 citation chain).

### Capability sources — MCP boundary remaining (§0.1)

- **`vscode.McpStdioServerDefinition`** + **`vscode.lm.registerMcpServerDefinitionProvider`** — preserved verbatim from ARCHITECTURE §3.4 / S4_DESIGN §4. The provider continues to publish `playwright-mcp` during pause; `qa-debug` is **removed** from its server list.

### Agentic-design sources (§0.2)

- **Tool descriptions, third-person voice, return-shape disclosure, error taxonomy** — Anthropic `anthropic.com/engineering/writing-tools-for-agents` (Sep 11 2025). Already applied to the six qa_* tool defs at `qa-debug-mcp/src/tools.ts:60-296`. v5.14 reuses the same `description` text verbatim as `modelDescription` in `languageModelTools` contributions; no new agentic prescription introduced.

- **Confirmation by impact severity** — `anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents` (Aug 4 2025), already cited in ARCHITECTURE §3.2 for the propose/commit gate on `qa_propose_close_browser`. v5.14 §2.3 inherits the same asymmetry framing for `prepareInvocation.confirmationMessages` — only the implementation primitive changes; the human-approval principle does not.

## 1. Why MCP is the wrong abstraction here (motivation extract)

Recapping the 2026-05-22 discussion for the file:

MCP is a **portability protocol**, not a "remote server protocol". It defines a JSON-RPC contract so the same tool implementation works across many hosts (Claude Desktop, Claude Code, Cursor, Zed, VS Code Copilot, ChatGPT desktop), often via stdio subprocess. Its value comes from five axes:

1. Cross-host portability (one impl, many hosts).
2. Process isolation (crash isolation, runtime isolation, dependency isolation, release-cycle isolation).
3. Language isolation (e.g., Python tool in a TS extension).
4. User-installable independent of host extension.
5. Uniform capability discovery (sampling, resources, prompts).

qa-debug exercises **zero** of those axes:

| Axis | qa-debug situation |
|---|---|
| 1. Cross-host | VS Code only. No plan to ship Claude Desktop / Cursor variants. |
| 2. Process isolation | All six tools are in-process reads/writes against `MementoPauseStore` + `DecisionRouter` — both extension-internal singletons. The in-extension HTTP MCP host (`extension/src/qa-debug-server.ts`) already runs *inside* the same extension host process; there is no real isolation. |
| 3. Language isolation | TypeScript on both ends. |
| 4. User-installable | The extension ships the tools; no separate install. |
| 5. Uniform discovery | Single host (Copilot agent mode); no multi-host capability negotiation. |

We pay for that unused portability with: an HTTP server bound to 127.0.0.1, a Streamable HTTP transport, a per-activation bearer token, `McpServerDefinitionProvider` indirection, the `@modelcontextprotocol/sdk` dependency, an `mcpServerDefinitionProviders` contribution, and (most acutely) **a configuration the target organization's policy disallows**.

**The Implementor should treat v5.14 as removing a layer rather than rewriting a layer.** Tool *contracts* (names, schemas, descriptions, error taxonomy) are unchanged. Tool *host* moves from "in-extension MCP server reached via HTTP" to "extension-direct `vscode.lm.registerTool`".

## 2. Architecture decision (rewrites ARCHITECTURE §2)

### 2.1 Replace "gated dynamic MCP registration" with "extension-contributed Language Model Tools + when-gated visibility"

ARCHITECTURE §2 reads: *"the system ships as a single VS Code extension that ... registers MCP servers conditionally per pause via `vscode.lm.registerMcpServerDefinitionProvider` and `onDidChangeMcpServerDefinitions`"*.

v5.14 replaces that clause with:

> The system ships as a single VS Code extension that:
>
> 1. Owns the Mocha lifecycle (spawn / observe / hold-on-fail / continue) — unchanged.
> 2. Owns the browser lifecycle (held `:9222` headed Chrome) — unchanged.
> 3. **Contributes the six `qa_*` verbs as `languageModelTools` in `package.json` and registers them on activation via `vscode.lm.registerTool`. Visibility is gated per-tool by `when: "qa-debug.paused"`, the same context key already used for UI command enablement.**
> 4. **Continues to publish `playwright-mcp` (an external, third-party MCP server we do not own) via `McpServerDefinitionProvider` during pause; the provider's server list shrinks from `[playwright-mcp, qa-debug]` to `[playwright-mcp]` only.**
> 5. Surfaces a `qa-debug` Skill via the `chatSkills` contribution point — unchanged mechanism, content references updated in §3.3.

### 2.2 The qa-debug verb host moves from MCP to LM Tool API

Before (v5.6):
```
Agent → Copilot MCP client → HTTP transport → in-extension qa-debug MCP server → tool handler → pauseStore/decisionRouter
```

After (v5.14):
```
Agent → Copilot agent-mode tool call → LanguageModelTool.invoke → pauseStore/decisionRouter
```

Two fewer hops, no HTTP socket, no bearer token, no Streamable transport. The contract the agent sees (`name`, `inputSchema`, `description`, return shape) is preserved byte-for-byte except where §2.3 narrows it.

### 2.3 propose/commit split: dual-surface decision, with prepareInvocation as the agent-routed gate [I2#A — replaces iter#1 §2.3]

ARCHITECTURE §3.2 separates the three reversible-asset verbs into **propose** (agent-callable, writes a proposal into PauseStore as `awaiting_human`, surfaces a Test Explorer commit button) and **commit** (UI-button-only, calls `DecisionRouter.commit` directly). The propose verb returns `{ proposal_id, status: 'awaiting_human' }`; under v5.6 the agent polls `qa_get_failure_context.last_proposal_status` for the verdict, and the human-direct surface is the Test Explorer commit button.

Iter#1 collapsed this to a single `prepareInvocation`-gated invocation and described the result as a clean simplification. Iter#1 reviewer correctly pushed back: the **location** of the human-approval surface is part of the §3.2 framing, not an implementation detail. Moving the gate from the failing-test row (where the human is actively debugging the held browser) into the chat thread (where the agent lives) re-locates approval away from the asset, and ARCHITECTURE §3.2 cites `anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents` (Aug 4 2025) precisely on severity-by-domain — DOM/console/network are the human's own surface.

**v5.14 iter#2 commits to a dual-surface model with explicit canonical roles:**

| Surface | Initiator | Mechanism | Writes through | When to use |
|---|---|---|---|---|
| **Test Explorer commit button** (preserved from v5.6 §3.8) | Human, directly | `qa-debug.markPassed` / `qa-debug.giveUp` / `qa-debug.retry` registered VS Code commands | `DecisionRouter.commit(sessionId, kind, reason, 'user')` | Human acts spontaneously while inspecting the failing test row; no agent in the loop. Canonical for human-initiated commits — the gate lives on the asset. |
| **`prepareInvocation` confirmation chip** (new in v5.14) | Agent | `qa_propose_*` tool's `prepareInvocation` returns `confirmationMessages: { title, message }`; on Continue, `invoke` runs and commits | `DecisionRouter.commit(sessionId, kind, rationale, 'agent')` | Agent has investigated and recommends an asset-destructive action; user must approve at the chat surface to commit. Canonical for agent-initiated commits. |

**Both surfaces converge on `DecisionRouter.commit`** — the existing v5.6 lost-race story is preserved verbatim. If a Test Explorer click lands first, the subsequent agent-side `invoke` (after the user clicked Continue on the chip) calls `commit`, which returns `false`, and the tool body throws `PAUSE_ALREADY_RESOLVED` exactly as `qa-debug-mcp/src/server.ts:133-138` does today. The race semantics live in `DecisionRouter`, not in the tool host, so the MCP→LM migration does not change them. Per `anthropic.com/engineering/writing-tools-for-agents` ("high-signal information back to agents"), `PAUSE_ALREADY_RESOLVED` is the structured rejoinder that lets the agent reground via `qa_get_failure_context` rather than re-issue.

**Polled-status verb stays.** `qa_get_failure_context.last_proposal_status` keeps its v5.6 semantics — *useful* even with `prepareInvocation` in play, because the agent may invoke `qa_propose_*`, the user may take a long time at the confirmation chip, and the agent's subsequent turns may want to know "is my proposal still awaiting?" without re-firing. The proposal slot in PauseStore is now updated by the propose verb's `invoke` (not `prepareInvocation`, which is side-effect-free per `code.visualstudio.com/api/references/vscode-api`), and the resolved-status is set by `DecisionRouter.commit` on the Continue branch. The user's Cancel branch on the chip surfaces back to the agent as a regular `LanguageModelToolResult` carrying `status: 'rejected'`; this is structurally cleaner than v5.6's "agent polls until status flips" because the `invoke` only completes after the user's decision, but the polled-status path remains because the agent may want to check state from a future turn (e.g., after a context window switch).

**Why this preserves the ARCHITECTURE §3.2 asymmetry argument** (responding to iter#1 B3). The published defense rests on three claims:
1. The human approves *destruction of their own debugging asset* — preserved: the chip body (per §0 `LanguageModelToolConfirmationMessages.message`) names the asset (DOM/console/network) and the agent-supplied `rationale`.
2. Approval is by *impact severity*, not blanket per-action — preserved: only the three `qa_propose_*` verbs ship `prepareInvocation`; `qa_request_retry/give_up` and `qa_get_failure_context` do not (see Q-B-resolved below).
3. The friction is justified because the alternative is destruction — preserved: `anthropic.com/research/measuring-agent-autonomy` (Feb 18 2026) cautions against confirmation on every action, not against confirmation on asset-destructive ones.

The chip's location in chat (vs. on the test row) is a UX surface choice the user already lives with whenever Copilot agent mode runs *any* destructive tool from any extension. The Test Explorer commit button survives as the alternative for users who prefer to act on the asset directly. **Implementor:** both surfaces must be available simultaneously during pause — neither hides when the other is engaged; only `DecisionRouter` arbitrates the commit.

**Q-A resolved.** Dual surface, both write through `DecisionRouter.commit`, lost-race semantics inherited from v5.6.

**Q-B resolved [I2#B].** Author's (i) stands: `qa_request_retry` / `qa_request_give_up` ship without `prepareInvocation`. Failure mode of an unwanted retry is "test re-runs with held browser" — cheap to undo, fully audited via `reason`. Symmetry argument loses to `anthropic.com/research/measuring-agent-autonomy` friction warning.

## 3. Components (rewrites ARCHITECTURE §3.2 / §3.4; §3.1, §3.3 content, §3.5, §3.6 noted)

### 3.1 Module map (new files / modified files / deleted files) [I2#C — Q-E resolved in-CR; shared spec/errors extraction promoted from follow-up to required scope]

```
NEW WORKSPACE PACKAGE: @qa-debug/tool-contracts
  Holds the shared tool spec records + error taxonomy, consumed by both the
  extension (LM tool classes) and qa-debug-mcp (evals-only stdio MCP server).
  Promotes iter#1 Q-E from "open" to "in scope for this CR" — iter#1 B1
  showed that extension/src/pause-store.ts:29 imports QaToolError from
  @qa-debug/qa-debug-mcp/pause-store today; deleting the workspace dep
  without the extraction breaks production type-check.

pause-store-types/          [UNCHANGED — already a shared workspace package]

tool-contracts/             [NEW workspace package: @qa-debug/tool-contracts]
├── package.json            [NEW] declares @qa-debug/tool-contracts; zero runtime deps beyond zod
├── tsconfig.json           [NEW]
└── src/
    ├── errors.ts           [MOVED FROM qa-debug-mcp/src/errors.ts verbatim]
    │                       Exports: QaErrorCode, QaToolError, errorResult
    └── tools.ts            [MOVED FROM qa-debug-mcp/src/tools.ts verbatim]
                            Exports: QaToolJsonSchema, JsonSchemaProp,
                            QaToolAnnotations, QaToolDef, the six
                            qa_* QaToolDef records, qaTools, QaToolName,
                            QA_TOOL_NAMES.

qa-debug-mcp/               [MODIFIED — now depends on @qa-debug/tool-contracts]
├── package.json            [MODIFIED] add @qa-debug/tool-contracts workspace dep; remove local tools.ts / errors.ts source files (they moved)
└── src/
    ├── errors.ts           [DELETED — moved to tool-contracts/]
    ├── tools.ts            [DELETED — moved to tool-contracts/]
    ├── pause-store.ts      [MODIFIED] re-export QaToolError from @qa-debug/tool-contracts (keep the existing surface so InMemoryPauseStore consumers don't break); imports tool defs from @qa-debug/tool-contracts
    └── server.ts           [MODIFIED] imports tool defs + errorResult from @qa-debug/tool-contracts (cosmetic; no behavioral change)

extension/src/
├── extension.ts            [MODIFIED] activate() no longer hosts MCP server; registers LM tools instead. McpServerDefinitionProvider survives for playwright-mcp only.
├── lm-tools/               [NEW DIR]
│   ├── index.ts            [NEW] registerQaDebugLmTools(context, deps): Disposable — single entry point called from activate()
│   ├── base.ts             [NEW] shared types only — no body-level prescription; Implementor reads vscode.d.ts:21162-21179 (LanguageModelTool<T>) and @qa-debug/tool-contracts/errors for the shapes
│   ├── get-failure-context.ts   [NEW] class GetFailureContextTool implements LanguageModelTool<{session_id?: string; response_format?: 'concise'|'detailed'}>
│   ├── request-retry.ts         [NEW] class RequestRetryTool implements LanguageModelTool<{session_id: string; reason: string}>
│   ├── request-give-up.ts       [NEW] class RequestGiveUpTool implements LanguageModelTool<{session_id: string; reason: string}>
│   ├── propose-mark-passed.ts   [NEW] class ProposeMarkPassedTool implements LanguageModelTool<{session_id: string; rationale: string}>  — ships prepareInvocation
│   ├── propose-close-browser.ts [NEW] class ProposeCloseBrowserTool implements LanguageModelTool<...>                                   — ships prepareInvocation; honors Mode A decline (port ≠ 9222) BEFORE prepareInvocation per ARCHITECTURE §3.2 / qa-debug-mcp/src/server.ts:213-227
│   └── propose-abort-suite.ts   [NEW] class ProposeAbortSuiteTool implements LanguageModelTool<...>                                     — ships prepareInvocation
├── pause-store.ts          [MODIFIED] swap import on line 29: `@qa-debug/qa-debug-mcp/pause-store` → `@qa-debug/tool-contracts/errors` for QaToolError. (B1 fix.)
├── mcp-provider.ts         [MODIFIED] strip qa-debug branch; provider becomes playwright-mcp-only. Drop qaDebugUri/qaDebugToken constructor params.
├── commands.ts             [MODIFIED] line 171 prefilled-chat prompt: `qa-debug:qa_get_failure_context` → `qa-debug_qa_get_failure_context` (B2 fix). `playwright-mcp:browser_*` references on the same line are UNCHANGED (playwright-mcp survives as MCP).
├── qa-debug-server.ts      [DELETED ENTIRELY] no in-extension MCP host
└── (other files unchanged: chat-participant.ts, chrome.ts, decision-router.ts, output-channel.ts, pause-status-bar.ts, session-manager.ts, smoke-test-message.ts, test-controller.ts, test-discovery.ts, audit-file.ts)

extension/package.json       [MODIFIED]
  - ADD contributes.languageModelTools block (6 entries) — see §3.4
  - ADD dependencies.@qa-debug/tool-contracts: workspace:*
  - REMOVE dependencies.@qa-debug/qa-debug-mcp (no longer consumed by extension)
  - REMOVE dependencies.@modelcontextprotocol/sdk (no longer consumed by extension)
  - KEEP contributes.mcpServerDefinitionProviders (playwright-mcp branch)
  - KEEP contributes.chatSkills, chatParticipants, commands, menus (all unaffected)

extension/skills/qa-debug/SKILL.md [MODIFIED] qa-debug:qa_* → qa-debug_qa_* — see §3.3 for exact occurrence list. playwright-mcp:browser_* references UNCHANGED.

PLAN-paused-test-affordances.md:83 [MODIFIED] same string as commands.ts:171 (paired-source duplicate of the prefilled prompt). qa-debug: → qa-debug_; playwright-mcp: unchanged.

NEXT-SESSION-PROMPT.md:16, PLAN-onDecision-wire.md:29/53 [MODIFIED] update expected audit log prefix from `[qa-debug-mcp]` to `[qa-debug-lm]` for the smoke-test expectations the Implementor will exercise (Q-H resolved in §3.5).

Historical CRs (ARCHITECTURE-CR-v5.{1,2,3,4,5,6}.md, ARCHITECTURE-CR-v5.md) [LEFT AS-IS] — these are immutable iteration artifacts; do not touch.
```

**Symbol-by-symbol extraction map (@qa-debug/tool-contracts, B1 resolution).** Implementor consumes these via the new package:

| Symbol | v5.6 import path | v5.14 import path | Consumer(s) |
|---|---|---|---|
| `QaErrorCode` (type) | `qa-debug-mcp/src/errors.ts` | `@qa-debug/tool-contracts/errors` | extension/src/pause-store.ts (transitive), qa-debug-mcp/src/server.ts |
| `QaToolError` (class) | `@qa-debug/qa-debug-mcp/pause-store` (re-export) | `@qa-debug/tool-contracts/errors` | extension/src/pause-store.ts:29 (direct fix for B1), extension/src/lm-tools/*.ts (new), qa-debug-mcp/src/server.ts |
| `errorResult` (helper) | `qa-debug-mcp/src/errors.ts` | `@qa-debug/tool-contracts/errors` | qa-debug-mcp/src/server.ts (stdio path still needs MCP-shaped error envelopes); extension/src/lm-tools/base.ts uses its own LanguageModelToolResult wrapper |
| `QaToolDef<T>` (interface) | `qa-debug-mcp/src/tools.ts` | `@qa-debug/tool-contracts/tools` | extension/src/lm-tools/* (read description, inputSchemaZod, inputSchemaJson), qa-debug-mcp/src/server.ts |
| Six `QaToolDef` records | `qa-debug-mcp/src/tools.ts` | `@qa-debug/tool-contracts/tools` | extension/src/lm-tools/*, qa-debug-mcp/src/server.ts |
| `qaTools`, `QaToolName`, `QA_TOOL_NAMES` | `qa-debug-mcp/src/tools.ts` | `@qa-debug/tool-contracts/tools` | evals harness (qa-debug-mcp/src/bin/*.ts); not consumed by extension/ |

The extension consumes ONLY `tool-contracts`; it has no transitive `@modelcontextprotocol/sdk` dependency after the migration. Verified that nothing else in `extension/src/` imports from `@qa-debug/qa-debug-mcp/*` beyond the line 29 import in `pause-store.ts`.

### 3.2 Tool surface (rewrites ARCHITECTURE §3.2)

**No change to the six verbs.** Names, input schemas, descriptions, return shapes, error codes (NO_ACTIVE_PAUSE, SESSION_NOT_FOUND, PAUSE_ALREADY_RESOLVED) are preserved bit-for-bit from `qa-debug-mcp/src/tools.ts:60-296`. The single source-of-truth `QaToolDef` records in that file are *reused* by the new LM tool classes — see §3.1 module map note that `qa-debug-mcp/` survives as a shared spec package even though the extension no longer pulls in its MCP server factory.

**Two surface-level changes:**

1. **Tool `name` form.** MCP servers self-identify and tools are addressed as `server:tool` (`qa-debug:qa_get_failure_context`). LM tools live in a flat namespace; convention from the canonical example is `extensionPrefix_verbName`. The mapping is mechanical:

   | v5.6 (MCP FQN) | v5.14 (LM tool name) |
   |---|---|
   | `qa-debug:qa_get_failure_context` | `qa-debug_qa_get_failure_context` |
   | `qa-debug:qa_request_retry`       | `qa-debug_qa_request_retry` |
   | `qa-debug:qa_request_give_up`     | `qa-debug_qa_request_give_up` |
   | `qa-debug:qa_propose_mark_passed` | `qa-debug_qa_propose_mark_passed` |
   | `qa-debug:qa_propose_close_browser` | `qa-debug_qa_propose_close_browser` |
   | `qa-debug:qa_propose_abort_suite` | `qa-debug_qa_propose_abort_suite` |

   The double `qa-debug_qa_` is intentional: it preserves the `qa_` action prefix in the public name (per `anthropic.com/engineering/writing-tools-for-agents` *"prefix with action-noun for searchability"*) while satisfying the LM tool `extensionPrefix_*` convention. The `toolReferenceName` (user-side `#` form) collapses to `qaFailureContext`, `qaRetry`, etc. — see §3.4 for the per-tool contribution block shape.

2. **Annotations field.** MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) do not exist as first-class fields on `languageModelTools`. The replacement signal:
   - `readOnlyHint: true` from MCP world → reflect in `modelDescription` prose (already worded "Idempotent and safe to call multiple times" at `tools.ts:75`). No first-class field needed.
   - Destructive-verb gating → moves to `prepareInvocation.confirmationMessages` on the three `propose_*` verbs (§2.3).
   - **Open question for reviewer (Q-C):** Is loss of structured annotations a problem? Author's read: annotations were forward-compat for future MCP clients (CR-v5.4 §2.3 iter#2 NB1); the LM-Tool-API world expresses the same intent through `prepareInvocation` (gate) + `modelDescription` (semantics) + `tags` (grouping). No actual functional loss.

### 3.3 SKILL.md content (touches ARCHITECTURE §3.3) [I2#D — B2 rewrite]

Mechanism unchanged: `chatSkills` contribution, description-driven engagement, `qa-debug.paused` context key gates UI affordances only.

**Critical scoping rule** (the iter#1 reviewer's B2 hinge): the rename is **NOT a global s/`qa-debug:`/`qa-debug_`/**. Only the qa-debug verbs migrate to LM Tool API; **`playwright-mcp:browser_*` references stay in colon form** because `@playwright/mcp` remains an MCP server (we do not own it; §2.1 item 4). Any tool a global replace would corrupt is enumerated below; the Implementor performs the rename per-occurrence, not via a tree-wide sed.

**Exact occurrence list** for the rename (iter#1 §3.3 claimed "six expected"; iter#2 grep against the actual files gives the corrected count):

| File | Lines | Form to rename | Count |
|---|---|---|---|
| `extension/skills/qa-debug/SKILL.md` | 8, 12, 20, 35, 36, 83, 97, 107, and any Arm 1–5 sub-headings, the §"after-investigation" pointer to `qa_get_failure_context.last_proposal_status`, the §Mode A/B paragraphs | `qa-debug:qa_*` | ≥10 — Implementor must grep the file and update each; the live-doc nature of SKILL.md (S5 has been iterating) means an exact line list at CR-time will likely drift before merge |
| `extension/src/commands.ts` | 171 (prefilled-chat prompt body) | `qa-debug:qa_get_failure_context` | 1 |
| `PLAN-paused-test-affordances.md` | 83 (duplicate of the commands.ts:171 prefilled prompt) | `qa-debug:qa_get_failure_context` | 1 |

**Untouched** (must NOT be renamed):

| File | Form | Why |
|---|---|---|
| `extension/skills/qa-debug/SKILL.md` (multiple) | `playwright-mcp:browser_*` | playwright-mcp remains an MCP server; colon form is correct |
| `extension/src/commands.ts:171` | `playwright-mcp:browser_snapshot`, `:browser_evaluate` | same — colon form for the MCP-hosted playwright tools |
| `qa-debug-mcp/src/tools.ts:11, 77, 225` | `playwright-mcp:browser_*` (used in qa_* tool descriptions to disambiguate from `qa_propose_close_browser`) | playwright-mcp colon form survives; the qa_* tool descriptions go into both the v5.14 LM tool `modelDescription` and the qa-debug-mcp stdio CLI (evals) verbatim. **Note:** the qa_* tool *names* the descriptions reference (e.g., "Distinct from playwright-mcp:browser_close") do not need updating because the playwright-mcp half remains MCP-shaped. |
| `qa-debug-mcp/src/server.ts:15` (doc comment) | `qa-debug:qa_*` (in FQN-explainer prose) | stdio MCP path keeps the colon form; the comment is correct for that surface |
| `NEXT-SESSION-PROMPT.md:14` (smoke-test prose reference) | `qa-debug:qa_*` | smoke-test prose; Implementor refreshes when running the smoke (not blocking the rename pass) |
| Historical CRs (`ARCHITECTURE-CR-v5.{1..6}.md`, `S4_DESIGN.md`, `S5_DESIGN.md`, `SLICE_PLAN*.md`, `ARCHITECTURE.md`, `ARCHITECTURE-CR-v5.md`) | `qa-debug:qa_*` (numerous) | immutable historical artifacts; the v5.14 ARCHITECTURE rewrite in iter#3 of this Ralph loop will update the live `ARCHITECTURE.md` once approved, but iter#2 CR scope is the change description only |

**Engagement semantics unaffected by the rename.** The agent learns to *defer* the call to `qa_get_failure_context` to "when a pause is currently active"; this was already the case under v5.6 (the agent could not call MCP tools that were not registered) and remains so under v5.14 (the agent cannot call LM tools whose `when` evaluates false — see §3.4 Q-D resolution).

The qa-debug chat participant (`extension/src/chat-participant.ts`) is unaffected — chat participants and LM tools are orthogonal VS Code concepts.

### 3.4 Gating model (rewrites ARCHITECTURE §3.4)

v5.6 gated via `McpServerDefinitionProvider` returning `[playwright-mcp, qa-debug]` during pause and `[]` at idle, firing `onDidChangeMcpServerDefinitions` on transitions.

v5.14 splits the responsibility:

| Tool | Host | Gating mechanism |
|---|---|---|
| All six `qa_*` verbs | LM Tool API (in-extension `vscode.lm.registerTool`) | Per-tool `when: "qa-debug.paused"` in the `languageModelTools` contribution. VS Code evaluates the when-clause when building the agent-mode tool list per turn. |
| `playwright-mcp` (~25 tools) | External MCP server via `McpStdioServerDefinition` | `McpServerDefinitionProvider` returns `[playwright-mcp]` during pause, `[]` at idle. `onDidChangeMcpServerDefinitions` fires on transitions. |

**Net effect at idle:** zero qa-debug verbs visible (`when` false), zero playwright tools visible (provider returns `[]`). Same surface as v5.6.

**Net effect during pause:** six qa-debug verbs visible, ~25 playwright tools visible. Same surface as v5.6.

**The Tool Search Tool threshold analysis from ARCHITECTURE §3.4 is preserved verbatim** — total during-pause tool count is unchanged (~31), token-budget triggers unchanged, deferral to Phase 2 unchanged.

**Per-tool gating granularity is new** — under v5.6, all six qa-debug verbs appeared/disappeared as one unit (entire MCP server). Under v5.14 each verb has its own `when` and could in principle gate differently (e.g., `qa_propose_abort_suite` could require a `qa-debug.severityHigh` flag). v5.14 does NOT exercise this granularity — every verb uses the same `qa-debug.paused` clause for parity. Flagged as an enabling capability, not a current design choice.

**Q-D resolved [I2#E]:** `when`-clause is a **discovery filter** applied before the tool reaches `lm.tools` for a given request. Verified at `node_modules/.pnpm/@types+vscode@1.120.0/.../index.d.ts:21126-21146` — `LanguageModelToolInformation` carries `{ name, description, inputSchema, tags }` only; no `when` field reaches the model. VS Code re-evaluates per-tool `when` against current context keys when building the agent-mode tool list each request. Once `invoke` is dispatched the call runs to completion regardless of subsequent context-key changes; the tool body itself returns `NO_ACTIVE_PAUSE` via `pauseStore.getActivePause()` if the pause was cleared between dispatch and execution — identical to v5.6 semantics (the error code is the same; only the surfacing layer changed).

### 3.5 Observability — host-side invocation log (touches ARCHITECTURE §3.5) [I2#F — Q-F and Q-H resolved]

v5.6 wires `createQaDebugServer.onInvocation` (the host-side hook in `qa-debug-mcp/src/server.ts:41-43`) to `appendInfo(auditChannel, ...)` so CR-v5.4 §4.5 test #4 ("Agent-mode auto-engagement smoke") can grep the Output Channel for `[qa-debug-mcp] <name> called session=<id>`.

v5.14: the equivalent log line moves to each tool class's `invoke` entry. The base class (`extension/src/lm-tools/base.ts`) absorbs this — every tool class emits a single audit line before delegating to the verb-specific logic. **No agentic semantics change; only the wire prefix:** `[qa-debug-mcp] X called` → `[qa-debug-lm] X called`.

**Q-F resolved [I2#F1].** There is no `vscode.lm.onDidInvokeTool` event in `node_modules/.../@types/vscode/index.d.ts:20779-20813` (the `lm` namespace surface). Host-side `appendInfo` from inside each tool's `invoke` is therefore the only path for the audit log. This is what `extension/src/lm-tools/base.ts` does; it is structurally equivalent to `qa-debug-mcp/src/server.ts:81-88`'s wire+host dual-emit (minus the wire half, since LM Tool API has no wire equivalent of MCP's `sendLoggingMessage`).

**Q-H resolved [I2#F2].** Files with the `[qa-debug-mcp]` prefix expectation (grep against `*.md` / `*.ts` excluding historical CRs):

| File | Lines | Disposition |
|---|---|---|
| `qa-debug-mcp/src/server.ts` | 85 | **KEEP** — stdio CLI path remains MCP-shaped; `[qa-debug-mcp]` is the correct prefix for that surface |
| `extension/src/qa-debug-server.ts` | 47, 50, 59 | **N/A — file deleted** per §3.1 |
| `PLAN-onDecision-wire.md` | 29, 53 | **UPDATE** — smoke-test expectations for the extension's audit channel must reflect `[qa-debug-lm]` after this CR lands |
| `NEXT-SESSION-PROMPT.md` | 16 | **UPDATE** — same expectation |
| `ARCHITECTURE-CR-v5.4.md` | 343, 425, 478 | **LEAVE** — historical iteration artifacts |

The MCP server logging capability (`server.sendLoggingMessage` at `qa-debug-mcp/src/server.ts:83-88`) is no longer used by the extension path. The stdio CLI path (evals harness) still uses it and keeps the `[qa-debug-mcp]` prefix on its own audit surface.

### 3.6 qa-reporter (ARCHITECTURE §3.6) — unaffected

The Mocha reporter does not interact with the tool host. PauseStore is queried directly by the reporter (S4 in-process variant); the reporter is unaware of whether the agent reached the store via MCP or LM Tool API.

### 3.7 IPC (ARCHITECTURE §3.5 IPC paragraph) — unaffected

qa-hooks ↔ extension IPC is over Node's `stdio[3]` channel. The tool-host migration does not touch IPC.

## 4. Failure-pause loop (sequence updates touching ARCHITECTURE §4)

ARCHITECTURE §4 steps with v5.14 deltas:

1. User clicks Run / `@qa run` — unchanged.
2. Extension launches Chrome `:9222`, then `mocha ...` — unchanged.
3. Test fails; qa-hooks IPC `publishPause` → MementoPauseStore — unchanged.
4. **Extension flips `qa-debug.paused` context key to `true` via `setContext`.** This (i) enables Test Explorer commit buttons (unchanged effect), (ii) **causes all six `languageModelTools` `when` clauses to evaluate true so VS Code re-computes the agent-mode tool list to include them**, and (iii) drives `McpServerDefinitionProvider.setPaused(cdpHttpEndpoint)` for the playwright-mcp branch only.
5. Chat notification surfaces — unchanged.
6. Agent flow — unchanged from §3.2; `qa_get_failure_context` is called via `lm.invokeTool` (Copilot side) or transparently via agent-mode tool-call resolution.
7. Decision verbs:
   - `qa_request_*` — auto-commit via DecisionRouter (no `prepareInvocation`) — pending Q-B answer.
   - `qa_propose_*` — `prepareInvocation` returns `confirmationMessages`; on Continue, `invoke` commits.
8. On commit: extension flips `qa-debug.paused` to `false`; LM tools become invisible (next agent turn sees an empty qa-debug surface); MCP provider returns `[]`; chrome stays per existing policy.

## 5. Tech stack (rewrites ARCHITECTURE §5)

| v5.6 | v5.14 |
|---|---|
| `@modelcontextprotocol/sdk` in extension `dependencies` | **Removed from extension/package.json**; survives in qa-debug-mcp/package.json (evals harness only). |
| `@qa-debug/qa-debug-mcp` workspace dep in extension | **Removed.** Extension imports tool-spec records (`qa_get_failure_context` etc.) directly from a relocated shared module — see §6 follow-up: extract `tools.ts` into a new workspace package `@qa-debug/tool-contracts` so both extension (LM tools) and qa-debug-mcp (stdio CLI) depend on the spec without the extension pulling in the MCP server code. |
| `vscode.lm.registerMcpServerDefinitionProvider` | **Kept** — playwright-mcp only. |
| `vscode.lm.registerTool` | **NEW** — six call sites in `extension/src/lm-tools/index.ts`. |
| `contributes.mcpServerDefinitionProviders` | Kept (playwright). |
| `contributes.languageModelTools` | **NEW** — six entries. |
| Streamable HTTP transport + 127.0.0.1 bearer-token loopback | **Deleted.** |

## 6. Open questions & follow-ups for the reviewer [I2#G — list shrunk; Q-A/B/D/E/F/H resolved inline]

Resolved in iter#2:
- **Q-A** → §2.3 (dual-surface commit, both write through `DecisionRouter.commit`, lost-race semantics inherited from v5.6).
- **Q-B** → §2.3 (no `prepareInvocation` for `request_retry` / `request_give_up`; friction-vs-cheap-undo per `anthropic.com/research/measuring-agent-autonomy`).
- **Q-C** → §3.2 (MCP annotations were forward-compat for non-VS-Code MCP clients; v5.14 ships `prepareInvocation` + `modelDescription` + `tags` as the structural equivalent; no functional loss).
- **Q-D** → §3.4 (`when` is a discovery filter; `LanguageModelToolInformation` carries no `when`; once `invoke` is dispatched it runs to completion; tool-body returns `NO_ACTIVE_PAUSE` on race).
- **Q-E** → §3.1 (new workspace package `@qa-debug/tool-contracts` carries the spec + errors; resolves iter#1 B1; extension/ free of MCP-SDK deps).
- **Q-F** → §3.5 (no `lm.onDidInvokeTool`; host-side `appendInfo` is the only path).
- **Q-H** → §3.5 (enumerated file list; PLAN-onDecision-wire.md + NEXT-SESSION-PROMPT.md update; historical CRs untouched).

Remaining open:
- **Q-G (deferred to v5.8).** The `qa-debug-mcp` workspace package becomes evals-harness-only after v5.14. Rename to `@qa-debug/evals-mcp-shim` to signal scope, or leave as-is to minimize churn? **Author's preference: defer to v5.8.** Rationale: v5.14 is already touching three packages (`@qa-debug/tool-contracts` new, `qa-debug-mcp` modified, `extension` modified); a rename adds package-reference churn across pnpm-lock + tsconfig project references for no functional benefit while the LM Tool migration is the load-bearing change. Iter#3 should not re-litigate.

## 7. Risk & rollback

**Primary risk.** `prepareInvocation`-based confirmation may render differently from v5.6's Test Explorer commit button — specifically, the chip lives in the chat thread, not next to the failing test in the Testing view. UX evaluation needs the in-extension live-run smoke (cannot be settled in this CR). Mitigation: keep the Test Explorer commit buttons (v5.6 §3.8) as a parallel commit surface so the human always has a non-chat path.

**Secondary risk.** LM Tool API is GA in VS Code 1.95+; current `engines.vscode` declares `^1.120.0` (already past). No version-pin tightening needed.

**Rollback.** This CR strictly removes the in-extension MCP host and adds LM tool classes whose contracts mirror the deleted MCP handlers. A bisect rollback to v5.6 is a clean module-level revert: restore `qa-debug-server.ts`, restore the `qa-debug` branch in `mcp-provider.ts`, restore the `@modelcontextprotocol/sdk` dep, delete `extension/src/lm-tools/`, delete the `languageModelTools` block in package.json. The qa-debug-mcp/ workspace package is untouched throughout, so the rollback does not touch the evals harness.

## 8. Iteration history

- **Iteration #1** (2026-05-22) — initial draft. Ralph-loop reviewer (general-purpose, adversarial-Anthropic-engineer framing per [[feedback-ralph-loop]]) returned **REVISE-with-blockers**:
  - **B1** unenumerated `extension/src/pause-store.ts:29` production import from `@qa-debug/qa-debug-mcp/pause-store` (`QaToolError`) — §5 said dep removed; §3.1 did not list the move; iter#1 would have broken the build.
  - **B2** §3.3 occurrence count (claimed "six expected") was wrong (actual ≥10 in SKILL.md), AND `extension/src/commands.ts:171` prefilled-chat prompt was missed entirely, AND CR did not call out that `playwright-mcp:` colon form must survive (a naïve global s/`qa-debug:`/`qa-debug_`/ would corrupt playwright references).
  - **B3** §2.3 propose/commit→`prepareInvocation` collapse waved at "principle preserved; surface only" without committing to a canonical-surface decision or lost-race semantics, leaving the Implementor with two competing UI affordances and undefined race resolution.
  - Polish: P1 (citation for the collapse), P2 (Q-D resolvable today), P3 (Q-F resolvable today), P4 (Q-H file list).
- **Iteration #2** (this file, 2026-05-22) — all three blockers addressed inline (B1 → §3.1 `@qa-debug/tool-contracts` extraction with symbol map; B2 → §3.3 occurrence enumeration with explicit untouched-playwright-colon-form rule; B3 → §2.3 dual-surface canonical commit model, both write through `DecisionRouter.commit`, lost-race inherits v5.6 `PAUSE_ALREADY_RESOLVED`). Polish P1–P4 folded; Q-A/B/D/E/F/H resolved → dropped from §6 open list. Q-G remains deferred to v5.8 by design.
- **Iteration #2 reviewer verdict (2026-05-22):** **APPROVE-with-polish** (4 cosmetic polish items: `tool-defs`→`tool-contracts` consistency, deleted confusing stub line in §3.1, added `server.ts:15` + `NEXT-SESSION-PROMPT.md:14` to §3.3 untouched table, added Q-G rationale one-liner). All four swept inline; per CR-v5.4 §8 / CR-v5.5 / CR-v5.6 precedent, cosmetic polish does not warrant iter#3. Architecture v5.14 is implementation-ready.
