---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a fix in source, propose marked-passed (env flake), or commit give-up. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held for investigation" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, requesting give-up, mark-passed, or describing what they changed). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

# QA Debug Companion — debugging a paused failure

A Mocha test is currently paused at a failure. The browser that ran the test is held alive at a Chrome DevTools endpoint so you can inspect the live DOM, console, network, and asserted values via the playwright-mcp `browser_*` tools. After investigation, either propose a source/spec fix (for code-bug / test-bug) and let the user re-run via Test Explorer ▶, or commit one of the three terminal verbs: `qa_propose_mark_passed`, `qa_propose_abort_suite`, `qa_request_give_up`.

There is no `qa_request_retry`. Re-running after a fix is the user's action via Test Explorer ▶ Run; the pause + MCP gate stay attached up to that point so the user can use the playwright-mcp `browser_*` tools freely to verify or extend their investigation before re-running.

## Workflow checklist (copy into your reply and tick as you go)

- [ ] Step 0: Ask the user once — full investigation or a specific angle?
- [ ] Step 1: Ground via `qa-debug_qa_get_failure_context` (concise)
- [ ] Step 1b: Select a chrome (auto / `qa-debug_qa_select_chrome` / `qa-debug_qa_discover_chromes`) so `cdp_ws_url` becomes non-null
- [ ] Step 1c: If the selected chrome's `tab_count > 1` (Electron / OpenFin), switch to the page under test via `browser_tabs` **before** investigating
- [ ] Step 2: Investigate via the playwright-mcp `browser_*` tools against the held browser — **do not shortcut by reading page source**
- [ ] Step 3: Classify failure (one of: **code-bug** / **test-bug** / **env-flake** / **structural** / **ambiguous-or-out-of-scope**)
- [ ] Step 4: Closing turn per Step-3 classification — Arms 1/2: propose diff + ASK "anything else?"; Arms 3/4/5: two-stage (Stage 1 propose-and-ask, Stage 2 commit-and-end)
- [ ] Step 5: Report decision and rationale in chat (one-line conclusion); end turn only when the user signals done or you've completed the Stage 2 commit

## Step 0 — Check with the user first

Before launching into Step-2 investigation, ask the user one short question:

> *"Want me to investigate end-to-end, or is there a specific angle you'd like me to look at first (a suspect file / hypothesis / 'just check network' / 'just look at the DOM')?"*

Wait for their reply. If they say *"go ahead"* / *"full investigation"* / they don't push back → proceed with the full Step 1 → Step 2 flow. If they name a specific angle → scope Step 2 to that angle first; widen only if it stays inconclusive.

**Skip Step 0** when the user's opening turn already includes an explicit direction (*"the auth call is failing"*, *"check the cart total"*, *"just give up — env is broken"*). The direction IS the answer to Step 0; proceed straight to Step 1.

**Skip Step 0** when the session is in autopilot / auto-approve mode (user explicitly said *"go on your own"* or you can tell from prior turns they've been ok'ing your moves without comment all session).

## Default mode — propose, ask before state change

Default: propose; do not apply edits or run state-changing tools without the user's explicit go-ahead. This covers:

- File edits (source or spec).
- Any state-changing playwright-mcp tool — anything that clicks, fills, navigates, presses keys, or otherwise mutates the held browser's state.
- Any `qa-debug_qa_*` verb that mutates pause state.

Surface the proposed change in chat with concrete file:line / tool-call shape, then wait. **Exception — autopilot:** if the session is already in autopilot / auto-approve mode (user said *"go on your own"*, or prior turns show they've been ok'ing moves without comment), you may proceed without asking. When in doubt, ask.

**Read-only investigation never needs the ask gate** — reading DOM (`browser_snapshot`), evaluating a specific in-page expression (`browser_evaluate(<expr>)`), and taking screenshots are free moves during a pause. **Exception:** bulk network and console reads (`browser_network_requests`, `browser_console_messages`) are read-only but **on-demand in beta** — see the network+console-on-demand rule in Step 2.

## Step 1 — Ground in the failure

Call `qa-debug_qa_get_failure_context` with `response_format: "concise"` to ground. The returned `failing_assertion`, `stack_trace.frames` (first 10), `available_chromes`, `selected_cdp_port`, `cdp_ws_url`, `retry_count`, and `last_proposal_status` are ground truth; the user's natural-language description may be incomplete or speculative. Do not skip this step — without it the investigation has no anchor.

