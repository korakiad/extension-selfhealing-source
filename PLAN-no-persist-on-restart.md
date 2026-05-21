# PLAN — Reset pause/failed status on VS Code restart

**Date:** 2026-05-21
**Author:** Claude (Opus 4.7), per user directive
**Status:** Iteration #2 — Ralph reviewer APPROVE-WITH-POLISH from iter#1 applied; awaiting final sign-off.

## Problem

User reports the current behavior as "unnatural" (2026-05-21):

> "When closing VS Code and reopening, no need to keep pause/failed status. It should behave like a normal test suite, where status resets when the runner exits."

Today, two persistence mechanisms survive a window close + reopen:

1. **Pause state (`MementoPauseStore` over `globalState`)** — extension/src/pause-store.ts:34. v5.7 `deactivateHook` clears it on *clean* close (extension/src/extension.ts:205-223). On a *crash* (no `qa-debug.clean_shutdown` sentinel), `resumeStalePauseIfAny()` re-surfaces the pause UI with reduced action surface (extension/src/session-manager.ts:166).
2. **TestRun "failed" rendering in Test Explorer** — `controller.createTestRun(request, name, /* persist */ true)` (extension/src/test-controller.ts:523). Per https://code.visualstudio.com/api/extension-guides/testing (capability claim only): *"Passing `false` here instructs VS Code not to retain the test result, like it would for runs in the editor, since these results can be reloaded from an external source externally."* `true` retains the result across reloads; the red ✗ on the previously-failed test stays visible after restart with no live Mocha child behind it.

This PLAN extends v5.7's "reset on clean close" to "**reset on every activate, full stop**" — symmetrical for clean-close + crash, and preserves audit by capturing the orphan-pause case in `audit.jsonl` instead of in live UI.

## Verification of the user claim

Confirmed by reading source:

| Claim | Evidence |
|---|---|
| Pause persists across restart | `MementoPauseStore` uses `context.globalState` (pause-store.ts:35,38); `peekActivePause()` reads it on activate (session-manager.ts:167). |
| "Failed" visual persists across restart | `controller.createTestRun(request, name, /* persist */ true)` at test-controller.ts:523. |
| Clean-close already clears pause | extension.ts:205-223 `deactivateHook` calls `pauseStore.clearActivePause()` + writes `qa-debug.clean_shutdown` sentinel. |
| Crash path still shows stale-resume UI | extension.ts:196-201 falls through to `sessionMgr.resumeStalePauseIfAny()` when no sentinel; UI fires per session-manager.ts:166. |

User's claim is correct.

## Anthropic-sourced rationale

Per https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (Nov 26 2025): *"Start the session by reading the progress notes file and git commit logs, and run a basic test on the development server to catch any undocumented bugs"* and *"The key insight here was finding a way for agents to quickly understand the state of work when starting with a fresh context window."* The recommended pattern for cross-session continuity is **durable, content-addressed records** (progress notes, logs) — not live UI gates pointing at dead resources.

The pre-PLAN behavior re-binds *live* UI (status bar, MCP gate, context keys) to a session whose browser is gone. That is "ghost UI for a dead session," not durable session state. Moving the trail to `audit.jsonl` aligns with the cited pattern; resurrecting UI on activate violates it.

Per https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents (Aug 4 2025): *"humans should retain control over how their goals are pursued, particularly before high-stakes decisions are made."* At activate time, the only remaining action is Give Up (a synthesized no-op against a dead browser) — there is no high-stakes decision left to gate. Audit visibility is satisfied by the JSONL; UI gating buys nothing.

Per https://www.anthropic.com/research/measuring-agent-autonomy: only ~0.8% of agent actions are irreversible. The post-close state here contains zero irreversible actions on the table — the browser is gone, mocha is gone, all proposed-action MCP calls would no-op.

## Fix shape

On every `activate()`, treat the previous run as gone:

1. **`MementoPauseStore.clearActivePause()` runs unconditionally** before any UI wiring. Drops `qa-debug.pause.active` + `qa-debug.pause.proposal`.
2. **`createTestRun(..., persist: false)`** at test-controller.ts:523 so VS Code itself does not retain run results across restarts (capability cite above).
3. **Audit-completeness via sidecar** — if `peekActivePause()` returns a payload at activate time, append one JSONL line `kind='orphan-pause-at-activate'` to `audit.jsonl` *before* clearing. (Reviewer #1 NB#2: the field is named after the **observation** — "a pause Memento entry was leftover" — not after the **inferred root cause** ("crash"), per poka-yoke pattern in https://www.anthropic.com/research/building-effective-agents: *"Poka-yoke your tools. Change the arguments so that it is harder to make mistakes."*)
4. **Delete the stale-resume UI code path** — `SessionManager.resumeStalePauseIfAny()`, the `qa-debug.staleResume` context key, and every `enablement` / `when` clause in `extension/package.json` that references it.
5. **Delete the `qa-debug.clean_shutdown` sentinel entirely** (reviewer #1 NB#3 — dead-code bait, no consumers remain; kill in this commit, no migration grace).

## Touchlist

### 1. `extension/src/extension.ts`

Delete lines 187-201 (the `cleanShutdown` read-and-branch + `resumeStalePauseIfAny()` call) and the sentinel write at line 222. Replace with:

```ts
if (workspaceRoot) {
  sessionMgr = new SessionManager({ /* unchanged */ });
  sessionManagerSingleton = sessionMgr;
  registerCommands(context, { /* unchanged */ });

  // v5.11 — restart-reset semantics. Previous extension-host instance is gone;
  // treat any persisted pause as orphaned and drop it. Audit-trail goes to
  // audit.jsonl, not live UI.
  const orphan = pauseStore.peekActivePause();
  if (orphan) {
    try {
      await appendOrphanPauseAudit(context.globalStorageUri, orphan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendInfo(channel, `[activate] audit append failed: ${msg}`);
    }
    appendInfo(
      channel,
      `[activate] orphan pause cleared session=${orphan.session_id} test="${orphan.test_title}"`,
    );
  }
  await pauseStore.clearActivePause();

  // deactivateHook keeps clean-close audit + clearActivePause; the sentinel
  // write is removed (no consumer remains).
  deactivateHook = async (): Promise<void> => {
    const active = pauseStore.peekActivePause();
    if (active) {
      decisionRouter.abandon(active.session_id, 'extension deactivated', 'hook');
      try {
        await appendDeactivateAudit(context.globalStorageUri, active);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendInfo(channel, `[deactivate] audit-file append failed: ${msg}`);
      }
      await pauseStore.clearActivePause();
    }
  };
}
```

Net diff (this file):
- Delete `cleanShutdown` read-and-branch.
- Delete `sessionMgr.resumeStalePauseIfAny()` call.
- Delete `context.globalState.update('qa-debug.clean_shutdown', true)` at line 222 (dead write).
- Add unconditional clear + orphan-audit append at activate.

### 2. `extension/src/audit-file.ts`

Add `appendOrphanPauseAudit()` sibling to `appendDeactivateAudit()`. New entry shape includes `prior_clean_shutdown_sentinel: boolean` for honest provenance (reviewer #1 NB#2). Since the sentinel is being deleted (NB#3), the value is always read as `false` in v5.11; the field remains in the schema so a future "any-extension-host-crash-flag" can fill it without breaking the consumer contract:

```ts
interface OrphanPauseAuditEntry {
  ts: string;
  kind: 'orphan-pause-at-activate';
  session_id: string;
  test_title: string;
  file: string;
  line: number | undefined;
  paused_at_ms: number;
  prior_clean_shutdown_sentinel: boolean; // always false in v5.11; reserved for future provenance
}

export async function appendOrphanPauseAudit(
  globalStorageUri: vscode.Uri,
  pause: PausePayload,
): Promise<void> { /* same write shape as appendDeactivateAudit; reads sentinel as false */ }
```

Also update the file-header JSDoc with the dual-write dedup note (reviewer #1 NB#8):

> If a `deactivate()` writes a `deactivate-with-active-pause` line then is `SIGKILL`'d before the Memento `clearActivePause` flushes, the next `activate()` writes an additional `orphan-pause-at-activate` line for the same `session_id`. Consumers of `audit.jsonl` should dedupe by `(session_id, latest kind)` if they need one row per pause.

### 3. `extension/src/test-controller.ts`

Flip the persist flag at line 523. Comment cites the VS Code capability quote and the user mandate; no Jest/Pytest analogies (reviewer #1 NB#5):

```ts
// v5.11 — close + reopen resets the run state. VS Code testing-guide on the
// persist flag: "Passing `false` here instructs VS Code not to retain the
// test result, like it would for runs in the editor, since these results
// can be reloaded from an external source externally."
const run = controller.createTestRun(request, name, /* persist */ false);
```

### 4. `extension/src/session-manager.ts`

Delete `resumeStalePauseIfAny()` (lines 166-202). The method becomes unreferenced after the extension.ts edit.

### 5. `extension/package.json`

Remove `&& !qa-debug.staleResume` from four sites:
- Line 48: `qa-debug.retry` `enablement`
- Line 49: `qa-debug.markPassed` `enablement`
- Line 55: `qa-debug.retry` menu `when`
- Line 56: `qa-debug.markPassed` menu `when`

(Line 57's `qa-debug.giveUp` menu `when` was already unguarded against staleResume — leave alone.)

### 6. `S4_DESIGN.md` §11

Append a v5.11 amendment (replaces the v5.7 amendment paragraph's role; the v5.7 paragraph stays for historical context):

> **v5.11 amendment (2026-05-21):** §11 stale-resume UI is fully removed. Audit completeness is preserved via a new `orphan-pause-at-activate` kind appended to `${globalStorageUri}/audit.jsonl` at activate time. The `qa-debug.clean_shutdown` sentinel and the `qa-debug.staleResume` context key are removed entirely. CR-S4-d exit criterion "pause re-bound on activation; gate re-opens" is reinterpreted to: **audit line written; gate stays closed; the user runs the suite again to re-enter pause.** Rationale (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): durable content-addressed records (JSONL sidecar) replace ghost-UI on activate. Reviewer-loop iter#1 verdict: APPROVE-WITH-POLISH; all eight polish items applied.

## Audit-trail comparison

| Scenario | v5.7 behavior | This PLAN |
|---|---|---|
| Clean close, pause active | `audit.jsonl` `kind=deactivate-with-active-pause`; sentinel skips UI on next activate | Same `kind=deactivate-with-active-pause` line; no UI |
| Crash, pause active | No audit entry; next activate shows stale-resume UI | `audit.jsonl` `kind=orphan-pause-at-activate` line on next activate; no UI |
| Crash AFTER deactivate's audit-write but BEFORE its Memento-clear | (Unreachable in v5.7 — both happened or neither did) | Both `deactivate-with-active-pause` AND `orphan-pause-at-activate` lines for the same `session_id`. Documented dedup hazard (reviewer #1 NB#8). |
| No pause, any close | No-op | No-op |
| Failed test, any close | "failed" red ✗ persists after restart (`persist=true`) | "not run" on next launch (`persist=false`) |

The crash path *gains* an audit entry it didn't have in v5.7 (improvement). The dual-write edge case is benign (consumer dedupe is a known JSONL pattern).

## Acceptance gates

1. **Smoke A — Pause, clean close, reopen.** Run fixture suite → reach a paused test → Cmd+Q VS Code → relaunch and open the same workspace.
   - **Expect:** no `QA Paused` status bar; Test Explorer shows the previously-failed test as "not run"; Output channel `[activate] orphan pause cleared` is **absent** (clean-close path already cleared at deactivate); `audit.jsonl` has one `deactivate-with-active-pause` entry.

2. **Smoke B — Pause, crash, reopen.** Run fixture suite → reach a paused test → trigger extension-host restart via `Developer: Restart Extension Host` (or `kill -9` the ext-host PID).
   - **Expect:** no `QA Paused` status bar on reopen; Test Explorer shows the test as "not run"; `audit.jsonl` has one `orphan-pause-at-activate` line written at activate.

3. **Smoke C — Failed test (no pause), close, reopen.** Run a test that fails fast without a pause → close + reopen.
   - **Expect:** test shows as "not run" in Test Explorer; no replay of red ✗.

4. **Smoke D — Live pause UX unchanged.** Run a test that pauses; verify the in-session pause UX (status bar, MCP gate, Retry / Mark Passed / Give Up buttons) is identical to v5.7 within the same VS Code window.

5. **Smoke E — In-session reload during run (`persist:false` guard).** Start a suite that takes ≥10s. Mid-run, no pause active, fire `Developer: Reload Window`.
   - **Expect:** the in-flight run disappears from Test Explorer on reload (acceptable per user model); `qa-debug.paused` context key is unset after the activate (audit via Developer Tools → `vscode.commands.executeCommand('getContext','qa-debug.paused')` returns falsy; or simply: no command-palette QA Debug action appears in the gated set). Reviewer #1 NB#1 + NB#4.

6. **Code health.** `pnpm -w build` clean. No remaining references to `resumeStalePauseIfAny`, `qa-debug.staleResume`, or `qa-debug.clean_shutdown` (audit via `grep -r`).

## Key design decisions (for reviewer)

- **Unconditional clear + orphan-audit at activate.** No clean-vs-crash branching in live code; the `kind` field in the audit-line carries the distinction.
- **Field named after observation, not inference** (`orphan-pause-at-activate`, not `crash-detected-with-active-pause`). The activate observes "a Memento entry was leftover" — naming the entry that maps to that observation is honest; calling it a "crash" inverts cause and evidence.
- **`prior_clean_shutdown_sentinel: boolean` reserved-for-future field.** v5.11 always writes `false` (since the sentinel is deleted). Keeps schema extensible if a future crash-detection signal lands.
- **`persist: false` at `createTestRun`.** Matches the user's mandate. The VS Code testing-guide capability quote is the load-bearing reference; no Jest/Pytest analogies retained.
- **No migration grace for the sentinel write.** Grep confirms the only consumer was the activate-side read, which this PLAN deletes. Kill both in one commit.
- **CR-S4-d reversal is documented inline in §11.** Right-sized per `feedback-ralph-loop-scope` — no full CR-vN.md doc required for a behavior tweak within an established architecture (PauseStore + audit + Test Explorer all stay; only the activate-time UI surface is removed).

## Out of scope

- Persisting failures to a workspace-local history view.
- A "QA Debug: History" command surfacing `audit.jsonl` in a UI panel.
- Atomic JSONL writes (`audit-file.ts` already notes this as Phase-2 polish).

## Risks and trade-offs

1. **End-user who genuinely wanted "pick up where I left off" loses that affordance.** Mitigation: user has explicitly rejected this semantics; no irreversible action remains post-close (https://www.anthropic.com/research/measuring-agent-autonomy).
2. **Activate-side audit writes are slightly less specific than deactivate-audit** (we know a Memento entry was leftover; we don't know *why* the host died). Acceptable — same level of detail VS Code itself offers about crashes.
3. **Dual-write of `deactivate-with-active-pause` + `orphan-pause-at-activate` for the same `session_id`** in the rare deactivate-then-SIGKILL race. Documented in audit-file.ts JSDoc with consumer-side dedup recipe (reviewer #1 NB#8).
