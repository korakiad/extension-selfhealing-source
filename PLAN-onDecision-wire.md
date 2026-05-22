# PLAN — wire MCP request verbs through DecisionRouter

## Bug (one-liner)

Agent's `qa-debug:qa_request_retry` / `qa_request_give_up` call `MementoPauseStore.recordDecision` (pure storage; clears proposal slot, returns payload) but never reach `DecisionRouter.commit`. The mocha child's `decision.await` IPC promise stays pending → status-bar `QA Paused` never hides → no respawn. UI-button path at `commands.ts:65` calls `decisionRouter.commit` directly and works; agent MCP path is the architectural miss.

## Fix shape

Add optional `onDecision(sessionId, kind: 'retry' | 'give_up', reason): boolean` callback to `CreateQaDebugServerOptions`. Server handlers call it AFTER `store.recordDecision`. False return → throw `PAUSE_ALREADY_RESOLVED` (new error code) with actionable recovery hint. Extension wires it to `decisionRouter.commit(sid, kind, reason, 'agent')`.

## Touchlist

1. **`qa-debug-mcp/src/errors.ts`** — add `'PAUSE_ALREADY_RESOLVED'` to `QaErrorCode` union. ~1 LOC. `errorResult` already formats `${code}: ${message}`; no new branch.