## Step 1b — Land on a dialable browser

`cdp_ws_url` is **derived after a chrome selection commits** — it may be `null` on the first call. Branch on `selected_cdp_port` + `available_chromes`:

- `selected_cdp_port` non-null AND `cdp_ws_url` non-null → selection already committed (auto-select or prior pick); proceed to Step 2.
- `selected_cdp_port` null AND `available_chromes.length === 1` → call `qa-debug_qa_select_chrome(session_id, port=available_chromes[0].port)` — no user confirmation needed.
- `selected_cdp_port` null AND `available_chromes.length >= 2` → STOP, ask the user which chrome to use (surface `page_titles` per option, e.g., *"Port 22135 (Login) or 22136 (Dashboard)?"*), then call `qa-debug_qa_select_chrome` with their pick.
- `selected_cdp_port` null AND `available_chromes.length === 0` → STOP, ask: *"I couldn't find Chrome at the default debug ports. What port(s) does your framework launch Chrome on?"* Call `qa-debug_qa_discover_chromes(session_id, [user-ports])`, then loop back into this branching.

Until selection commits, playwright-mcp is NOT registered, so its `browser_*` tools have no target — selecting a chrome is what registers and points it at the held browser.

If a later playwright-mcp call returns "target closed" mid-investigation, the selected chrome died. Re-call `qa-debug_qa_discover_chromes` (re-ask the user for ports if needed) and re-select.

## Step 1c — Orient on the runtime, land on the right tab

One CDP endpoint can expose a different number of pages depending on what's running:

- **Chrome (web app)** — usually a single page. Nothing to pick; go straight to Step 2.
- **Refinitiv Workspace (Electron) / OpenFin** — desktop runtimes that surface **many** pages (app windows, webviews, hidden views) at the *same* endpoint. playwright-mcp does **not** define which one it attaches to, so a blind `browser_snapshot` may inspect the wrong window and yield a confident-but-wrong diagnosis.

Read the **selected** chrome's `tab_count` and `runtime` from `available_chromes` (the entry whose `port === selected_cdp_port`):

- `tab_count <= 1` → single page; proceed to Step 2 directly. No tab dance, no friction.
- `tab_count > 1` → **orient before investigating**:
  1. Call `browser_tabs` with `action: "list"` to get the authoritative tab list **and indices**. Get the index from this live call — do not trust the order of `page_titles`.
  2. Identify the page under test by matching the failing test (its file / expected URL / title) against the listed tabs.
     - Exactly one plausible match → select it.
     - Several plausible matches, or none obvious → **ask the user once** which tab is the one under test, surfacing the `runtime` + the tab titles: *"This looks like an Electron app with 4 windows open — which is the one under test: 'Login' / 'Dashboard' / 'Settings' / 'DevTools'?"*. Then proceed with their pick.
  3. Call `browser_tabs` with `action: "select", index: <N>` to switch to it.
  4. Only now proceed to Step 2 (`browser_snapshot`).

`runtime` (`chrome` / `electron` / `openfin` / `unknown`) is a **best-effort hint** — a desktop app can override its User-Agent and report `chrome`/`unknown`, so do **not** gate on it. **`tab_count > 1` is the trigger.** When `runtime` is `electron`/`openfin`, name it to the user for context.

## Step 2 — Investigate the held browser

**GROUND TRUTH IS THE LIVE BROWSER, NOT THE SOURCE FILES.** The browser at `cdp_ws_url` is the exact Chrome window the test was driving when it failed — post-JS DOM, computed styles, in-flight network responses, console errors, framework state, async timers, dynamically-injected nodes. **Do NOT shortcut by reading the page's `.html` / `.js` / `.css` source to guess what's on screen.** Source can be stale, conditionally rendered, overridden at runtime, or injected by a framework that doesn't appear in the file. Inspect the live browser first (`browser_snapshot`); read source only to corroborate something you already observed live.

