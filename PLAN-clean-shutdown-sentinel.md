# PLAN — auto-reset stale-resume on clean shutdown

## Problem

Today, every F5 launch runs `resumeStalePauseIfAny()` at activate(). If `MementoPauseStore` (over `globalState`) has ANY persisted active pause, the extension shows `$(debug-alt) QA Paused` status bar + info toast + reduced-action Test Explorer (only Give Up enabled). This was empirically confusing 2026-05-21 — user reported "is this a bug?" when seeing `QA Paused` at fresh-launch `0/0` state.

Per research subagent (2026-05-21):
- NN/G Heuristic #1 (Visibility of System Status): *"explicitly communicate the current system's status — which items are no longer available"* → showing a paused indicator when nothing actually paused = zombie UI.
- VS Code precedents (Debug, Jupyter, DevTools, Terminal-process) all RESET on close; only annotations / scrollback / breakpoints survive.
- VS Code Terminal asymmetry is the canonical model: **content/audit may persist; live-resource references do not.**

## Fix shape

Two-bit signal distinguishes clean-shutdown from crash. `deactivate()` writes a fresh-clean-close sentinel AFTER clearing pause state; `activate()` reads-and-clears sentinel before deciding whether to fire stale-resume UI. Audit trail preserved out-of-band via a JSONL sidecar file.

## Touchlist

1. **`extension/src/audit-file.ts` (NEW)** — `appendDeactivateAudit(globalStorageUri, payload)`:
   - Resolves path: `${globalStorageUri.fsPath}/audit.jsonl`.
   - Ensures the dir exists (`vscode.workspace.fs.createDirectory(globalStorageUri)` is idempotent).
   - Appends one JSONL line: `{ts: ISO, kind: 'deactivate-with-active-pause', session_id, test_title, file, line, paused_at_ms}`.
   - Sync-write equivalent via `vscode.workspace.fs.writeFile` (read-existing + concat + write). Five-second `deactivate()` budget is plenty.

