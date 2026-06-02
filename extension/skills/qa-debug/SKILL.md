---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a source/spec fix in chat. A pause is a pure inspection hold (a breakpoint) — there is no pass/fail verdict to commit; the QA re-runs from Test Explorer ▶ after applying a fix, or ends the run with Stop. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held for investigation" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, or describing what they changed). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

# QA Debug Companion — investigating a paused failure

A Mocha test is currently paused at a failure. The browser that ran the test is held alive at a Chrome DevTools endpoint so you can inspect the live DOM, console, network, and asserted values via the playwright-mcp `browser_*` tools.

**A pause is a pure inspection hold — like a breakpoint.** There is no pass/fail verdict to commit and no decision verb to call. Your job is to investigate the live browser and propose a source or spec fix in chat. The QA then re-runs the test via Test Explorer ▶ Run (a fresh pause arrives if it still fails), or ends the whole run with Stop. The test stands at its natural Mocha outcome — you never override it.

There is no retry verb, no mark-passed verb, no give-up verb. Re-running after a fix is the user's action via Test Explorer ▶ Run; the pause + MCP gate stay attached up to that point so the user can keep using the playwright-mcp `browser_*` tools to verify or extend the investigation before re-running.

## Workflow checklist (copy into your reply and tick as you go)

- [ ] Step 0: Ask one either/or — **A** "find the root cause for me" or **B** "I'll tell you the fix, you apply it" — then branch
- [ ] Step 1: Ground via `qa-debug_qa_get_failure_context` (concise)
- [ ] Step 1b: Select a chrome (auto / `qa-debug_qa_select_chrome` / `qa-debug_qa_discover_chromes`) so `cdp_ws_url` becomes non-null
- [ ] Step 1c: If the selected chrome's `tab_count > 1` (Electron / OpenFin), switch to the page under test via `browser_tabs` **before** investigating
- [ ] Step 1d: Verify `browser_*` tools are visible; if none appear, STOP and ask the user to install/enable playwright-mcp
- [ ] Step 2: Investigate via the playwright-mcp `browser_*` tools against the held browser — **do not shortcut by reading page source**
- [ ] Step 3: Diagnose + propose a fix in chat (file:line + the change), then ASK "anything else before you re-run?"; keep the loop open until the user signals done

## Step 0 — Ask one question, then branch

Open with one short either/or question — present it as an interactive choice popup with exactly two **selectable** options the user clicks (a two-button / quick-pick popup is good here — use it). Just don't ask an open-ended, free-text *"how would you like me to proceed? / enter your answer"* question — that's the wrong shape; the answer is always one of these two:

> **Option A — "Find the root cause for me":** *you're not sure why it failed — I'll investigate the held browser end-to-end, diagnose the cause, and come back with a proposed fix for you to approve.*
>
> **Option B — "I'll tell you the fix, you apply it":** *you already know the cause — describe what's wrong and the exact change you want, and I'll apply exactly that. No investigation, and I will not guess my own fix or touch anything you didn't ask for.*

Then branch:

