# S4 Verification Walkthrough

> Companion to `SLICE_PLAN.md` §S4 + `S4_DESIGN.md`. Walks the engineer through Phase 5: F5 Extension Host smoke + TestMessage-retention verification per S4_DESIGN §7.2 R#3-NB1.
>
> Estimated time: 20–40 minutes interactive.

## Pre-requisites

- VS Code **1.120.0 or newer** (engines floor per S4_DESIGN §0; lower versions may lack `McpServerDefinitionProvider`).
- Chrome installed at a default path, or `CHROME_PATH` env var pointing at the binary. The extension auto-discovers `/Applications/Google Chrome.app/...` on darwin, `/usr/bin/google-chrome*` on linux, `C:\Program Files\Google\Chrome\...` on win32.
- `pnpm install && pnpm -r --filter='./mocha-hooks' --filter='./pause-store-types' --filter='./qa-debug-mcp' --filter='./extension' run build` ran clean. The `.vscode/launch.json` pre-launch task does this automatically.
- Working copy at commit `f3cf948` or newer.

## Verification 1: TestMessage retention smoke (load-bearing for §7.2)

Why first: the §7.2 marked-passed mapping assumes `run.passed(testItem)` after `run.failed(testItem, [msg])` keeps the failure `TestMessage` attached. If that assumption fails on this VS Code build, the §7.2 fallback (drop the inline annotation, file an ARCH §3.6 relaxation CR) becomes the actual path, and the marked-passed UX needs to be redesigned before the rest of S4 can be considered shipped.

Steps:
1. Open the project root (`mocha-vscode-tesitng/`) in VS Code.
2. Press **F5** to launch the Extension Development Host. Wait for the new window with the `[Extension Development Host]` title.
3. In the **dev host window**, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
4. Run **"QA Debug: Smoke — TestMessage Retention"**.
5. A notification will appear saying the test is in FAILED state with a TestMessage attached.
6. Open the **Test Explorer** sidebar (left side, beaker icon). Find **"QA Debug Smoke — TestMessage Retention"** controller.
7. Click into the failing test (`should reveal whether TestMessage survives passed transition`). The Test Results panel should show the TestMessage body: *"This is the failure TestMessage — created at run.failed(...) time."*
8. **Take screenshot #1** (failed state with message visible). Save as `verify-shots/01-failed-with-message.png` in the repo workspace.
9. Click **"Transition to passed"** in the original notification.
10. The test row turns green. Click into it again. Observe the Test Results panel:
    - **If the failure message is still visible** → §7.2 mapping holds. Proceed.
    - **If the failure message disappears** → §7.2 fallback path; file `ARCHITECTURE-CR-v5.2-mark-passed-relaxation.md` per S4_DESIGN §7.2 last paragraph. Stop here and surface to the team before completing S4 PR.
11. **Take screenshot #2** (passed state showing whether message survived). Save as `verify-shots/02-passed-after-failed.png`.
12. Click **OK** on the final notification to end the run.

Both screenshots get attached to the S4 PR description per S4_DESIGN §7.2 R#3-NB1.

## Verification 2: Fixture-suite smoke against SLICE_PLAN §S4 exit criteria

Pre-requisite: V1 above passed (failure message survives).

### 2.1 Exit criterion — MCP gate opens on pause; disappears on commit

1. In the dev host window, Command Palette → **"QA Debug: Run Fixture Suite"**.
2. Chrome should spawn (visible window opens). Wait ~3s.
3. Mocha runs `fixture-tests/specs/*.spec.js`. The three intentionally-failing tests will pause one at a time.
4. On the first pause:
   - A notification appears: `QA Debug: test "..." failed at ... Browser held at :9222.`
   - Open Command Palette → **"Developer: Show Running Extensions"** OR (depending on VS Code build) the MCP servers panel.
   - Verify `qa-debug` AND `playwright-mcp` are listed under the QA Debug Companion provider.
5. Click **Give Up** (Test Explorer button in the failure annotation, or Command Palette → "QA Debug: Give Up on Paused Test").
6. The notification clears. Re-check the MCP servers panel — both servers should now be absent.
7. **Pass criterion:** servers appear during pause, disappear after commit.

### 2.2 Exit criterion — Click Mark Passed renders distinct from plain pass

1. Continue from §2.1. Wait for the next test to pause.
2. Click **Mark Passed**. (Cold click — no agent proposal — will prompt for rationale.)
3. Enter a rationale: e.g., `intermittent CI flake; verified locally with same selector`.
4. The test row should turn green. Click into it.
5. **Pass criterion:** Test Explorer row shows `(marked passed)` in the description, and the Test Results panel shows both the original failure message AND a "Marked passed by human" header with the rationale.
6. **Take screenshot #3** as `verify-shots/03-marked-passed-tri-state.png`.

### 2.3 Exit criterion — Retry respawns mocha while Chrome stays alive

1. Continue. Next test pauses.
2. Click **Retry**.
3. Watch the QA Debug Companion Output Channel (`View → Output → QA Debug Companion`). You should see:
   - `[session-manager] respawn for retry: spec=... test="..."`
   - `[chrome] reuse pid=...` (Chrome NOT respawned)
   - `[session-manager] spawn mocha cwd=... args=["--grep","^..."]`
