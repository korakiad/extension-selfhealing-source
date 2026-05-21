# ARCHITECTURE v5.3 — Change Request: chat-participant integration for seamless pause-to-investigation handoff

> Status: **Iteration #3 draft 2026-05-21** — APPROVED by reviewer #2 with explicit waiver of iter#4. Iter-#1 applied 6 blockers + 9 non-blockers; iter-#2 reviewer returned APPROVE-with-polish with 9 polish items; iter-#3 (this draft) applies all 9 polish items inline. Change tags: **[R#2-Bn]** / **[R#2-NBn]** = iter-2 fixes (preserved); **[R#3-NBn]** = iter-3 polish. Iter-#1 surfaced from user feedback against the v5.2 F5 smoke output (screenshot 2026-05-21): pause-publish + Test Explorer + MCP gate all worked correctly, but the Sessions / Copilot chat panel did NOT auto-engage the qa-debug Skill — user had to manually open chat and type a query, leaving an "experience seam" the [[feedback-transparent-use]] mandate doesn't cover but [[feedback-chat-panel-engagement]] now formalizes.
>
> Scope: §2 (Architecture decision — chat-participant added to component list), §3.3 (SKILL.md retained but augmented with chat-participant invocation path), §3.4 (gating — context-key flips now also fire the chat-participant availability event), §3.5 (notification UX gains "Ask Copilot" button), §4 (failure-pause loop adds chat-open step), and SLICE_PLAN.md §4 (chat-participant promoted from Phase 2 to Phase 1 must-have).
>
> **Scope upgrade:** `vscode.chat.createChatParticipant` was explicitly deferred to Phase 2 in v5 SLICE_PLAN.md §4. This CR promotes it to Phase 1 because the v5.2 smoke surfaced that without it the product is incomplete from the QA's perspective.

## 0. Sources (per ARCHITECTURE v5 §0.1)

### Research finding: Option 3 (VS Code Sessions API) — does NOT exist

The user's directive was "research Option 3 first; if no, then Option 2". Option 3 was hypothesized to be a VS Code 1.120+ extension API that lets us register a "session provider" against the new Sessions panel visible in the user's screenshot. Research negative:

- **`@types/vscode@1.120.0`** — `grep -nE 'export (class|interface|namespace|function|const) [A-Z][a-zA-Z]*Session' index.d.ts | grep -iE 'agent|chat|plan|tool'` returns ZERO results. The only `Session` exports are `AuthenticationSession` (unrelated) and `DebugSession` (unrelated). No `AgentSession`, `ChatSession`, `PlanSession`, `RegisterSessionProvider`, `lm.createSession`, or similar.
- **`code.visualstudio.com/updates/v1_120`** (WebFetched 2026-05-21, May 13 2026 release) — release notes mention "Agents window" with internal UI navigation ("Navigate between recent sessions") but explicitly NO extension API for sessions. Quote: *"The closest reference to session-related functionality is the ability to 'Navigate between recent sessions' in the Agents window using arrow buttons, but this appears to be a UI navigation feature rather than an extensibility API."*
- The "SESSIONS" panel visible in the user's screenshot is internal VS Code 1.120 UI for the Agents window — surfaced for the user, NOT for extension authors.

**Conclusion:** Option 3 is unimplementable on the current VS Code surface. Proceed with Option 2 (`vscode.chat.createChatParticipant`).

### Capability sources for Option 2

- **`vscode.chat.createChatParticipant`** — `node_modules/.pnpm/@types+vscode@1.120.0/node_modules/@types/vscode/index.d.ts:20126`:

  ```ts
  export function createChatParticipant(id: string, handler: ChatRequestHandler): ChatParticipant;
  ```

  `ChatParticipant` interface at vscode.d.ts:19790–19824 with `id`, `iconPath?`, `requestHandler`, `followupProvider?`, `onDidReceiveFeedback`, `dispose()`. The doc comment (vscode.d.ts:19786–19788 verbatim): *"A chat participant can be invoked by the user in a chat session, using the `@` prefix. When it is invoked, it handles the chat request and is solely responsible for providing a response to the user."*

- **`ChatRequestHandler`** — vscode.d.ts:19784:

  ```ts
  export type ChatRequestHandler = (request: ChatRequest, context: ChatContext, response: ChatResponseStream, token: CancellationToken) => ProviderResult<ChatResult | void>;
  ```

- **`ChatResponseStream` methods** — `code.visualstudio.com/api/extension-guides/ai/chat` (5/20/2026):
  - `markdown(text)` — render text/Markdown.
  - `progress(message)` — show intermediate feedback during operations.
  - `button(options)` — invoke a VS Code command via a clickable button.
  - `reference(uri)` — add reference to URL or editor location.
  - `anchor(uri, title)` — create inline reference.
  - `filetree(tree, baseLocation)` — display file tree control.

