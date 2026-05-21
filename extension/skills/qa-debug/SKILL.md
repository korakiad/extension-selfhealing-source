---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a retry, give-up, or marked-passed decision. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held at ws://localhost:9222" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, requesting retry, give-up, or marked-passed, or describing what they changed before retrying). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

# QA Debug Companion — debugging a paused failure

A Mocha test is currently paused at a failure. The browser that ran the test is held alive at a Chrome DevTools endpoint so you can inspect the live DOM, console, network, and asserted values via `playwright-mcp:browser_*` tools. After investigation, commit a decision per the tree below; the QA reviews any irreversible proposals via Test Explorer buttons.

## Workflow checklist (copy into your reply and tick as you go)

- [ ] Step 1: Ground via `qa-debug:qa_get_failure_context` (concise)
- [ ] Step 2: Investigate via `playwright-mcp:browser_*` against the held browser
- [ ] Step 3: Classify failure (one of: **code-bug** / **test-bug** / **env-flake** / **structural** / **ambiguous-or-out-of-scope**)
- [ ] Step 4: Commit decision per Step-3 classification (see "Commit decisions" below)
- [ ] Step 5: Report decision and rationale in chat (one-line conclusion)

## Step 1 — Ground in the failure

Call `qa-debug:qa_get_failure_context` with `response_format: "concise"` to ground. The returned `failing_assertion`, `stack_trace.frames` (first 10), `cdp_ws_url`, `retry_count`, and `last_proposal_status` are ground truth; the user's natural-language description may be incomplete or speculative. Do not skip this step — without it the investigation has no anchor.

## Step 2 — Investigate the held browser

The browser at `cdp_ws_url` is held precisely so you can multi-call investigate. Recommended starting tools:

- `playwright-mcp:browser_snapshot` — current DOM state.
- `playwright-mcp:browser_evaluate` — resolve the asserted value in-page.
- `playwright-mcp:browser_console_messages` — in-page errors (JS exceptions, CSP violations, renderer crashes).
- `playwright-mcp:browser_network_requests` — XHR / fetch / WebSocket activity around the assertion moment.

Investigation order is up to you (degrees of freedom: medium). **Do NOT call `playwright-mcp:browser_close`** — closing destroys the QA's live inspection asset and is not recoverable.

**Browser ownership (Mode A vs Mode B):** `qa_get_failure_context.cdp_ws_url` reveals the mode.

- Random ephemeral port (e.g., `ws://localhost:54321`) → **Mode A**. The user's test code launched the browser via `wdio.remote()` and owns its lifecycle via `browser.deleteSession()` in teardown. `qa-debug:qa_propose_close_browser` returns `{ status: 'declined' }` here — do not call it.
- `:9222` → **Mode B**. The companion launched the browser. `qa-debug:qa_propose_close_browser` may be appropriate after investigation completes; the human commit closes via CDP.

## Step 3 — Classify the failure

Five mutually-exclusive classes. Pick the one that best fits what Step 2 surfaced. The fifth ("ambiguous-or-out-of-scope") is a first-class branch — *naming the limit* is better than forcing a four-way bucket when the evidence does not disambiguate.

| Class | Signal pattern | Examples |
|---|---|---|
| **code-bug** | The asserted production behavior is wrong (the test caught a real defect). | `expected 1 element matching ".submit-btn" but found 0` and `browser_snapshot` confirms `.submit-btn` is missing because a recent commit renamed it; `expected $80 but got $90` and `browser_evaluate(window.computedDiscount)` returns 10% not 20%, matching a production logic regression. |
| **test-bug** | The assertion logic is wrong; the asserted value is correct (test is stale w.r.t. product spec change). | Selector outdated after intentional product rename; magic constant in test hasn't been updated for new pricing; brittle timing-based wait now flakes against an intentionally slower loader animation. |
| **env-flake** | A *specific*, *named*, *transient* environmental signal explains the failure; production code paths are NOT involved. | Upstream auth-service returned HTTP 503 at the assertion moment per `browser_network_requests`; staging seed data missing one row per `failing_assertion` cross-checked against the seed manifest; renderer crash mid-assertion per `browser_console_messages` containing "Renderer process gone". |
| **structural** | The failure is a cross-test signal — every test in the suite will hit the same blocker. | First test fails on `pg_connection_refused` in `beforeAll`; license-server unreachable so every test's `beforeAll(login)` fails; wrong staging URL produces 404 on every navigation. |
| **ambiguous-or-out-of-scope** | Investigation completed but the failure does not disambiguate into the four above, OR the fix is outside the QA's repository / authority. | Race-condition flake with no upstream signal (clean network, empty console); runtime-environment skew where product code is correct in the production locale but the runner ships a different one; cross-repo dependency (backend microservice change needed); spec ambiguity needing a PM decision. |