4. Mocha re-runs ONLY the retried test. It fails again (deterministic fixture). New pause notification appears.
5. **Pass criterion:** new pause has a fresh `session_id`, the Test Explorer item is the SAME row (id formula `fileUri::title`), Chrome pid unchanged.
6. Give Up to clear.

### 2.4 Exit criterion — Give Up renders as failed; gate closes

Already covered in §2.1.

### 2.5 Exit criterion — VS Code Reload mid-pause; PauseStore survives; reduced-action-surface re-bind

1. Run the fixture again. On the first pause, do NOT commit.
2. In the dev host window: Command Palette → **"Developer: Reload Window"**.
3. After reload, the QA Debug Companion activates and:
   - Posts a notification: `QA Debug: last suite was interrupted while a pause was active (test: "..."). The browser state is no longer available. Choose Give Up in Test Explorer to clear, or close to defer.`
   - The `qa-debug.paused` context key is true; `qa-debug.staleResume` is true.
   - **Retry** and **Mark Passed** Test Explorer buttons / commands are DISABLED.
   - **Give Up** is enabled.
4. Click **Give Up**. The pause clears, MCP gate closes, audit log records `[session-manager] stale-resume resolved session=... kind=give_up`.
5. **Pass criterion:** Memento payload survived the reload; UI showed reduced action surface; Give Up cleared cleanly via local synthesis (no IPC to dead child).

This is the SLICE_PLAN §S4 (d) wording reinterpretation formalized in `SLICE_PLAN-CR-S4-d.md`.

### 2.6 Exit criterion — Chrome lifecycle

Verified inline during §2.1–§2.3:
- Spawns on suite start (not on extension activation).
- Reuses across tests within a suite.
- Reuses across retry respawn.
- Tears down on mocha clean exit when no pause is outstanding.
- Stays alive if mocha exits with an outstanding pause.

To verify Chrome teardown:
- Run a full suite, Give Up all three pauses.
- After the third Give Up, mocha exits cleanly. Output Channel: `[chrome] tearing down pid=...`.

To verify Chrome survival on outstanding pause:
- Run the fixture. On the first pause, kill mocha externally (e.g., `pkill -f mocha` in another terminal). The hook abandons; final_decision with by=hook arrives; PauseStore clears IF the synthesis path runs.
- Actually — under §9.3 row 1, the mocha exit synthesizes give_up, which clears PauseStore. So this rare path leaves no outstanding pause. To trigger the "Chrome stays up with outstanding pause" branch, you'd need to interrupt mocha's exit before the synthesis fires — corner case; deferred.

### 2.7 Exit criterion — Test Explorer outcome rendering matches qa-reporter

Already covered visually by §2.1–§2.3.

The qa-reporter stdout from mocha is visible in the Debug Console (or wherever VS Code surfaces inherited stdio). It should show the same three outcomes (passed / failed / marked-passed) per the canonical tally format in `fixture-tests/snapshots/s2-3-decision-tally.txt`. Spot-diff after each suite run.

## What to file in the S4 PR description

1. Screenshots 1, 2, 3 from above.
2. Build outputs: `pnpm -r --filter='./mocha-hooks' --filter='./pause-store-types' --filter='./qa-debug-mcp' --filter='./extension' run build` and `pnpm -r ... run build:check` (paste tail).
3. Output Channel transcript for one complete fixture run (showing pause+commit cycle for all three tests).
4. Result of `node --import tsx tools/snapshot-check.ts` (S2 regression guard).
5. Followup pre-PR work: WebFetch `code.visualstudio.com/updates/v1_101` through `v1_120` to identify the actual landing release for `McpServerDefinitionProvider`. If found earlier than 1.120, relax `extension/package.json` engines.vscode in the same PR.

## If Verification 1 fails (TestMessage disappears on passed transition)

Per S4_DESIGN.md §7.2 last paragraph:

1. STOP. Do not open the S4 PR.
2. Create `ARCHITECTURE-CR-v5.2-mark-passed-relaxation.md` proposing to relax ARCH §3.6 line 273 from *"Rendered as `✓ marked-passed by <user>: <rationale>` in stdout AND in the Test Explorer annotation"* to *"Rendered as `✓ marked-passed by <user>: <rationale>` in stdout AND in the Test Explorer description (the failure annotation is retracted by VS Code on passed transition; the description carries the visual distinction)"*.
3. Run that CR through the Ralph loop (one or two iterations is plenty — the scope is one-line).
4. After CR approval, modify `extension/src/test-controller.ts:recordDecision` mark_passed branch to skip the sticky-failure-message attempt; rely on `description` + `appendOutput` alone.
5. Re-run Verification 1 and 2.2 to confirm.

## Skipping Verification 2 sub-criteria

All seven criteria above must pass for S4 PR to open. If any single criterion fails, surface it before merge — the S4 commits stay on `main` but the slice is considered incomplete until exit criteria are green.