2. **`qa-debug-mcp/src/server.ts`** —
   - Re-import `QaToolError`.
   - Add `onDecision?: (sid, kind: 'retry' | 'give_up', reason) => boolean` to `CreateQaDebugServerOptions`.
   - In `qa_request_retry` handler (lines 95–115): after `store.recordDecision`, call `options.onDecision?.(sid, 'retry', reason)`; if returns `false`, throw `new QaToolError('PAUSE_ALREADY_RESOLVED', '<recovery-hint-text>')`.
   - Same change in `qa_request_give_up` handler (lines 117–137).
   - Recovery-hint text [R#NB2 — trimmed to actionable tool-call guidance only]: *"Pause already resolved by another caller; no respawn was triggered. Call qa_get_failure_context (omit session_id) to ground in current state, then re-classify if a new pause arrived. Do NOT re-issue against the stale session_id."*

3. **`qa-debug-mcp/src/tools.ts`** —
   - Fix wrong "propose verb" comment on `qa_request_retry` annotation (line 132) and `qa_request_give_up` (~line 169). Replace with: *"request verb: auto-commits via DecisionRouter (v5.6)."*
   - **[R#B1]** Update `description` string for BOTH verbs. `Errors:` clause currently reads *"NO_ACTIVE_PAUSE when the pause was already resolved; SESSION_NOT_FOUND when session_id is stale"* (lines 114, 151). Replace with: *"NO_ACTIVE_PAUSE when no pause is active; SESSION_NOT_FOUND when session_id is stale; PAUSE_ALREADY_RESOLVED when another caller committed the verb first."* The "NO_ACTIVE_PAUSE when the pause was already resolved" wording is now technically wrong — that case is PAUSE_ALREADY_RESOLVED post-v5.6; NO_ACTIVE_PAUSE means literally no pause is active.

4. **`extension/src/qa-debug-server.ts`** —
   - Add `decisionRouter: DecisionRouter` parameter to `hostQaDebugMcp` (positional, second arg).
   - Pass `onDecision: (sid, kind, reason) => decisionRouter.commit(sid, kind, reason, 'agent')` into `createQaDebugServer`.
   - One `appendInfo` audit line per call: `[qa-debug-lm] onDecision sessionId=... kind=... committed=...`.

5. **`extension/src/extension.ts`** — at line 48, pass `decisionRouter` as the second arg to `hostQaDebugMcp`. `decisionRouter` already in scope.

6. **`extension/skills/qa-debug/SKILL.md`** —
   - Arm 1 / Arm 2 / Arm 5 named-error sections gain a `PAUSE_ALREADY_RESOLVED` bullet (Arms 3/4 use propose verbs, no impact). Text: *"PAUSE_ALREADY_RESOLVED → another caller (typically the QA via Test Explorer) committed the verb first; your call had no effect. Call qa_get_failure_context (omit session_id) to confirm idle vs fresh pause, then re-classify if a new pause arrived. Do NOT re-issue the same verb against the stale session_id."*
   - **[R#NB1]** Anti-patterns table (~line 173) gains row: *"Re-issuing `qa_request_retry` / `qa_request_give_up` after PAUSE_ALREADY_RESOLVED on the same session_id."* with reason *"The verb has already committed; re-issuing only churns the audit log. Re-ground via `qa_get_failure_context` and re-classify if a new pause exists."*

## Key design decisions (these need review)

- **Ordering:** store.recordDecision FIRST, then onDecision. Reason: store-call validates session_id (throws SESSION_NOT_FOUND fail-fast); proposal-clear is idempotent. Inverted order risks committing then failing the agent with NO_ACTIVE_PAUSE.
- **Sync, not async:** `onDecision` returns `boolean`. `decisionRouter.commit` is sync (decision-router.ts:36). No async benefit.
- **isError: true for PAUSE_ALREADY_RESOLVED**, NOT v5.2 §2.6's success-with-`{status: 'declined'}` shape. Reason: v5.2 §2.6 decline IS the intended outcome (Mode A test owns browser; close-browser is no-op-by-design). v5.6 PAUSE_ALREADY_RESOLVED means the agent's intent did NOT complete — a different caller's commit consumed the single-shot. Agent must refetch ground-truth via `qa_get_failure_context`, not treat as success-with-different-shape.
- **No SKILL.md frontmatter change**, no new tool, no protocol change.

## Acceptance gate

1. **Race regression test (new):** `evals/src/race-test.ts` — construct `createQaDebugServer` with `InMemoryPauseStore` + scripted `onDecision` (returns true once, false next call). Assert:
   - **[R#B2 strengthened]** First `qa_request_retry` MCP call returns `isError !== true` AND payload contains `{decision: 'retry', accepted_at_ms: <number>}`.
   - Second call returns `isError === true` AND `content[0].text` matches `/^PAUSE_ALREADY_RESOLVED:/`.
   - **[R#B2]** onDecision was invoked exactly twice with **`(sessionId, 'retry', reason)` arguments** (not just count) — assert kind === 'retry' and sessionId matches the active pause.
   - InMemoryPauseStore active pause persists after both calls (session-manager retains sole ownership of clearing).
   - Add `"race-test": "tsx src/race-test.ts"` to evals/package.json. **Hard gate: must exit 0.**
2. **F5 retry round-trip:** agent calls `qa_request_retry` in real Extension Host →
   - Output Channel "QA Debug Companion" shows `[qa-debug-lm] qa_request_retry called` + `[qa-debug-lm] onDecision sessionId=... kind=retry committed=true`.
   - **[R#B2]** Output Channel shows `[decision-router] commit ... by=agent` (NOT `by=human`) — proves the agent-attribution path is wired, not silently falling back to UI semantics.
   - Status-bar hides within 500ms; new mocha child spawns; respawn log line lands.
3. **F5 give_up round-trip:** agent calls `qa_request_give_up` →
   - `committed=true` + `by=agent` audit lines.
   - final_decision clears active pause; mocha exits cleanly.
   - v5.5 sticky failure TestMessage retained on the TestItem after the agent-committed give_up lands.
4. **Existing evals unchanged:** `pnpm --filter @qa-debug/evals run engagement` and `decision-tree` continue passing; stdio CLI works with undefined onDecision.
5. **`pnpm -r build` + `pnpm -r build:check` green** across 7 workspaces. S2 reporter snapshot unchanged.

## Out of scope (Phase 2)

- Telemetry on PAUSE_ALREADY_RESOLVED frequency.
- Automated race test under real VS Code Extension Host (the new unit-level race-test exercises the server.ts logic; the live router race is small-window and exercised by F5 secondary gate only).

## Risks

- `decisionRouter.commit` callback path includes synchronous `pauseStatusBar.hide()` (session-manager.ts:336–344). Disposed StatusBarItem during F5-reload could throw `Cannot access disposed object`; existing server.ts `try/catch` catches and routes through `errorResult → INTERNAL_ERROR`. Acceptable.
- Forgetting to pass `decisionRouter` into `hostQaDebugMcp` at extension.ts:48 → TS compile error (required param). Compile-time check is the safeguard.

## References

- Bug repro: `[[project-wdio-test-err-undefined]]` shares the same F5 session.
- Architecture context: ARCHITECTURE.md §3.2 (verb taxonomy), S4_DESIGN.md §9 (DecisionRouter), S5 SKILL.md (named-error path semantics).
- Anthropic doctrine: writing-tools-for-agents (recovery-hint UX); safe-and-trustworthy-agents (request-vs-propose asymmetry).
