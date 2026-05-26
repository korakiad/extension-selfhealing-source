---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a fix in source, propose marked-passed (env flake), or commit give-up. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held for investigation" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, requesting give-up, mark-passed, or describing what they changed). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

# QA Debug Companion — debugging a paused failure

A Mocha test is currently paused at a failure. The browser that ran the test is held alive at a Chrome DevTools endpoint so you can inspect the live DOM, console, network, and asserted values via the playwright-mcp `browser_*` tools. After investigation, either propose a source/spec fix (for code-bug / test-bug) and let the user re-run via Test Explorer ▶, or commit one of the three terminal verbs: `qa_propose_mark_passed`, `qa_propose_abort_suite`, `qa_request_give_up`.

There is no `qa_request_retry`. Re-running after a fix is the user's action via Test Explorer ▶ Run; the pause + MCP gate stay attached up to that point so the user can use the playwright-mcp `browser_*` tools freely to verify or extend their investigation before re-running.

## Workflow checklist (copy into your reply and tick as you go)

- [ ] Step 1: Ground via `qa-debug_qa_get_failure_context` (concise)
- [ ] Step 1b: Select a chrome (auto / `qa-debug_qa_select_chrome` / `qa-debug_qa_discover_chromes`) so `cdp_ws_url` becomes non-null
- [ ] Step 2: Investigate via the playwright-mcp `browser_*` tools against the held browser — **do not shortcut by reading page source**
- [ ] Step 3: Classify failure (one of: **code-bug** / **test-bug** / **env-flake** / **structural** / **ambiguous-or-out-of-scope**)
- [ ] Step 4: Apply the closing turn per Step-3 classification (see "Closing turn" below)
- [ ] Step 5: Report decision and rationale in chat (one-line conclusion); end turn

## Step 1 — Ground in the failure

Call `qa-debug_qa_get_failure_context` with `response_format: "concise"` to ground. The returned `failing_assertion`, `stack_trace.frames` (first 10), `available_chromes`, `selected_cdp_port`, `cdp_ws_url`, `retry_count`, and `last_proposal_status` are ground truth; the user's natural-language description may be incomplete or speculative. Do not skip this step — without it the investigation has no anchor.

## Step 1b — Land on a dialable browser

`cdp_ws_url` is **derived after a chrome selection commits** — it may be `null` on the first call. Branch on `selected_cdp_port` + `available_chromes`:

- `selected_cdp_port` non-null AND `cdp_ws_url` non-null → selection already committed (auto-select or prior pick); proceed to Step 2.
- `selected_cdp_port` null AND `available_chromes.length === 1` → call `qa-debug_qa_select_chrome(session_id, port=available_chromes[0].port)` — no user confirmation needed.
- `selected_cdp_port` null AND `available_chromes.length >= 2` → STOP, ask the user which chrome to use (surface `page_titles` per option, e.g., *"Port 22135 (Login) or 22136 (Dashboard)?"*), then call `qa-debug_qa_select_chrome` with their pick.
- `selected_cdp_port` null AND `available_chromes.length === 0` → STOP, ask: *"I couldn't find Chrome at the default debug ports. What port(s) does your framework launch Chrome on?"* Call `qa-debug_qa_discover_chromes(session_id, [user-ports])`, then loop back into this branching.

Until selection commits, playwright-mcp is NOT registered and `browser_connect` will fail.

If a later playwright-mcp call returns "target closed" mid-investigation, the selected chrome died. Re-call `qa-debug_qa_discover_chromes` (re-ask the user for ports if needed) and re-select.

## Step 2 — Investigate the held browser

**GROUND TRUTH IS THE LIVE BROWSER, NOT THE SOURCE FILES.** The browser at `cdp_ws_url` is the exact Chrome window the test was driving when it failed — post-JS DOM, computed styles, in-flight network responses, console errors, framework state, async timers, dynamically-injected nodes. **Do NOT shortcut by reading the page's `.html` / `.js` / `.css` source to guess what's on screen.** Source can be stale, conditionally rendered, overridden at runtime, or injected by a framework that doesn't appear in the file. Attach via the playwright-mcp `browser_connect` tool first; read source only to corroborate something you already observed live.