You MUST articulate which class the failure falls in before committing a verb. The wrong-class commit (e.g., `qa_propose_mark_passed` for a code-bug, or `qa_request_retry` without a code change) is the dominant failure mode of an under-guided agent.

## Step 4 — Commit decisions

Five arms, one per class. The **Stop-and-report contract** below governs all five.

### Stop-and-report contract (applies to all five arms)

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

### Arm 1 — code-bug → `qa-debug:qa_request_retry` after source edit

**Prerequisite:** Edit the production source file fixing the defect. The retry runs against the freshly-edited code. *"Let's try again"* is NOT a code-bug signal — no diff, no retry.

**Rationale shape (`reason` arg):** What was changed, by file, and what behavior is now correct. Example: *"Fixed `src/auth/login.ts` so the JWT decoder accepts the new RS256 signing alg (was hard-coded to HS256); test should now pass because the assertion checks for `decoded.sub` which the decoder now produces."*

**Turn-end:** Per the Stop-and-report contract. The retry runs in a fresh child; the next pause (or pass) arrives as a new chat turn.

**Named-error paths:**

- `NO_ACTIVE_PAUSE` → no Mocha test is currently paused. STOP — do not re-call. Report: *"No pause is active; my code-bug analysis stands — please review the source edit at `<file>:<line>`."*
- `SESSION_NOT_FOUND` → your `session_id` is stale (rare; a fresh pause superseded the one you were investigating). Re-call `qa_get_failure_context` (omit `session_id`) to ground in the current pause, then re-classify.
- `PAUSE_ALREADY_RESOLVED` → another caller (typically the QA via Test Explorer) committed the verb first; your call had no effect. Call `qa_get_failure_context` (omit `session_id`) to confirm idle vs fresh pause, then re-classify if a new pause arrived. Do NOT re-issue the same verb against the stale session_id.

### Arm 2 — test-bug → `qa-debug:qa_request_retry` after test edit

**Prerequisite:** Edit the test spec fixing the stale assertion / selector / constant. Same *no diff, no retry* rule.

**Rationale shape:** What in the test was wrong vs the product spec, by line. Example: *"Updated `fixture-tests/specs/checkout.spec.js:42` selector from `.submit-btn` to `.primary-submit` per the product-side rename in commit 1a2b3c4; the assertion logic is unchanged."*

**Turn-end:** Per the Stop-and-report contract.

**Named-error paths:** Same as Arm 1.

### Arm 3 — env-flake → `qa-debug:qa_propose_mark_passed`

**Rationale shape:** A *falsifiable* signal — concrete timestamp, log line, network response, or service-status reference. The rationale is what the human reads when accepting or rejecting the proposal. Examples:

- *"`browser_network_requests` shows auth-service returned HTTP 503 at 14:03:42.117 mid-login; the same auth-service `/healthz` returned 200 at 14:04:01.039 (one second after the failure) — transient upstream blip, not a product regression."*
- *"Renderer crashed mid-assertion per `browser_console_messages: 'Renderer process (pid 4892) gone'`; the asserted DOM was never reachable. Re-render in a fresh browser session is the right next step (Test Explorer Run)."*

**Anti-rationale — these do NOT justify mark_passed:**

- *"Test seems flaky."* — no concrete signal.
- *"The failure is intermittent."* — `retry_count` is the right place to check intermittency; "intermittent" alone is not falsifiable.
- Any rationale where the asserted value derives from production code paths under test. That is code-bug (Arm 1), not flake.