**playwright-mcp is available in your registry.** Find its child tools by the **`browser_*` suffix** — the server may show up under various prefixes depending on host (Copilot Chat normalizes to `mcp_<server>_browser_*`; a vendor-namespaced registration like `com.microsoft/playwright-mcp/browser_*` is also valid; Claude-Code-style hosts use `mcp__<server>__browser_*`). Don't match on prefix; match on the `browser_` suffix. There is no connect/attach tool — the extension already pointed playwright-mcp at the held browser when the chrome was selected; just call `browser_snapshot` to inspect it, then use the rest of the playwright-mcp surface — DOM, in-page JS, network, screenshots, plus interactive tools when read-only can't disambiguate. Investigation order is up to you (degrees of freedom: medium). Prefer read-only moves first; reach for interactive tools only when read-only can't answer.

**Network + console on-demand (beta).** Tools that bulk-read network or console output (`browser_network_requests`, `browser_console_messages`, and `browser_evaluate(console.*)`-style log scrapes) are **off by default in beta** — they emit noisy framework / source-map / hot-reload / HMR / dev-telemetry chatter that drowns the diagnostic signal. Call them only when one of these is true:

- The **user explicitly asks** (*"show the console"*, *"any console errors?"*, *"check the network"*, *"any failed requests?"*).
- **You asked first and they said yes** — e.g., during env-flake suspicion you ask *"Want me to pull network requests to check for an upstream issue?"* and the user confirms.

**Default read-only investigation** (no ask gate, no opt-in needed):

- `browser_snapshot` — DOM / accessibility tree.
- `browser_evaluate` against a **specific expression** (`window.__lastError`, `window.__lastFetch?.status`, framework state, a computed value). Targeted reads of named state are free; bulk scrapes of `console.*` are not.
- `browser_take_screenshot` — visual ground truth.

For runtime-state queries that don't need the bulk network or console feed, prefer the targeted `browser_evaluate` route instead.

