# ARCHITECTURE v5.4 — Change Request: chat-flow refinement (drop chat-driven suite-running; status-bar augments notification; MCP tool annotations for Agent-mode auto-invocation)

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> Status: **Iteration #1 (file)** drafted 2026-05-21. An *in-conversation* iter-#1 design sketch was reviewed earlier the same day and returned **REVISE** with 4 blockers (**B1** drop chat-driven suite-running entirely per reviewer option (ii); **B2** no confirmation-dialog-as-safety-net; **B3** reword "Primary canonical" → "Primary surface (project choice)"; **B4** reword "status bar replaces notification" → "augments") + 1 resolved non-blocker (**NB1** `LanguageModelToolInformation.tags` exists at vscode.d.ts:21146). This file incorporates B1–B4 inline from inception so the next iter#2 reviewer audits the converged design directly. Change tags: **[Bn]** = in-conversation iter-#1 blockers applied here.
>
> Scope: §3.3 (chat-participant + SKILL coexistence retained; `qa_run_suite` and `#qaRunSuite` explicitly NOT added — **[B1]**), §3.4 (MCP gating gains §3.4.3 annotations), §3.5 (notification reverts to two-button form — removes v5.3 "Ask Copilot"), §3.7 NEW (status-bar entry — **[B4]** augments, does not replace), §4 step 5.5 (revised: no Ask-Copilot click; status-bar augments toast), and SLICE_PLAN §4 (Phase-2 follow-ups appended).
>
> **Scope vs v5.3.** v5.3 (APPROVED 2026-05-21) added the chat-participant + "Ask Copilot" button as a one-click bridge from pause-toast to Copilot. v5.4 REFINES the chat-flow after the post-v5.3 F5 + user feedback 2026-05-21: team primarily uses Copilot **Agent mode** (where MCP tools auto-invoke when the qa-debug gate is open), so the "Ask Copilot" toast button became a friction step — interrupting an ongoing Agent session to click a toast — rather than the seam-closer it was designed as. v5.4 reverts that button, adds an ambient status-bar entry, and tags the qa-debug MCP tools with `readOnlyHint` / `destructiveHint` so VS Code's Agent-mode MCP gate skips per-call confirmation where appropriate. v5.3's chat-participant + SKILL.md description-driven engagement paths remain unchanged.

## 0. Sources (per ARCHITECTURE v5 §0.1 / §0.2)

### Capability sources (§0.1)

- **`vscode.StatusBarItem` interface** — `node_modules/.pnpm/@types+vscode@1.120.0/node_modules/@types/vscode/index.d.ts:7564–7659`. Relevant members:

  ```ts
  export interface StatusBarItem {
    readonly id: string;
    readonly alignment: StatusBarAlignment;
    readonly priority: number | undefined;
    name: string | undefined;
    text: string;                                          // supports $(icon-name)
    tooltip: string | MarkdownString | undefined;
    color: string | ThemeColor | undefined;
    backgroundColor: ThemeColor | undefined;               // only 'statusBarItem.errorBackground' or '.warningBackground'
    command: string | Command | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
  }
  ```

- **`vscode.window.createStatusBarItem`** — same file, two overloads at :11643 and :11653:

  ```ts
  export function createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
  export function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
  ```