**Turn-end:** Per the Stop-and-report contract — emit *"Proposed mark-passed pending your review; rationale: <text>."* and end the turn. Do NOT poll `last_proposal_status` in-turn.

**Named-error paths:** Same `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` handling as Arm 1.

### Arm 4 — structural → `qa-debug:qa_propose_abort_suite`

**Rationale shape:** Cite the cross-test signal that explains why continuing the suite is wasted. Example: *"All tests will fail at fixture seed: `pg_connection_refused` on `postgres://localhost:5432/staging`; `browser_network_requests` also shows the auth-service unreachable. Continuing the suite produces N more identical failures with no diagnostic value."*

**Anti-rationale:**

- A single failed assertion in one test → use Arm 5 (`qa_request_give_up`), not abort_suite.
- *"The codebase is broken."* — too vague; cite the specific shared dependency.
- *"Tests are slow."* — orthogonal to suite-abort.

**Turn-end:** Per the Stop-and-report contract — emit *"Proposed abort-suite pending your review; rationale: <text>."* and end the turn.

**Named-error paths:** Same `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` handling as Arm 1. PAUSE_ALREADY_RESOLVED does NOT apply — propose verbs return a success payload with `status: 'awaiting_human'` (no `isError`), so a lost-race is impossible by construction.

### Arm 5 — ambiguous-or-out-of-scope → `qa-debug:qa_request_give_up`

Use when investigation completed but commits in Arms 1–4 are not justified:

- **Ambiguous:** Failure does not disambiguate from a single pause (suspected race condition with no upstream signal; runtime-environment skew; spec ambiguity).
- **Out-of-scope:** Confident diagnosis but you cannot make the fix (cross-repo dependency, PM-decision-needed, file in a different repo).
- **Unrecoverable session:** Browser state unrecoverable AND not env-flake.
- **Retry-exit:** `retry_count >= 2` AND failure is same-shape per "Retry exit conditions" below AND no fundamentally different diagnosis emerged.

**Rationale shape:** *Name the limit* — state what evidence you consulted and where it stopped being decisive. Examples:

- **Ambiguous (race-flake):** *"Race condition suspected: `retry_count=1`, same-shape recurrence, no upstream 5xx, empty console. Product code path under test is `EventBus.subscribe`; cannot disambiguate code-bug from env-flake from a single browser snapshot. Suggest verbose timing log re-run."*
- **Out-of-scope (cross-repo):** *"Asserted value `Promise-pending` indicates production code returns an unresolved promise; fix requires `await` in `src/cart/total.ts:42`. That file lives in a different repo (`api-server`) and cannot be edited from this workspace. Reporting for the backend engineer."*
- **Out-of-scope (spec):** *"Selector `.checkout-cta` doesn't exist in DOM (snapshot confirmed); product spec calls for `.proceed-to-checkout` rename but the new branch is not yet merged. Test will pass once the rename lands in main."*

**NOT for "I don't know":** the rationale must name the limit. *"Investigation inconclusive"* alone is insufficient — list which signals you consulted and which dimensions stayed ambiguous.

**Turn-end:** Per the Stop-and-report contract.

**Named-error paths:** Same as Arm 1.

## Retry exit conditions

`qa_get_failure_context.retry_count` is the number of retries the extension has already performed for this test (via `--grep` respawn). If `retry_count >= 2` AND the failure is **same-shape** as the prior pause, do NOT propose a third retry without a fundamentally different diagnosis. Either re-classify (the failure may be env-flake / structural / ambiguous that masqueraded as code-bug on first investigation), or call `qa_request_give_up` per Arm 5 with rationale citing the recurrence.

**Same-shape definition.** A pause is same-shape as the prior pause iff BOTH:

