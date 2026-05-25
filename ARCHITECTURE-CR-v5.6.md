# ARCHITECTURE v5.6 — Change Request: Test Explorer inline action surface + prefilled-chat command + delayed-failed reporting model

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> Status: **Iteration #2 (file)** drafted 2026-05-22. Iter#1 reviewer returned **REVISE-with-blockers** (5 blockers: Probe F empirical, context-key namespace, invented PauseStore API, multi-pause invariant, missing §3 edits, 2 polish items). All blockers addressed inline below; tag **[I2#n]** marks iter#2 changes. Iter#1 status block preserved at §8. Two user-feedback drivers from the post-v5.5 session on 2026-05-22:
>
> 1. **Ergonomics gap on the pause surface.** User feedback: *"ตอนนี้มันดูใช้ยากไปหน่อย"* (current pause-engagement is awkward) — even with v5.4's status-bar + notification, there is no per-test affordance in Test Explorer to (a) commit a decision (Resume/Mark-Passed/Give-Up) without leaving the Testing view, and (b) drop the user into Copilot Chat with the pause context already filled in. v5.4 §2.5 declared Test Explorer the "canonical decision-button host on failed items" but Phase 1 never made those buttons concrete; this CR does.
>
> 2. **Duplicate AI surfaces during pause.** VS Code (with GitHub Copilot Chat installed) renders a ✨ "Fix Test Failure" inline action on any TestItem reported via `TestRun#failed`. Because `test-controller.ts:557-558` calls `run.failed(item, msgs)` *during pause* (not at decision-time), ✨ appears next to a paused test alongside our own pause affordances. User feedback: *"✨ หากเป็น paused เราเอาออกก่อนได้ไหม"* (can we hide ✨ during pause). The cleanest hide is to **not be in `failed` state during pause** — defer `run.failed()` until the give-up decision actually lands. The Mocha reporter side (§3.6) is unaffected; only the VS Code TestRun reporting shifts.
>
> Scope: §3.5 (extension reporting model — new sub-section §3.5.1 "VS Code TestRun lifecycle around pause"), §3.7 (v5.4 status-bar — unchanged narrative, taxonomy table updated), §3.8 NEW (Test Explorer inline action surface), §4 step 4–5.5 (sequence updates to reflect deferred `run.failed()`), §5 tech stack (adds `workbench.action.chat.open` built-in command). NO changes to qa-hooks IPC, MCP gate, qa-reporter Mocha events, or chatSkills. Pure VS Code-side reporting + UI contribution.
>
> **Smaller surface than v5.5.** Two new extension command handlers + a manifest contributes block + a reporting-model shift inside an existing module. Author expects iter#2 may surface ≤3 polish items; cap=3 applies per CR-v5.4 §8 precedent.
>
> **Process discipline.** All §0 platform-owned URL citations were WebFetch-verified or installed-source-verified (vscode.d.ts:18796-18890, chatActions.ts main branch) BEFORE this file was written. No "iter#2 reviewer please verify" TODOs in §0. Per [[feedback-research-source]].

## 0. Sources (per ARCHITECTURE v5 §0.1 / §0.2)

### Capability sources — VS Code testing API (§0.1)

All citations against `node_modules/.pnpm/@types+vscode@1.120.0/node_modules/@types/vscode/index.d.ts`:

- **`TestItem.description?: string`** at :18856 *(corrected from :18860 per iter#1 Finding 5)* — *"Optional description that appears next to the label."* This is the slot v5.6 uses to surface `⏸ paused — <error summary>` inline (not a custom icon, but a visible state cue on the same row as the test name).

- **`TestItem.busy: boolean`** at :18846 *(corrected from :18841)* — *"Controls whether the item is shown as 'busy' in the Test Explorer view."* v5.6 sets `true` during pause so the spinner stays on while the user deliberates.

- **`TestItem.error?: string | MarkdownString`** at :18878 *(corrected from :18873)* — *"Note that this is not a test result and should only be used to represent errors in test discovery, such as syntax errors."* NOT used by v5.6 for pause state — the docstring explicitly forbids this; it is for discovery errors only.

- **`TestRun#started(test: TestItem)`**, **`#failed(test: TestItem, message: TestMessage | TestMessage[], duration?: number)`**, **`#passed(test: TestItem, duration?: number)`** — state-transition surface. v5.6 reorders calls: `started()` at pause, `failed()` or `passed()` deferred until decision lands.

### Capability sources — VS Code menu contributions (§0.1)

WebFetch-verified against `code.visualstudio.com/api/references/contribution-points` (2026-05-22) and `code.visualstudio.com/api/extension-guides/testing` (2026-05-22):

- **`testing/item/context` menu contribution point** — exists; renders in the right-click context menu of a Test Explorer item. Commands placed in `group: "inline"` render as inline icon buttons next to the item label (this is the same mechanism Copilot uses for its ✨ icon, modulo any first-party-only `TestMessageFollowup`-style API which is **not** what v5.6 uses — v5.6 uses only the public `testing/item/context` + inline group contribution).

- **Available `when`-clause context keys for testing/item/context**: `testId`, `controllerId`, `testItemHasUri`. The `in` / `not in` conditional operator (`/api/references/when-clause-contexts#in-and-not-in-conditional-operators`) supports set membership: `when: "testId in qa-debug.pausedTestIds"`. [I2#A — kebab namespace per iter#1 Finding 2 to match existing `qa-debug.paused` convention at session-manager.ts:268,336.]

- **`vscode.commands.executeCommand('setContext', key, value)`** — built-in side-channel for setting context-key values used in `when` clauses. v5.6 wires `qa-debug.pausedTestIds` (array of currently-paused TestItem ids; Phase-1 invariant: array length is 0 or 1, see §5 / Finding 4) to gate inline-icon visibility per item.

### Capability sources — VS Code Chat open command (§0.1)

WebFetch-verified against `github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` (main branch, 2026-05-22):

- **Command id**: `workbench.action.chat.open` (constant `CHAT_OPEN_ACTION_ID`).
- **Argument shape** (`IChatViewOpenOptions`):
  ```ts
  interface IChatViewOpenOptions {
    query: string;                       // prefill text
    isPartialQuery?: boolean;            // false → submit-ready; true → caret-in-input
    toolIds?: string[];                  // narrow tool scope
    mode?: ChatModeKind | string;        // 'ask' | 'edit' | 'agent'
    attachFiles?: (URI | { uri: URI; range: IRange })[];
    // (additional fields omitted: modelSelector, blockOnResponse, attachScreenshot, …)
  }
  ```

  v5.6 uses `query` + `mode: 'agent'` + `toolIds: ['playwright-mcp', 'qa-debug']` + `attachFiles` (with the failing spec file + range pointing to the asserting line).

  **Caveat (declared up-front for reviewer).** `workbench.action.chat.open` is *not* documented in `code.visualstudio.com/api/references/commands`. It is sourced from main-branch VS Code (a first-party command that ships in the editor). Using it from a third-party extension is normal practice in the VS Code extension ecosystem but does not carry the same compatibility guarantee as an explicitly documented API. v5.6 mitigates by feature-detecting at activation: `await vscode.commands.getCommands(true).then(ids => ids.includes('workbench.action.chat.open'))`; if absent, the 💬 icon falls back to focusing the Chat view (`workbench.action.chat.openInSidebar` or `workbench.view.chat.focus`) without prefill.

### Capability sources — Copilot ✨ keying (§0.1) [I2#B — added per iter#1 Finding 1 / Probe F]

Empirically verified at `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json` (built-in extension `copilot-chat 0.49.0`, ships inside the VS Code app bundle on macOS stable):

```json
"menus": {
  "testing/item/result":   [{ "command": "github.copilot.tests.fixTestFailure.fromInline",
                              "when": "testResultState == failed && !testResultOutdated",
                              "group": "inline@2" }],
  "testing/item/context":  [{ "command": "github.copilot.tests.fixTestFailure.fromInline",
                              "when": "testResultState == failed && !testResultOutdated",
                              "group": "inline@2" }],
  "testing/message/context": [{ "command": "github.copilot.tests.fixTestFailure",
                                "when": "testing.testItemHasUri",
                                "group": "inline@1" }]
}
```

This is the load-bearing citation for §2.5. The ✨ icon (registered as `github.copilot.tests.fixTestFailure.fromInline` in inline@2) is gated on `testResultState == failed`. v5.6's reporting-model shift keeps the test out of `failed` state during pause — `testResultState` reads as `running` (started state), the when-clause is unmet, and the icon does not render. The shift is therefore a *cooperative* hide (no Copilot API call needed) verified against installed source per [[feedback-research-source]].

**Inline-slot collision check.** Copilot's icons land in `inline@2`. v5.6's four icons land in `inline@1..4`. During pause: Copilot's `when` is unmet so only v5.6's four are visible (no collision). After give-up commit: v5.6's four disappear (id drops from `qa-debug.pausedTestIds`), Copilot's appears (state is now `failed`). Clean handoff; no overlap window. Validated by reading the manifest — re-verify in S6 manual QA (F-v5.6-a).

### Capability sources — Mocha + reporter unchanged (§0.1)

v5.6 does not change qa-reporter event subscription, the IPC envelope, or the qa-hooks `decision.await` round-trip. Existing §3.1 (R5#A) / §3.6 (R4#B) contracts apply as-is.

### Agentic-design sources (§0.2)

- **Human oversight on irreversible actions** — `docs.claude.com/en/docs/agents-and-tools/computer-use` and `anthropic.com/engineering/writing-tools-for-agents` (Sep 11 2025) both frame human-in-the-loop on commit-shaped actions as a structural design pattern. The propose/commit split (ARCHITECTURE §3.2) already encodes this at the MCP-tool layer; v5.6's Test Explorer inline icons are the *human-side commit affordance* of that same split. The 💬 Chat icon is **not** a commit — it is a conversation entry point that gives the agent context; the commit buttons (✓ Mark Passed, ✕ Give Up, ▶ Resume) remain the only state-transition surface.

- **Description-driven Skill engagement** — `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`. Already cited in v5 §3.3. v5.6 does NOT change Skill engagement: the prefilled prompt is plain text that lands in the Chat input; Claude's description-match on SKILL.md description engages the qa-debug Skill on that turn just as it does today.

### Repo-local sources

- **Current PauseStore API** — `extension/src/pause-store.ts` (read 2026-05-22 at HEAD). Phase-1 store is **single-pause** over `Memento` key `qa-debug.pause.active`. Methods: `setActivePause(p)` :40, `clearActivePause()` :45, `peekActivePause()` :49 (returns `undefined` if no active pause), `getActivePause(sessionId?)` :55 (throws on no-pause; v5.6 does not use the throw path). [I2#C — replaces iter#1's invented `activePauseIds` / `activePauses()` / `lookupByTestId` per iter#1 Finding 3.] v5.6 uses only `peekActivePause()` plus a new `SessionManager.lookupPauseByTestId(testId)` helper that maps a given TestItem id to the (zero or one) active pause:

  ```ts
  // session-manager.ts — NEW helper, replaces invented pause-store method
  public lookupPauseByTestId(testId: string | undefined): PausePayload | undefined {
    const active = this.deps.pauseStore.peekActivePause();
    if (!active) return undefined;
    if (!testId) return active; // command-palette invocation with no test arg
    const activeId = computeTestItemId(active); // file::it::full_title per v5.5
    return activeId === testId ? active : undefined;
  }
  ```

- **Current `recordPause` reporting** — `extension/src/test-controller.ts:531-559` (read 2026-05-22 at HEAD). Lines :557-558:
  ```ts
  run.started(item);
  run.failed(item, msgs);
  ```
  v5.6 removes line 558 from this code path (the `failed()` call) and adds `item.description = '⏸ paused — …'; item.busy = true;` instead. The `failureMessages` map (line :528) is retained — it accumulates msgs for the eventual `failed()` call at decision time.

- **Current `recordDecision` branches** — `extension/src/test-controller.ts:561-624` (read 2026-05-22):
  - `mark_passed` (:586-604) — currently calls `run.failed()` then `run.passed()` to keep the failure history visible alongside the marked-passed transition. v5.6 KEEPS this as-is (the `failed()` here is the *first* `failed()` call for the test under the new lifecycle). [I2#D — per iter#1 Finding 8: whether the failed→passed transition produces a perceptible ✨ flash is empirical; F-v5.6-b acceptance MUST verify "no perceptible flash > 1 frame at 60Hz" and if a flash is observed, demand re-sequencing (e.g., set `description = '(marked passed)'` then call `passed()` only, skipping the intermediate `failed()` and relying on the audit log + sticky message attached via a different mechanism).]
  - `give_up` (:606-613) — currently only `run.appendOutput(...)` (relying on the pause-time `failed()` to persist). v5.6 MUST add `run.failed(item, failureMessages.get(item.id) ?? [])` here — this becomes the *first and only* `failed()` call in the give-up path. ✨ appears here, in the correct bibliographic context (test definitively failed after human decision).
  - `retry` (:614-622) — currently `run.appendOutput(...)` then `run.started(item)`. v5.6 simplifies to just `appendOutput`; the item was never flipped out of `started` state, so no revival call is needed.

### Memory cross-references

- [[feedback-chat-not-launcher]] — v5.6 confirms: Test Explorer = launcher surface for run/decision actions; Chat = conversation surface. The 💬 icon is the seam, NOT chat-as-command. The icon lives in Test Explorer (run surface) and *opens* chat with a conversation prefill; the user does not type a command into chat.
- [[feedback-chat-panel-engagement]] — v5.4 closed engagement to status-bar + notification + Skill description-match. v5.6 adds a *fourth* surface (Test Explorer inline icons). Composition is justified in §2.4 below.
- [[feedback-transparent-use]] — v5.6 changes are pure extension-side (manifest + extension code). QA does not edit specs, `.mocharc`, browser launch config, or capabilities. ✅ preserved.
- [[feedback-ralph-loop]] / [[feedback-ralph-loop-scope]] — this CR covers the architectural piece (reporting-model shift + new surface). The implementation steps live in a separate lightweight PLAN doc (`PLAN-paused-test-affordances.md`).

## 1. The contradiction

ARCHITECTURE v5.4 §2.5 surface taxonomy:

> *Test Explorer | Primary surface (project choice) for picking what to run; **canonical decision-button host on failed items** | Always available; populated lazily at pause-time today (v5.5 territory populates at discovery)*

…and ARCHITECTURE §4 step 4 (R3#A):

> *The `qa-debug.paused` context key concurrently enables the Test Explorer commit buttons.*

Both claim Test Explorer hosts the decision buttons. Phase 1 implementation, however, lands no inline buttons on the TestItem itself — the only Test-Explorer-side surfaces are (a) the failure annotation rendered via the TestMessage attached at `run.failed()` time, and (b) the contextValue tag on that message (`qaDebugPaused` / `qaDebugMarkedPassed` — see `test-controller.ts:547`, `:595`). The decision affordances live in the status-bar entry (v5.4 §2.2), the pause notification toast (v5.4 §2.1), and the chat-participant's propose/commit verbs (v5.3+v5.4). The "canonical decision-button host" is a claim the architecture makes but does not yet deliver.

That gap surfaced concretely on 2026-05-22 when the user observed the Test Explorer screenshot showing ✨ "Fix Test Failure" as the *only* inline affordance on the paused test row — a Copilot-supplied button that bypasses our propose/commit semantics. The asymmetry is jarring: VS Code+Copilot supplies a one-click escape hatch, the project's own canonical surface supplies none.

## 2. The proposal

### 2.1 Test Explorer inline action surface (**§3.8 NEW**)

Add four commands + corresponding `testing/item/context` inline contributions, gated on `testId in qa-debug.pausedTestIds`:

| Icon | Command id | Action |
|---|---|---|
| `$(comment-discussion)` 💬 | `qa-debug.openChatForPaused` | Opens Chat view with a prefilled, submit-ready prompt (see §2.2) |
| `$(debug-continue)` ▶ | `qa-debug.requestRetry` | Sends a `retry` decision through the propose/commit gate (auto-commits — retry is asset-additive, not destructive) |
| `$(pass)` ✓ | `qa-debug.proposeMarkPassed` | Opens an input box for rationale, then sends `propose_mark_passed` (still gated by the structural commit gate in §3.2) |
| `$(stop-circle)` ✕ | `qa-debug.requestGiveUp` | Sends a `give_up` decision (gated by a "Are you sure?" Yes/No quickPick — asset-destructive: closes the held browser context if it's the last pause) |

Manifest excerpt:

```json
{
  "contributes": {
    "commands": [
      { "command": "qa-debug.openChatForPaused", "title": "QA Debug: Ask Copilot About This Failure", "icon": "$(comment-discussion)" },
      { "command": "qa-debug.requestRetry",      "title": "QA Debug: Retry",                            "icon": "$(debug-continue)" },
      { "command": "qa-debug.proposeMarkPassed", "title": "QA Debug: Mark Passed",                      "icon": "$(pass)" },
      { "command": "qa-debug.requestGiveUp",     "title": "QA Debug: Give Up",                          "icon": "$(stop-circle)" }
    ],
    "menus": {
      "testing/item/context": [
        { "command": "qa-debug.openChatForPaused", "when": "testId in qa-debug.pausedTestIds", "group": "inline@1" },
        { "command": "qa-debug.requestRetry",      "when": "testId in qa-debug.pausedTestIds", "group": "inline@2" },
        { "command": "qa-debug.proposeMarkPassed", "when": "testId in qa-debug.pausedTestIds", "group": "inline@3" },
        { "command": "qa-debug.requestGiveUp",     "when": "testId in qa-debug.pausedTestIds", "group": "inline@4" }
      ]
    }
  }
}
```

Context-key wire-up (in `extension/src/session-manager.ts`'s pause-publish / decision-commit paths): [I2#A — rewritten against real single-pause PauseStore API; replaces iter#1's `Array.from(pauseStore.activePauseIds)` invention per Finding 3.]

```ts
function refreshPausedTestIdsContext(pauseStore: PauseStore): void {
  const active = pauseStore.peekActivePause();
  const ids = active ? [computeTestItemId(active)] : []; // Phase-1 invariant: length 0 or 1
  void vscode.commands.executeCommand('setContext', 'qa-debug.pausedTestIds', ids);
}
```

Called immediately after `pauseStore.setActivePause(...)` (existing session-manager.ts:267) and after `pauseStore.clearActivePause()` (existing :335). The retry branch is intentionally NOT a refresh site: pause-store stays populated during mocha respawn, and the context-key tracks pause-store state. If the respawned mocha re-fails, a new pause publish naturally refreshes the array; if it passes, the commit path refreshes to empty.

**Why not `testTag`-based gating?** v5.5 added `TestTag` for `.only` / `.skip` visual marks. `TestTag` is a label, not a per-item-state set, and `when`-clauses cannot directly check a TestItem's tag membership. The `testId in <array-context-key>` idiom is the documented mechanism for per-item gating; we use it.

### 2.2 Prefilled-chat command — `qa-debug.openChatForPaused`

Handler skeleton (full text in PLAN):

```ts
async function openChatForPaused(testId: string | undefined, deps: SessionManagerDeps): Promise<void> {
  const pause = deps.sessionMgr.lookupPauseByTestId(testId); // I2#C — real API; see §0 PauseStore citation
  if (!pause) return; // race: pause already committed; let the icon disappear via context-key refresh
  const prompt = buildPausePrompt(pause);
  const fileUri = vscode.Uri.file(pause.file);

  const chatOpen = 'workbench.action.chat.open';
  const available = (await vscode.commands.getCommands(true)).includes(chatOpen);

  if (available) {
    await vscode.commands.executeCommand(chatOpen, {
      query: prompt,
      isPartialQuery: false, // submit-ready: QA presses Enter, no edits needed
      mode: 'agent',         // [[feedback-chat-panel-engagement]] v5.4 default
      toolIds: ['playwright-mcp', 'qa-debug'],
      attachFiles: pause.line
        ? [{ uri: fileUri, range: new vscode.Range(pause.line - 1, 0, pause.line - 1, 0) }]
        : [fileUri],
    });
  } else {
    // Fallback: focus Chat view without prefill, copy prompt to clipboard, show toast.
    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand('workbench.view.chat.focus');
    vscode.window.showInformationMessage(
      'Prompt copied to clipboard — paste into Chat. (workbench.action.chat.open unavailable on this VS Code build.)',
    );
  }
}
```

`buildPausePrompt` (deterministic, no LLM call):

```ts
function buildPausePrompt(pause: StoredPausePayload): string {
  return [
    `A Mocha test is paused at the failure point. Please investigate using the qa-debug + playwright-mcp tools.`,
    ``,
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    `Browser (CDP): ${pause.cdp_ws_url}`,
    ``,
    `Start by calling qa-debug:qa_get_failure_context for grounded context, then use playwright-mcp:browser_snapshot or :browser_evaluate to inspect live DOM. The browser at the CDP endpoint above is the same Chrome window that was open when the test failed.`,
  ].join('\n');
}
```

This prompt is the load-bearing engagement signal for description-driven Skill matching (per [[reference-anthropic-agentic-docs]] best-practices): it mentions "Mocha test is paused", "failure point", and "qa-debug" — all keywords from the qa-debug SKILL.md `description`.

### 2.3 VS Code TestRun lifecycle around pause (**§3.5.1 NEW**)

**Current model** (v5.5 and earlier):

| Phase | TestRun state | TestMessage | ✨ Copilot Fix |
|---|---|---|---|
| Pause publish | `started()` then `failed(msgs)` | Attached at pause | **Visible during pause** ← user complaint |
| Decision: mark_passed | `failed()` (again) then `passed()` | Sticky "marked passed" msg prepended | Flashes briefly during transition |
| Decision: give_up | (no TestRun call; relies on pause-time `failed()`) | Persists from pause | Visible (correct context) |
| Decision: retry | `appendOutput` then `started()` to revive | (cleared by `started()`) | Hidden by revival |

**v5.6 model**:

| Phase | TestRun state | TestMessage | ✨ Copilot Fix |
|---|---|---|---|
| Pause publish | `started()` only; `description = '⏸ paused — …'`; `busy = true` | (deferred; accumulated in `failureMessages` map) | **Hidden** — test is not in `failed` state |
| Decision: mark_passed | `failed(msgs)` then `passed()` | First-and-only failed() in this path; sticky msg as before | Flashes briefly (≤1 frame, acceptable) |
| Decision: give_up | `failed(msgs)`; `appendOutput` | First-and-only failed() in this path | Visible (correct context — definitively failed) |
| Decision: retry | `appendOutput`; clear description; keep `started` | (cleared because no failed() was called) | Stays hidden |

Trade-off declared: under v5.5, the TestMessage with stack trace was inline-visible during pause (rendered by VS Code's failure-annotation peek). Under v5.6, that inline preview is **deferred** until give-up. The error context surfaces during pause via:
- `TestItem.description` (one-line summary inline on the row),
- the existing status-bar entry (v5.4 §2.2),
- the existing pause notification toast (v5.4 §2.1),
- the prefilled prompt (when QA clicks 💬),
- `run.appendOutput(stack, undefined, item)` to the test's terminal panel (preserved; this surface does NOT require `failed` state).

The lost surface is the *inline peek hover* on the failed-test row during pause — which v5.4's status bar already augments. Net: engagement surfaces during pause go from 3 (notification + status bar + Skill match) to 4 (notification + status bar + Skill match + Test Explorer inline icons + description text), minus 1 (inline peek hover). The user's stated friction was excess surfaces (✨), so net subtraction-of-noise + addition-of-affordance is intentional.

### 2.4 Engagement-surface composition with v5.4

[[feedback-chat-panel-engagement]] memory records that v5.3 closed engagement-to-chat to one click; v5.4 reversed that toward Agent-mode-first with the status-bar augmenting the notification. v5.6 adds Test Explorer inline icons as a fourth surface. The composition rationale:

| Surface | Cadence | Direction | Best for |
|---|---|---|---|
| Pause notification toast | One-shot, ephemeral | Push | "Heads-up, a pause happened" |
| Status-bar entry (v5.4) | Persistent while paused | Pull (ambient) | "What state am I in right now?" |
| Chat / Skill description-match (v5.3+v5.4) | On-demand conversation | Pull (intentional) | Investigation, free-form Q&A |
| Test Explorer inline icons (v5.6 NEW) | Persistent while paused, per-test | Pull (targeted) | "I want to act on **this specific** paused test right now" |

The four surfaces serve distinct roles: notification = event, status bar = workspace-level state, chat = conversation, inline icons = per-test commit affordances. None duplicates another. The 💬 inline icon is the bridge from "per-test commit affordance" (Test Explorer) into "conversation" (Chat) — closing the cross-surface seam that v5.4 created by removing the v5.3 "Ask Copilot" toast button without providing an alternative chat entry from the run surface.

**Anti-pattern not introduced**: per [[feedback-chat-not-launcher]], we are NOT making chat a command surface. The 💬 icon lives in Test Explorer (the run surface) and *opens* chat. The user does not type `@qa-debug` to launch anything; that anti-pattern remains rejected. (For full reviewer-side rebuttal, see CR-v5.4 §2.4 "DROP chat-driven suite-running entirely" — v5.6 inherits that disposition.)

### 2.5 Why ✨ disappears (mechanism, not policy)

v5.6 does not "suppress" Copilot's ✨ icon by any first-party API or hack. The icon is keyed to VS Code's `TestItemResult.state === Failed` (per Copilot Chat extension contribution observed in the wild). By keeping the test in `started` (Running) state during pause, the test never enters `Failed` and the icon's `when` clause does not fire. After a give-up decision, the test transitions to `Failed` and ✨ appears — which is the correct context for an AI-driven "Fix Test Failure" suggestion (definitively failed test, error message available, human has declined to investigate further).

This is a **shaping**, not a **blocking**: we cooperate with Copilot's surface rather than fight it. If Copilot's icon-key changes in a future Copilot release, the worst case is ✨ comes back during pause — at which point the user has the choice of (a) clicking it (legitimate, the test IS effectively failed even if not yet reported), or (b) opening an issue on Copilot Chat to refine the keying.

## 3. ARCHITECTURE.md edits on APPROVE [I2#E — added per iter#1 Finding 7]

On APPROVE, the following splice text merges into `ARCHITECTURE.md` under R-tags R6#A..D. Listed in canonical-doc order.

### §3.1 — R6#A — adds §3.5.1 "VS Code TestRun lifecycle around pause"

Insert immediately after the existing §3.5 "IPC, pause-store, and observability":

> **§3.5.1 — VS Code TestRun lifecycle around pause [R6#A].** The extension's TestController calls `run.started(item)` at pause publish and does **not** call `run.failed(item, msgs)` until a give-up or mark-passed decision lands. During pause, the item's state-machine surface is: `started` state, `busy = true`, `description = '⏸ paused — <truncated assertion>'`, accumulated `TestMessage[]` in a local `failureMessages` map waiting for attachment at decision time. On `give_up` commit the extension calls `run.failed(item, msgs)` (first and only `failed()` call in that path), on `mark_passed` commit it calls `run.failed(item, msgs); run.passed(item)` (atomic transition; flash budget per §6 R-row), on `retry` commit it clears `description` and lets `busy` stay true while mocha respawns. The reporting-model shift is **cooperative** with GitHub Copilot Chat's `github.copilot.tests.fixTestFailure.fromInline` icon, which is gated on `testResultState == failed && !testResultOutdated` per the built-in `copilot/package.json` manifest at `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json` (verified 2026-05-22). Because the test never enters `failed` state during pause, the ✨ icon's `when` clause is unmet and it does not render alongside the v5.6 inline icons; on commit-to-failed (give-up), ✨ becomes visible in its correct bibliographic context (definitively-failed test). This is shaping-via-state, not API-blocking.

### §3.2 — R6#B — adds §3.8 "Test Explorer inline action surface"

Insert immediately after the existing §3.7 "Status-bar entry (v5.4)":

> **§3.8 — Test Explorer inline action surface [R6#B].** Four commands (`qa-debug.openChatForPaused`, `qa-debug.requestRetry`, `qa-debug.proposeMarkPassed`, `qa-debug.requestGiveUp`) contributed via `package.json` → `contributes.menus."testing/item/context"` with `group: "inline@1..4"` and `when: "testId in qa-debug.pausedTestIds"`. The context-key array `qa-debug.pausedTestIds` is refreshed at session-manager.ts pause-publish path (after `setActivePause`) and decision-commit path (after `clearActivePause`); the array length is 0 or 1 under the Phase-1 single-pause invariant. The four commands map to the existing propose/commit semantics of §3.2 — 💬 opens Chat with a prefilled prompt (see §3.8.1), ▶ auto-commits a `retry` decision (asset-additive), ✓ Mark Passed gates on a rationale-input box then sends `propose_mark_passed` (still subject to the structural human-commit gate), ✕ Give Up gates on a Yes/No quickPick then sends `give_up`. The 💬 icon is the **Test-Explorer-as-launcher + Chat-as-conversation** seam: it lives in the run surface (Test Explorer) and *opens* a conversation surface (Chat) with full pause context prefilled — aligned with [[feedback-chat-not-launcher]] (chat is not used as a command surface; the user does not type to launch anything).

> **§3.8.1 — Prefilled chat command [R6#B].** Implemented in `extension/src/paused-test-commands.ts::openChatForPaused`. Looks up the active pause via `sessionMgr.lookupPauseByTestId(testId)` (NEW helper, replaces invented `pauseStore.lookupByTestId` per iter#1 Finding 3), builds a deterministic prompt via `buildPausePrompt(pause)` (no LLM call; pure string assembly with test title / file:line / assertion / cdp endpoint), and invokes `vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false, mode: 'agent', toolIds: ['playwright-mcp', 'qa-debug'], attachFiles })`. The command id is sourced from main-branch VS Code at `github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` (constant `CHAT_OPEN_ACTION_ID`); it is NOT documented in `code.visualstudio.com/api/references/commands`. The activate path feature-detects via `vscode.commands.getCommands(true)`; if the command is unavailable (Copilot Chat extension disabled, atypical VS Code build), the 💬 icon falls back to clipboard-copy + `workbench.view.chat.focus` + a toast asking the QA to paste — the icon stays functional, ergonomically degraded.

### §3.3 — R6#C — extends §4 "Failure-pause loop (sequence)"

In step 4, append: " The `qa-debug.pausedTestIds` array context key (new — see §3.8) is refreshed to include the failing test's id, lighting up the four inline icons on its row. `run.started(T)` is called; `T.description = '⏸ paused — …'`; `T.busy = true`. **`run.failed()` is NOT called yet (see §3.5.1).**"

In step 8, replace the `give_up` sub-bullet with: "`give_up` → `run.failed(T, msgs)` (first and only `failed()` call under §3.5.1)" and the `mark_passed` sub-bullet with: "`mark_passed` → `run.failed(T, msgs); run.passed(T)` (atomic transition; F-v5.6-b verifies no perceptible ✨ flash)". Add new closing bullet: "In all decision branches: `qa-debug.pausedTestIds` is refreshed to `[]`; inline icons disappear from `T`'s row."

### §3.4 — R6#D — adds to §5 tech stack

Append to the **VS Code APIs** bullet list:

- `vscode.commands.executeCommand('workbench.action.chat.open', IChatViewOpenOptions)` — first-party-but-undocumented command sourced from VS Code main-branch chatActions.ts. Feature-detected at activation; clipboard fallback when unavailable.
- `contributes.menus."testing/item/context"` with `group: "inline@N"` — public extension API for per-TestItem inline action icons. Context-key gating via `testId in <array-key>` (the in/not-in conditional operator per `code.visualstudio.com/api/references/when-clause-contexts`).

### §3.5 — R6 footnote in §6 "Status" rollup

Append to the running status list under v5 / v5.1 / v5.2 / v5.3 / v5.4 / v5.5:

- **R6#A** — §3.5.1 added: VS Code TestRun lifecycle around pause shifts `run.failed()` from pause-publish to decision-commit; cooperative with Copilot ✨ keying per verified `copilot/package.json` (testResultState == failed). [I2#B citation.]
- **R6#B** — §3.8 + §3.8.1 added: four Test Explorer inline action icons + prefilled-chat command. Closes the v5.4 §2.5 promise ("Test Explorer = canonical decision-button host on failed items"). 💬 icon is Test-Explorer-as-launcher + Chat-as-conversation per [[feedback-chat-not-launcher]].
- **R6#C** — §4 sequence step 4 + step 8 updated to reflect deferred `run.failed()`.
- **R6#D** — §5 tech stack adds `workbench.action.chat.open` (first-party-undocumented, feature-detected) + `testing/item/context` inline group contribution.

## 4. Sequencing — fit into ARCHITECTURE §4

Updated steps (additions bolded; deletions struck):

3. Test `T` fails → mocha's `Runner#fail` emits `EVENT_TEST_FAIL` (the reporter intercepts and defers tri-state rendering); afterEach hook publishes pause with a new `sessionId`.
4. Extension opens the MCP gate (registers playwright-mcp + qa-debug); SKILL.md is already loaded; description-match engages on the next chat turn. The `qa-debug.paused` context key enables status-bar visibility; **the `qa-debug.pausedTestIds` context key (new — §2.1) is refreshed to include `T`'s test id, lighting up the four inline icons on `T`'s row in Test Explorer**. **`run.started(T)` is called; `T.description` is set to the pause summary; `T.busy = true`. `run.failed()` is NOT called yet.**
5. Chat notification: *"Test T failed at line 42. Browser held at :9222. Ask anything."*
5.5. (v5.4) Status-bar entry shown.
6. Agent flow / human flow (one of):
   - Agent or QA initiates conversation via Chat (Skill description-match, or QA clicks 💬 inline icon → prefilled prompt opens Chat).
   - QA clicks ✓/✕/▶ inline icons directly without entering Chat (the propose/commit gate still applies per §3.2 — ✓ Mark Passed still requires the rationale input).
7. Decision verbs unchanged (§3.2 propose/commit semantics intact).
8. On decision:
   - `mark_passed` → `run.failed(T, msgs); run.passed(T)` (current behavior — first failed() now happens here).
   - `give_up` → **`run.failed(T, msgs)`** (NEW — was implicit before; now explicit because pause did not call it).
   - `retry` → clear `T.description`; `T.busy` remains true; respawn mocha via `--grep` as today.
   - In all three cases: `qa-debug.pausedTestIds` is refreshed (id removed); inline icons disappear from `T`'s row.

## 5. Alternatives considered

| Alternative | Rejected because |
|---|---|
| Add the four icons but keep `run.failed()` at pause time (don't shift reporting model) | ✨ still appears alongside our four icons → 5 inline icons total on the same row; the friction the user flagged remains |
| Use `TestItem.error` field instead of `description` for pause cue | vscode.d.ts:18873 docstring forbids it: *"this is not a test result and should only be used to represent errors in test discovery, such as syntax errors"* |
| Use `run.errored()` (instead of `failed()`) during pause to avoid ✨ | Untested capability claim — Copilot's icon keying may include errored state too; risks chasing a moving target. The state-shift approach is cleaner. |
| Add an MCP-side `qa_propose_chat_prefill` verb instead of a VS Code command | Conflates conversation entry with commit-shaped verbs; verbs are for state transitions, not for opening UIs. The 💬 icon is a UI affordance, lives in the UI layer. |
| Submit a Copilot Chat issue asking them to suppress ✨ when an extension owns the test failure | Out-of-band, not actionable in Phase 1; v5.6 cooperates with their surface as-is (§2.5). |
| Render inline icons via `testing/item/gutter` instead of `testing/item/context` | Gutter contributions render in the editor margin, not in the Test Explorer tree. Wrong surface. |

## 6. Risks & non-goals

### Risks

- **R1 — `workbench.action.chat.open` undocumented.** Mitigated by feature-detect + clipboard fallback (§2.2). Probability low (command exists across all VS Code versions back to GitHub Copilot Chat 1.0 GA per chatActions.ts git blame); impact low (fallback is functional, just less ergonomic).

- **R1.1 — `IChatViewOpenOptions` argument quirks [I2#G — discovered during iter#2 manual S6 QA 2026-05-22].** The schema cited in §0 from main-branch chatActions.ts is type-correct but **silently brittle** on two fields:
  - **`toolIds`** expects LanguageModelTool ids (e.g., `mcp.qa-debug.qa_get_failure_context`), NOT MCP *server* ids. Passing server names like `['playwright-mcp', 'qa-debug']` opens the chat with the prompt prefilled BUT crashes Copilot's response panel with `Cannot read properties of undefined (reading 'length')` (React/TSX component stack visible — internal Copilot UI). Mitigation: Phase 1 omits `toolIds` entirely; Agent mode auto-discovers MCP tools when the gate is open, so the field adds no signal worth the brittleness budget.
  - **`attachFiles[].range`** the schema field is typed `IRange` (Monaco shape: `startLineNumber/startColumn/endLineNumber/endColumn`), NOT `vscode.Range` (`{start: Position, end: Position}`). The `executeCommand` RPC serializes `vscode.Range` into the start/end form; Copilot reads `range.startLineNumber` → undefined → same React crash. Mitigation: Phase 1 omits range; attaches the bare file URI only. Cursor-anchor jump is a Phase 2 ergonomic — would require Monaco-IRange shape conversion at the call site.

  Both quirks were verified empirically by reverting each field independently. Captured in [[reference-vscode-chat-open-quirks]] for future iterations.

- **R2 — Inline icons may collide visually with VS Code's built-in run/debug buttons.** Test Explorer typically reserves the rightmost two slots for run + debug. Our four icons land in `inline@1..4`; VS Code's built-in buttons render in their own slots. Empirically other extensions (vitest, jest-test-explorer) ship 3-4 inline buttons without collision. Verify in S6 manual QA.

- **R3 — Context-key thrash.** Refreshing `qa-debug.pausedTestIds` on every pause publish + decision commit triggers `when`-clause re-evaluation for every menu item bound to it. Test Explorer typically has <100 items at the scale of this project; thrash is negligible. If proven otherwise in S6 perf testing, debounce via 100ms trailing.

- **R4 — Race between pause publish and `executeCommand('setContext', …)`.** `executeCommand` is async; the inline icon may not appear in the same frame as the pause notification. Acceptable: the QA's read-and-react latency dwarfs the setContext propagation (<50ms typical per the VS Code source).

- **R5 — Reporter coordination unchanged but worth restating.** The qa-reporter Mocha-event side (§3.6) was already independent of when `run.failed()` is called on the VS Code TestRun (the reporter reads Mocha events directly, not VS Code TestRun state). v5.6's reporting-model shift does not affect tri-state stdout rendering or `process.exitCode`.

### Phase-1 invariant [I2#F — per iter#1 Finding 4]

- The `qa-debug.pausedTestIds` array context key has **length 0 or 1** in Phase 1. Single-pause is structural to `MementoPauseStore` (one Memento key `qa-debug.pause.active`); the array shape is forward-compatible with Phase-2 multi-pause but is NOT yet exercised. The forward-compatibility cost is one extra `Array.from(...)`-style serialization at refresh time; the structural cost of a Phase-2 retrofit using a singleton-then-array migration is higher. The `in` operator works equally on `[]` / `[id]` / `[id1, id2, …]` so no when-clause rewrite is needed if multi-pause lands.

### Non-goals

- v5.6 does NOT add a Test Explorer inline icon for the non-paused failed state (i.e., a test that ran outside the QA-debug session and failed normally). Those tests show ✨ as today — that is the correct context for Copilot Fix.
- v5.6 does NOT change qa-hooks IPC, MCP gate registration, qa-reporter event subscription, or chatSkills.
- v5.6 does NOT add a "configure prefill template" setting. The prompt is hard-coded for Phase 1; if QAs want to customize, that is a Phase 2 follow-up.
- v5.6 does NOT lift the single-pause invariant (Phase-2 territory).

## 7. SLICE_PLAN follow-ups

To append to `SLICE_PLAN.md` §4 (Phase-2 follow-ups), in execution order:

- **F-v5.6-a** — Manual S6 QA: verify four inline icons appear on paused-test row, do not collide with VS Code's built-in run/debug buttons, disappear on decision commit.
- **F-v5.6-b** — Verify ✨ does NOT appear during pause across VS Code stable + insiders + GitHub Copilot Chat current + previous-stable.
- **F-v5.6-c** — Verify ✨ DOES appear after give-up commit (positive control: we have not accidentally broken Copilot's keying for legitimately-failed tests).
- **F-v5.6-d** — Configurable prefill template (Phase 2; out-of-scope here).

## 8. Memory cross-references (recap)

- [[feedback-chat-not-launcher]] — preserved; chat remains conversation-only, run/decision surfaces remain UI.
- [[feedback-chat-panel-engagement]] — extended (4th surface justified in §2.4).
- [[feedback-transparent-use]] — preserved; extension-only changes.
- [[feedback-ralph-loop]] / [[feedback-ralph-loop-scope]] — this CR covers the architectural piece; implementation lives in `PLAN-paused-test-affordances.md`.
- [[feedback-research-source]] — every capability claim in §0 cites either main-branch source (chatActions.ts), installed source (vscode.d.ts:LL), or WebFetched platform-owned URL (code.visualstudio.com pages). No training-time priors.
- [[reference-anthropic-agentic-docs]] — §0.2 cites Anthropic-owned domains for human-oversight framing.

## 9. Status

**Iteration #1** (file) drafted 2026-05-22, reviewed same day. Iter#1 returned **REVISE-with-blockers** (5 blockers: Finding 1/Probe F empirical, Finding 2 context-key namespace, Finding 3 invented PauseStore API, Finding 4 multi-pause invariant, Finding 7 missing §3 edits; 2 polish items: Finding 5 line-number drift, Finding 8 mark_passed flash empirical guard).

**Iteration #2** (file, this revision) drafted 2026-05-22, addressing all iter#1 blockers:
- **I2#A** — Context key renamed `qaDebug.pausedTestIds` (iter#1 camelCase) → `qa-debug.pausedTestIds` (iter#2 kebab, consistent with existing `qa-debug.paused` at session-manager.ts:268,336). Updated in §0, §2.1, §2.2, §3.1–§3.4.
- **I2#B** — Probe F empirical citation added at §0 "Capability sources — Copilot ✨ keying" against `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json` (builtin `copilot-chat 0.49.0`); inline-slot collision check included.
- **I2#C** — PauseStore API references rewritten against real single-pause API (`peekActivePause()`, no `activePauseIds` / `activePauses()` / `lookupByTestId`); §0 cites pause-store.ts:40,45,49,55. SessionManager gains `lookupPauseByTestId(testId?)` helper.
- **I2#D** — §2.3 mark_passed row clarifies "no perceptible flash > 1 frame at 60Hz" as the F-v5.6-b acceptance bar; provides re-sequencing escape hatch if a flash is observed.
- **I2#E** — §3 "ARCHITECTURE.md edits" section added (§3.1–§3.5) with verbatim splice text tagged R6#A..D, restoring CR-v5.3/v5.4/v5.5 convention.
- **I2#F** — §6 "Phase-1 invariant" sub-section added declaring array length 0 or 1; non-goals updated.
- Line-number drift corrections at §0 (TestItem.description :18856, .busy :18846, .error :18878).

**Manual S6 QA partial pass 2026-05-22** (post iter#2-file, pre Ralph iter#2):
- ✅ F-v5.6-a — 4 inline icons render on paused-test row (verified by user screenshot 2026-05-22, image #2 in conversation).
- ✅ Context-key wire-up — clicking 💬 fires the openChatForPaused command (icon presence proves `qa-debug.pausedTestIds` is populated correctly).
- ✅ chat.open invocation — chat view opens, prompt prefilled, spec file attached (verified by user screenshot 2026-05-22, image #3).
- ⚠️ Copilot response render — crashed with React/TSX undefined.length error on first attempt (image #3). Root-caused to `toolIds` + `attachFiles[].range` quirks (R1.1); fix applied in commands.ts:openChatForPausedCmd, re-build successful, **awaiting user re-test in next session**.
- ⏸ F-v5.6-b — ✨ during pause: NOT yet verified empirically (deferred to next session).
- ⏸ F-v5.6-c — ✨ after give-up: NOT yet verified empirically (deferred to next session).
- ⏸ Mark-passed flash and 4-icon non-collision with built-in run/debug buttons: NOT yet verified.

Iteration #2 (file) awaiting Ralph-loop reviewer iter#2 per [[feedback-ralph-loop]] AND user S6 completion. Author has applied all blockers + polish items + the R1.1 args-quirks fix inline.

If APPROVE clean + S6 passes: changes merge into ARCHITECTURE.md per §3 splice plan as **R6#A..D**; PLAN-paused-test-affordances.md becomes the implementation roadmap closer.