- **A** (or a vague *"go ahead"* / *"you find it"*) → run the full Step 1 → Step 2 investigation, then **propose** a fix per Step 3 (don't apply it unless autopilot).
- **B** → skip the browser investigation. Your **first** move is to ask the user to state the root cause and the exact change they want — do **not** infer a fix, edit any file, or investigate until they have described it. Once they describe it, apply **exactly** that change (ground via Step 1 only if you need the file/line). Their description *is* the instruction, so you don't need a separate propose-and-wait round for the change they dictated — but never apply a fix they did not describe.

Skip the ask only when the user's **own words** decide it (they described the root cause → treat as **B**; they explicitly told you to just go investigate → treat as **A**), or in autopilot / auto-approve mode (default to **A**). The prefilled launch message (*"A Mocha test just paused…"*) is the session entry point, **not** a user decision — do **not** read it as "asked you to investigate." On the first turn of a pause, run the Step 0 ask unless one of those genuine conditions holds.

## Step 1 — Ground in the failure

Call `qa-debug_qa_get_failure_context` with `response_format: "concise"` to ground. The returned `failing_assertion`, `stack_trace.frames` (first 10), `available_chromes`, `selected_cdp_port`, `cdp_ws_url`, and `retry_count` are ground truth; the user's natural-language description may be incomplete or speculative. Do not skip this step — without it the investigation has no anchor.

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

**Verify playwright-mcp is visible before you investigate.** Once the chrome selection has committed (Step 1b), confirm at least one `browser_*` tool actually appears in your tool registry. If **no** `browser_*` tool is present, playwright-mcp is not running — do **not** silently fall back to reading source. Stop and tell the user:

> *"I can't see the playwright-mcp browser tools, so I can't inspect the live browser. The extension launches playwright-mcp via `npx @playwright/mcp@latest`; please make sure MCP support is enabled in this editor and the playwright-mcp server is installed/trusted/started, then ask me to retry."*

Wait until they confirm it's available before continuing.

**playwright-mcp is available in your registry.** Find its child tools by the **`browser_*` suffix** — the server may show up under various prefixes depending on host (Copilot Chat normalizes to `mcp_<server>_browser_*`; a vendor-namespaced registration like `com.microsoft/playwright-mcp/browser_*` is also valid; Claude-Code-style hosts use `mcp__<server>__browser_*`). Don't match on prefix; match on the `browser_` suffix. There is no connect/attach tool — the extension already pointed playwright-mcp at the held browser when the chrome was selected; just call `browser_snapshot` to inspect it, then use the rest of the playwright-mcp surface — DOM, in-page JS, network, screenshots, plus interactive tools when read-only can't disambiguate. Investigation order is up to you (degrees of freedom: medium). Prefer read-only moves first; reach for interactive tools only when read-only can't answer.

**Network + console on-demand (beta).** Tools that bulk-read network or console output (`browser_network_requests`, `browser_console_messages`, and `browser_evaluate(console.*)`-style log scrapes) are **off by default in beta** — they emit noisy framework / source-map / hot-reload / HMR / dev-telemetry chatter that drowns the diagnostic signal. Call them only when one of these is true:

- The **user explicitly asks** (*"show the console"*, *"any console errors?"*, *"check the network"*, *"any failed requests?"*).
- **You asked first and they said yes** — e.g., during a suspected upstream issue you ask *"Want me to pull network requests to check for an upstream error?"* and the user confirms.

**Default read-only investigation** (no ask gate, no opt-in needed):

- `browser_snapshot` — DOM / accessibility tree.
- `browser_evaluate` against a **specific expression** (`window.__lastError`, `window.__lastFetch?.status`, framework state, a computed value). Targeted reads of named state are free; bulk scrapes of `console.*` are not.
- `browser_take_screenshot` — visual ground truth.

For runtime-state queries that don't need the bulk network or console feed, prefer the targeted `browser_evaluate` route instead.

**Do NOT call `browser_close` or `browser_navigate`** — both destroy the post-failure state the pause is preserving (`browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test). Both are not recoverable.

**Browser lifecycle.** The Chrome process is owned by the test framework. The framework's own teardown (e.g., `browser.deleteSession()` for wdio) disposes the session when the suite finishes; an out-of-band crash is handled by re-running the suite.

## Step 3 — Diagnose and propose a fix, then hand back

There is no verdict to commit and no decision tree to walk — a pause is just a held breakpoint for you to investigate. Once Step 2 surfaces the cause, do this:

1. **State a one-line conclusion first, then the evidence.** Cite concrete findings from Step 2 (a `browser_evaluate` return value, a `browser_snapshot` observation, a network row the user opted into). *"Let's try again"* without a diagnosis is not a conclusion.
2. **Propose the fix in chat** — file + line and the concrete change, enough that the user can paste it. For a product defect that's a source file; for a stale assertion that's the spec. **Surface it; don't apply it** unless the session is in autopilot / auto-approve mode (then you may edit and say so). *(This propose-first gate covers a fix **you** diagnosed in path A. A change the user explicitly dictated under Step 0 Option B is their instruction — apply exactly that, no separate approval round.)*
   - **Selector fixes:** if the fix is a selector change and the right DOM node isn't obvious from `browser_snapshot` alone, **invoke the `identify-element` skill before writing the diff** — the picker has the QA click the target in the held browser and returns structured DOM attributes to build a project-matched locator. Don't guess selectors when you can ask the QA visually.
3. **Ask explicitly: "anything else before you re-run?"** — *"Anything else you'd like me to investigate, add to the fix, or check first (pull network/console if you want them, check a sibling spec, add a defensive guard)?"* Do **not** end the turn after the diff; the user often has follow-up steps. Keep the loop open and iterate on what they ask for.
4. **End the turn** only when the user signals they're done (*"looks good, going to re-run"*, *"that's it, thanks"*) or pivots to a different concern.

**If you cannot make the fix** (cross-repo dependency, PM-decision-needed, a backend change in another service): say so plainly — name the limit, name what you verified, and point the user at who can act on it. There is no give-up verb to call; you just report and hand back.

**How the pause ends.** The user re-runs the failed row in Test Explorer ▶ once they've applied a fix (a fresh pause arrives if it still fails), or clicks **Stop** to end the whole run. You do not drive either — the runner has no agent-callable re-run or stop. The test then shows its natural Mocha result.

**Named-error paths (apply to any `qa-debug_qa_*` tool call you make):**

- `NO_ACTIVE_PAUSE` → no Mocha test is currently paused. STOP — do not re-call. Report: *"No pause is active; my analysis stands — please review the source edit at `<file>:<line>`."*
- `SESSION_NOT_FOUND` → your `session_id` is stale (a fresh pause superseded the one you were investigating). Re-call `qa-debug_qa_get_failure_context` (omit `session_id`) to ground in the current pause, then continue.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| **Reading the page's `.html` / `.js` / `.css` source to guess what's on screen instead of inspecting the live browser with `browser_snapshot` / `browser_evaluate`.** | Source files are static; the live browser holds the post-JS DOM, computed styles, in-flight network responses, console errors, and dynamically-injected nodes. Source-reading silently gives the wrong answer when the failure is caused by runtime state — exactly the case that paused the test. Inspect the live browser first; read source only to corroborate. |
| Calling `browser_*` tools before Step 1b (chrome selection) commits. | playwright-mcp is not registered until selection commits, so its tools have no target. Walk the Step-1b branching first; once it commits, the browser is auto-attached. |
| After selection commits, finding **no** `browser_*` tool in your registry and falling back to reading source (or guessing) instead of stopping. | No `browser_*` tool means playwright-mcp isn't running — there is no live browser to inspect, and source-reading is exactly the wrong-answer trap the pause exists to avoid. STOP and ask the user to install/enable playwright-mcp (Step 1d), then retry. |
| Calling `browser_snapshot` on a multi-tab runtime (`tab_count > 1`, Electron / OpenFin) without selecting the page under test first. | playwright-mcp attaches to an arbitrary page when the endpoint exposes many; snapshotting blind inspects the wrong window and produces a confident-but-wrong diagnosis. Run Step 1c: `browser_tabs(action:"list")` → match or ask → `browser_tabs(action:"select", index)`. |
| Guessing a port for `qa-debug_qa_discover_chromes` instead of asking the user. | The port list is consumer-framework-specific (often locked, often non-default); guessing wastes a probe and ships a wrong answer if the guess succeeds against an unrelated chrome. |
| Looking for a "mark passed" / "give up" / "retry" / "abort suite" verb to commit a result. | None exist — a pause is a pure inspection hold. You diagnose and propose; the QA re-runs from Test Explorer ▶ or ends the run with Stop. The test stands at its natural Mocha outcome. |
| On Step 0 **Option B**, inferring a fix and editing the file yourself instead of first asking the user to describe the change. | **B** means *"I describe, you apply"* — the user dictates the exact edit and you apply only that. Clicking **B** is **not** a license to guess a fix and write it. Ask what's wrong and the exact change first, then apply precisely that — nothing they didn't ask for. |
| Pseudo-code or prescriptive script for "how to investigate" the browser. | Step 2 is medium-freedom; multiple investigation paths are valid; over-prescribing causes you to skip the right tool when the failure shape suggests it. |
| Editing `.mocharc.cjs`, the SKILL itself, or extension internals. | The QA owns the specs; the extension owns hook injection. You own diagnosis and source/spec edits. |
| Chat-as-launcher patterns (e.g., "type `@qa-debug run X`"). | Test Explorer is the run surface; chat is conversation / investigation. |
| Mocha CLI flags (`--bail`, `--reporter`, etc.). | The extension constructs the mocha command line; do not advise the QA to change it. |
| Calling the playwright-mcp `browser_close` or `browser_navigate` tool during investigation. | Both destroy the post-failure state the pause is preserving — `browser_close` kills the held Chrome; `browser_navigate` discards the DOM / console / network log that paused the test. Neither is recoverable. |
| Ending the turn after the diff with only a passive "let me know if you need anything else." | Step 3 requires an *explicit* "anything else to investigate, add, or check before you re-run?" ask. Passive offers get ignored; explicit asks keep the loop open and surface the follow-up steps QAs reliably have. |
| Bulk-pulling network (`browser_network_requests`) or console (`browser_console_messages`) on first investigation without the user opting in. | Step 2 network+console-on-demand rule: beta env emits noisy framework / HMR / dev-telemetry chatter that drowns the diagnostic signal. Either the user asks for the pull, or you ask and they confirm — then pull. Targeted `browser_evaluate(<expr>)` against specific runtime state is the free alternative. |

## Worked examples

Concrete patterns reusing fixture-tests failures so you have anchors. These are *examples of the shape*, not prescriptive scripts. In every case the closing move is the same: diagnose, propose the fix in chat, ask "anything else?", and hand back for the user to re-run.

| Failure | Shape | Closing turn |
|---|---|---|
| `fixture-tests/specs/value-mismatch.spec.js` | `expected "$80.00" but got "$90.00"` | Identify the diff (`src/cart/discount.ts` applies 10% not 20%); propose the edit; offer to verify against the live browser before re-run; hand back for ▶ Run. |
| `fixture-tests/specs/selector.spec.js` | `locator(".submit-btn") resolved to 0 elements` after an intentional rename to `.primary-submit` | Propose the spec-side selector edit (use `identify-element` if the node isn't obvious); offer further checks; hand back for ▶ Run. |
| `fixture-tests/specs/timeout.spec.js` with a suspected upstream issue | `TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms` | Ask the user whether to pull `browser_network_requests`; if a 503 from `/auth/login` is confirmed, report it as a likely environmental cause and suggest the user re-run; you do not mark it passed — they decide whether to re-run or stop. |
| First test fails on `pg_connection_refused` in `beforeAll` | every test in the suite would hit the same blocker | Report the shared dependency (DB unreachable) as a one-line conclusion; suggest the user fix the environment and re-run, or Stop the run. No abort verb — the user ends the run with Stop. |
