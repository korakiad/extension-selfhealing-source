# PLAN — Stop button kills the whole process group (Ctrl-C parity)

Make the "stop / cancel suite" affordances terminate the mocha run the way a terminal Ctrl-C does: signal the **entire process group** (mocha + the launched Electron/OpenFin/Chrome + any framework worker), with an escalation to a hard kill, instead of a single `SIGTERM` to the mocha PID.

## 1. Problem / root cause

Both stop paths converge on `child.kill('SIGTERM')` against the single mocha PID:
- Test Explorer native stop → run-profile `token.onCancellationRequested` → `session-manager.ts:444-454`.
- Status-bar `$(debug-stop) Cancel Suite` → `qa-debug.cancelRun` → `cancelActiveRun()` → `session-manager.ts:636-650`.
- Deactivate → `dispose()` → `session-manager.ts:337`.

`child.kill(sig)` delivers `sig` to **only** the mocha process. The child is spawned **without** `detached` (`session-manager.ts:429-433`), so it sits in the extension-host's process group; the browser/app the consumer framework launches are descendants in that same group and never receive the signal. A terminal Ctrl-C sends **SIGINT to the whole foreground process group**, hitting every descendant at once.

Consequences:
1. The launched Electron/OpenFin/Chrome is orphaned (keeps running) after "stop".
2. If the consumer framework (wdio / `@tr/mocha-runner-hooks`) registered an async SIGTERM/SIGINT teardown that blocks on the *paused* browser, mocha never exits → `child.on('exit')` → `onMochaExit()` → `run.end()` never fire → Test Explorer keeps spinning, button looks dead.
3. No SIGTERM→SIGKILL escalation: a process that traps/stalls on the signal lives forever.