2. **`extension/src/extension.ts`** —
   - **Closure pattern [R#NB4]** — replace would-be 4 new singletons with a single `let deactivateHook: (() => Promise<void>) | undefined`. Captured in `activate()` over `context`, `pauseStore`, `decisionRouter`. `deactivate()` is one line: `await deactivateHook?.();`. Cuts mutable module-state surface from 4 bindings to 1.
   - **`deactivate()` body (assigned inside activate())**:
     ```ts
     deactivateHook = async () => {
       const active = pauseStore.peekActivePause();
       if (active) {
         // Best-effort: synthesize give_up via DecisionRouter. abandon()
         // returns false (logs to audit channel) if router has no pending
         // callback — it never throws. [R#NB8]
         decisionRouter.abandon(active.session_id, 'extension deactivated', 'hook');
         try {
           await appendDeactivateAudit(context.globalStorageUri, active);
         } catch {
           // best-effort; never block shutdown on audit write [R#NB6]
         }
         await pauseStore.clearActivePause();
       }
       // Boolean sentinel [R#NB3] — read-and-clear at activate() proves the
       // close immediately preceding THIS activate was clean. No freshness
       // window: a window would create a blind spot where a true crash
       // after a clean-close-within-window is hidden behind the sentinel.
       await context.globalState.update('qa-debug.clean_shutdown', true);
     };
     ```
   - **`activate()`** sentinel check (BEFORE `sessionMgr.resumeStalePauseIfAny()` at current line 177):
     ```ts
     const cleanShutdown = context.globalState.get<boolean>('qa-debug.clean_shutdown') === true;
     await context.globalState.update('qa-debug.clean_shutdown', undefined);
     if (cleanShutdown) {
       // Defense-in-depth — pre-v5.7 globalState data may still exist from a
       // pre-sentinel run; clear it. Remove in v5.8 once migration window passes. [R#NB5]
       await pauseStore.clearActivePause();
       appendInfo(channel, `[activate] clean-shutdown sentinel found; skipped stale-resume`);
     } else {
       await sessionMgr.resumeStalePauseIfAny();
     }
     ```

3. **`extension/src/session-manager.ts`** — `resumeStalePauseIfAny()` (line 187): reword the info toast text.
   - Before: *"last suite was interrupted while a pause was active"*
   - After: *"previous session ended unexpectedly while paused"*
   - Reason: matches the real cause (extension didn't clean-shutdown). Researcher's polish suggestion.

## Key design decisions (Ralph-loop reviewer approved iter#1)

- **Boolean sentinel, no freshness window [R#NB3].** Read-and-clear at activate() proves "the close immediately preceding this activate was clean." A freshness window would create a blind spot where a true crash after a clean-close-within-window is hidden behind a stale sentinel. Simpler + more correct.
- **Clear sentinel immediately at activate()**, not at deactivate, so it counts ONLY the immediately-preceding shutdown (cannot survive across two activations).
- **Pause-at-deactivate auto-give_up** (synthesize via DecisionRouter.abandon) so audit semantics are honest: the failure was either resolved by user or auto-given-up at shutdown. No zombie "still paused" forever. `abandon()` never throws — returns false + logs if no pending callback exists (verified at decision-router.ts:36–48).
- **Crash path preserved**: if `deactivate()` doesn't run (true crash), no sentinel written → activate() falls through to existing `resumeStalePauseIfAny()` → user sees the same UI as today. Phase 1 keeps the safety net.
- **Audit file is sidecar (jsonl)**, not part of globalState: keeps state small + machine-greppable for any future "QA Debug: History" command (Phase 2). Audit completeness argument satisfied without live-UI bookkeeping. **Non-atomic write trade-off [R#NB6]:** single-writer (only deactivate fires it), no concurrent contention, crash window is microseconds during `fs.writeFile` — acceptable for Phase 1. Tmpfile+rename is Phase-2 polish.
- **Closure pattern over module singletons [R#NB4]**: `let deactivateHook: (() => Promise<void>) | undefined` captures dependencies at activate(); deactivate() is one line. Avoids 4 new mutable module-level bindings.

## Acceptance gates

1. **Manual smoke A (clean close, no active pause):** F5 → Cmd+Q (or close window) → re-F5. Expected: NO `QA Paused` status bar, NO information toast, Test Explorer fresh. Output Channel shows `[activate] clean-shutdown sentinel found (Xms ago); skipped stale-resume`.

2. **Manual smoke B (clean close WITH active pause):** F5 → run failing fixture test → pause fires → Cmd+Q without clicking Give Up → re-F5. Expected: NO `QA Paused` status bar (clean-shutdown sentinel skips stale-resume). `audit.jsonl` at `globalStorageUri/audit.jsonl` contains one new line `{kind: 'deactivate-with-active-pause', session_id: 's4-...', ...}`. Output Channel shows `[activate] clean-shutdown sentinel found`.

3. **Manual smoke C (true crash):** F5 → run failing test → pause fires → `kill -9` the Extension Host process (no `deactivate()` runs) → re-F5. Expected: existing stale-resume UI fires; info toast now reads "previous session ended unexpectedly while paused"; Output Channel does NOT show the sentinel log line.

4. **Existing regression test:** `pnpm --filter @qa-debug/evals run race-test` continues to PASS (sentinel changes don't affect MCP server / DecisionRouter wire).

5. **Build + type-check + S2 snapshot:** `pnpm -r build` + `pnpm -r build:check` + `node --import tsx tools/snapshot-check.ts` all green.

## Out of scope (Phase 2)

- `qa-debug.showHistory` command surfacing audit.jsonl in VS Code (researcher noted; not blocking).
- Audit log rotation (cap at 10MB, archive older lines). Phase 2.
- Telemetry on stale-resume occurrence rates (would need pre/post measurement; defer).

## Risks

- `deactivate()` budget [R#NB2]: 5 seconds per VS Code extension-host source (`extHostExtensionService.ts` `Promise.race(timeout(5000))`); NOT documented in public API. File append (~ms) + Memento update + sync `decisionRouter.abandon` are well under budget. Note: `context.subscriptions[]` dispose chains are NOT awaited by VS Code per vscode.d.ts:8423–8427 — `deactivateHook` is invoked directly from `deactivate()`, not via subscriptions, so its await is honored.
- File-system write failures (full disk, permissions): wrapped in `try/catch`; logs to Output Channel but never blocks shutdown. Audit-completeness degrades to "no record" for that one event; not a correctness issue.

## References

- Research subagent findings (this session) — NN/G Heuristic #1, VS Code Debug/Jupyter/DevTools/Terminal precedents.
- `S4_DESIGN.md §11` [R#NB1] (stale-resume — add a one-line "v5.7 amendment: clean-shutdown sentinel suppresses stale-resume" pointer at the section header so future readers see the divergence).
- Existing code: `extension/src/extension.ts:177` activate() call, `extension/src/extension.ts:203–206` current 2-line deactivate, `extension/src/session-manager.ts:166–194` resumeStalePauseIfAny, `extension/src/pause-store.ts:43` clearActivePause, `extension/src/decision-router.ts:51` abandon().