- **`LanguageModelToolInformation.tags`** — same file, :21146 (verbatim, resolving in-conversation iter-#1 NB1):

  ```ts
  /** A set of tags, declared by the tool, that roughly describe the tool's
   *  capabilities. A tool user may use these to filter the set of tools to
   *  just ones that are relevant for the task at hand. */
  readonly tags: readonly string[];
  ```

- **MCP `ToolAnnotationsSchema`** — `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2361–2368`:

  ```ts
  export declare const ToolAnnotationsSchema: z.ZodObject<{
      title: z.ZodOptional<z.ZodString>;
      readOnlyHint: z.ZodOptional<z.ZodBoolean>;
      destructiveHint: z.ZodOptional<z.ZodBoolean>;
      idempotentHint: z.ZodOptional<z.ZodBoolean>;
      openWorldHint: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>;
  ```

  And embedded inside `ToolSchema` at :2393 (i.e., `annotations` is a first-class field on `tools/list` entries).

- **MCP spec — Tool annotations semantics** — canonical schema JSON at `https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.json` under `definitions.ToolAnnotations` (verified at iter#2 — the rendered spec page at `modelcontextprotocol.io/specification/2025-06-18/server/tools` no longer renders a #tool-annotations subsection; the canonical source is the schema). Verbatim:
  - `readOnlyHint`: "If true, the tool does not modify its environment. Default: false"
  - `destructiveHint`: "If true, the tool may perform destructive updates...If false, the tool performs only additive updates. (This property is meaningful only when `readOnlyHint == false`) Default: true"
  - `idempotentHint`: "If true, calling the tool repeatedly with the same arguments will have no additional effect on the its environment. (This property is meaningful only when `readOnlyHint == false`) Default: false"
  - `openWorldHint`: "If false, the tool's domain of interaction is closed. For example, the world of a web search tool is open, whereas that of a memory tool is not. Default: true"

  Implication of the "meaningful only when `readOnlyHint == false`" clauses: a read-only tool should declare ONLY `readOnlyHint: true` and OMIT `destructiveHint` / `idempotentHint`. This drives §2.3's annotation map.

- **VS Code MCP client annotation handling** — `https://code.visualstudio.com/api/extension-guides/ai/mcp` (WebFetched iter#2, verified verbatim):
  - *"VS Code doesn't ask for confirmation to run read-only tools."*
  - *"The confirmation dialog will be shown for all tools that are not marked with the readOnlyHint annotation."*

  Critical secondary finding from the same page: VS Code today consumes ONLY `title` and `readOnlyHint` from MCP tool annotations; `destructiveHint`, `idempotentHint`, and `openWorldHint` are NOT mentioned and are NOT acted upon. Declaring them is harmless (the spec allows; SDK passes them through to the wire) but VS Code does not render different UI for `destructiveHint: false`. The propose verbs in §2.3 declare these hints purely for forward-compatibility with future MCP clients; today they have no behavioral effect inside VS Code. §3.4.3 must disclose this so readers do not over-claim Agent-mode behavior.

### Agentic-design sources (§0.2)

- **`anthropic.com/engineering/writing-tools-for-agents`** — already cited in ARCHITECTURE v5 §0.2: *"Too many tools or overlapping tools can also distract agents from pursuing efficient strategies. Make sure each tool you build has a clear, distinct purpose."* The §2.4 decision to **drop chat-driven suite-running entirely** (**[B1]**) rests on this — a `qa_run_suite` tool would overlap with Test Explorer's run gesture without adding LLM-judgment value, so it fails the "clear, distinct purpose" test.

- **`anthropic.com/research/measuring-agent-autonomy`** (Feb 18 2026) — already cited in ARCHITECTURE v5 §3.2 / CR-v5.3 §0: *"oversight requirements that prescribe specific interaction patterns…will create friction without necessarily producing safety benefits."* The §2.1 decision to **remove the Ask-Copilot toast button** rests on this — for the Agent-mode workflow the team primarily uses, the button is friction without a corresponding safety benefit (Agent mode already produces context-driven invocation; the toast click is a ritual).

- **Chat-as-launcher critique** — `code.visualstudio.com/api/extension-guides/ai/chat` chat-participant guidance: *"Chat participants should not be purely question-answering bots; rich and convenient interactions, such as buttons in your responses, menu items"* (paraphrased — iter#2 reviewer please verify verbatim wording at WebFetch time). Combined with the Anthropic distinct-purpose rule above, this supports the §2.4 drop of chat-driven suite-running: picking a test to run is a UI gesture (Test Explorer / command palette / inline editor action), not a chat conversation.

### Repo-local sources

- `ARCHITECTURE.md` v5.1 §3.3 / §3.4 / §3.5 / §4.
- `ARCHITECTURE-CR-v5.2.md` — adjacent; v5.4 layers on top.
- `ARCHITECTURE-CR-v5.3.md` APPROVED 2026-05-21 — §2.3 (Ask Copilot toast button — to be reverted) and §2.1 (chat-participant — to be retained unchanged).
- `extension/src/session-manager.ts:264–304` — current `pause.publish` handler with three-button toast + Ask-Copilot dispatch (to be reverted to two-button form per §2.1).
- `extension/src/chat-participant.ts` — v5.3 chat participant (unchanged in v5.4).
- `extension/skills/qa-debug/SKILL.md` — unchanged.
- `qa-debug-mcp/src/tools.ts:44–230` — 6 qa-debug tool defs (annotations field added per §2.3).
- `qa-debug-mcp/src/server.ts` — `server.registerTool(...)` call site (passes annotations through per §2.3).
- `pause-store-types/src/index.ts` — PausePayload (unchanged in v5.4; not the v5.5 territory).

### Memory cross-references

- [[feedback-chat-not-launcher]] — Ralph iter#1 verdict that picking what to run is NOT a chat job. Foundation for **[B1]**.
- [[feedback-chat-panel-engagement]] — gap that v5.3 partially closed; v5.4 closes the remaining workflow-mismatch (Agent-mode auto-invocation + ambient status bar).
- [[feedback-transparent-use]] — broader principle the chat-flow refinement honors.
- [[reference-anthropic-agentic-docs]] — known-good URLs for iter#2 reviewer.

## 1. The contradiction

`ARCHITECTURE-CR-v5.3.md` §2.3 (APPROVED 2026-05-21) added a three-button pause notification with **"Ask Copilot"** as the new default action — one-click bridge from pause-toast to a pre-seeded `@qa-debug` chat query. The CR §2.5 paragraph honestly acknowledged a residual *one-click seam* and pinned a Phase-2 follow-up for event-driven zero-click invocation.

User feedback 2026-05-21 (post-v5.3 implementation + F5 smoke) reframes the workflow assumption that drove v5.3's design:

> *"ไม่อยากให้เป็น เราต้องกดที่ notification"* — team primarily uses Copilot **Agent mode**, where MCP tools auto-invoke when context is available; clicking a toast button to open a NEW chat session breaks the active Agent session.

Two distinct workflow assumptions are at play:

| Assumption | Engagement primitive | v5.3 seam-closer |
|---|---|---|
| User opens Copilot per-task (Ask mode) | Toast click → chat opens with pre-seeded query → participant handles | Ask-Copilot button (the v5.3 design fit this) |
| User is already in Agent mode | MCP gate opens → registered qa-debug tools auto-invoke when the agent's turn touches the pause context | Status-bar entry + auto-invocation (the v5.4 design fits this) |

The team's actual workflow is the second. v5.3's button optimizes for the first. Both workflows are legitimate, but Phase-1 cannot ship two competing toast-button defaults. v5.4 chooses the Agent-mode workflow because (a) it is the team's stated default, and (b) it produces less interruption — the status bar is *pull* (ambient pull-style information; QA glances when they want), whereas the toast button is *push* (interrupts whatever the QA is doing).

There is a second, narrower contradiction surfaced by the in-conversation iter-#1 Ralph review: the v5.4 design *sketch* (pre-file) tempted toward a `qa_run_suite` MCP tool or `#qaRunSuite` LanguageModelTool — letting users type `@qa-debug run my fixture suite` in chat. This conflates chat-as-conversation with chat-as-command-launcher. Per [[feedback-chat-not-launcher]] + Anthropic writing-tools-for-agents + VS Code chat docs, picking-what-to-run belongs in Test Explorer / command palette / inline editor, NOT chat. This CR drops chat-driven suite-running entirely (**[B1]**), eliminating the structural risk of wrong-suite invocation so a confirmation dialog is not needed (**[B2]**).

## 2. The proposal

Four additive / refining changes, none of which remove v5.3's chat-participant or SKILL.md paths:

### 2.1 Notification — revert to two-button form (removes v5.3 "Ask Copilot")

`extension/src/session-manager.ts` `pause.publish` handler. The v5.3 three-button form:

```ts
void vscode.window.showInformationMessage(
  `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
    `Browser held — ask Copilot to investigate.`,
  'Ask Copilot',         // ← REMOVE
  'Open Test Explorer',
  'Open Audit Log',
).then(...);
```

becomes the v5.4 two-button form:

```ts
void vscode.window.showInformationMessage(
  `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
    `Browser held — investigate via Copilot Agent mode (qa-debug tools auto-invoke) or pick a follow-up in Test Explorer.`,
  'Open Test Explorer',
  'Open Audit Log',
).then((sel) => {
  if (sel === 'Open Audit Log') {
    this.deps.channel.show();
  } else if (sel === 'Open Test Explorer') {
    void vscode.commands.executeCommand('workbench.view.testing.focus');
  }
});
```

- The `chatOpenAvailable` / `chatOpenFallbackAvailable` SessionManagerDeps fields are NO LONGER read by the notification handler. They remain on the deps shape for the chat-participant runtime guard (separate code path).
- Body text becomes informational, naming the two engagement paths (Agent-mode auto-invocation + Test Explorer) rather than directing one click.

### 2.2 Status-bar entry — ambient pause indicator (**[B4]** augments, does not replace)

New module `extension/src/pause-status-bar.ts`:

```ts
import * as vscode from 'vscode';
import type { MementoPauseStore } from './pause-store.js';
import type { OutputChannel } from 'vscode';
import { appendInfo } from './output-channel.js';

export function registerPauseStatusBar(
  context: vscode.ExtensionContext,
  pauseStore: MementoPauseStore,
  channel: OutputChannel,
): { show(sessionId: string): void; hide(sessionId: string): void; dispose(): void } {
  // id is required for the typed three-arg overload (vscode.d.ts:11643)
  const item = vscode.window.createStatusBarItem(
    'qa-debug.paused',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = 'QA Debug — Paused indicator';
  // Clicking the entry focuses Test Explorer per §2.5 surface taxonomy
  // (Test Explorer = primary surface (project choice); chat is conversational, not a status-bar destination).
  item.command = 'workbench.view.testing.focus';

  const refreshTooltip = (): void => {
    const active = pauseStore.peekActivePause();
    if (!active) {
      item.tooltip = undefined;
      return;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**QA Debug — paused**\n\n`);
    md.appendMarkdown(`\`${active.test_title}\`\n\n`);
    md.appendMarkdown(`**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n\n`);
    md.appendMarkdown(`**Mode:** ${active.mode === 'A' ? 'A — your wdio session owns the browser' : 'B — companion-launched browser'}\n\n`);
    md.appendMarkdown(`**CDP:** \`${active.cdp_ws_url}\`\n\n`);
    md.appendMarkdown(`Click to focus Test Explorer.`);
    item.tooltip = md;
  };

  return {
    show(sessionId: string): void {
      item.text = '$(debug-alt) QA Paused';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      refreshTooltip();
      item.show();
      appendInfo(channel, `[status-bar] shown for session=${sessionId}`);
    },
    hide(sessionId: string): void {
      item.hide();
      appendInfo(channel, `[status-bar] hidden for session=${sessionId}`);
    },
    dispose(): void {
      item.dispose();
    },
  };
}
```

- `priority: 100` — left-aligned, mid-range priority. Mocha's Test Explorer status indicators are left-aligned by VS Code default; this entry sits among them without colliding.
- `backgroundColor: 'statusBarItem.warningBackground'` — yellow attention without the alarm of `.errorBackground` (only two background colors are permitted per vscode.d.ts:7613–7624; warning is the right severity for a pause that is awaiting decision).
- `command: 'workbench.view.testing.focus'` — clicking focuses Test Explorer per §2.5 surface taxonomy (**[B3]**: Test Explorer is the primary surface (project choice) for run-related actions; chat is conversational, not a status-bar destination).
- `show()` / `hide()` are called from `session-manager.ts`'s `pause.publish` and `onDecisionCommit` paths respectively. The entry is augmentative (**[B4]**) — the notification toast is preserved and shown alongside.
- Tooltip is composed from `peekActivePause()` (extension/src/pause-store.ts:48; never throws). Includes mode A/B per Q3.

`extension/src/extension.ts` `activate()` wires the entry into `context.subscriptions` (Disposable contract via `dispose()`).

### 2.3 MCP tool annotations — `readOnlyHint` + `destructiveHint`

Extend `QaToolDef` in `qa-debug-mcp/src/tools.ts`:

```ts
export interface QaToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface QaToolDef<I = unknown> {
  name: string;
  description: string;
  inputSchemaJson: QaToolJsonSchema;
  inputSchemaZod: z.ZodType<I>;
  annotations?: QaToolAnnotations;   // NEW
}
```

Per-tool annotation map (Phase 1). Column convention: "—" means the field is OMITTED from the annotation object (not emitted as `false` — per MCP spec the `destructiveHint` / `idempotentHint` fields are "meaningful only when `readOnlyHint == false`", so a read-only tool emitting `idempotentHint: true` would be spec-incoherent).

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` | Rationale |
|---|---|---|---|---|---|
| `qa_get_failure_context` | `true` | — | — | `false` | Read-only over MementoPauseStore; `destructiveHint`/`idempotentHint` are not meaningful for read-only tools per MCP spec. |
| `qa_request_retry` | `false` | `false` | `false` | `false` | Creates a proposal in the pause store; commit happens via UI button only. |
| `qa_request_give_up` | `false` | `false` | `false` | `false` | Same — proposal-only. |
| `qa_propose_mark_passed` | `false` | `false` | `false` | `false` | Proposal-only; UI commit gates the irreversible outcome. |
| `qa_propose_close_browser` | `false` | `false` | `false` | `false` | Mode A returns declined per v5.2 §2.6; Mode B proposes and UI commits. |
| `qa_propose_abort_suite` | `false` | `false` | `false` | `false` | Proposal-only; UI commit gates. |

Per MCP spec semantics (§0 source above): `destructiveHint: false` declares that the tool, while mutating state, performs only **additive** updates (creating a proposal does not destroy or overwrite prior proposals — the decision router enforces single-shot semantics, see extension/src/decision-router.ts). This is the truthful annotation given the propose/commit split: the *proposal* is non-destructive; only the UI commit can destroy/finalize state.

**Two distinct gates (clarification).** v5.4 surfaces two different confirmation gates that should not be conflated:

- **VS Code per-call MCP confirmation gate** — fires for any tool invocation that lacks `readOnlyHint: true` (per §0 verbatim VS Code MCP docs). This is a *client-policy* gate. v5.4 declares `readOnlyHint: true` on `qa_get_failure_context` so this gate skips for that tool.
- **Project-architectural UI button gate** — the propose/commit split documented in ARCHITECTURE §3.2: MCP-side tools never directly commit irreversible state; the UI button in Test Explorer / chat-participant / status-bar entry is the sole commit path. This gate is *structural to the project*, independent of any MCP client.

Both gates fire for the 5 propose verbs in Phase 1 — the VS Code per-call gate (because they are not read-only) AND the project UI button gate (because they are propose-only). Only the project UI button gate is structural; the VS Code per-call gate is client policy that could be removed by VS Code (or by a different MCP client) without affecting the propose/commit architecture.

`qa-debug-mcp/src/server.ts`'s tool-registration call site is updated to pass annotations through (`@modelcontextprotocol/sdk` SDK accepts annotations on the `tools/list` response payload per MCP types.d.ts:2393):

```ts
server.registerTool(
  tool.name,
  {
    description: tool.description,
    inputSchema: tool.inputSchemaJson,
    annotations: tool.annotations,    // NEW — pass through
  },
  handler,
);
```

**Effect on VS Code Agent-mode confirmation gate.** Per the capability claim in §0 (iter#2 reviewer to verify), `readOnlyHint: true` on `qa_get_failure_context` allows VS Code to auto-invoke without prompting per call when the agent's turn touches the pause context. The 5 propose verbs keep their per-call confirmation (the human-in-the-loop requirement for irreversible actions is structural — see ARCHITECTURE v5 §3.2). This is exactly the right asymmetry for v5.4's Agent-mode workflow: the read tool surfaces context auto-magically; the commit-shaped tools (propose verbs) still cost a confirmation step that maps to the UI button gate.

### 2.4 DROP chat-driven suite-running entirely (**[B1]** + **[B2]**)

The in-conversation iter-#1 design sketch tempted toward a `qa_run_suite` MCP tool + `#qaRunSuite` LanguageModelTool registration. **This CR explicitly forbids both.**

- No `qa_run_suite` is added to qa-debug-mcp.
- No `qa_run_suite`-shaped LanguageModelTool is registered via `vscode.lm.registerTool`.
- No `@qa-debug run …` bare-arg invocation pattern is documented or supported.
- The existing 6 qa-debug tools cover the legitimate chat-as-investigation scope: read failure context, propose decision verbs.

Justification (per [[feedback-chat-not-launcher]] + Anthropic writing-tools-for-agents + VS Code chat docs):

| Anti-pattern | Why it fails |
|---|---|
| Bare-arg `@qa-debug test1` | Not natural-language chat; not the documented `#toolReferenceName` idiom. A third ad-hoc dialect that LLMs will struggle to differentiate from typos. |
| `qa_run_suite` MCP tool | Overlaps Test Explorer's run gesture; fails Anthropic's "clear, distinct purpose" rule; uses LLM judgment where a UI gesture already exists. |
| Enum'd `#qaRunSuite` LanguageModelTool with `tags: ['suite-name']` | Same overlap; `#toolReferenceName` is the right idiom only when LLM judgment is the fundamental value-add, not when it duplicates a UI surface. |

By structurally removing chat-driven suite-running (rather than guarding it with a dialog), **[B2]** is also resolved: there is no wrong-suite risk to guard against because the surface is gone. `qa_propose_retry` covers rerun-after-fail; Test Explorer + command palette cover initial run.

### 2.5 Surface taxonomy — "Primary surface (project choice)" (**[B3]** + **[B4]**)

For Phase 1, this project chooses Test Explorer as the **primary surface** for picking what to run. This is a *project choice*, not a platform mandate — VS Code testing docs treat Test Explorer + decorations + commands as peers (per the chat-not-launcher Ralph iter-#1 citation).

| Surface | Role | When it fires |
|---|---|---|
| **Test Explorer** | Primary surface (project choice) for picking what to run; canonical decision-button host on failed items | Always available; populated lazily at pause-time today (v5.5 territory populates at discovery) |
| **Pause notification toast** | Ephemeral *push* on pause-publish | Once per pause-publish; auto-dismisses |
| **Status-bar entry** | Ambient *pull* indicator that **augments** (**[B4]**) the notification | Shown while a pause is active; hidden on decision commit |
| **Chat / @qa-debug participant + SKILL.md** | Post-failure conversational + agentic investigation surface | Engaged when the user types a free-form turn matching disambiguation/description, OR when Agent mode invokes qa-debug tools per `readOnlyHint` policy |

Augmentation (**[B4]**) means: a user who dismisses the notification still has the status-bar entry as a persistent ambient cue ("yes, a pause is in flight; click to focus Test Explorer"). The status bar does **not** replace the notification; both fire on pause-publish and both go away on decision commit.

### 2.6 Residual seam — honest acknowledgment

v5.4 closes most of the v5.3 residual seam by switching the bridge from a *push* button to an *ambient pull* indicator plus *Agent-mode auto-invocation*. Two residual seams remain:

1. **Agent-mode auto-invocation is per-context, not per-pause-event.** A user who is NOT currently in a chat session still must engage a chat themselves (toast / status-bar / cmd-palette) for qa-debug tools to fire. v5.4 does not auto-open a chat panel on pause — that would be an intrusion (interrupting the QA's other work) for a benefit that the status-bar entry already provides without intrusion (per measuring-agent-autonomy).
2. **VS Code MCP confirmation policy is documentation-driven, not statically typed.** Whether `readOnlyHint: true` actually skips the per-call confirmation dialog is a runtime observation against the user's VS Code build. If a future VS Code build changes this policy, qa_get_failure_context auto-invocation may regress. §4.5 test #4 surfaces this as a non-blocker; Phase 2 may add a feature-detection probe.

A future Phase 2+ CR could explore:
- Event-driven `workbench.action.chat.open` on pause (zero-click bridge) — currently no such API; tracked as Phase-2 SLICE_PLAN follow-up.
- Telemetry on Agent-mode-vs-Ask-mode engagement to validate the workflow assumption.
- A "pulsing" status-bar variant (text animation) if QAs report missing the static entry — Phase 2 only if measured.

For Phase 1 / v5.4, the ambient status-bar + Agent-mode auto-invocation is the right friction level.

### 2.7 Implementation requirement — qa-debug-mcp tool invocation logging

For §4.5 test #4 (Agent-mode auto-engagement smoke) to be falsifiable, qa-debug-mcp's tool handlers MUST emit a positive log line on each invocation. Today (verified at iter#2 against `qa-debug-mcp/src/server.ts:41–80`) the `qa_get_failure_context` handler does NOT emit such a line — its only path to the extension's Output Channel is via thrown errors that the Streamable HTTP transport surfaces. v5.4 implementation (Task #20) MUST add the missing log calls before the §4.5 test #4 can pass.

Concrete requirement: in `qa-debug-mcp/src/server.ts`, each tool's request handler emits an MCP server-side log via `server.sendLoggingMessage({ level: 'info', data: '...' })` (or equivalent SDK call) at the top of the handler, BEFORE any business logic:

```ts
server.registerTool(qa_get_failure_context.name, { ... }, async (args, ctx) => {
  void server.sendLoggingMessage({
    level: 'info',
    data: `[qa-debug-mcp] qa_get_failure_context called session=${(args as { session_id?: string })?.session_id ?? 'active'}`,
  });
  // ... existing handler body
});
```

The extension's qa-debug-server.ts (Streamable HTTP host) MUST already forward MCP `notifications/message` to the extension's Output Channel — if it doesn't, that wiring is also required. Phase 1 acceptance test #4 fails if the log line does not appear (the test must be falsifiable).

This requirement applies to all 6 qa-debug tools, with the per-tool name interpolated. It is cheap, has no behavior effect, and turns the §4.5 test #4 smoke from "did I see a dialog" eyeballing into a deterministic log-presence check.

## 3. ARCHITECTURE.md edits

### §2 Component list

Append to the diagram description:

> *"v5.4 adds a `vscode.window.createStatusBarItem('qa-debug.paused', Left, 100)` ambient pause indicator that augments the existing notification toast (does not replace it). The entry's `command` focuses Test Explorer per §2.5 surface taxonomy. The entry is shown on `pause.publish` and hidden on decision commit; its tooltip is a MarkdownString composed from MementoPauseStore.peekActivePause()."*

### §3.3 SKILL.md

Append to the v5.3 paragraph:

> *"v5.4 (2026-05-21) policy: chat-driven suite-running is explicitly out of scope. No `qa_run_suite` MCP tool, no `#qaRunSuite` LanguageModelTool, no bare-arg `@qa-debug <suite>` invocation pattern. Test Explorer is the primary surface (project choice) for picking what to run; chat is the post-failure investigation surface. The existing 6 qa-debug tools cover the chat-as-investigation scope completely; `qa_propose_retry` covers rerun-after-fail. See [[feedback-chat-not-launcher]] + Anthropic writing-tools-for-agents."*

### §3.4 MCP gating

Add §3.4.3:

> **§3.4.3 Tool annotations (v5.4).**
>
> qa-debug MCP tools declare MCP-standard annotations (per the canonical schema at github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.json `definitions.ToolAnnotations` and MCP SDK ToolAnnotationsSchema at types.d.ts:2361). "—" means the field is OMITTED (not emitted) because the MCP spec marks it "meaningful only when `readOnlyHint == false`":
>
> | Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
> |---|---|---|---|---|
> | `qa_get_failure_context` | `true` | — | — | `false` |
> | All 5 propose verbs | `false` | `false` | `false` | `false` |
>
> Per VS Code MCP client docs verbatim (§0 source), VS Code consumes ONLY `title` and `readOnlyHint`. The remaining three hints (`destructiveHint` / `idempotentHint` / `openWorldHint`) are declared for forward-compatibility with future MCP clients; they have NO behavioral effect inside VS Code today. The behavioral consequence in VS Code 1.120 is therefore narrow but precise: `qa_get_failure_context` SKIPS the per-call confirmation dialog ("VS Code doesn't ask for confirmation to run read-only tools"); the 5 propose verbs SHOW the per-call confirmation dialog ("The confirmation dialog will be shown for all tools that are not marked with the readOnlyHint annotation"). The two-gate clarification in §2.3 applies: this VS Code per-call gate is distinct from the project-architectural UI button gate documented in §3.2; both fire for the propose verbs.

### §3.5 Notification surface

Replace the §3.5 IPC paragraph's notification clause (v5.3 three-button form) with the v5.4 two-button form (full text in §2.1 above). Body text becomes informational, naming Agent-mode + Test Explorer as the two engagement paths.

### §3.7 (NEW) Status-bar entry

> **§3.7 Status-bar entry (v5.4).**
>
> An ambient pause indicator augments the pause notification (does not replace it — see §3.5). Created lazily at extension activation with `vscode.window.createStatusBarItem('qa-debug.paused', Left, 100)`. Shown on `pause.publish`, hidden on decision commit. Text: `$(debug-alt) QA Paused`. Background: `statusBarItem.warningBackground` (the warning ThemeColor is one of the two permitted background ThemeColors per vscode.d.ts:7613–7624; `.errorBackground` would over-signal since a pause is awaiting decision, not in a failed terminal state). Tooltip: a `MarkdownString` (untrusted) composed from `MementoPauseStore.peekActivePause()` showing test title, file:line, mode A/B (per v5.2), CDP URL. Click action: `workbench.view.testing.focus` — focuses Test Explorer (the primary surface per §2.5 / **[B3]**).
>
> **Stale-resume case (per §11 reload-mid-pause).** On extension activation, `session-manager.ts:resumeStalePauseIfAny()` (currently at session-manager.ts:145–169) calls `peekActivePause()` and, if non-undefined, sets `qa-debug.paused` + `qa-debug.staleResume` context keys and shows the stale-resume notification. v5.4 extends this path: immediately after the context key set (session-manager.ts:149–150) and before the notification show, the status-bar entry `show()` is called with the stale session_id. The ambient indicator is exactly the right friction level for the stale-resume case — the browser state is gone (Chrome process died with prior Extension Host), but the Memento has the pause record; the QA needs to see the indicator so they can focus Test Explorer and pick Give Up to clear stale state. The status-bar entry hides on stale-resume decision commit (same path as fresh-pause hide). Wiring: `pauseStatusBar.show(stale.session_id)` is added to `resumeStalePauseIfAny()` between the context-key set and the `vscode.window.showInformationMessage` call.

### §4 Failure-pause loop sequence

Insert revised step 5.5 (replacing the v5.3 §4 step 5.5 "user clicks Ask Copilot"):

> *"5.5. **Status-bar entry shows** (augments the notification toast; the toast remains as an ephemeral push). The notification body informs the user that qa-debug tools auto-invoke in Agent mode and Test Explorer is the run surface; no Ask-Copilot button is offered. If the user is already in an Agent-mode chat, VS Code's MCP gate fires `qa_get_failure_context` automatically on the next agent turn (per the `readOnlyHint: true` annotation declared in §3.4.3). If the user is not in chat, they may engage via Test Explorer (decision buttons on the failed TestItem), the chat participant (free-form `@qa-debug …`), or the SKILL.md description-driven path; v5.3 / v5.2 / v5.1 mechanics for those paths are unchanged."*

### §6 Status

Append:

> *"v5.4 APPROVED YYYY-MM-DD by Ralph-loop reviewer #N. Scope: removed v5.3 'Ask Copilot' notification button; added §3.7 status-bar entry (ambient pause indicator that augments the notification — `[B4]`); added §3.4.3 MCP tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) to skip per-call confirmation for `qa_get_failure_context` in VS Code Agent mode while preserving human-in-the-loop for the 5 propose verbs; explicitly dropped chat-driven suite-running (no `qa_run_suite`, no `#qaRunSuite`, no bare-arg `@qa-debug <suite>`) per `[B1]` + [[feedback-chat-not-launcher]]; reworded surface-taxonomy language `[B3]` to 'primary surface (project choice)' rather than 'primary canonical'. Closes the workflow-mismatch surfaced post-v5.3 (team uses Agent mode where toast buttons interrupt rather than bridge). Residual seams: Agent-mode auto-invocation is per-context not per-pause-event (acknowledged in §2.6); VS Code MCP confirmation policy is documentation-driven (Phase-1 acceptance test §4.5#4 is non-blocking)."*

## 4. SLICE_PLAN.md edits

- Append to Phase 2 follow-ups:
  - *"Event-driven chat-open on pause (zero-click) — pending a VS Code chat-open-on-event extension API. Currently `workbench.action.chat.open` requires a user-intent gesture; auto-open on pause would be intrusive."*
  - *"Engagement-path telemetry — measure Agent-mode-vs-Ask-mode-vs-Test-Explorer paths to validate the v5.4 workflow assumption that Agent mode is the team default. May trigger surface-taxonomy revision in v6 if the assumption is wrong."*
  - *"Tool annotation feature detection — probe whether VS Code's MCP client honors `readOnlyHint` for auto-invocation on the user's build; degrade `qa_get_failure_context` to require per-call confirmation if not (no regression vs v5.3)."*

- No removals from existing Phase-1 / Phase-2 sequencing.

## 4.5 Phase 1 acceptance tests

The v5.4 implementation MUST verify the following at F5-Extension-Host time before merging Task #20 (or whatever the v5.4 implementation task is):

1. **Notification two-button form** (BLOCKER). Run fixture → pause publishes → toast shows exactly two action buttons: "Open Test Explorer" and "Open Audit Log". Confirm "Ask Copilot" button is gone. Confirm body text mentions "Agent mode" and "Test Explorer" (per §2.1 wording). **Pass criterion:** visual + screenshot.

2. **Status-bar entry lifecycle** (BLOCKER). On `pause.publish`: status-bar entry appears in left alignment with `$(debug-alt) QA Paused` text and warning background. Tooltip on hover shows test title + file:line + Mode A/B + CDP URL. On decision commit (mark-passed / give-up / retry succeeds): entry hides within 500ms (event-driven, not polling). Output Channel shows `[status-bar] shown for session=…` and `[status-bar] hidden for session=…`. Click action focuses Test Explorer. **Pass criterion:** visual confirmation + Output Channel log + click behavior.

3. **MCP annotations passthrough** (BLOCKER). Launch the qa-debug-mcp server via the MCP Inspector (e.g., `npx @modelcontextprotocol/inspector dist/qa-debug-mcp.js`). The `tools/list` response includes `annotations.readOnlyHint: true` for `qa_get_failure_context` AND the `destructiveHint` / `idempotentHint` fields are OMITTED from that tool's annotations object (per the §2.3 spec-coherence rule — they are "meaningful only when `readOnlyHint == false`"). For each of the 5 propose verbs, `annotations.readOnlyHint: false` AND `annotations.destructiveHint: false`. **Pass criterion:** Inspector JSON inspection screenshot.

4. **Agent-mode auto-engagement smoke** (NON-BLOCKER, deterministic via §2.7 log). F5 Extension Host → fixture-tests run → on pause, open Copilot chat in Agent mode → take a turn that mentions the failing test (e.g., "what's wrong with the paused test"). Verify `qa_get_failure_context` is invoked WITHOUT a per-call confirmation dialog. **Pass criterion:** Output Channel shows `[qa-debug-mcp] qa_get_failure_context called session=...` (emitted per §2.7 implementation requirement) AND no "Allow tool" prompt fires between the agent turn and the log line. **Why non-blocking:** the VS Code MCP confirmation policy is documented (§0 verbatim) and matches our expectation, so this test is defense-in-depth against doc/impl drift rather than the load-bearing check. If the dialog appears anyway, qa_get_failure_context still functions (with confirmation) — no regression vs v5.3; the only loss is the v5.4 ergonomic improvement.

5. **No `qa_run_suite` shaped surface ships** (BLOCKER — structural check). Grep `qa-debug-mcp/src/tools.ts` + `extension/src/extension.ts` + `extension/package.json`:
   - `grep -r 'qa_run_suite\|qaRunSuite\|run-suite' qa-debug-mcp/ extension/` returns no matches.
   - `extension/package.json` `contributes.languageModelTools` (if any) does not include a `qaRunSuite`-shaped entry.
   - **Pass criterion:** zero matches.

6. **Stale-resume status-bar lifecycle** (BLOCKER — added per iter#2 NB4). F5 Extension Host → run fixture → publish pause → kill Extension Host without committing decision (Cmd+R reload window, or close + reopen). Re-activate via re-F5 (or natural reactivation). Within 500ms of `activate()` completion the status-bar entry appears (warning background, "QA Paused" text) with tooltip showing the stale session details; `qa-debug.staleResume` context key is set so command palette `QA Debug: Give Up Stale` is enabled. Committing Give Up from the command palette hides the status-bar entry. **Pass criterion:** visual + Output Channel `[status-bar] shown for session=...` (during activate path, NOT from a fresh pause.publish) + Output Channel `[session-manager] stale-resume detected session=...` per session-manager.ts:148.

Failures in 1–3, 5, 6 are blockers. #4 is non-blocking (the static annotation declaration is the deliverable; the runtime auto-invocation skip is a downstream observable confirmed by §0 verbatim VS Code docs).

## 5. Risk

- **Removing the Ask-Copilot button regresses v5.3's seam-closer for the Ask-mode workflow (medium).** v5.3 was designed for the assumption that the team opens Copilot per-task; v5.4 chooses the Agent-mode assumption. **Mitigation:** the chat-participant + SKILL.md description-driven engagement paths remain unchanged — a user who types `@qa-debug` or any of the disambiguation phrasings in chat still gets the same handler. The status-bar entry provides the ambient pull cue. If telemetry (Phase 2) shows Ask-mode users miss the explicit button, the SLICE_PLAN Phase-2 follow-up "engagement-path telemetry" surfaces it; v6 can decide whether to restore the button as an opt-in setting.

- **Forward-compatibility risk: future MCP clients may misread `destructiveHint: false` on propose verbs (low for Phase 1, hypothetical for Phase 2+).** VS Code 1.120 today does NOT consume `destructiveHint` at all (per §0 verbatim VS Code MCP docs), so this risk is empty against the Phase-1 client. However, a future MCP client (or VS Code release) that begins consuming `destructiveHint` might interpret `false` as "safe to auto-invoke" — conflating proposal-creation with no-op. For qa-debug propose verbs that DO create UI-visible proposals, this would mean a future Agent-mode session could speculatively cycle through `qa_propose_mark_passed` / `qa_propose_close_browser` / `qa_propose_abort_suite` without user intent. **Mitigation:** the propose verbs each *require* a `session_id` matching the active pause (NO_ACTIVE_PAUSE / SESSION_NOT_FOUND errors otherwise — see qa-debug-mcp/src/tools.ts), and the proposal commit is gated by UI button (always — see ARCHITECTURE §3.2; this is the **project-architectural** gate, distinct from the VS Code per-call gate per §2.3 two-gate clarification). The worst case is a noisy audit log; no irreversible commit can occur from MCP-only invocation regardless of how a future client interprets `destructiveHint`. Phase 2 may add a "speculative-proposal-rate" metric if a non-VS-Code client becomes a Phase-2 target.

- **`readOnlyHint` is a hint, not a guarantee (low).** Per MCP spec, annotations are advisory and clients are not required to honor them. VS Code's MCP client policy interpretation may change between versions. **Mitigation:** §4.5 test #4 is non-blocking; the user-visible default (per-call confirmation) is the existing v5.3 behavior, not a regression.

- **Status-bar entry crowding (low).** Other extensions add status-bar entries. `priority: 100` is mid-range; if a higher-priority entry pushes qa-debug off-screen on narrow VS Code windows, the user loses the ambient cue but the notification still fires. **Mitigation:** Phase 2 may raise the priority or add a settings entry for priority customization; the click action's destination (Test Explorer) is reachable from cmd-palette regardless.

- **Tooltip `MarkdownString` rendering quirks (low).** Test titles containing backticks or asterisks may render oddly inside the inline-code spans. **Mitigation:** the tooltip uses `MarkdownString(undefined, true)` (supportThemeIcons) and `isTrusted = false` to avoid arbitrary command-link injection; test titles are interpolated into `\`…\`` spans where Markdown escaping is implicit. If the QA reports rendering issues for specific test titles, Phase 2 can add explicit escaping.

- **B1 + Test Explorer empty until first pause (v5.5 territory, NOT this CR's risk).** Today, TestController only creates TestItems lazily at pause-time, so a user who wants to "pick a test to run" cannot pre-populate Test Explorer. This is the v5.5 gap, NOT a v5.4 risk; v5.4's surface taxonomy (Test Explorer as primary surface) is forward-compatible with v5.5's discovery work and does not bind v5.5's design choices.

## 6. Open questions for reviewer

**Q1, Q2, Q5, Q7 resolved at iter#2 — see §8 status entry.** Iter#2 reviewer WebFetched the MCP canonical schema + VS Code MCP client docs and inlined verbatim quotes into §0 / §2.3 / §3.4.3. Q1 (MCP spec citation) is resolved by the schema-JSON citation in §0. Q2 (VS Code confirmation policy) is resolved by the two verbatim quotes in §0. Q5 (idempotentHint on read-only tool) is resolved by dropping the field per the "meaningful only when readOnlyHint == false" spec clause. Q7 (openWorldHint = false truthfulness) is resolved by the spec's definition of "closed domain of interaction" matching the qa-debug surface (MementoPauseStore only).

Remaining open questions (status quo) — defer to Phase 2 telemetry or implementation-time judgment:

1. **Status-bar click destination.** Current §2.2: focuses Test Explorer. Alternative: opens chat with `@qa-debug` pre-typed. Recommendation (confirmed by iter#2 reviewer): keep Test Explorer per **[B3]** (Test Explorer is the primary run surface; chat is conversational, not a status-bar destination — opening chat re-introduces the very ritual v5.4 is eliminating). **Resolution: Test Explorer focus, as drafted.**

2. **Status-bar lifecycle relative to multi-pause Phase 2.** Phase 1 invariant is single active pause, so the status-bar entry is a singleton. If Phase 2 lifts the multi-pause invariant, does the status-bar entry become a counter ("$(debug-alt) QA Paused (3)") or a stacked indicator? Defer to Phase 2; v5.4 ships the singleton form.

3. **Tooltip mode-display.** §2.2 — tooltip shows Mode A/B per v5.2 §2.5 transparent-use parity. iter#2 reviewer confirmed this is helpful (Mode A/B is the exact context a QA needs to know whether they own browser teardown). **Resolution: keep, as drafted.**

## 7. Recommendation

Apply v5.4 as drafted (iter#2 polish applied inline). Proceed to v5.4 implementation (Task #20). The v5.4 work touches notification UX, status bar, MCP annotations, qa-debug-mcp invocation logging (§2.7), and tools.ts type extension, with no breaking changes to v5.3's chat-participant or v5.2's transparent use modes.

## 8. Status

- **In-conversation Iteration #1** — 2026-05-21. Reviewer iter#1 (in-conversation, no file) returned REVISE with 4 blockers (B1–B4 above) + NB1 resolved (LanguageModelToolInformation.tags exists at vscode.d.ts:21146). Documented in [[project-qa-companion]] v5.4 IN-FLIGHT section.
- **Iteration #1 (this file)** — 2026-05-21 file write. All 4 in-conversation blockers applied inline from inception. Q1–Q7 open for iter#2.
- **Iteration #2** — 2026-05-21. Ralph-loop reviewer #7 (general-purpose subagent, adversarial Anthropic-engineer style) returned **APPROVE-with-polish** — 0 blockers, 11 non-blockers + Q1/Q2/Q5/Q7 resolved via WebFetch of canonical MCP schema JSON + VS Code MCP client docs. NBs applied inline in this iter-#2 polish pass:
  - **NB1** — dropped `idempotentHint: true` from `qa_get_failure_context` annotation; MCP schema clause "meaningful only when `readOnlyHint == false`" makes it spec-incoherent for read-only tools. §0 + §2.3 + §3.4.3 + §4.5 test #3 updated.
  - **NB2** — §0 source URL for MCP spec replaced with canonical schema JSON path (github.com/modelcontextprotocol/.../schema.json `definitions.ToolAnnotations`); the rendered modelcontextprotocol.io spec page no longer renders a #tool-annotations subsection. "(n/a)" column re-encoded as "—" meaning OMITTED.
  - **NB3** — §0 + §3.4.3 disclose verbatim VS Code MCP docs ("VS Code doesn't ask for confirmation to run read-only tools" / "The confirmation dialog will be shown for all tools that are not marked with the readOnlyHint annotation") + secondary finding that VS Code today consumes ONLY `title` + `readOnlyHint`; `destructiveHint` / `idempotentHint` / `openWorldHint` are declared for forward-compatibility only.
  - **NB4** — §3.7 stale-resume wiring added (`pauseStatusBar.show(stale.session_id)` in `resumeStalePauseIfAny` after context-key set, before notification show). §4.5 acceptance test #6 (BLOCKER) added.
  - **NB5** — vscode.d.ts line-citation corrected from 7626–7632 → 7613–7624 (covers the actual backgroundColor restriction Note + declaration; 7626–7632 covered the unrelated `command:` field).
  - **NB7** — §2.3 added "Two distinct gates" clarification (VS Code per-call MCP confirmation gate vs project-architectural UI button gate; both fire for propose verbs, only the latter is structural).
  - **NB8** — §6 inlined the resolutions of Q1/Q2/Q5/Q7 (resolved via iter#2 WebFetch); Q3/Q4/Q6 retained as Phase-2-deferred or implementation-judgment items.
  - **NB9** — new §2.7 implementation requirement: qa-debug-mcp must emit `[qa-debug-mcp] qa_get_failure_context called session=...` (and equivalent per-tool log lines) via `server.sendLoggingMessage` so §4.5 test #4 is falsifiable. Verified at iter#2 that current qa-debug-mcp/src/server.ts:41–80 does NOT emit this log — Task #20 implementation must add it.
  - **NB10** — §5 risk row "destructiveHint misread" reframed from "medium" (active) to "low for Phase 1, hypothetical for Phase 2+" (forward-compat against future MCP clients; VS Code 1.120 does not consume the field).
  - **NB11** — process note for [[feedback-ralph-loop]]: when §0 source bullets self-flag "WebFetch needed at iter#2", the iter-#1 author should make the WebFetch attempt before writing the file. Iter#2 cap should not be spent on what iter#1 could have done. Documented for next CR.
  - **NB6** — no fix required (informational only — confirmed `createStatusBarItem` overload choice is correct as drafted).
- **ARCHITECTURE-CR-v5.4 APPROVED 2026-05-21** (Ralph-loop reviewer #7 APPROVE-with-polish; all 11 NBs applied inline; convergence at iter#2 per cap=3 precedent established by CR-v5.1 / CR-v5.2 / CR-v5.3). Task #20 (implementation) may begin with §4.5 acceptance tests as gating checks.