**Do NOT call `browser_close` or `browser_navigate`** — both destroy the post-failure state the pause is preserving (`browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test). Both are not recoverable.

**Browser lifecycle.** The Chrome process is owned by the test framework. qa-debug does not provide a "close browser" verb. The framework's own teardown (e.g., `browser.deleteSession()` for wdio) disposes the session when the suite finishes; an out-of-band crash is handled by re-running the suite.

## Step 3 — Classify the failure

Five mutually-exclusive classes. Pick the one that best fits what Step 2 surfaced. The fifth ("ambiguous-or-out-of-scope") is a first-class branch — *naming the limit* is better than forcing a four-way bucket when the evidence does not disambiguate.

| Class | Signal pattern | Examples |
|---|---|---|
| **code-bug** | The asserted production behavior is wrong (the test caught a real defect). | `expected 1 element matching ".submit-btn" but found 0` and `browser_snapshot` confirms `.submit-btn` is missing because a recent commit renamed it; `expected $80 but got $90` and `browser_evaluate(window.computedDiscount)` returns 10% not 20%, matching a production logic regression. |
| **test-bug** | The assertion logic is wrong; the asserted value is correct (test is stale w.r.t. product spec change). | Selector outdated after intentional product rename; magic constant in test hasn't been updated for new pricing; brittle timing-based wait now flakes against an intentionally slower loader animation. |
| **env-flake** | A *specific*, *named*, *transient* environmental signal explains the failure; production code paths are NOT involved. | Upstream auth-service returned HTTP 503 at the assertion moment per `browser_network_requests`; staging seed data missing one row per `failing_assertion` cross-checked against the seed manifest; `browser_evaluate(window.__lastFetch?.status)` returns 503 mid-assertion, matching a transient upstream blip. |
| **structural** | The failure is a cross-test signal — every test in the suite will hit the same blocker. | First test fails on `pg_connection_refused` in `beforeAll`; license-server unreachable so every test's `beforeAll(login)` fails; wrong staging URL produces 404 on every navigation. |
| **ambiguous-or-out-of-scope** | Investigation completed but the failure does not disambiguate into the four above, OR the fix is outside the QA's repository / authority. | Race-condition flake with no upstream signal (clean network, empty console); runtime-environment skew where product code is correct in the production locale but the runner ships a different one; cross-repo dependency (backend microservice change needed); spec ambiguity needing a PM decision. |

You MUST articulate which class the failure falls in before deciding the closing turn. The wrong-class commit (e.g., `qa_propose_mark_passed` for a code-bug) is the dominant failure mode of an under-guided agent.

## Step 4 — Closing turn

Five arms, one per class. Arms 1 and 2 do NOT commit a verb autonomously — you propose the fix, **ask "anything else?"**, then hand back to the user, who re-runs via Test Explorer ▶ when ready. Arms 3, 4, 5 each commit one of `qa_propose_mark_passed`, `qa_propose_abort_suite`, `qa_request_give_up` — but only after the **two-stage commit** in the Stop-and-report contract (propose + ask first, commit + end-turn second).

### Stop-and-report contract (applies to Arms 3–5)

**Two-stage commit.** Arms 3, 4, 5 verbs mutate pause state, so under Default mode they need the ask gate. The full shape is:

1. **Stage 1 — Propose-then-ask** (no tool call yet). Surface your classification and proposed verb in chat: *"I'm leaning toward Arm 3 / mark-passed because [rationale]. Before I commit, anything else you'd like me to investigate or add? (Sibling specs? Pull network/console if you haven't? A different angle?)"* WAIT for the user.
2. **Stage 2 — Commit verb + report** (one tool call, then end turn). Once the user confirms with *"go ahead"* / *"commit it"* / silence-but-not-pivot, call the verb exactly once and emit ONE concluding chat line. No further tool calls this turn.

The verb call IS the checkpoint — *"Agents can then pause for human feedback at checkpoints or when encountering blockers."* The new Stage 1 ask adds a second checkpoint *before* the verb, so the user can extend investigation instead of being railroaded into a give-up / mark-passed they didn't want.

**Autopilot exception.** If the session is in autopilot / auto-approve mode (per Default-mode section), Stage 1 collapses into Stage 2 — propose and commit in the same turn. Use sparingly; even on autopilot, Arm 5 (`qa_request_give_up`) benefits from a one-line check-in.

Behavior at Stage 2:

- After the verb call, emit ONE concluding chat line summarizing your decision and rationale. No further tool calls this turn.
- The next turn begins when a new chat message arrives. The human commit is **event-driven, not clock-driven** — do not poll.
- If the human REJECTS a proposal at Stage 1 (says *"no, check X first"*), pivot to what they asked for; do not commit. If they REJECT at Stage 2 (after the verb went out), treat rejection as new ground truth: re-classify per Step 3 — the rejection often points at a class you missed. Do not re-call the same verb.

**Anti-example — do NOT do this (skipping Stage 1):**

```
turn N: qa_propose_mark_passed(...)        ← WRONG: committed without asking the user first
turn N: <chat: "Proposed mark-passed.">
```

**Anti-example — do NOT do this (in-turn polling):**

```
turn N: qa_propose_mark_passed(...)
turn N: qa_get_failure_context(...)        ← WRONG: polling for the commit on the same turn
turn N: <check last_proposal_status>
turn N: qa_get_failure_context(...)        ← tight-polling
```

**Correct shape (two-stage):**

```
turn N:   <chat: "Leaning mark-passed because <rationale>. Before I commit, anything else to investigate or pull?">
turn N+1: <user: "go ahead">
turn N+1: qa_propose_mark_passed(...)
turn N+1: <chat: "Proposed mark-passed; rationale: ... Click Approve or Reject in Test Explorer.">
turn N+2: <new human turn arrives; investigate that turn>
```

### Arms 1 & 2 — code-bug / test-bug → propose a source or spec fix, then hand back

The pause stays attached while the user reviews your proposed fix. Do NOT call any `qa_request_*` or `qa_propose_*` verb — there is no retry verb to commit, and committing `give_up` would prematurely mark the test failed when the user is about to re-run with the fix applied.

**Closing turn shape.** Surface, in one concise message:

1. Where the fix should be applied (file + line) and what it should change — concrete enough that the user can paste it. For code-bug, this is a production source file; for test-bug, the spec.
2. An explicit **"anything else?" ask** — do **not** just hand back passively: *"Anything else you'd like me to investigate, add to the fix, or check before you re-run? (e.g., verify the fix against the live browser, check a sibling spec for the same bug, add a defensive guard, pull network or console if you want them)."* The pause stays attached and playwright-mcp is still hot — the user often has follow-up steps; let them voice those before you end the turn.
3. The three exits available to them once they're satisfied:
   - **▶ Run** on the test row in Test Explorer once the source is edited (re-runs against the new code; a fresh pause arrives if it still fails).
   - **✓ Mark Passed** if your investigation revealed the assertion was wrong rather than the code (Arm 3 territory).
   - **✕ Give Up** to abandon this attempt without re-running.

Do NOT autonomously click any of these for the user. The runner has no agent-callable "re-run" verb by design.

**Loop-open rule.** End the turn *only* when the user explicitly signals they're done (*"looks good, going to re-run"*, *"that's it, thanks"*) or pivots to a different concern. Until then, keep the loop open and iterate on what they ask for — additional investigation, a defensive addition to the fix, a sibling check, pulling network/console (now they've opted in). Arms 1 & 2 are an iteration loop, not a one-shot proposal.

**Rationale style.** Cite concrete evidence from Step 2 (a `browser_evaluate` return value, a `browser_snapshot` finding, a `browser_network_requests` row). *"Let's try again"* without a diff is not a code-bug signal.

**Selector identification.** If the proposed fix is a selector change (test-bug Arm 2 territory, or code-bug Arm 1 where you need to confirm which DOM node the failure refers to) and the right element isn't obvious from `browser_snapshot` alone, **invoke the `identify-element` skill before writing the diff**. The picker has the QA click the target in the held browser and returns structured DOM attributes for you to build a project-matched locator. Do not guess selectors when you can ask the QA visually.

**Named-error paths (apply to any tool call you do make, e.g., `qa_get_failure_context`):**

- `NO_ACTIVE_PAUSE` → no Mocha test is currently paused. STOP — do not re-call. Report: *"No pause is active; my analysis stands — please review the source edit at `<file>:<line>`."*
- `SESSION_NOT_FOUND` → your `session_id` is stale (rare; a fresh pause superseded the one you were investigating). Re-call `qa_get_failure_context` (omit `session_id`) to ground in the current pause, then re-classify.

### Arm 3 — env-flake → `qa-debug_qa_propose_mark_passed`

**Rationale shape:** A *falsifiable* signal — concrete timestamp, log line, network response, or service-status reference. The rationale is what the human reads when accepting or rejecting the proposal. Note: env-flake usually hinges on network or console evidence, both of which are **on-demand in beta** — if you suspect env-flake, ASK the user *"Want me to pull network requests to check for an upstream issue?"* first, then build the rationale on what you find. Examples:

- *"`browser_network_requests` (user-confirmed pull) shows auth-service returned HTTP 503 at 14:03:42.117 mid-login; the same auth-service `/healthz` returned 200 at 14:04:01.039 (one second after the failure) — transient upstream blip, not a product regression."*
- *"`browser_evaluate(window.__lastFetch)` returns `{ url: '/api/cart', status: 503, ts: 14:03:42 }` (free read — targeted expression); `browser_network_requests` (user-confirmed) corroborates the 503 burst was bounded to a 1.2s window and recovered. Transient upstream, not product."*

**Anti-rationale — these do NOT justify mark_passed:**

- *"Test seems flaky."* — no concrete signal.
- *"The failure is intermittent."* — `retry_count` is the right place to check intermittency; "intermittent" alone is not falsifiable.
- Any rationale where the asserted value derives from production code paths under test. That is code-bug (Arm 1), not flake.

**Turn-end (two-stage per Stop-and-report contract):** Stage 1 — surface the classification and ask *"I'm leaning mark-passed because [rationale]. Before I commit, anything else to investigate or pull (network/console, sibling spec)?"* Wait. Stage 2 — once user confirms, call `qa-debug_qa_propose_mark_passed`, emit *"Proposed mark-passed pending your review; rationale: <text>."* and end the turn. Do NOT poll `last_proposal_status` in-turn.

**Named-error paths:** Same `NO_ACTIVE_PAUSE` / `SESSION_NOT_FOUND` handling as Arm 1.

### Arm 4 — structural → `qa-debug_qa_propose_abort_suite`

**Rationale shape:** Cite the cross-test signal that explains why continuing the suite is wasted. Note: network reads are on-demand (Step 2 rule) — ASK before pulling if the structural signal lives in the network log. Example: *"All tests will fail at fixture seed: `pg_connection_refused` on `postgres://localhost:5432/staging`; `browser_network_requests` (user-confirmed pull) also shows the auth-service unreachable. Continuing the suite produces N more identical failures with no diagnostic value."*

**Anti-rationale:**

- A single failed assertion in one test → use Arm 5 (`qa_request_give_up`), not abort_suite.
- *"The codebase is broken."* — too vague; cite the specific shared dependency.
- *"Tests are slow."* — orthogonal to suite-abort.

**Turn-end (two-stage per Stop-and-report contract):** Stage 1 — surface the structural diagnosis and ask *"I'm leaning abort-suite because [rationale]. Before I commit, anything else to confirm — try a second test to verify the shared blocker, or pull network to nail down the dependency?"* Wait. Stage 2 — once user confirms, call `qa-debug_qa_propose_abort_suite`, emit *"Proposed abort-suite pending your review; rationale: <text>."* and end the turn.

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

**Do not jump to give-up.** Arm 5 is the **last** thing you reach for, not the first. Before considering give-up, you must have at least: (1) grounded via `qa-debug_qa_get_failure_context`, (2) attached to the held browser, (3) read DOM + at least one targeted `browser_evaluate`, AND (4) asked the user whether they want network or console pulled (per Step 2 on-demand rule — give-up rationale often hinges on the negative result of those reads). The user often has follow-up steps you haven't considered; let them voice those first.

**Turn-end (two-stage per Stop-and-report contract):** Stage 1 — surface the named-limit rationale and ask *"I've checked [signals]; before I commit give-up, anything else you'd like me to investigate, or want me to pull network/console first?"* Wait. Stage 2 — once user confirms, call `qa-debug_qa_request_give_up`, emit *"Give-up committed; rationale: <text>."* and end the turn.

**Named-error paths:** Same as Arms 1 & 2.

## Escalation paths

If during investigation you observe signals suggesting multiple tests will fail with the same root cause (e.g., `browser_evaluate(window.app)` returns `undefined` indicating the framework never bootstrapped; or after the user opts you into a network pull, `browser_network_requests` shows auth-service unreachable on every request), classify as **structural** and route through Arm 4 — even if only one test has paused so far. Pausing on N more tests with the same root cause produces audit-log noise without diagnostic value. (Per Default-mode and the new "anything else?" ask, propose Arm 4 to the user before committing `qa_propose_abort_suite`.)

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| **Reading the page's `.html` / `.js` / `.css` source to guess what's on screen instead of inspecting the live browser with `browser_snapshot` / `browser_evaluate`.** | Source files are static; the live browser holds the post-JS DOM, computed styles, in-flight network responses, console errors, and dynamically-injected nodes. Source-reading silently gives the wrong answer when the failure is caused by runtime state — exactly the case that paused the test in the first place. Inspect the live browser first; read source only to corroborate. |
| Calling `browser_*` tools before Step 1b (chrome selection) commits. | playwright-mcp is not registered until selection commits, so its tools have no target. Walk the Step-1b branching first; once it commits, the browser is auto-attached. |
| Calling `browser_snapshot` on a multi-tab runtime (`tab_count > 1`, Electron / OpenFin) without selecting the page under test first. | playwright-mcp attaches to an arbitrary page when the endpoint exposes many; snapshotting blind inspects the wrong window and produces a confident-but-wrong diagnosis. Run Step 1c: `browser_tabs(action:"list")` → match or ask → `browser_tabs(action:"select", index)`. |
| Guessing a port for `qa-debug_qa_discover_chromes` instead of asking the user. | The port list is consumer-framework-specific (often locked, often non-default); guessing wastes a probe and ships a wrong answer if the guess succeeds against an unrelated chrome. |
| Pseudo-code or prescriptive script for "how to investigate" the browser. | Step 2 is medium-freedom; multiple investigation paths are valid; over-prescribing causes you to skip the right tool when the failure shape suggests it. |
| Editing `.mocharc.cjs`, the SKILL itself, or extension internals. | The QA owns the specs; the extension owns hook injection. You own diagnosis and source/spec edits. |
| Chat-as-launcher patterns (e.g., "type `@qa-debug run X`"). | Test Explorer is the run surface; chat is conversation / investigation. |
| Mocha CLI flags (`--bail`, `--reporter`, etc.). | The extension constructs the mocha command line; do not advise the QA to change it. |
| Polling `qa_get_failure_context.last_proposal_status` in-turn. | The human commit is event-driven (next chat turn), not clock-driven. See the anti-example in the Stop-and-report contract. |
| Calling the playwright-mcp `browser_close` or `browser_navigate` tool during investigation. | Both destroy the post-failure state the pause is preserving — `browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test. Neither is recoverable; QA loses the live state they paused to inspect. |
| Autonomously committing `qa_request_give_up` after proposing a code-bug or test-bug fix. | The user is about to re-run via ▶ Run in Test Explorer; `give_up` marks the test as a final failure and closes the MCP gate. Arms 1 & 2 hand back to the user without committing. |
| Re-issuing `qa_request_give_up` after `PAUSE_ALREADY_RESOLVED` on the same `session_id`. | The verb has already committed (typically by the QA via Test Explorer); re-issuing only churns the audit log. Re-ground via `qa_get_failure_context` (omit `session_id`) and re-classify if a new pause exists. |
| Applying file edits or running state-changing browser tools without surfacing the change to the user first. | Default mode is propose-first; the QA needs to see the diff / step shape before it lands. Skip the ask gate only when the session is explicitly in autopilot / auto-approve mode. |
| Calling `qa_request_give_up` (or `qa_propose_mark_passed` / `qa_propose_abort_suite`) without first asking the user if there's any other angle to investigate. | Arms 3–5 verbs are end-of-loop commits. The user often has follow-up steps (sibling specs to check, defensive additions, alternative hypotheses, network/console pulls they want to opt into). The Stop-and-report contract requires a two-stage commit: propose-then-ask, then commit-and-end-turn. Skipping Stage 1 railroads the user out of the loop. |
| Ending an Arm 1 / Arm 2 turn after the diff with only a passive "let me know if you need anything else." | The Closing turn shape requires an *explicit* "anything else to investigate, add to the fix, or check before you re-run?" ask. Passive offers get ignored; explicit asks keep the loop open and surface the follow-up steps QAs reliably have. |
| Bulk-pulling network (`browser_network_requests`) or console (`browser_console_messages`) on first investigation without the user opting in. | Step 2 network+console-on-demand rule: beta env emits noisy framework / HMR / dev-telemetry chatter that drowns the diagnostic signal. Either the user asks for the pull, or you ask them and they confirm — then pull. Targeted `browser_evaluate(<expr>)` against specific runtime state is the free alternative. |

## Worked examples

Concrete patterns reusing fixture-tests failures so you have anchors. These are *examples of the shape*, not prescriptive scripts.

| Class | Fixture | Failure shape | Closing turn |
|---|---|---|---|
| code-bug | `fixture-tests/specs/value-mismatch.spec.js` | `expected "$80.00" but got "$90.00"` | Identify the diff (`src/cart/discount.ts` applies 10% not 20%); propose the edit; offer to verify against the live browser before re-run; surface the three exits (▶ Run / ✓ Mark Passed / ✕ Give Up). Do NOT commit a verb. |
| test-bug | `fixture-tests/specs/selector.spec.js` | `locator(".submit-btn") resolved to 0 elements` when the product spec rename to `.primary-submit` is intentional | Propose the spec-side selector edit; offer further checks; surface the three exits. Do NOT commit a verb. |
| env-flake | `fixture-tests/specs/timeout.spec.js` with upstream 503 in `browser_network_requests` | `TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms` AND network 503 from `/auth/login` at the assertion moment | Call `qa_propose_mark_passed` with falsifiable rationale citing the 503 timestamp and the `/healthz` 200 a second later. |
| structural | `fixture-tests/_diagnostics/_seed-failure.spec.js` — first test fails on `pg_connection_refused` in `beforeAll` | Same `pg_connection_refused` would fire on every test in the suite | Call `qa_propose_abort_suite` with rationale citing the shared seed dependency. |
| ambiguous-or-out-of-scope | (race-condition flake; no permanent fixture) | `expected event "ready" but timed out 5000ms` AND `browser_network_requests` all 200s AND console empty | Call `qa_request_give_up` naming dimensions checked: *"Race condition suspected: no upstream 5xx, no console errors. EventBus.subscribe timing unverifiable from single snapshot. Suggest verbose timing log re-run."* |
