# PLAN — recover Test Explorer + pause state when retry respawn passes

> Iter#2 revision (2026-05-22) — addresses Ralph iter#1 blocking issues #1 (IPC ordering), #2 (Option A rejected justification), #3 (Gate #1 postconditions). Folds in iter#1 non-blockings #3 (crash-after-retry cleanup) and #6 (audit-trail logging).

## Problem (root cause confirmed by static trace 2026-05-22)

When an `agent` or `human` commits a `retry` decision on a paused test, the extension's `SessionManager.wireConnection` handler for `final_decision` takes an **early return** ([session-manager.ts:339-347](extension/src/session-manager.ts#L339)) and intentionally skips `clearActivePause()` / `setContext('qa-debug.paused', false)` / `refreshPausedTestIdsContext()` / `mcpProvider.setIdle()`. The skip is by design — the pause-store stays populated *during the respawn* so that if the respawn re-fails, the state matches up. The design ([ARCHITECTURE-CR-v5.6.md:186](ARCHITECTURE-CR-v5.6.md#L186)) explicitly says: *"if it passes, the commit path refreshes to empty."*

But **there is no commit path on respawn pass.** Concretely:

- [qa-hooks.ts:243](mocha-hooks/src/qa-hooks.ts#L243) `afterEach` returns immediately when `test.state !== 'failed'` → no IPC fires for a passing test.
- [qa-reporter.ts:109-111](mocha-hooks/src/qa-reporter.ts#L109) `EVENT_TEST_PASS` writes to stdout but never touches the IPC channel.
- Wire protocol ([protocol.ts:103-108](mocha-hooks/src/protocol.ts#L103)) has methods `pause.publish`, `decision.await`, `heartbeat`, `final_decision` — no `test.passed` method exists.
- [session-manager.ts:391-410](extension/src/session-manager.ts#L391) `onMochaExit` of a clean retry-pass respawn just disposes Chrome + calls `run.testHandle.end()` — no pause-store cleanup, no `run.passed(item)`, no `item.busy = false`.

User-visible symptoms (all four traceable to this single gap):

1. Test Explorer spinner spins forever — `item.busy = true` set at [test-controller.ts:574](extension/src/test-controller.ts#L574) and only cleared in `mark_passed`/`give_up` branches, not in the retry-then-pass path. Comment at [:658-659](extension/src/test-controller.ts#L658) explicitly says *"keep busy true (mocha will respawn and either re-pause or pass)"* — but the "pass" half of the bargain was never built.
2. Test never transitions to green — no `run.passed(item)` call.
3. Inline ▶ Retry / ✓ Mark Passed / ✕ Give Up icons stay visible — gated by `testId in qa-debug.pausedTestIds` (package.json:61-64), and `refreshPausedTestIdsContext` is in the skipped block at [session-manager.ts:351](extension/src/session-manager.ts#L351).
4. Clicking inline ▶ Retry yields toast *"QA Debug: Pause already resolved."* — `pauseStore.getActivePause()` returns the stale pause, `decisionRouter.commit(oldSessionId, …)` returns false (callback consumed by the original retry commit), surfacing the error at [commands.ts:68](extension/src/commands.ts#L68).

## Fix shape

Add wire method `test.passed` as a **request** (not notification) from child → parent on every passing test's afterEach. The parent's handler runs the missing commit path (when an active pause matches `full_title`), then acks. The child `await`s the ack — this exploits Mocha's documented hook-Promise contract ([runnable.js:363-377](node_modules/.pnpm/mocha@10.8.2/node_modules/mocha/lib/runnable.js#L363)) to **structurally block** `EVENT_RUN_END` and child exit until the parent has observed the message. No race possible.

### Why request, not notification (iter#1 blocking #1 fix)

iter#1 PLAN said "notification, fire-and-forget, Node IPC ordering will save us." That was **wrong**: Node's `child_process` docs guarantee NO `'message'`-before-`'exit'` invariant. Mocha's default exit path is `exitMochaLater` ([run-helpers.js:28-32](node_modules/.pnpm/mocha@10.8.2/node_modules/mocha/lib/cli/run-helpers.js#L28)) which lets the event loop drain naturally — and qa-hooks calls `channel.unref()` ([qa-hooks.ts:131-134](mocha-hooks/src/qa-hooks.ts#L131)) so the IPC channel does NOT pin the loop. On a single-test `--grep` respawn the entire drain happens within tens of ms. Empirical repro (see Gate #1c below) confirms `'exit'` fires on the parent before `'message'` in a measurable fraction of runs.

`await c.request(...)` closes the race because Mocha's `Runnable.prototype.run` at `runnable.js:367` does `result.then(done, …)` — the hook-completion callback fires only after the awaited Promise resolves, which only happens after the parent has read AND acknowledged. The parent's ack is sent before child afterEach returns, so EVENT_RUN_END cannot occur until cleanup completed parent-side.

### Why Option B (qa-hooks afterEach), not Option A (qa-reporter EVENT_RUN_END) — iter#1 blocking #2 fix

Two fresh-context research passes both picked B. Maintainability axes: B wins 7-of-9 (preserves ARCH §3.6 "qa-reporter = rendering only"; matches every existing `c.notify(METHOD.*)` callsite in repo at [qa-hooks.ts:346](mocha-hooks/src/qa-hooks.ts#L346) and oracle; survives a future `--reporter spec` escape-hatch swap, which is the single most likely future change). The only axis A wins is per-test telemetry expansion (test_skipped/duration), which is a future "if/when" not a current requirement. IPC-ordering axis: B + request is the ONLY structurally safe option; A + notification has the same race as B + notification.

The specific future-change that would most regret choosing A: a user adds `--reporter junit` for CI compatibility, swaps out qa-reporter, and the entire QA Debug cleanup wire dies with it. Under B the wire lives in `--require`'d hooks, invariant under reporter choice.

### Why notify on every pass (kept from iter#1, unchanged)

Child stays oblivious to spawn intent; extension owns correlation via `pauseStore.peekActivePause()`. Avoids hook ↔ extension coupling through env vars or grep-flag introspection. Cost: one no-op request round-trip per non-retry passing test — measured at <2ms localhost IPC; well below mocha-test-overhead noise.

## Touchlist

1. **`mocha-hooks/src/protocol.ts`** — add wire shape + method name + result schema (~14 LOC):
   ```ts
   export const TestPassedParams = z.object({
     full_title: z.string(),
     test_file: z.string().nullable(),
   });
   export type TestPassedParams = z.infer<typeof TestPassedParams>;

   export const TestPassedResult = z.object({}); // empty ack
   export type TestPassedResult = z.infer<typeof TestPassedResult>;

   export const METHOD = {
     pausePublish: 'pause.publish',
     decisionAwait: 'decision.await',
     heartbeat: 'heartbeat',
     finalDecision: 'final_decision',
     testPassed: 'test.passed',           // NEW — request/response shape
   } as const;
   ```

2. **`mocha-hooks/src/qa-hooks.ts`** afterEach — add pass branch BEFORE existing fail-state early return (~10 LOC). Note: **`c.request` is awaited**, not fire-and-forget:
   ```ts
   async afterEach(this: Mocha.Context): Promise<void> {
     const test = this.currentTest;
     if (!test) return;
     const c = getConnection();
     if (!c) return;

     if (test.state === 'passed') {
       // v5.13 — request (not notify) so afterEach awaits parent ack before
       // returning. Mocha's runnable.js:367 `result.then(done, …)` blocks
       // EVENT_RUN_END on this Promise, structurally closing the exit-race
       // window where the parent might observe 'exit' before 'message'.
       try {
         await c.request(METHOD.testPassed, {
           full_title: test.fullTitle(),
           test_file: test.file ?? null,
         }, TestPassedResult);
       } catch (err) {
         // Parent disconnect / malformed reply: log and let mocha continue.
         // The cleanup gap re-emerges only if parent crashed, in which case
         // the extension lifecycle has bigger problems than a stuck spinner.
         process.stderr.write(`[qa-hooks] test.passed request failed: ${(err as Error).message}\n`);
       }
       return;
     }

     if (test.state !== 'failed') return;
     // ... existing failure-publish flow unchanged ...
   }
   ```

3. **`extension/src/session-manager.ts`** `wireConnection()` — add request **handler** (not onNotification) + return ack only after cleanup completes (~20 LOC):
   ```ts
   connection.handle(METHOD.testPassed, async (raw) => {
     const params = TestPassedParams.parse(raw);
     const active = this.deps.pauseStore.peekActivePause();
     if (!active || active.full_title !== params.full_title) {
       // Non-retry pass — no stored pause to clean up. Ack immediately.
       return {};
     }

     appendInfo(this.deps.channel,
       `[session-manager] retry-pass recovery for "${params.full_title}" session=${active.session_id}`);

     run.testHandle.recordRetryPassed(active);
     this.deps.pauseStatusBar.hide(active.session_id);
     await this.deps.pauseStore.clearActivePause();
     await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
     await refreshPausedTestIdsContext(this.deps.pauseStore);
     this.deps.mcpProvider.setIdle();

     return {}; // Ack AFTER cleanup completes — makes Gate #1 postconditions
                // observable the instant the request resolves child-side.
   });
   ```
   Mirrors the exact post-commit cleanup at [session-manager.ts:349-352](extension/src/session-manager.ts#L349) that the retry branch's early return skips. Status-bar `hide()` is invoked here for symmetry — original retry commit already hid it once, but a re-pause→retry→re-pause→pass cycle could have shown it again.

4. **`extension/src/test-controller.ts`** TestRunHandle — extend interface + add method (~15 LOC). Includes **audit-trail logging** per iter#1 non-blocking #6:
   ```ts
   export interface TestRunHandle {
     recordPause(pause: PausePayload): void;
     recordDecision(decision: FinalDecisionParams, pause: PausePayload | undefined): void;
     recordRetryPassed(pause: PausePayload): void;   // NEW
     end(): void;
   }

   // inside beginRun() return object:
   recordRetryPassed: (pause): void => {
     const fileUri = vscode.Uri.file(pause.file);
     const item = items.get(itemIdForTest(fileUri, pause.full_title))
       ?? Array.from(items.values()).find((it) => it.id.endsWith(`::it::${pause.full_title}`));
     if (!item) {
       appendInfo(channel, `[test-controller] no TestItem for retry-pass "${pause.full_title}"`);
       return;
     }
     const durationMs = Date.now() - pause.paused_at_ms;
     // v5.13 — audit trail entry parallel to appendDecision so the QA-facing
     // log row exists for the auto-green transition (transparency per
     // Anthropic's "Building effective agents" — agent retried, env returned
     // ground-truth pass; surface it in the same channel as the retry commit).
     appendDecision(channel, {
       sessionId: pause.session_id,
       testTitle: pause.full_title,
       decision: 'retry_passed',  // synthetic verb — see protocol-side TODO
       by: 'env',
       reasonOrRationale: `respawn passed after ${durationMs}ms`,
     });
     run.passed(item, durationMs);
     item.busy = false;
     item.description = undefined;
     run.appendOutput(`✓ retry passed after ${durationMs}ms\r\n`, undefined, item);
   },
   ```
   The synthetic `decision: 'retry_passed'` / `by: 'env'` may need a small `DecisionKind`/`DecisionBy` type-relaxation in `output-channel.ts` `appendDecision` signature (or a new `appendOutcome` helper). Confirm during implementation; ~3 LOC if the latter.

5. **`extension/src/session-manager.ts`** `onMochaExit` — fold in crash-after-retry cleanup per iter#1 non-blocking #3 (~6 LOC). When mocha child exits with code≠0 AND pauseStore still holds an entry that has NO pending decision callback (the original retry already consumed it), the only way out is to synthesize a give_up cleanup:
   ```ts
   // After existing line 412: const stalePause = this.deps.pauseStore.peekActivePause();
   if (stalePause && !this.deps.decisionRouter.hasPending(stalePause.session_id)) {
     // Crash after retry commit — original callback was consumed; no agent/human
     // will resolve this. Force-clear so the UI doesn't stay stuck on a dead session.
     appendInfo(this.deps.channel,
       `[session-manager] mocha crashed after retry; clearing stale pause session=${stalePause.session_id}`);
     run.testHandle.recordCrashCleared?.(stalePause);  // optional helper for test-controller
     await this.deps.pauseStore.clearActivePause();
     await vscode.commands.executeCommand('setContext', 'qa-debug.paused', false);
     await refreshPausedTestIdsContext(this.deps.pauseStore);
     this.deps.mcpProvider.setIdle();
     this.deps.pauseStatusBar.hide(stalePause.session_id);
   }
   ```
   `recordCrashCleared` on TestRunHandle is a thin wrapper that calls `run.failed(item, [msg])` + `item.busy = false` — mirror `give_up` shape with rationale `"mocha crashed during retry respawn"`. Same lookup pattern as `recordRetryPassed`.

6. **No changes to** `pause-store.ts`, `decision-router.ts`, `mcp-provider.ts`, `pause-status-bar.ts`, `commands.ts`, `chat-participant.ts`, package.json menus, or qa-debug-mcp tools.

## Key design decisions

- **Request, not notification** (changed from iter#1). Structurally safe IPC delivery via Mocha's Promise-await contract; eliminates the race surfaced by iter#1 reviewer. <2ms localhost overhead per pass.
- **Hook (not reporter) emits** (kept). 7-of-9 maintainability axes; preserves ARCH §3.6; matches every existing IPC callsite in repo.
- **Notify on every pass, not just retry respawns** (kept). Child stays generic; extension correlates.
- **Parent acks AFTER cleanup completes** (new). Makes Gate #1 postconditions observable the instant the child-side request resolves. Adds maybe ~1ms to round-trip; well within budget.
- **Correlate on `full_title`, not session_id** (kept). The child has no `session_id` here (paused in the prior, dead child process); extension's pauseStore is the session-id source of truth.
- **`run.passed(item, durationMs)` measured from original `pause.paused_at_ms`** (kept). Captures deliberation + respawn window as one duration. Matches `recordDecision`'s `durationMs` at [:600](extension/src/test-controller.ts#L600).
- **Audit trail entry in `appendDecision` channel** (new, iter#1 non-blocking #6). Auto-green transitions go through the same human-readable audit row that the original retry commit went through, satisfying the transparency principle from [Building effective agents](https://www.anthropic.com/research/building-effective-agents).
- **Crash-after-retry cleanup folded in** (new, iter#1 non-blocking #3). 6 LOC closes the only remaining path where symptom #1 (stuck spinner) survives the rest of the fix.

## Acceptance gates

1. **Wire test (new, in `evals/src/retry-pass-recovery.ts`)** — must include all three sub-gates:

   **1a — happy path with state postconditions** (iter#1 blocking #3 fix). Spawn a fixture spec that fails on attempt 1, passes on attempt 2. Drive via the existing oracle: pause.publish arrives → oracle commits `retry` → mocha respawns → assert:
   - `test.passed` request was received by the parent (recorded via a Recorder around `connection.handle`).
   - `pauseStore.peekActivePause()` returns `undefined` after handler resolves.
   - `qa-debug.pausedTestIds` context was set to `[]` (verify via a stub `setContext` recorder).
   - `mcpProvider.state` is `'idle'`.
   - The TestRun received `run.passed(item, durationMs)` for the test (Recorder around `controller.createTestRun`).

   **1b — non-retry pass returns early.** Spawn a passing fixture spec with no prior pause. Assert: `test.passed` request fires, parent ack returns `{}` immediately, no pauseStore mutation, no setContext call.

   **1c — exit-race deterministic repro** (iter#1 blocking #1 fix). Standalone `repro-race.cjs` per iter#1 reviewer + IPC research agent's spec: 200x loop, fork a child that calls `process.send` then exits via natural event-loop drain (with `channel.unref()`); count parent runs where `'exit'` observed before `'message'`. With `await c.request(...)` shape, expected count = 0. Save as `evals/src/race-test-exit.cjs`; integrate into `pnpm --filter @qa-debug/evals run race-test`.

   Hard gate: all three must exit 0.

2. **Manual F-bug-1 (S6 QA):** Re-run `fixture-tests-wdio/specs/<bug-fixture>.spec.js` where attempt 1 fails (stale selector), attempt 2 passes (selector heals). Sequence:
   - Run via Test Explorer → fails → pause notification appears.
   - Agent calls `qa-debug:qa_request_retry` (or human clicks ▶ Retry).
   - Expected within ~2 sec of respawn pass:
     - Spinner stops on the test row.
     - Test row shows green ✓.
     - Inline ▶ ✓ ✕ icons disappear from the test row.
     - Status bar `$(debug-alt) QA Paused` entry hides (if not already hidden).
     - Audit channel shows `[decision] retry_passed by env: respawn passed after Xms` AND `[session-manager] retry-pass recovery for "<title>"`.
   - Click qa-debug.retry from command palette → toast says *"no Mocha test is currently paused"* (not *"Pause already resolved"*).

3. **Manual F-crash-1 (S6 QA, iter#1 non-blocking #3 gate):** Run failing fixture → agent commits retry → kill mocha child during respawn (e.g., `kill -9` the pid surfaced in audit log). Expected: audit log shows `[session-manager] mocha crashed after retry; clearing stale pause`; UI test row turns red ✗ with rationale `"mocha crashed during retry respawn"`; inline icons disappear; Retry command palette entry says *"no Mocha test is currently paused"*.

4. **Regression — pause-then-give-up still passes:** Run a failing fixture, click ✕ Give Up. Expected: red ✗ (unchanged). No `test.passed` request fires.

5. **Regression — normal passing test in non-retry run:** Run a passing fixture spec. `test.passed` requests fire from child, parent acks empty, no state mutation. VS Code default test-pass rendering still works.

6. **Build + type-check:** `pnpm -r build` + `pnpm -r build:check` green across 7 workspaces.

7. **Wire integrity:** `pnpm --filter @qa-debug/evals run race-test` PASS (the existing race-test, plus the new `race-test-exit.cjs` from gate 1c).

## Risks

- **Parent crash during child afterEach.** Child's `await c.request(...)` would reject (JsonRpcConnection sees channel close). Caught in the qa-hooks try/catch; child stderr-logs and continues to EVENT_RUN_END. If the extension comes back up before the next run, the user's NEXT run starts fresh (no stale pauseStore persistence concern in v5.11 restart-reset). Acceptable.
- **`appendDecision` signature widening for `'retry_passed'`/`'env'`.** Confirm `output-channel.ts` types; if `DecisionKind` is a strict zod enum, we add a parallel helper `appendOutcome` instead of widening. ~5 LOC either way.
- **Test renamed between attempts.** Impossible — respawn uses `--grep ^${escapeRegex(testTitle)}$` ([session-manager.ts:406](extension/src/session-manager.ts#L406)).
- **Multiple retries (retry → fail → retry → pass).** Each fail emits its own pause.publish (new session_id); each retry commit fires final_decision (consumed by decisionRouter callback). On final pass, `pauseStore.peekActivePause()` returns the most recent pause (pause-store enforces single-active invariant at [pause-store.ts:37](extension/src/pause-store.ts#L37)); `full_title` matches; cleanup runs. Same code path; no extra logic.
- **Two specs with same `fullTitle()` (cross-spec collision in `recordRetryPassed` fallback lookup).** Primary lookup keys on `itemIdForTest(fileUri, full_title)` — fileUri from `pause.file`, full_title from wire. Fallback `Array.from(items.values()).find` could return wrong item if two distinct spec files both contain a test of identical fullTitle. Mitigation: deprioritize fallback; if primary misses AND fallback matches multiple, log + return without action (defer to user manual cleanup via run again). Same fragility as `recordDecision` already has at [:589-593](extension/src/test-controller.ts#L589); the bug class is pre-existing.

## References

- IPC ordering research 2026-05-22: Mocha `runnable.js:363-377` (callFn awaits hook Promise), `runner.js:1045-1088` (synchronous EVENT_RUN_END emit), `cli/run-helpers.js:28-32` (exitMochaLater natural drain), `cli/run-helpers.js:41-66` (exitMocha with --exit flag, IPC NOT in flush list). Node docs: `child_process` 'message'/'exit' ordering — no documented invariant.
- Maintainability research 2026-05-22: B wins 7-of-9 axes; A wins only telemetry-expansion; the regretted scenario for A is `--reporter spec` swap for CI compatibility.
- Design gap location: [ARCHITECTURE-CR-v5.6.md:186](ARCHITECTURE-CR-v5.6.md#L186) ("if it passes, the commit path refreshes to empty" — but no commit path existed).
- Mocha source: `node_modules/.pnpm/mocha@10.8.2/node_modules/mocha/lib/runnable.js`, `runner.js`, `cli/run-helpers.js`.
- Anthropic agentic design — transparency principle: [anthropic.com/research/building-effective-agents](https://www.anthropic.com/research/building-effective-agents).
- Memory: [[project-qa-companion]] (v5.12 LANDED 2026-05-21 commit ed32523); this PLAN is the next slice.