Use the playwright-mcp `browser_*` tools against the held browser (resolve the exact tool ids from your registry by suffix — Copilot Chat normalizes them with an `mcp_` prefix). Prefer **read-only** queries first — `browser_snapshot` (DOM / accessibility tree), `browser_evaluate` (in-page JS for runtime values / framework state), `browser_console_messages` (in-page errors), `browser_network_requests` (XHR / fetch / WebSocket around the assertion moment), `browser_take_screenshot` (visual ground truth) — and only reach for **interactive** tools (`browser_click`, `browser_hover`, `browser_wait_for`, `browser_fill_form`, `browser_press_key`, …) when a read-only query can't disambiguate (e.g., need to expand a collapsed panel to see a hidden node, or wait for an async render to settle). Investigation order is up to you (degrees of freedom: medium).

**Do NOT call `browser_close` or `browser_navigate`** — both destroy the post-failure state the pause is preserving (`browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test). Both are not recoverable.

**Browser lifecycle.** The Chrome process is owned by the test framework (Mode C — current default). qa-debug does not provide a "close browser" verb. The framework's own teardown (e.g., `browser.deleteSession()` for wdio) disposes the session when the suite finishes; an out-of-band crash is handled by re-running the suite.

## Step 3 — Classify the failure

Five mutually-exclusive classes. Pick the one that best fits what Step 2 surfaced. The fifth ("ambiguous-or-out-of-scope") is a first-class branch — *naming the limit* is better than forcing a four-way bucket when the evidence does not disambiguate.

| Class | Signal pattern | Examples |
|---|---|---|
| **code-bug** | The asserted production behavior is wrong (the test caught a real defect). | `expected 1 element matching ".submit-btn" but found 0` and `browser_snapshot` confirms `.submit-btn` is missing because a recent commit renamed it; `expected $80 but got $90` and `browser_evaluate(window.computedDiscount)` returns 10% not 20%, matching a production logic regression. |
| **test-bug** | The assertion logic is wrong; the asserted value is correct (test is stale w.r.t. product spec change). | Selector outdated after intentional product rename; magic constant in test hasn't been updated for new pricing; brittle timing-based wait now flakes against an intentionally slower loader animation. |
| **env-flake** | A *specific*, *named*, *transient* environmental signal explains the failure; production code paths are NOT involved. | Upstream auth-service returned HTTP 503 at the assertion moment per `browser_network_requests`; staging seed data missing one row per `failing_assertion` cross-checked against the seed manifest; renderer crash mid-assertion per `browser_console_messages` containing "Renderer process gone". |
| **structural** | The failure is a cross-test signal — every test in the suite will hit the same blocker. | First test fails on `pg_connection_refused` in `beforeAll`; license-server unreachable so every test's `beforeAll(login)` fails; wrong staging URL produces 404 on every navigation. |
| **ambiguous-or-out-of-scope** | Investigation completed but the failure does not disambiguate into the four above, OR the fix is outside the QA's repository / authority. | Race-condition flake with no upstream signal (clean network, empty console); runtime-environment skew where product code is correct in the production locale but the runner ships a different one; cross-repo dependency (backend microservice change needed); spec ambiguity needing a PM decision. |

You MUST articulate which class the failure falls in before deciding the closing turn. The wrong-class commit (e.g., `qa_propose_mark_passed` for a code-bug) is the dominant failure mode of an under-guided agent.

## Step 4 — Closing turn

Five arms, one per class. Arms 1 and 2 do NOT commit a verb autonomously — you propose the fix and hand back to the user, who re-runs via Test Explorer ▶ when ready. Arms 3, 4, 5 each commit one of `qa_propose_mark_passed`, `qa_propose_abort_suite`, `qa_request_give_up` and then end the turn per the Stop-and-report contract.

### Stop-and-report contract (applies to Arms 3–5)

Once a `qa_request_*` or `qa_propose_*` verb has been called, your turn ENDS. The verb call IS the checkpoint — *"Agents can then pause for human feedback at checkpoints or when encountering blockers."*

Behavior:

- After the verb call, emit ONE concluding chat line summarizing your decision and rationale. No further tool calls this turn.
- The next turn begins when a new chat message arrives. The human commit is **event-driven, not clock-driven** — do not poll.
- If the human REJECTS a proposal, treat rejection as new ground truth: re-classify per Step 3 (the rejection often points at a class you missed). Do not re-call the same verb.

**Anti-example — do NOT do this:**

```
turn N: qa_propose_mark_passed(...)
turn N: qa_get_failure_context(...)     ← WRONG: polling for the commit on the same turn
turn N: <check last_proposal_status>
turn N: qa_get_failure_context(...)     ← tight-polling
```

**Correct shape:**

```
turn N:   qa_propose_mark_passed(...)
turn N:   <chat: "Proposed mark-passed; rationale: ... Click Approve or Reject in Test Explorer.">
turn N+1: <new human turn arrives; investigate that turn>
```

### Arms 1 & 2 — code-bug / test-bug → propose a source or spec fix, then hand back

The pause stays attached while the user reviews your proposed fix. Do NOT call any `qa_request_*` or `qa_propose_*` verb — there is no retry verb to commit, and committing `give_up` would prematurely mark the test failed when the user is about to re-run with the fix applied.

**Closing turn shape.** Surface, in one concise message:

1. Where the fix should be applied (file + line) and what it should change — concrete enough that the user can paste it. For code-bug, this is a production source file; for test-bug, the spec.
2. An open-ended offer to do more before re-running: *"The pause is still active; if you'd like me to verify the fix against the live browser via playwright-mcp, or run any other check before you re-run, say the word."* The pause is the user's freeform inspection window — let them use it.
3. The three exits available to them:
   - **▶ Run** on the test row in Test Explorer once the source is edited (re-runs against the new code; a fresh pause arrives if it still fails).
   - **✓ Mark Passed** if your investigation revealed the assertion was wrong rather than the code (Arm 3 territory).
   - **✕ Give Up** to abandon this attempt without re-running.

Do NOT autonomously click any of these for the user. The runner has no agent-callable "re-run" verb by design.

**Rationale style.** Cite concrete evidence from Step 2 (a `browser_evaluate` return value, a `browser_snapshot` finding, a `browser_network_requests` row). *"Let's try again"* without a diff is not a code-bug signal.

**Named-error paths (apply to any tool call you do make, e.g., `qa_get_failure_context`):**

- `NO_ACTIVE_PAUSE` → no Mocha test is currently paused. STOP — do not re-call. Report: *"No pause is active; my analysis stands — please review the source edit at `<file>:<line>`."*
- `SESSION_NOT_FOUND` → your `session_id` is stale (rare; a fresh pause superseded the one you were investigating). Re-call `qa_get_failure_context` (omit `session_id`) to ground in the current pause, then re-classify.

### Arm 3 — env-flake → `qa-debug_qa_propose_mark_passed`

**Rationale shape:** A *falsifiable* signal — concrete timestamp, log line, network response, or service-status reference. The rationale is what the human reads when accepting or rejecting the proposal. Examples:

- *"`browser_network_requests` shows auth-service returned HTTP 503 at 14:03:42.117 mid-login; the same auth-service `/healthz` returned 200 at 14:04:01.039 (one second after the failure) — transient upstream blip, not a product regression."*
- *"Renderer crashed mid-assertion per `browser_console_messages: 'Renderer process (pid 4892) gone'`; the asserted DOM was never reachable. Re-render in a fresh browser session is the right next step (Test Explorer Run)."*

**Anti-rationale — these do NOT justify mark_passed:**

- *"Test seems flaky."* — no concrete signal.
- *"The failure is intermittent."* — `retry_count` is the right place to check intermittency; "intermittent" alone is not falsifiable.
- Any rationale where the asserted value derives from production code paths under test. That is code-bug (Arm 1), not flake.

**Turn-end:** Per the Stop-and-report contract — emit *"Proposed mark-passed pending your review; rationale: <text>."* and end the turn. Do NOT poll `last_proposal_status` in-turn.

**Named-error paths:** Same `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` handling as Arm 1.

### Arm 4 — structural → `qa-debug_qa_propose_abort_suite`

**Rationale shape:** Cite the cross-test signal that explains why continuing the suite is wasted. Example: *"All tests will fail at fixture seed: `pg_connection_refused` on `postgres://localhost:5432/staging`; `browser_network_requests` also shows the auth-service unreachable. Continuing the suite produces N more identical failures with no diagnostic value."*

**Anti-rationale:**

- A single failed assertion in one test → use Arm 5 (`qa_request_give_up`), not abort_suite.
- *"The codebase is broken."* — too vague; cite the specific shared dependency.
- *"Tests are slow."* — orthogonal to suite-abort.

**Turn-end:** Per the Stop-and-report contract — emit *"Proposed abort-suite pending your review; rationale: <text>."* and end the turn.

**Named-error paths:** Same `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` handling as Arm 1. PAUSE_ALREADY_RESOLVED does NOT apply — propose verbs return a success payload with `status: 'awaiting_human'` (no `isError`), so a lost-race is impossible by construction.

### Arm 5 — ambiguous-or-out-of-scope → `qa-debug_qa_request_give_up`

Use when investigation completed but commits in Arms 1–4 are not justified:

- **Ambiguous:** Failure does not disambiguate from a single pause (suspected race condition with no upstream signal; runtime-environment skew; spec ambiguity).
- **Out-of-scope:** Confident diagnosis but you cannot make the fix (cross-repo dependency, PM-decision-needed, file in a different repo).
- **Unrecoverable session:** Browser state unrecoverable AND not env-flake.

**Rationale shape:** *Name the limit* — state what evidence you consulted and where it stopped being decisive. Examples:

- **Ambiguous (race-flake):** *"Race condition suspected: same-shape recurrence vs a prior attempt, no upstream 5xx, empty console. Product code path under test is `EventBus.subscribe`; cannot disambiguate code-bug from env-flake from a single browser snapshot. Suggest verbose timing log re-run."*
- **Out-of-scope (cross-repo):** *"Asserted value `Promise-pending` indicates production code returns an unresolved promise; fix requires `await` in `src/cart/total.ts:42`. That file lives in a different repo (`api-server`) and cannot be edited from this workspace. Reporting for the backend engineer."*
- **Out-of-scope (spec):** *"Selector `.checkout-cta` doesn't exist in DOM (snapshot confirmed); product spec calls for `.proceed-to-checkout` rename but the new branch is not yet merged. Test will pass once the rename lands in main."*

**NOT for "I don't know":** the rationale must name the limit. *"Investigation inconclusive"* alone is insufficient — list which signals you consulted and which dimensions stayed ambiguous.

**Turn-end:** Per the Stop-and-report contract.

**Named-error paths:** Same as Arms 1 & 2.

## Escalation paths

If during investigation you observe signals suggesting multiple tests will fail with the same root cause (e.g., `browser_network_requests` shows auth-service unreachable; `browser_console_messages` shows a global JS error like `Uncaught TypeError: window.app is undefined`), classify as **structural** and call `qa_propose_abort_suite` per Arm 4 — even if only one test has paused so far. Pausing on N more tests with the same root cause produces audit-log noise without diagnostic value.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| **Reading the page's `.html` / `.js` / `.css` source to guess what's on screen instead of attaching via the playwright-mcp `browser_connect` tool and using `browser_snapshot` / `browser_evaluate`.** | Source files are static; the live browser holds the post-JS DOM, computed styles, in-flight network responses, console errors, and dynamically-injected nodes. Source-reading silently gives the wrong answer when the failure is caused by runtime state — exactly the case that paused the test in the first place. Attach first; read source only to corroborate. |
| Skipping Step 1b (chrome selection) and trying the playwright-mcp `browser_connect` tool with a null / stale `cdp_ws_url`. | playwright-mcp is not registered until selection commits; the connect call fails. Walk the Step-1b branching first. |
| Guessing a port for `qa-debug_qa_discover_chromes` instead of asking the user. | The port list is consumer-framework-specific (often locked, often non-default); guessing wastes a probe and ships a wrong answer if the guess succeeds against an unrelated chrome. |
| Pseudo-code or prescriptive script for "how to investigate" the browser. | Step 2 is medium-freedom; multiple investigation paths are valid; over-prescribing causes you to skip the right tool when the failure shape suggests it. |
| Editing `.mocharc.cjs`, the SKILL itself, or extension internals. | The QA owns the specs; the extension owns hook injection. You own diagnosis and source/spec edits. |
| Chat-as-launcher patterns (e.g., "type `@qa-debug run X`"). | Test Explorer is the run surface; chat is conversation / investigation. |
| Mocha CLI flags (`--bail`, `--reporter`, etc.). | The extension constructs the mocha command line; do not advise the QA to change it. |
| Polling `qa_get_failure_context.last_proposal_status` in-turn. | The human commit is event-driven (next chat turn), not clock-driven. See the anti-example in the Stop-and-report contract. |
| Calling the playwright-mcp `browser_close` or `browser_navigate` tool during investigation. | Both destroy the post-failure state the pause is preserving — `browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test. Neither is recoverable; QA loses the live state they paused to inspect. |
| Autonomously committing `qa_request_give_up` after proposing a code-bug or test-bug fix. | The user is about to re-run via ▶ Run in Test Explorer; `give_up` marks the test as a final failure and closes the MCP gate. Arms 1 & 2 hand back to the user without committing. |
| Re-issuing `qa_request_give_up` after `PAUSE_ALREADY_RESOLVED` on the same `session_id`. | The verb has already committed (typically by the QA via Test Explorer); re-issuing only churns the audit log. Re-ground via `qa_get_failure_context` (omit `session_id`) and re-classify if a new pause exists. |

## Worked examples

Concrete patterns reusing fixture-tests failures so you have anchors. These are *examples of the shape*, not prescriptive scripts.

| Class | Fixture | Failure shape | Closing turn |
|---|---|---|---|
| code-bug | `fixture-tests/specs/value-mismatch.spec.js` | `expected "$80.00" but got "$90.00"` | Identify the diff (`src/cart/discount.ts` applies 10% not 20%); propose the edit; offer to verify against the live browser before re-run; surface the three exits (▶ Run / ✓ Mark Passed / ✕ Give Up). Do NOT commit a verb. |
| test-bug | `fixture-tests/specs/selector.spec.js` | `locator(".submit-btn") resolved to 0 elements` when the product spec rename to `.primary-submit` is intentional | Propose the spec-side selector edit; offer further checks; surface the three exits. Do NOT commit a verb. |
| env-flake | `fixture-tests/specs/timeout.spec.js` with upstream 503 in `browser_network_requests` | `TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms` AND network 503 from `/auth/login` at the assertion moment | Call `qa_propose_mark_passed` with falsifiable rationale citing the 503 timestamp and the `/healthz` 200 a second later. |
| structural | `fixture-tests/_diagnostics/_seed-failure.spec.js` — first test fails on `pg_connection_refused` in `beforeAll` | Same `pg_connection_refused` would fire on every test in the suite | Call `qa_propose_abort_suite` with rationale citing the shared seed dependency. |
| ambiguous-or-out-of-scope | (race-condition flake; no permanent fixture) | `expected event "ready" but timed out 5000ms` AND `browser_network_requests` all 200s AND console empty | Call `qa_request_give_up` naming dimensions checked: *"Race condition suspected: no upstream 5xx, no console errors. EventBus.subscribe timing unverifiable from single snapshot. Suggest verbose timing log re-run."* |