**Verified non-issues (so the reviewer needn't re-check):**
- The run-profile `CancellationToken` *does* still fire after the run handler's promise resolves — the `TestRun` stays open until `run.end()`, so VS Code keeps the request's token live. The signal is being sent; it just doesn't reach the group. (No change needed to the immediate-resolve `spawnMochaChild` shape.)
- The unref'd IPC channel and the qa-hooks heartbeat `setInterval` pin the child's event loop, but POSIX signal disposition bypasses the event loop, so SIGINT/SIGKILL terminate regardless.

## 2. Goal / non-goals

**Goal.** "Stop" / "Cancel Suite" tears down the run + everything it launched, reliably, matching Ctrl-C. Hung/uncooperative children are force-killed after a grace window.

**Non-goals.**
- No change to *when* cancel is offered (modal confirm on the command path stays).
- No change to the pause/decision/heartbeat protocol. Group-kill makes the child exit; the existing `userCancelled` → `onMochaExit` → abandon-pending-sessions path is unchanged.
- No graceful per-session browser teardown on our side — we delegate "graceful" to SIGINT (same as Ctrl-C); if the framework's handler hangs, SIGKILL the group.

## 3. Approach

1. **Spawn as group leader.** Add `detached: true` to the `spawn` options. The child's PID becomes its PGID; descendants inherit it. Do **not** `unref()` — we still track exit via the existing `child.on('exit')`.
2. **Group signal on cancel (POSIX).** `process.kill(-child.pid, 'SIGINT')` — SIGINT is exactly what Ctrl-C sends, so the framework takes the same teardown path the QA already trusts from the terminal.
3. **Escalate.** After `KILL_GRACE_MS`, if the run still hasn't exited (`this.activeRun === run`), `process.kill(-child.pid, 'SIGKILL')`. Clear the escalation timer in `onMochaExit`.
4. **Windows fallback.** `process.kill(-pid)` is unsupported on Windows. When `process.platform === 'win32'`, kill the tree with `taskkill /pid <pid> /T /F` (force; `/T` = tree). Relevant because OpenFin QAs are likely on Windows.
5. **Single chokepoint.** All three call sites (token handler, `cancelActiveRun`, `dispose`) route through one new private method so the group/escalation/platform logic lives in exactly one place.

## 4. Contracts (signatures only — bodies live in the implementation)

### `session-manager.ts`

```ts
// New module constant near HEARTBEAT_MS.
// Grace between the polite group signal and the hard kill. Env override for tests.
const KILL_GRACE_MS = Number(process.env.QA_DEBUG_KILL_GRACE_MS ?? 3_000);

interface ActiveRun {
  // ...existing fields...
  /** Set when terminateRun schedules the SIGKILL escalation; cleared in onMochaExit. */
  killEscalationTimer?: NodeJS.Timeout;
}

// New private method — the single chokepoint for tearing a run down.
//   reason  → audit log line
//   Sends the polite group signal now and arms the SIGKILL escalation.
//   Idempotent: a second call while a timer is armed is a no-op beyond logging.
private terminateRun(run: ActiveRun, reason: string): void;

// New file-local helper(s) — platform-aware group kill. No throw on ESRCH
// (group already gone). Bodies pick process.kill(-pid, sig) vs taskkill /T /F.
function signalProcessGroup(pid: number, signal: 'SIGINT' | 'SIGKILL', log: (m: string) => void): void;
```

Call-site changes (replace `child.kill('SIGTERM')`):
- `spawnMochaChild` token handler (`:444-454`) → `this.terminateRun(run, 'cancellation token')`.
  - NB: the token handler currently closes over `child` before `run` is constructed (`run` is built at `:457`). Reorder so the `onCancellationRequested` registration happens *after* `run` exists, or capture `run` — implementor's call.
- `cancelActiveRun` (`:636-650`) → set `userCancelled`, then `this.terminateRun(run, reason)`.
- `dispose` (`:334-344`) → `this.terminateRun(this.activeRun, 'extension deactivate')` (best-effort; deactivate can't await the grace timer, so also fire an immediate group SIGKILL synchronously on this path — implementor decides).

`onMochaExit` (`:611-629`): `clearTimeout(run.killEscalationTimer)` alongside the existing heartbeat-timer cleanup.

### `spawnMochaChild` spawn opts (`:429-433`)
Add `detached: true` to the options object. Stdio/env/cwd unchanged.

## 5. Files touched

```
extension/src/session-manager.ts   ← detached spawn, terminateRun, group-kill helper, 3 call sites, onMochaExit cleanup
extension/src/run-status-bar.ts    ← tooltip string: "(SIGTERM mocha)" → "interrupt the run + browser (like Ctrl-C)"
extension/src/commands.ts          ← header comment + cancelRun doc string wording
extension/test/<new>.test.mts      ← see §7
```
No new dependencies. No package.json contribution changes (commands/menus unchanged).

## 6. Edge cases / risks

- **`detached: true` + ext-host exit.** A detached child survives if VS Code is *force*-killed (no deactivate). Same orphaning that already happened to the browser; `dispose()` covers the normal-quit path. Acceptable; note in code comment.
- **PID reuse / `-pid` to a recycled group.** `process.kill(-pid)` after the group is gone throws `ESRCH` — swallow it. The escalation timer also guards on `this.activeRun === run` so we never SIGKILL a *different* run that started in the meantime.
- **`child.pid` undefined** (spawn failed before fork): guard — `child.on('error')` already handles spawn failure; `terminateRun` no-ops when `pid == null`.
- **Windows graceful step.** `taskkill /F` is a hard kill (no SIGINT-equivalent). Accepted: on Windows the reliable Ctrl-C analogue is `taskkill /T /F`; the framework loses its graceful teardown, but the alternative (CTRL_C_EVENT to a console-less child) is unreliable.
- **Double-signal.** Pressing stop twice, or token + command both firing: `terminateRun` is idempotent (no-op if a timer is already armed).

## 7. Test plan

- **Unit (extension/test, .mts + node:test):** `terminateRun` / `signalProcessGroup` with a fake `child` whose `.pid` and a stubbed `process.kill` record calls — assert: (a) SIGINT to `-pid` first; (b) SIGKILL to `-pid` after `QA_DEBUG_KILL_GRACE_MS` (use a tiny override); (c) escalation timer cleared when exit fires before grace; (d) `win32` branch shells `taskkill /pid <pid> /T /F`; (e) `ESRCH` swallowed.
- **Manual / e2e:** run a fixture that launches the app, hit both the Test Explorer stop and the status-bar Cancel Suite — confirm mocha *and* the launched app are gone (`ps`/Task Manager) and Test Explorer stops spinning within the grace window. Repeat with a spec whose `afterEach` deliberately hangs to exercise the SIGKILL escalation.

## 8. Open question for review

SIGINT vs SIGTERM for the polite first signal: SIGINT mirrors Ctrl-C exactly (frameworks key their graceful teardown off SIGINT). SIGTERM is the conventional "please stop." Proposal: **SIGINT**, because the whole bug report is "make it behave like Ctrl-C," and consumer frameworks already have a trusted SIGINT path. Reviewer: confirm or override.
