# PLAN — Paused-test inline affordances (Test Explorer icons + prefilled chat + delayed run.failed)

**Date:** 2026-05-22
**Author:** Claude (Opus 4.7), per user directive
**Status:** Drafted, awaits CR-v5.6 APPROVE + light reviewer pass per [[feedback-ralph-loop-scope]] (code-level → PLAN, not full CR).
**Parent CR:** ARCHITECTURE-CR-v5.6.md (delivers the architectural decisions; this PLAN delivers the code changes).

## Goal

When a Mocha test is paused, render four inline icons on its row in Test Explorer (💬 Chat / ▶ Resume / ✓ Mark Passed / ✕ Give Up), and stop reporting the test as `failed` to VS Code until the give-up decision actually lands (so Copilot's ✨ "Fix Test Failure" icon does not double-up the affordances during pause).

## Scope (code surface)

Files touched (existing) — diff-sized estimate in lines:

| File | Why | Approx. LOC |
|---|---|---|
| `extension/package.json` | Add `contributes.commands` (4 new) + `contributes.menus.testing/item/context` (4 entries) | +30 |
| `extension/src/test-controller.ts` | `recordPause`: drop `run.failed()`, add description+busy. `recordDecision.give_up`: add `run.failed(item, msgs)`. `recordDecision.retry`: drop revival `run.started()` since item never left started state. Export a `clearPauseAffordances(itemId)` helper for retry/decision paths. | +25 / −5 |
| `extension/src/session-manager.ts` | Wire `qa-debug.pausedTestIds` context-key refresh after `pauseStore.publish` and `pauseStore.commit`. | +15 |
| `extension/src/extension.ts` | Register four command handlers; feature-detect `workbench.action.chat.open`. | +60 |

Files created (new):

| File | Why | Approx. LOC |
|---|---|---|
| `extension/src/paused-test-commands.ts` | Holds the four command handlers + `buildPausePrompt`. Keeps `extension.ts` lean. | +120 |

No changes to: `mocha-hooks/`, `qa-debug-mcp/`, `pause-store-types/`, `tools/`, `evals/`. No IPC schema change. No MCP tool added.

## Step-by-step

### Step 1 — Manifest contributions

Edit `extension/package.json`:

```json
{
  "contributes": {
    "commands": [
      { "command": "qa-debug.openChatForPaused", "title": "QA Debug: Ask Copilot About This Failure", "icon": "$(comment-discussion)", "category": "QA Debug" },
      { "command": "qa-debug.requestRetry",      "title": "QA Debug: Retry",                            "icon": "$(debug-continue)",     "category": "QA Debug" },
      { "command": "qa-debug.proposeMarkPassed", "title": "QA Debug: Mark Passed (with rationale)",     "icon": "$(pass)",               "category": "QA Debug" },
      { "command": "qa-debug.requestGiveUp",     "title": "QA Debug: Give Up",                          "icon": "$(stop-circle)",        "category": "QA Debug" }
    ],
    "menus": {
      "testing/item/context": [
        { "command": "qa-debug.openChatForPaused", "when": "testId in qa-debug.pausedTestIds", "group": "inline@1" },
        { "command": "qa-debug.requestRetry",      "when": "testId in qa-debug.pausedTestIds", "group": "inline@2" },
        { "command": "qa-debug.proposeMarkPassed", "when": "testId in qa-debug.pausedTestIds", "group": "inline@3" },
        { "command": "qa-debug.requestGiveUp",     "when": "testId in qa-debug.pausedTestIds", "group": "inline@4" }
      ],
      "commandPalette": [
        { "command": "qa-debug.openChatForPaused", "when": "qa-debug.paused" },
        { "command": "qa-debug.requestRetry",      "when": "qa-debug.paused" },
        { "command": "qa-debug.proposeMarkPassed", "when": "qa-debug.paused" },
        { "command": "qa-debug.requestGiveUp",     "when": "qa-debug.paused" }
      ]
    }
  }
}
```

`commandPalette` gating uses the existing `qa-debug.paused` boolean (already managed by session-manager; gates "any pause active"). Inline gating uses the per-id array `qa-debug.pausedTestIds` (added in step 3).

### Step 2 — Implement `paused-test-commands.ts`

```ts
// extension/src/paused-test-commands.ts
import * as vscode from 'vscode';
import type { SessionManager } from './session-manager';
import type { StoredPausePayload } from '@qa-debug/pause-store-types';

export function buildPausePrompt(pause: StoredPausePayload): string {
  return [
    `A Mocha test is paused at the failure point. Please investigate using the qa-debug + playwright-mcp tools.`,
    ``,
    `Test: ${pause.full_title}`,
    `File: ${pause.file}:${pause.line ?? '?'}`,
    `Failure: ${pause.failing_assertion}`,
    `Browser (CDP): ${pause.cdp_ws_url}`,
    ``,
    `Start by calling qa-debug_qa_get_failure_context for grounded context, then use playwright-mcp:browser_snapshot or :browser_evaluate to inspect live DOM. The browser at the CDP endpoint above is the same Chrome window that was open when the test failed.`,
  ].join('\n');
}

interface Deps {
  sessionMgr: SessionManager;
  channel: vscode.OutputChannel;
}

export function registerPausedTestCommands(
  context: vscode.ExtensionContext,
  deps: Deps,
): void {
  const chatOpenId = 'workbench.action.chat.open';
  let chatOpenAvailable: boolean | undefined;

  async function isChatOpenAvailable(): Promise<boolean> {
    if (chatOpenAvailable !== undefined) return chatOpenAvailable;
    const all = await vscode.commands.getCommands(true);
    chatOpenAvailable = all.includes(chatOpenId);
    return chatOpenAvailable;
  }

  async function openChatForPaused(testId?: string): Promise<void> {
    const pause = deps.sessionMgr.lookupPauseByTestId(testId);
    if (!pause) {
      vscode.window.showInformationMessage('No active pause for this test.');
      return;
    }
    const prompt = buildPausePrompt(pause);
    const fileUri = vscode.Uri.file(pause.file);
    const range = pause.line && pause.line >= 1
      ? new vscode.Range(pause.line - 1, 0, pause.line - 1, 0)
      : undefined;

    if (await isChatOpenAvailable()) {
      await vscode.commands.executeCommand(chatOpenId, {
        query: prompt,
        isPartialQuery: false,
        mode: 'agent',
        toolIds: ['playwright-mcp', 'qa-debug'],
        attachFiles: range ? [{ uri: fileUri, range }] : [fileUri],
      });
    } else {
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand('workbench.view.chat.focus').then(undefined, () => undefined);
      vscode.window.showInformationMessage(
        'QA Debug: prompt copied to clipboard — paste into Chat. (workbench.action.chat.open unavailable on this VS Code build.)',
      );
    }
  }

  async function requestRetry(testId?: string): Promise<void> {
    const pause = deps.sessionMgr.lookupPauseByTestId(testId);
    if (!pause) return;
    await deps.sessionMgr.commitDecision({
      session_id: pause.session_id,
      kind: 'retry',
      by: 'human',
      reason: 'manual retry from Test Explorer inline icon',
      full_title: pause.full_title,
    });
  }

  async function proposeMarkPassed(testId?: string): Promise<void> {
    const pause = deps.sessionMgr.lookupPauseByTestId(testId);
    if (!pause) return;
    const rationale = await vscode.window.showInputBox({
      prompt: 'Rationale for marking this test passed (required, will be recorded in audit log)',
      placeHolder: 'e.g., "environment flake — fixture seed inconsistent, root cause filed as ENG-1234"',
      validateInput: (v) => (v.trim().length < 8 ? 'Rationale must be at least 8 characters' : undefined),
    });
    if (!rationale) return; // QA cancelled
    await deps.sessionMgr.commitDecision({
      session_id: pause.session_id,
      kind: 'mark_passed',
      by: 'human',
      reason: rationale,
      full_title: pause.full_title,
    });
  }

  async function requestGiveUp(testId?: string): Promise<void> {
    const pause = deps.sessionMgr.lookupPauseByTestId(testId);
    if (!pause) return;
    const confirm = await vscode.window.showQuickPick(['Yes — give up and close', 'Cancel'], {
      placeHolder: 'Give up on this paused test? The held browser will close if this is the last pause.',
    });
    if (confirm !== 'Yes — give up and close') return;
    await deps.sessionMgr.commitDecision({
      session_id: pause.session_id,
      kind: 'give_up',
      by: 'human',
      reason: 'manual give-up from Test Explorer inline icon',
      full_title: pause.full_title,
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('qa-debug.openChatForPaused', openChatForPaused),
    vscode.commands.registerCommand('qa-debug.requestRetry', requestRetry),
    vscode.commands.registerCommand('qa-debug.proposeMarkPassed', proposeMarkPassed),
    vscode.commands.registerCommand('qa-debug.requestGiveUp', requestGiveUp),
  );
}
```

### Step 3 — Wire `qa-debug.pausedTestIds` context key in `session-manager.ts`

**Updated per iter#2 against real single-pause `MementoPauseStore` API** (pause-store.ts:40,45,49 — only `peekActivePause()` exists; no `activePauses()` / `activePauseIds`):

Add helper near the top of `session-manager.ts`:

```ts
function computeTestItemId(pause: PausePayload): string {
  // v5.5 unified-id formula — must match test-controller's lookupOrCreateTestItem.
  return `${vscode.Uri.file(pause.file).toString()}::it::${pause.full_title}`;
}

async function refreshPausedTestIdsContext(pauseStore: PauseStore): Promise<void> {
  const active = pauseStore.peekActivePause();
  const ids = active ? [computeTestItemId(active)] : [];
  await vscode.commands.executeCommand('setContext', 'qa-debug.pausedTestIds', ids);
}
```

Call sites (existing flow in `wireConnection`, near the existing `setContext('qa-debug.paused', ...)` calls):
- After `await this.deps.pauseStore.setActivePause(stored)` at line :267 → `await refreshPausedTestIdsContext(this.deps.pauseStore);`
- After `await this.deps.pauseStore.clearActivePause()` at line :335 → `await refreshPausedTestIdsContext(this.deps.pauseStore);`
- Retry branch (line :325-333 early return) intentionally NOT a refresh site: pause-store stays populated during mocha respawn, so the array correctly continues to include the test id until either (a) the respawn re-fails (new publish refreshes naturally) or (b) the respawn passes (no new pause, but the existing pause is cleared at session end).

Also expose `lookupPauseByTestId(testId?: string)` on `SessionManager`:

```ts
public lookupPauseByTestId(testId: string | undefined): PausePayload | undefined {
  const active = this.deps.pauseStore.peekActivePause();
  if (!active) return undefined;
  if (!testId) return active; // command palette: no test arg → return the only active pause
  const activeId = computeTestItemId(active);
  return activeId === testId ? active : undefined;
}
```

(Phase-1 single-pause invariant per CR-v5.6 §6 — array has length 0 or 1. Multi-pause is Phase 2.)

### Step 4 — Shift reporting model in `test-controller.ts`

#### 4.1 `recordPause` (current at :531-559)

Remove line 558 (`run.failed(item, msgs)`), add description + busy:

```ts
recordPause: (pause): void => {
  const fileUri = vscode.Uri.file(pause.file);
  const item = lookupOrCreateTestItem(fileUri, pause.full_title, pause.line);
  appendInfo(channel, `[test-controller] paused on id=${item.id}`);

  // Build the TestMessage but DEFER attachment — we accumulate for the eventual
  // give-up `failed()` call. See CR-v5.6 §2.3 for the lifecycle rationale.
  const md = new vscode.MarkdownString(/* ...as before... */);
  const msg = new vscode.TestMessage(md);
  msg.contextValue = 'qaDebugPaused';
  // ...stackTrace, location, etc. (unchanged)
  const msgs = failureMessages.get(item.id) ?? [];
  msgs.push(msg);
  failureMessages.set(item.id, msgs);

  // v5.6 — keep the item in `started` state during pause; surface pause via
  // description + busy. Inline icons (testing/item/context contribution) gate
  // visibility on `qa-debug.pausedTestIds`, which session-manager refreshes.
  run.started(item);
  item.description = `⏸ paused — ${truncate(pause.failing_assertion, 80)}`;
  item.busy = true;

  // Mirror stack to terminal panel so the QA still has the full trace at hand.
  run.appendOutput(
    `⏸ paused at ${pause.file}:${pause.line ?? '?'}\r\n${pause.failing_assertion}\r\n`,
    undefined,
    item,
  );
},
```

Add small helper at top of file:

```ts
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
```

#### 4.2 `recordDecision.give_up` (current at :606-613)

Add the first-and-only `run.failed()` call here:

```ts
case 'give_up': {
  const msgs = failureMessages.get(item.id) ?? [];
  run.failed(item, msgs);
  run.appendOutput(`✗ give-up by ${decision.by}: ${reasonOrRationale}\r\n`, undefined, item);
  item.description = undefined;
  item.busy = false;
  break;
}
```

#### 4.3 `recordDecision.mark_passed` (current at :586-604)

Already calls `run.failed()` then `run.passed()`. Add description+busy cleanup at the end:

```ts
case 'mark_passed': {
  item.description = '(marked passed)';
  const msgs = failureMessages.get(item.id) ?? [];
  // ...sticky message construction unchanged...
  msgs.unshift(stickyMsg);
  run.failed(item, msgs);
  run.passed(item, durationMs);
  run.appendOutput(`✓ marked-passed by ${decision.by}: ${reasonOrRationale}\r\n`, undefined, item);
  item.busy = false;
  break;
}
```

#### 4.4 `recordDecision.retry` (current at :614-622)

Drop the revival `run.started(item)` since the item never left started state:

```ts
case 'retry': {
  run.appendOutput(`↻ retry by ${decision.by}: ${reasonOrRationale}\r\n`, undefined, item);
  item.description = undefined;
  // item.busy stays true — the respawned mocha child will re-publish a pause if it fails again
  break;
}
```

### Step 5 — Wire registration in `extension.ts`

In `activate()`, after `sessionMgr` is constructed:

```ts
import { registerPausedTestCommands } from './paused-test-commands';
// ...
registerPausedTestCommands(context, { sessionMgr, channel });
```

That's it — `vscode.commands.registerCommand` already registers them for the lifetime of the extension.

## Test plan

### Unit

- `buildPausePrompt` — given a fixed `StoredPausePayload`, asserts the exact prompt text (newline-by-newline) including all five contextual fields.
- `refreshPausedTestIdsContext` — mock `vscode.commands.executeCommand`, assert it is called with the correct array given (a) empty pause store, (b) one pause, (c) the same pause after commit (array should be empty).

### Integration (S6)

Add `extension/src/test/paused-affordances.test.ts`:

- **Test A — icons appear on pause**: drive a fixture-test that fails; assert `qa-debug.pausedTestIds` context has the test id (via a fake `setContext` recorder); assert the four commands are registered.
- **Test B — `run.failed` is deferred**: spy on TestRun calls; assert `failed()` is NOT called between pause publish and decision commit; assert it IS called on give-up commit; assert the spy sees `failed` THEN `passed` on mark-passed commit.
- **Test C — context key clears on commit**: after committing give-up, assert `qa-debug.pausedTestIds` is empty.

### Manual (S6 QA per CR-v5.6 F-v5.6-a..c)

1. **F-v5.6-a** — Open the project in VS Code, run a failing fixture test, observe four icons appear on the paused row in Test Explorer, verify they do not overlap with VS Code's built-in run/debug buttons.
2. **F-v5.6-b** — Verify Copilot's ✨ icon does NOT appear during pause. Repeat on VS Code stable + insiders + Copilot Chat current + previous-stable.
3. **F-v5.6-c** — Click ✕ Give Up; verify ✨ DOES appear afterward on the now-failed row (positive control).
4. Manual: click each of the four icons in turn:
   - 💬 → Chat view opens with prefill visible; Enter sends to Agent mode with playwright-mcp + qa-debug tools available.
   - ▶ → mocha respawns via `--grep`; the test re-runs.
   - ✓ → input box appears for rationale; on submit, test transitions to marked-passed.
   - ✕ → quickPick confirmation; on Yes, test transitions to failed and the held browser closes.
5. Run on a build of VS Code where `workbench.action.chat.open` is unavailable (e.g., GitHub Copilot Chat disabled); verify the 💬 icon falls back to clipboard + chat-view-focus + info toast.

## Known issues from manual S6 QA 2026-05-22

### Resolved inline

- **Copilot chat panel crashed on response render** with `Cannot read properties of undefined (reading 'length')` (React/TSX stack inside Copilot bundle). Two args to `workbench.action.chat.open` were the culprits — both silently brittle despite being type-correct against chatActions.ts main-branch schema:
  - `toolIds: ['playwright-mcp', 'qa-debug']` — these are MCP **server** ids, but Copilot's tool-chip renderer expected LanguageModelTool ids (`mcp.qa-debug.<tool>` form). Lookup returned undefined → length crash.
  - `attachFiles[{ uri, range: new vscode.Range(...) }]` — schema field types `range` as Monaco IRange (`startLineNumber/...`); `vscode.Range` serializes to `{start, end}`. Copilot read `range.startLineNumber` → undefined → length crash.

  **Fix applied** at `extension/src/commands.ts::openChatForPausedCmd` (post-iter#2): drop both `toolIds` and `range`; attach bare file URI; Agent mode auto-discovers MCP tools when the gate is open. Build re-verified clean. **Re-test in next session.**

  Captured in CR-v5.6 R1.1 and memory [[reference-vscode-chat-open-quirks]].

### Outstanding (next session)

- F-v5.6-a 4-icon non-collision with VS Code built-in run/debug buttons on the paused row.
- F-v5.6-b ✨ verifiably HIDDEN during pause (the load-bearing claim of the entire reporting-model shift).
- F-v5.6-c ✨ verifiably VISIBLE after give-up commit (positive control).
- mark_passed: no perceptible ✨ flash during failed→passed transition.
- Retry: respawn + re-pause flow works end-to-end with the new busy/description lifecycle.
- Optional: switch Copilot model to non-preview (e.g., GPT-4o, Claude) to rule out Gemini 3 Flash Preview as a separate crash source.

## Rollback

If S6 manual QA fails on F-v5.6-a or F-v5.6-c (icons collide / Copilot keying broken):
1. Revert `test-controller.ts` to call `run.failed()` at pause time (current behavior). Inline icons still work but ✨ appears alongside.
2. If inline icons themselves are the problem, remove the four `testing/item/context` entries from `package.json`. Status bar + notification engagement (v5.4) remain intact; the project is back to v5.5 behavior.

## Open questions for the Ralph reviewer (CR-v5.6 iter#2)

- Q1 — Is the input-box on Mark Passed acceptable, or should it open a multi-line editor (like git commit messages) for longer rationales?
- Q2 — Should ▶ Retry be gated by a confirmation step too, or is the asset-additive framing in §3.2 sufficient justification for auto-commit?
- ~~Q3 — context-key naming~~ — **RESOLVED iter#2**: kebab (`qa-debug.pausedTestIds`) per CR-v5.6 I2#A.

## Memory hooks

After this PLAN ships and is APPROVED + implemented, update:

- [[project-qa-companion]] — append v5.13 (or whatever the next minor is) with commit SHA + the affordance + reporting-shift summary.
- [[feedback-chat-panel-engagement]] — append "v5.6 added 4th surface: Test Explorer inline icons; chat-launcher seam closed via 💬 prefill" so future iterations remember the surface count.

---

End of PLAN. Awaiting CR-v5.6 reviewer pass + user GO before implementation.
