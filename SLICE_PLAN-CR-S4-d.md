# SLICE_PLAN CR — S4 (d) reload-mid-pause exit criterion clarification

> Status: Iteration #1 draft 2026-05-21, raised as part of S4_DESIGN.md Ralph-loop iteration #2 (resolves reviewer #1 Blocking #5).
>
> Scope: SLICE_PLAN §S4 exit criterion (d) only. No other change.

## 0. Sources (per ARCHITECTURE v5 §0.1)

- `SLICE_PLAN.md` v5 §S4 exit criteria, specifically the bullet "VS Code Reload mid-pause: PauseStore survives Memento; pause re-bound on activation; gate re-opens" (SLICE_PLAN.md:154).
- `ARCHITECTURE.md` v5.1 §3.5 "Pause-store" paragraph: "Survives Copilot Chat restart but not VS Code restart (intentional for phase 1)" — note the apparent contradiction with SLICE_PLAN §S4 (d) which DOES want survival across VS Code reload. The CR resolves this by distinguishing "Memento survives" (true) from "live mocha child resurrected" (not implementable).
- `S4_DESIGN.md` (iteration #2) §3.5 + §11 — the design that motivates this CR.
- `node_modules/.pnpm/@types+vscode@1.120.0/.../vscode.d.ts:8615` — Memento "value must be JSON-stringifyable"; explains why a Memento payload survives but the dependent live process state does not.

## 1. The contradiction

SLICE_PLAN.md:154 says, verbatim: *"VS Code Reload mid-pause: PauseStore survives Memento; pause re-bound on activation; gate re-opens."*

A literal reading of "pause re-bound on activation" implies that on extension activation after a mid-pause reload, the extension re-binds the persisted pause to a live mocha child + held Chrome and resumes the pre-reload flow. That reading is **not implementable** because:

1. **The mocha child is gone.** Child processes die with their parent extension host. There is no API to revive a dead child process and re-attach to its in-memory state (the `decision.await` Promise it was holding, the IPC channel it was reading from).
2. **The held Chrome is gone.** The extension owns Chrome; when the extension host dies, the Chrome process is orphaned and either persists with no debugger client or gets reaped by the OS. Even if Chrome survived, the live browser state (DOM, console, network) at the failure moment is no longer reachable in any structured way — the agent would observe a different live state from the one in the Memento payload, making the persisted pause misleading.
3. **Auto-re-running the failing test to recreate the pause is worse.** Re-spawning mocha with `--grep <title>` on activation would generate a *new* failure with a different `session_id`, a different stack snapshot, different console logs, and may not reproduce at all (flaky tests). The Memento payload would then describe a pause state the system never re-entered.

The Memento payload itself *does* survive — Memento persists to disk per vscode.d.ts:8615 — but the dependent live state (mocha child, Chrome process, IPC channel) does not. The SLICE_PLAN wording conflates the two.

## 2. The reinterpretation

Replace SLICE_PLAN §S4 exit criterion (d) verbatim from:

> *"VS Code Reload mid-pause: PauseStore survives Memento; pause re-bound on activation; gate re-opens."*

to:

> *"VS Code Reload mid-pause: PauseStore survives Memento; on activation the pause is re-bound with **reduced action surface** (Give Up enabled; Retry and Mark Passed disabled because the mocha child and held Chrome are gone); the MCP gate re-opens in **read-only mode** so the agent can still inspect via `qa-debug:qa_get_failure_context` and `playwright-mcp:browser_*` tool calls will return CDP-connection errors via the natural playwright-mcp error path. The human clears the stale pause by clicking Give Up. Live-binding to the dead mocha child is not implementable in Phase 1; auto-relaunching Chrome + auto-re-running the failing test is deferred to Phase 2 if needed."*

## 3. Alternatives considered

| Approach | Why rejected |
|---|---|
| **Live-bind to dead mocha child.** | Not implementable (mocha child cannot be resurrected; the IPC channel and `decision.await` Promise state are lost). |
| **Auto-relaunch Chrome + auto-re-run the failing test on activation.** | Generates a new pause that may differ from the Memento'd one (flaky tests, non-deterministic state). The Memento payload becomes misleading. Also surprising UX: the user reloads VS Code for an unrelated reason and the extension starts running tests. |
| **Clear the Memento'd pause silently on activation.** | Loses audit trail. The user may not realize the pause was abandoned. Violates the spirit of "PauseStore survives Memento" — survival without a way to act on the survived state is purposeless. |
| **Reduced-action-surface UI on activation (proposed).** | Honors "survives Memento" by surfacing the persisted payload; honors "re-bound" by re-attaching it to the UI; honors "gate re-opens" by re-registering MCP servers in read-only mode; cleanly closes the stale pause via Give Up. The audit trail is intact. The user is not surprised. |

## 4. Implementation footprint

Already specified in `S4_DESIGN.md` iteration #2 §3.5 and §11. Concretely:
- A new context key `qa-debug.staleResume` is set true on activation-with-persisted-pause.
- The `testing/message/content` menu `when` clauses for `qa-debug.retry` and `qa-debug.markPassed` are extended to `testMessage == qaDebugPaused && !qa-debug.staleResume`.
- The activation-time notification: *"Last suite was interrupted while a pause was active. The browser state is no longer available. Choose **Give Up** to clear, or close this notification to defer."*
- The Give Up path locally synthesizes `decisionRouter.abandon(sessionId, 'resumed after VS Code reload')` since there is no live IPC channel to commit through.

## 5. Risk

- **Behavior risk:** zero — Phase 1 has never shipped reload-mid-pause behavior. This CR defines what shipping S4 will produce; no prior behavior is being changed.
- **Reviewer-pushback risk:** reviewer might prefer the more ambitious auto-relaunch-and-re-run option. Counter: the design rejection in §3 is grounded in test determinism (the new failure may differ from the persisted one), not in implementation difficulty alone. If a reviewer wants the more ambitious behavior, it lands as a Phase 2 CR with explicit determinism-handling, not as a Phase 1 default.
- **User-surprise risk:** the user reloads VS Code mid-investigation, comes back, and the Retry button is disabled. The notification explains why. Better UX than silently auto-running the suite or silently clearing the pause.

## 6. Recommendation

Apply §2 in `SLICE_PLAN.md` §S4 exit criterion (d). Reflects what S4 will actually ship per `S4_DESIGN.md` iteration #2.

## 7. Status

Iteration #1 draft 2026-05-21, raised within the S4_DESIGN.md iteration-#2 Ralph-loop pass. Pending reviewer #2 sign-off (the same reviewer pass that signs off S4_DESIGN iteration #2 will also sign off this CR, since they are mutually dependent).