- **`contributes.chatParticipants` package.json schema** — `code.visualstudio.com/api/extension-guides/ai/chat` (5/20/2026):

  ```json
  {
    "contributes": {
      "chatParticipants": [
        {
          "id": "chat-sample.my-participant",
          "name": "my-participant",
          "fullName": "My Participant",
          "description": "What can I teach you?",
          "isSticky": true
        }
      ]
    }
  }
  ```

  Required: `id`, `name`. Optional: `fullName`, `description`, `isSticky`, `commands`, `disambiguation`. The `disambiguation` field documents auto-routing categories with `description` and `examples` so the participant can be selected WITHOUT explicit `@name` if the user's free-form query matches one of the examples — verbatim: *"VS Code uses the `disambiguation` property containing detection categories with descriptions and examples to automatically route prompts to suitable participants without explicit mention."*

- **`workbench.action.chat.open` command** — `github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` (WebFetched 2026-05-21). The id `CHAT_OPEN_ACTION_ID = 'workbench.action.chat.open'` is registered alongside the sibling `ACTION_ID_OPEN_CHAT = 'workbench.action.openChat'` (this CR uses the former). **[R#2-B4]** The internal `run()` impl calls `chatWidget.setInput(opts.query); chatWidget.acceptInput()`. The `@<participant-name>` prefix routing happens in a separate VS Code module (`chatParser` / `chatRequestParser` — not WebFetched in this iter#1 pass), so the *expectation* that the `query` string can route to a participant via `@qa-debug` prefix is consistent with VS Code's user-facing behavior (typing `@qa-debug` in the chat input routes to that participant) but is **not citation-verified at the command-registration level** in this CR. Phase 1 implementation-time acceptance test (§5 risk row): smoke that the button actually invokes the participant handler.

  ```ts
  // Run signature:
  async run(accessor: ServicesAccessor, opts?: string | IChatViewOpenOptions)

  // IChatViewOpenOptions accepts:
  interface IChatViewOpenOptions {
    query: string;
    isPartialQuery?: boolean;
    attachFiles?: (URI | { uri: URI; range: IRange })[];
    mode?: ChatModeKind | string;
    previousRequests?: IChatViewOpenRequestEntry[];
    toolIds?: string[];
    blockOnResponse?: boolean;
    toolsInclude?: string[];
    toolsExclude?: string[];
  }
  ```

  `isPartialQuery: false` causes the query to auto-submit on chat open; `isPartialQuery: true` opens the chat with the query pre-typed but unsubmitted (lets the user edit before sending). Sibling commands: `workbench.action.openChatToSide` and `workbench.action.newChatWindow` (both with identical `IChatViewOpenOptions`). Per reviewer #1 Q1 recommendation: ADD an activation-time `vscode.commands.getCommands(true)` probe that verifies `workbench.action.chat.open` is present and degrades "Ask Copilot" to "Open Chat" (no query) if not — see §2.3 sketch. **[R#3-NB2]** Note: the degraded fallback `workbench.action.openChat` is ALSO an internal command (not in the formal commands reference); §2.3 probes both and shows a notification telling the user to open chat manually if neither is available. Phase 1 acceptance test #1 (§4.5) is the gating check for `@-prefix` routing path; §0 cross-reference [R#3-NB8] now correctly points at §4.5 test #1.

- **`ChatContext`** — vscode.d.ts:19673–19681. `readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>` lets the participant read prior turns in the same session.

- **`ChatFollowupProvider`** — vscode.d.ts (ChatFollowup at :19744, provider at :19770):

  ```ts
  cat.followupProvider = {
    provideFollowups(result, context, token) {
      return [{ prompt: 'text', label: 'Human-readable label' }];
    }
  };
  ```

  Lets us suggest follow-up prompts after each response.

### Repo-local sources

- `ARCHITECTURE.md` v5.1 §2 / §3.3 / §3.4 / §3.5 / §4.
- `SLICE_PLAN.md` v5 §4 — "**Chat-participant (`vscode.chat.createChatParticipant`) — Phase 2 if needed for `@qa run` user-driven invocation.**" This CR explicitly promotes it.
- `ARCHITECTURE-CR-v5.2.md` — APPROVED 2026-05-21 — adjacent; v5.3 layers on top.
- `S4_DESIGN.md` §8.4 (notification surface — gains "Ask Copilot" button).
- `extension/src/session-manager.ts:213–223` — current `vscode.window.showInformationMessage` call site for pause notification.
- `extension/skills/qa-debug/SKILL.md` — frontmatter description (S3 + S4 stub body) — remains unchanged; chat-participant is an ADDITIONAL entry path, not a replacement.
- **[R#2-B2]** `extension/src/pause-store.ts:48` — `MementoPauseStore.peekActivePause(): PausePayload | undefined` is what the chat participant reads (returns undefined when no pause, does NOT throw). Iter-#1 incorrectly cited `qa-debug-mcp/src/pause-store.ts` whose `InMemoryPauseStore` only exposes `getActivePause` (throws). The §2.1 sketch imports from `./pause-store.js` (the extension's MementoPauseStore) — implementation was correct, citation was wrong.

### Agentic-design sources (per ARCH v5 §0.2)

- `anthropic.com/research/measuring-agent-autonomy` (Feb 18, 2026) — already cited in ARCH §3.2: *"oversight requirements that prescribe specific interaction patterns…will create friction without necessarily producing safety benefits."* Reinforces that the "Ask Copilot" button is the right friction level for §2.5 — ONE click bridging pause to chat surface, not a multi-step approval gate.

**[R#2-B6] Honest acknowledgment of citation scope:** No Anthropic source addresses dual-channel engagement (description-driven Skill + chat-participant + disambiguation) coexistence. Reviewer #1 confirmed via WebFetch of `measuring-agent-autonomy` and `trustworthy-agents` that neither bears on this design call. §2.4's "keep both paths" choice is therefore **a deliberate Phase 1 pragmatic choice** — not an Anthropic-backed prescription. The framing is: until Phase 2 telemetry shows real user confusion from overlap, ship both paths because each catches different user behaviors (notification-click vs free-form-query) and both read the same MementoPauseStore so the surfaced context is consistent. This pragmatism replaces the iter-#1 implicit overclaim that the dual-path design was somehow Anthropic-grounded.

## 1. The contradiction

ARCHITECTURE v5.1 §3.3 prescribes: *"Skill engagement is **description-driven** per Anthropic Skills semantics… The `qa-debug.paused` VS Code context key gates **UI affordances only** — Test Explorer button visibility, command enablement, status-bar indicators. It does not gate Skill engagement."*

SLICE_PLAN v5 §4 explicitly defers chat-participant to Phase 2: *"Chat-participant (`vscode.chat.createChatParticipant`) — Phase 2 if needed for `@qa run` user-driven invocation."*

User directive 2026-05-21 (memory [[feedback-chat-panel-engagement]], surfaced via F5 smoke screenshot):

> *"It doesn't work seamless with copilot chat panel."*

Concrete experience as captured in the screenshot:
1. Test Explorer shows the wdio fixture as failed.
2. Output Channel shows pause-publish + MCP gate registration succeeded.
3. The Sessions / chat panel on the right shows only the generic "Describe what to build" prompt + a "Plan agent" tip. **No qa-debug context, no acknowledgement of the active pause, no participant or skill visible to the user.**

The current architecture is correct per its own contract — description-driven engagement requires the user to type a query that matches the SKILL description before Claude engages. The pause notification (`vscode.window.showInformationMessage`) is supposed to be the bridge, but it has no actionable path to the chat panel — the user must mentally translate "test paused" → "open Copilot" → "type a query about the failure" → wait for the Skill to engage.

This violates the spirit (not the letter) of [[feedback-transparent-use]]: transparent use extends beyond "no code edits" to "the AI integration doesn't require ritual queries to engage when there's an unambiguous active pause".

## 2. The proposal

Add `vscode.chat.createChatParticipant` registration. The notification UX gains an "Ask Copilot" button that opens the chat panel with a pre-filled query routed to the new participant. The Skill description-driven engagement is preserved as a parallel path (users who freely type still get Skill engagement via description match). The change is additive — no v5.1 / v5.2 behavior is removed.

### 2.1 Chat participant registration

Add a new component `extension/src/chat-participant.ts`:

```ts
import * as vscode from 'vscode';
import type { MementoPauseStore } from './pause-store.js';
import type { OutputChannel } from 'vscode';
import { appendInfo } from './output-channel.js';

export function registerQaDebugChatParticipant(
  context: vscode.ExtensionContext,
  pauseStore: MementoPauseStore,
  channel: OutputChannel,
): void {
  const participant = vscode.chat.createChatParticipant('qa-debug', async (request, ctxHistory, stream, token) => {
    // 1. Read active pause (if any). peekActivePause returns undefined cleanly
    // when no pause exists (does NOT throw) — extension/src/pause-store.ts:48.
    // No try/catch needed; iter-#1 sketch had dead try/catch removed per [R#2-B3].
    const active = pauseStore.peekActivePause();

    if (!active) {
      stream.markdown(
        `No Mocha test is currently paused under the QA Debug Companion. ` +
          `Run a fixture test from Test Explorer or via **QA Debug: Run Fixture Suite** ` +
          `to begin a session.`,
      );
      return {};
    }

    // 2. Surface pause context as Markdown.
    stream.markdown(
      `### Active pause: \`${active.test_title}\`\n\n` +
        `**File:** \`${active.file}\`${active.line ? ` (line ${active.line})` : ''}\n` +
        `**Failure:** ${active.failing_assertion}\n` +
        `**Browser held at:** \`${active.cdp_ws_url}\` (${active.mode === 'A' ? 'Mode A — your wdio session' : 'Mode B — companion-launched'})\n\n` +
        `The qa-debug + playwright-mcp tool surface is registered. ` +
        `Ask me to inspect the live browser, edit a selector, retry, give up, or mark as passed.`,
    );

    // 3. Offer decision buttons. The arg is a vscode.Command object per
    // vscode.d.ts:19938 button(command: Command); Command shape is
    // { title, command, tooltip?, arguments? } per vscode.d.ts:24-46.
    // [R#2-NB2 + R#2-NB5] Give Up works in BOTH modes — only close_browser
    // is declined in Mode A (v5.2 §2.6); the decision verbs are
    // mode-agnostic.
    stream.button({
      command: 'qa-debug.retry',
      title: 'Retry (commit)',
    });
    stream.button({
      command: 'qa-debug.giveUp',
      title: 'Give Up (commit)',
    });
    if (active.mode === 'A') {
      stream.markdown(
        `\n\n_Note: in Mode A, your test code owns the browser via wdio.remote(). ` +
          `Close it via \`browser.deleteSession()\` in your test teardown — ` +
          `\`qa_propose_close_browser\` returns declined per v5.2 §2.6._`,
      );
    }

    appendInfo(channel, `[chat-participant] handled request for session=${active.session_id}`);

    return {};
  });

  // Optional: icon + followups.
  participant.iconPath = new vscode.ThemeIcon('debug-alt');
  participant.followupProvider = {
    provideFollowups: (_result, _ctx, _token) => {
      const active = pauseStore.peekActivePause();
      if (!active) return [];
      return [
        { prompt: `Inspect the failing selector for "${active.test_title}"`, label: 'Inspect selector' },
        { prompt: `Show console logs for the held browser`, label: 'Console logs' },
        { prompt: `What was the failure root cause?`, label: 'Diagnose root cause' },
      ];
    },
  };

  context.subscriptions.push(participant);
}
```

### 2.2 package.json `contributes.chatParticipants`

Add to `extension/package.json` `contributes`:

```json
{
  "chatParticipants": [
    {
      "id": "qa-debug",
      "name": "qa-debug",
      "fullName": "QA Debug Companion",
      "description": "Investigates a paused Mocha test failure with live browser access via playwright-mcp.",
      "isSticky": true,
      "disambiguation": [
        {
          "category": "qa-debug-pause-investigation",
          "description": "Investigating a paused Mocha test failure where the browser is held alive for live inspection.",
          "examples": [
            "the test just failed, what's going on",
            "this assertion's wrong, can you look",
            "I think the selector changed",
            "help me debug this paused test"
          ]
        }
      ]
    }
  ]
}
```

**[R#2-B1 + Q2 answer]** `isSticky: true` per `code.visualstudio.com/api/extension-guides/ai/chat`: *"A boolean value indicating whether the chat participant is persistent in the chat input field after responding."* This is **UI persistence of the `@qa-debug` token in the input box** — NOT a guarantee the handler routes again automatically. Multi-turn flows benefit because the user doesn't have to re-type the `@` prefix; routing still happens because the `@` token is in the input on submit. Iter-#1 over-claimed sticky as a routing guarantee — corrected here.

`disambiguation` examples enable auto-routing for free-form queries — users who don't know the participant exists still get routed. **[R#2-B5]** Built-in chat participants take precedence (e.g., `@workspace` may auto-route ahead of `@qa-debug` for generic queries). The disambiguation examples here are tuned for pause-context-specific phrasings ("the test just failed", "this assertion's wrong", "I think the selector changed", "help me debug this paused test") to reduce overlap. See §5 risk row + §13 acceptance test for the verification that routing actually lands.

### 2.3 Notification UX — "Ask Copilot" button (+ activation-time command probe)

**[R#2-Q1 / R#2-NB9 activation guard]** At extension activation, probe whether `workbench.action.chat.open` is registered (the id is internal per `code.visualstudio.com/api/references/commands`). If absent on the user's VS Code build, downgrade the button to "Open Chat" with no query so the user still has a one-click path to the chat surface but without the @-prefixed seed.

```ts
// extension/src/extension.ts activate() — sketch
// [R#3-NB1] chatOpenAvailable + chatOpenFallback are passed to SessionManager
// via deps so the notification handler in session-manager.ts can read them.
let chatOpenAvailable = false;
let chatOpenFallbackAvailable = false;
try {
  const cmds = await vscode.commands.getCommands(/* filterInternal */ true);
  chatOpenAvailable = cmds.includes('workbench.action.chat.open');
  chatOpenFallbackAvailable = cmds.includes('workbench.action.openChat');
} catch { /* getCommands rarely fails; treat both as unavailable */ }
if (!chatOpenAvailable && !chatOpenFallbackAvailable) {
  appendInfo(channel, `[activate] neither workbench.action.chat.open nor workbench.action.openChat registered; Ask Copilot button will show manual-open instruction`);
} else if (!chatOpenAvailable) {
  appendInfo(channel, `[activate] workbench.action.chat.open absent; degraded to workbench.action.openChat (no query seeding)`);
}
```



Modify `extension/src/session-manager.ts` `pause.publish` handler — the existing notification:

```ts
void vscode.window.showInformationMessage(
  `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
    `Browser held at :9222. Ask Copilot to investigate.`,
  'Open Test Explorer',
  'Open Audit Log',
).then(...);
```

becomes:

```ts
void vscode.window.showInformationMessage(
  `QA Debug: test "${stored.test_title}" failed at ${path.basename(stored.file)}:${stored.line ?? '?'}. ` +
    `Browser held — ask Copilot to investigate.`,
  'Ask Copilot',         // NEW — the seam-closer
  'Open Test Explorer',
  'Open Audit Log',
).then((sel) => {
  if (sel === 'Ask Copilot') {
    // [R#2-NB4] Minimal query: just the routing token + nudge. The participant
    // handler reads MementoPauseStore for the rich context (test title, file,
    // failure, CDP URL, mode) — no need to interpolate them here. Avoids quote-
    // injection issues with test titles containing special characters.
    const query = '@qa-debug investigate this paused test';
    if (chatOpenAvailable) {
      try {
        void vscode.commands.executeCommand('workbench.action.chat.open', {
          query,
          isPartialQuery: false,
        });
      } catch (err) {
        appendInfo(this.deps.channel, `[notification] Ask Copilot failed: ${(err as Error).message}`);
        void vscode.window.showWarningMessage(`QA Debug: could not open chat — ${(err as Error).message}`);
      }
    } else if (this.deps.chatOpenFallbackAvailable) {
      // Degraded path per §2.3: open chat with no query; user types manually.
      void vscode.commands.executeCommand('workbench.action.openChat');
    } else {
      // [R#3-NB2] Both internal commands absent — surface manual instruction.
      void vscode.window.showInformationMessage(
        'QA Debug: open the Copilot Chat panel manually and type @qa-debug to investigate.',
      );
    }
  } else if (sel === 'Open Audit Log') {
    this.deps.channel.show();
  } else if (sel === 'Open Test Explorer') {
    void vscode.commands.executeCommand('workbench.view.testing.focus');
  }
});
```

The "Ask Copilot" button is the new default action. Test Explorer + Audit Log remain available for users who prefer those surfaces.

### 2.4 Skill description-driven engagement preserved

The chat-participant is an ADDITIONAL entry path, not a replacement. The SKILL.md description-driven engagement still fires when users type free-form prompts in the chat that match the description (per Anthropic Skills semantics). The two paths coexist:

| User behavior | Path |
|---|---|
| Reads pause notification, clicks "Ask Copilot" | Chat opens with `@qa-debug` query → participant handles |
| Opens chat manually, types "the test just failed" | `disambiguation` auto-routes → participant handles (Option 2 auto-routing) |
| Opens chat, types "help me debug this paused test" | Same as above OR Skill description-match engages first — both produce qa-debug context |
| Opens chat, types unrelated query | Neither participant nor Skill engages — standard Copilot flow |
| Tests fail without companion (no pause) | Participant + Skill both check pause state and return graceful "no active pause" message |

This honors [[feedback-transparent-use]] (no user edits needed; auto-routing works for free-form queries) AND [[feedback-chat-panel-engagement]] (the notification has a one-click path to engagement).

### 2.5 Remaining "seam" — honest acknowledgment

The CR closes most of the engagement gap but **does NOT achieve fully autonomous chat engagement** (chat appears on pause without any user action). Two reasons:

1. **VS Code API limit.** No event-driven invocation API for chat participants exists. The participant is invoked by user query — either via `@-mention`, `disambiguation` auto-routing, or `workbench.action.chat.open` command (which still represents user intent via button click).
2. **Anthropic Skill semantics.** Skills engage on description match — they read the user's turn. Auto-engaging without a user turn would bypass the engagement signal entirely and is not how Skills are documented.

The remaining seam is therefore **one user click** (the "Ask Copilot" button in the notification). This is a meaningful improvement over v5.2's multi-step ritual (read → open chat → type query → wait → maybe engage) but is not zero-click.

**A future Phase 2+ CR could explore:**
- Auto-opening the chat panel with the query pre-filled — could fire `workbench.action.chat.open` with `isPartialQuery: true` on pause-publish without waiting for the user to click, giving them an editable seed query in chat. **[R#3-NB9 corrected]** Phase 1 §2.3 uses `isPartialQuery: false` (auto-submit) deliberately — the click signals user intent to engage. Phase 2 could shift to true (pre-typed but unsubmitted) so users can edit before sending, OR push further to auto-open-on-pause (intrusive; may interrupt the user's other work — Phase 2 telemetry should weigh this).
- If VS Code ships an event-driven invocation API in a future release, integrate it.
- A status-bar item that pulses on pause as an additional visual signal.

For Phase 1 / v5.3, the one-click bridge is the right friction level.

### 2.6 Diagnostic improvements (bundled into this CR per [[feedback-chat-panel-engagement]] #4)

Add positive logging in `mocha-hooks/src/qa-hooks.ts`:

- `[qa-hooks] wdio.remote patch installed (path=<wdioPath>)` on successful Mode A patch.
- `[qa-hooks] Mode A engaged for session=<id> cdp=<url>` whenever `getPuppeteer().wsEndpoint()` succeeds inside `afterEach`.

Add engagement-path telemetry in extension (per [R#3-NB5] — moved from §4.5 test #5):

- `[chat-participant] handled request for session=<id>` whenever the chat participant's `requestHandler` runs (the line referenced by §4.5 tests #1 and #2).
- `[skill] description-match engaged for session=<id>` whenever the SKILL.md description-driven engagement fires. **Caveat:** there is no direct VS Code API to observe Skill engagement; this log can only be emitted from the qa-debug MCP server's `qa_get_failure_context` tool-call handler (proxy: if the agent calls `qa_get_failure_context` and the participant handler did NOT run in the same turn, infer Skill engagement). Phase 2 may add a more direct observability hook if VS Code ships one.

These let the engineer confirm Mode A AND engagement-path from Output Channel without re-running with custom debug instrumentation.

## 3. ARCHITECTURE.md edits

### §2 Component list

Add to the diagram and component description:

> *"Chat participant (`vscode.chat.createChatParticipant('qa-debug', ...)`) — first-class @qa-debug entry point in the Copilot chat panel, registered alongside the SKILL.md description-driven engagement path. The participant reads the active pause from MementoPauseStore and surfaces its context (test, file, failure, CDP URL, mode) to the agent immediately, without requiring the user to type the context themselves. Disambiguation examples enable auto-routing for free-form queries that match the pause-investigation context."*

### §3.3 SKILL.md

Add a closing paragraph:

> *"v5.3 (2026-05-21) augmentation: a `vscode.chat.createChatParticipant('qa-debug', ...)` is registered alongside the Skill. The two paths coexist — chat-participant is the **notification-driven** entry point (user clicks 'Ask Copilot' on the pause toast); the Skill is the **conversational** entry point (user types a free-form query matching the description). Both ultimately surface the same active-pause context from MementoPauseStore. The `chatParticipants` contribution's `disambiguation` examples mirror the Skill description's engagement signals so free-form queries route consistently regardless of which entry point Claude resolves through."*

### §3.4 MCP gating

Add to §3.4.1:

> *"Chat participant availability mirrors the MCP gate: the participant is registered at extension activation (not per-pause) — it must be present for Claude to route @-mentions to it — but its `requestHandler` reads the active pause from MementoPauseStore on each turn. When no pause is active, the handler returns a graceful 'no active pause; run a fixture to begin' Markdown response so the participant doesn't pretend to have context it doesn't have. This matches the §3.4 MCP-gate principle: the surface is registered when relevant, returns empty / null states when not."*

### §3.5 Notification surface

Replace the §3.5 IPC paragraph's notification clause with the v5.3 three-button form including "Ask Copilot" as the default action (full text in §2.3 above).

### §4 Failure-pause loop sequence

Insert new step 5.5 (between current step 5 — chat notification — and step 6 — agent flow):

> *"5.5. **User clicks 'Ask Copilot' in the notification** → `workbench.action.chat.open` executes with `query: '@qa-debug Test … failed at … Help me investigate'` + `isPartialQuery: false`. The chat panel opens with the query auto-submitted; VS Code routes the @qa-debug prefix to our participant's `requestHandler`; the handler reads MementoPauseStore and streams the pause context + decision-button shortcuts to the chat. The agent then proceeds with step 6 — calling `qa-debug:qa_get_failure_context` and the playwright-mcp investigation tools — but now with the conversation seeded by participant context, not by user typing."*

### §6 Status

Append:

> *"v5.3 APPROVED YYYY-MM-DD by Ralph-loop reviewer #N. Scope: chat-participant integration. §2 component list adds chat participant; §3.3 SKILL.md gains coexistence-with-participant paragraph; §3.4.1 gains participant-availability description; §3.5 notification gains 'Ask Copilot' button; §4 step 5.5 inserts the participant-handoff flow. SLICE_PLAN.md §4 promotes chat-participant from Phase 2 deferred to Phase 1 must-have. Closes [[feedback-chat-panel-engagement]] gap to within one user click; the remaining seam (no zero-click event-driven invocation API in VS Code 1.120) is acknowledged honestly with Phase 2 follow-up notes."*

### SLICE_PLAN.md §4 amendments

- Remove the line *"Chat-participant (`vscode.chat.createChatParticipant`) — Phase 2 if needed for `@qa run` user-driven invocation."* (promoted to Phase 1 per this CR).
- Add to Phase 2 follow-ups: *"Fully event-driven chat-participant invocation (zero-click bridge from pause to chat). Awaits VS Code shipping an extension API for non-user-initiated chat session opens; currently `workbench.action.chat.open` requires a user-intent gesture (button click)."*

## 4. Cost analysis

| | Keep v5.2 (description-driven only) | Apply v5.3 (chat-participant + button) |
|---|---|---|
| **User clicks to engage from pause** | 4+ (read notification, focus chat, type query, wait for Skill engagement) | 1 (click "Ask Copilot") |
| **Free-form chat engagement** | Description-match only (Skill semantics) | Description-match OR disambiguation-routing (two engagement signals; auto-route catches more queries) |
| **Participant surfaces pause context proactively** | No — agent must call `qa_get_failure_context` first turn | Yes — participant handler streams context Markdown immediately on first turn |
| **Phase 1 scope creep** | None | +~80 LOC (chat-participant.ts + notification-button wiring + positive Mode A logging) + 4 F5-time acceptance probes (§4.5) |
| **Architectural complexity** | Single engagement path (description-driven Skill) | Two paths (participant + Skill); the §2.4 coexistence table makes the contract explicit |
| **Risk of overlap confusion** | Low (single path) | Medium (two paths could give different responses) — mitigated by both paths reading the SAME MementoPauseStore so context is consistent |
| **Honors `[[feedback-chat-panel-engagement]]`** | No — gap surfaced as architectural | Yes — closes to one click; honest about residual seam |

Net: apply. The 80 LOC + one notification button buys a categorical UX improvement; the residual one-click seam is acknowledged and pinned to a Phase 2 follow-up tied to a hypothetical future VS Code API.

## 4.5 Phase 1 acceptance tests (added per reviewer #1)

The Phase 1 implementation MUST verify the following at F5-Extension-Host time before merging Task #19:

1. **[R#2-B4]** `workbench.action.chat.open` actually routes `@qa-debug` prefix to the participant. Click "Ask Copilot" button in pause notification → verify the participant's `requestHandler` runs (positive log line `[chat-participant] handled request for session=...` appears in Output Channel) AND the chat response includes the deterministic Markdown context from §2.1. If the prefix routing does NOT fire, the §0 capability claim is wrong and a fallback (e.g., pre-attaching `toolIds` or invoking the participant via a different mechanism) must be designed.
2. **[R#2-B5 / R#3-NB3 pass-criterion explicit]** `disambiguation` examples auto-route to `@qa-debug` rather than `@workspace`. Type each of the 4 disambiguation examples in a fresh chat with NO `@-prefix` and verify the participant handler runs. **Pass criterion:** same `[chat-participant] handled request for session=...` Output Channel log line as test #1 appears AND the response is the deterministic Markdown from §2.1 (no file-tree references unrelated to the paused test — those would indicate `@workspace` won). If any example silently routes elsewhere, retune the example or accept the fallback (user manually types `@qa-debug`).
3. **[R#2-NB1 / R#3-NB4 warning-text explicit]** `chatSkills` + `chatParticipants` coexist. **Pass criterion:** no ERROR-level entries containing `chat` or `participant` or `Skill` in Developer: Show Logs (Extension Host) during `activate()`. (The docs don't document `chatSkills` so VS Code may emit no warning at all — that's also a pass. The risk is an explicit duplicate-registration error.)
4. **[R#2-NB9 / VSIX]** Build the VSIX, install locally, confirm activate() does not throw on the missing-command fallback path. Confirm the chat participant registers (visible in @ picker).

Failures in 1–2 are blockers (the CR's design claim depends on them). Failures in 3–4 are non-blockers (the CR ships with caveats and Phase 2 follow-ups). **[R#3-NB5]** The former iter-#2 test #5 ("log which engagement path fired") was an implementation requirement, not a verification test — moved to §2.6 Diagnostic improvements (positive Mode A logging + participant-vs-Skill path log).

## 5. Risk

- **Behavior risk**: low. Chat participant is purely additive. v5.2 description-driven Skill flow is unchanged; v5.2 MCP gate is unchanged; v5.2 propose/commit flows are unchanged.
- **Overlap confusion (medium)**: a user types `the test failed help me investigate` — does Skill engage or participant auto-route? Both might surface; if both produce a response stream the user could see double output. **Mitigation:** both paths read the SAME pause store; the response content is therefore consistent (same test title, same failure assertion, same CDP URL). The visual presentation may differ (Skill response is agent-composed; participant response is handler-composed Markdown). Phase 1 acceptance: two consistent responses is acceptable; Phase 2 may add a "single-engagement-per-turn" arbitration if it becomes a real complaint.
- **`workbench.action.chat.open` is internal command**: not formally part of vscode.d.ts. **Mitigation already in §2.3 sketch:** activation probes both `workbench.action.chat.open` AND the sibling `workbench.action.openChat`; falls through to a manual-open instruction notification if neither is registered. The button handler also wraps `executeCommand` in try/catch so unrecognized opts don't throw. Breaking changes between VS Code minor versions are possible; mitigation is the multi-tier fallback.
- **`@qa-debug` query routing depends on VS Code's natural parsing**: per the VS Code source `query` field is parsed for `@<participant-name>` syntax. The participant's `name` is `qa-debug`. Verify at implementation time that the parser actually picks up the prefix.
- **Phase 2 deferral of zero-click**: the residual seam is one button click. Users who expect AI to engage without ANY click will see this as incomplete. **Mitigation:** the CR §2.5 paragraph + SLICE_PLAN.md §4 Phase 2 follow-up are explicit about why this is the right Phase 1 stopping point.
- **`disambiguation` examples false-positives**: a query like "this assertion's wrong" might auto-route to qa-debug even outside a pause window. **Mitigation:** the participant's handler returns a graceful "no active pause" message in that case; user is mildly confused but not blocked. Phase 2 may add a `when` clause to `disambiguation` if VS Code adds one.
- **[R#2-B5] Built-in participants take precedence**: per `code.visualstudio.com/api/extension-guides/ai/chat`, the docs warn custom participants *"might conflict with the built-in `@workspace` participant"*. For queries like "the test just failed" the disambiguation router may land on `@workspace` ahead of `@qa-debug`. **Mitigation:** Phase 1 acceptance test #2 (§4.5) verifies real-world routing; if `@workspace` wins, the disambiguation examples will need tuning to be more pause-specific, OR users will need to type `@qa-debug` explicitly. The "Ask Copilot" button-driven path is the unconditional fallback — it puts `@qa-debug` directly in the query so no disambiguation is needed.
- **[R#2-NB1] `chatSkills` + `chatParticipants` coexistence undocumented**: `extension/package.json:16` already declares `chatSkills` (S3); this CR adds `chatParticipants`. The official chat docs do not mention `chatSkills` at all and do not specify behavior when both are declared by the same extension. **Mitigation:** Phase 1 acceptance test #3 (§4.5) verifies no duplicate-engagement warning on activate. If VS Code errors, file a Phase 2 CR to choose between the two contribution points (likely keep `chatParticipants`, retire `chatSkills`).
- **[R#2-NB9] VSIX activation guard**: `vscode.chat.createChatParticipant` may be absent on user VS Code versions older than the `engines.vscode` floor (currently `^1.120.0` per v5.2). The activation should runtime-check `typeof vscode.chat?.createChatParticipant === 'function'` and degrade gracefully (skip participant registration; rely on Skill description-driven engagement alone). Matches the v5.2 `fs.existsSync` defensive pattern for bundled hook paths.

## 6. Open questions for reviewer

1. **`workbench.action.chat.open` stability.** The command is registered in `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` but NOT documented in `code.visualstudio.com/api/references/commands`. Is it stable enough to depend on for Phase 1, or does the CR need a fallback path (e.g., a no-op button that just sets a "qa-debug.shouldEngage" context key for the user to react to)? Recommendation: depend on the command for Phase 1 with try/catch; if it disappears in a future VS Code, the only consequence is the button stops working — degrades to current v5.2 behavior.

2. **`isSticky: true` semantics.** The chatParticipant package.json doc says `isSticky` keeps the participant active across follow-up turns. Does this mean the user's next turn auto-routes to qa-debug even without `@qa-debug` prefix? If so, this is great UX (multi-turn investigation flows naturally). If "sticky" means something narrower (e.g., the @-mention is auto-included in the next prompt's UI), the multi-turn flow needs more thought. Reviewer should verify against the chat docs.

3. **Coexistence of chat-participant and Skill — should they merge in Phase 2?** If both paths read the same pause store and produce overlapping responses, is it cleaner to have ONE path? Option A — keep both (current CR): two engagement signals catch more user behaviors. Option B — drop the Skill, rely only on participant (regresses [[project-qa-companion]] R3#A which spent effort defending description-driven engagement). Option C — chat participant calls into the Skill's existing prompt context (unclear if possible per VS Code chat API). Recommendation: Option A (keep both) is the right Phase 1 choice; revisit only if telemetry shows real user confusion.

4. **Notification button order.** Current proposal: "Ask Copilot" first, "Open Test Explorer" second, "Open Audit Log" third. This puts the new path forward but may surprise QAs who learned the v5.1/v5.2 flow. Reviewer should weigh: button order matters for first impressions but VS Code notification buttons are explicitly choices, not commitments — order is suggestion, not enforcement.

5. **Should the participant's response include the propose/commit decision buttons (Mark Passed / Retry / Give Up) inline?** §2.1's sketch includes Retry/Give Up buttons in Mode B. In Mode A, propose_close_browser is declined per v5.2; should we surface that politely in the participant message? Recommendation: yes — add a mode-aware footer noting "browser is owned by your test code; close via deleteSession() in teardown".

## 7. Recommendation

Apply v5.3 as drafted. Reviewer iteration #1 needed. Then proceed to Task #19 (implementation) and verify via F5 smoke against fixture-tests-wdio with the "Ask Copilot" path exercised.

## 8. Status

- **Iteration #1** — 2026-05-21 draft. Reviewer #1 returned REVISE with 6 blocking + 9 non-blocking + Q1–Q5 answers.
- **Iteration #2** — 2026-05-21. Applied all 6 blockers (B1 isSticky-UI-only framing, B2 §0 source path fix, B3 dead try/catch removed, B4 chat-open prefix-routing acceptance test, B5 disambiguation precedence risk, B6 dual-engagement reframed as pragmatic) + key non-blockers + folded Q1-Q5 answers + added §4.5 Phase 1 acceptance tests. Reviewer #2 returned APPROVE-with-polish with 9 polish items + explicit three-iteration-cap waiver: *"None of these block APPROVE per the iter#5.1/5.2 precedent — all are implementation-time fixable wording/scope tweaks. Three-iteration cap reached; recommend proceeding to Task #19 implementation."*
- **Iteration #3** — 2026-05-21. Applied all 9 reviewer-#2 polish items inline: NB1 chatOpenAvailable via deps, NB2 fallback also internal + manual-open final fallback, NB3 test #2 pass criterion explicit, NB4 test #3 warning-text falsifiable, NB5 test #5 reclassified to §2.6 telemetry, NB6 cost row notes acceptance-probe scaffolding, NB7 try/catch already-done acknowledgment, NB8 §0 cross-ref to §4.5, NB9 §2.5 isPartialQuery wording fix. **ARCHITECTURE-CR-v5.3 APPROVED 2026-05-21** (Ralph loop closed at 3 iterations per ARCHITECTURE-CR-v5.1.md + CR-v5.2.md precedent + reviewer #2 explicit waiver). Task #19 (implementation) may begin with §4.5 tests #1 + #2 as the gating checks before merge.