1. The `failing_assertion` matches at *template* level — compare after masking numeric spans (e.g., `\d+(\.\d+)?`) and quoted-value spans (`"…"`, `'…'`) to placeholders. *Example:* `expected $80 but got $90` and `expected $80 but got $91` are same-shape; `expected $80 but got $90` and `Timeout: page.waitForSelector(".welcome") exceeded 5000ms` are NOT.
2. The **first user-code stack frame** matches — i.e., first frame whose file path does NOT contain `node_modules` and is NOT an internal Node/V8 frame. Line number may drift ±5 (an edit between retries typically moves the assertion line by a few). If line drift exceeds 5, treat as different shape (you likely refactored, not just patched). Skip past chai/wdio/jest-assert library frames; compare on the spec file or other user-code frame.

## Escalation paths

If during investigation you observe signals suggesting multiple tests will fail with the same root cause (e.g., `browser_network_requests` shows auth-service unreachable; `browser_console_messages` shows a global JS error like `Uncaught TypeError: window.app is undefined`), classify as **structural** and call `qa_propose_abort_suite` per Arm 4 — even if only one test has paused so far. Pausing on N more tests with the same root cause produces audit-log noise without diagnostic value.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Pseudo-code or prescriptive script for "how to investigate" the browser. | Step 2 is medium-freedom; multiple investigation paths are valid; over-prescribing causes you to skip the right tool when the failure shape suggests it. |
| Editing `.mocharc.cjs`, the SKILL itself, or extension internals. | The QA owns the specs; the extension owns hook injection. You own diagnosis and source/spec edits. |
| Chat-as-launcher patterns (e.g., "type `@qa-debug run X`"). | Test Explorer is the run surface; chat is conversation / investigation. |
| Mocha CLI flags (`--bail`, `--reporter`, etc.). | The extension constructs the mocha command line; do not advise the QA to change it. |
| Polling `qa_get_failure_context.last_proposal_status` in-turn. | The human commit is event-driven (next chat turn), not clock-driven. See the anti-example in the Stop-and-report contract. |
| Calling `playwright-mcp:browser_close` during investigation. | Destroys the held browser; not recoverable; QA loses the live state they paused to inspect. |
| Re-issuing `qa_request_retry` / `qa_request_give_up` after `PAUSE_ALREADY_RESOLVED` on the same `session_id`. | The verb has already committed (typically by the QA via Test Explorer); re-issuing only churns the audit log. Re-ground via `qa_get_failure_context` (omit `session_id`) and re-classify if a new pause exists. |

## Worked examples

Concrete patterns reusing fixture-tests failures so you have anchors. These are *examples of the shape*, not prescriptive scripts.

| Class | Fixture | Failure shape | Decision tree path |
|---|---|---|---|
| code-bug | `fixture-tests/specs/value-mismatch.spec.js` | `expected "$80.00" but got "$90.00"` | Edit `src/cart/discount.ts` to apply 20% (was 10%); call `qa_request_retry` with diff-citing rationale. |
| test-bug | `fixture-tests/specs/selector.spec.js` | `locator(".submit-btn") resolved to 0 elements` when the product spec rename to `.primary-submit` is intentional | Edit the selector in the spec; call `qa_request_retry` with spec-citing rationale. |
| env-flake | `fixture-tests/specs/timeout.spec.js` with upstream 503 in `browser_network_requests` | `TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms` AND network 503 from `/auth/login` at the assertion moment | Call `qa_propose_mark_passed` with falsifiable rationale citing the 503 timestamp and the `/healthz` 200 a second later. |
| structural | `fixture-tests/_diagnostics/_seed-failure.spec.js` — first test fails on `pg_connection_refused` in `beforeAll` | Same `pg_connection_refused` would fire on every test in the suite | Call `qa_propose_abort_suite` with rationale citing the shared seed dependency. |
| ambiguous-or-out-of-scope | (race-condition flake; no permanent fixture) | `expected event "ready" but timed out 5000ms` AND `browser_network_requests` all 200s AND console empty AND `retry_count = 1` with same-shape prior pause | Call `qa_request_give_up` naming dimensions checked: *"Race condition suspected: no upstream 5xx, no console errors, same-shape recurrence. EventBus.subscribe timing unverifiable from single snapshot. Suggest verbose timing log re-run."* |
