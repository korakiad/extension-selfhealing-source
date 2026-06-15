---
name: test-script-orchestrator
description: Orchestrates generating or updating UI automation scripts from TestRail test cases in VS Code. Use when the QA asks to pull a TestRail case, BDD, or step list and create or modify Mocha/WebdriverIO/Playwright/Selenium tests by learning the current workspace's patterns. Enforces auto/manual mode selection, reuses existing page objects/selectors/helpers, never invents unverified locators, REHEARSES each step against the live app to capture the real post-condition (modal close, scroll-into-view, async settle) before writing — never coding an action it has not watched take effect, pauses to ask the user whenever MCP/live-browser inspection is ambiguous, self-reviews the generated script against observed behavior, and adds explicit waits for WebdriverIO projects that do not auto-wait. Does NOT engage for paused failure root-cause debugging; use qa-debug for that.
---

# Test Script Orchestrator

Create or update test automation from a TestRail case while matching the consumer workspace. Treat TestRail as the test **intent**, the workspace as the implementation **convention**, and the running app as **ground truth for what each step actually does**. The repo decides how to *express* a locator or a wait; only the live app honestly tells you the *runtime behavior* a step produces — does "Apply" close the modal, is the target below the fold and needing a scroll, does the list re-render before the assertion can run. **Never write an action you have not watched take effect in the live app.**

The browser MCP is the QA Debug Live Inspect Session, not a standalone browser launcher. `qa-debug-cdp` exists only after the QA has launched or attached a Web, Electron, or OpenFin app through **QA Debug: Inspect App**, **QA Debug: Attach Existing Inspect App (CDP Port)**, or `@qa-agent`. A long-lived logged-in app may be reused by attaching to its existing CDP port; do not relaunch it unless the QA chooses launch. If no Live Inspect Session is active, work repo-first and ask the QA to launch or attach inspection before any browser/MCP step.

## Workflow checklist

- [ ] Step 0: Ask the QA to choose **Auto** or **Manual**, unless their words already decide it
- [ ] Step 1: Read and normalize the TestRail case
- [ ] Step 2: Learn the workspace's test framework, selector strategy, page-object/helper style, waits, assertions, and data setup
- [ ] Step 3: Map each TestRail step to a repo-matched action/assertion plan, naming the post-condition to confirm live
- [ ] Step 4: Walk every step in the live app — resolve its target (repo selectors first) AND rehearse the action to capture the real post-condition (modal close, scroll, settle); never skip rehearsal just because the locator was already known
- [ ] Step 5: Generate or update the script in the discovered convention, with waits/scrolls that match what you observed
- [ ] Step 6: Self-review the script against observed behavior, then validate with the narrowest useful command and report what ran

## Step 0 - Mode choice

Open with one short choice when the user has not already chosen:

- **Auto**: make reasonable implementation decisions, edit files, and keep moving. Hard gates still apply: ask before ambiguous MCP choices, destructive changes, missing TestRail IDs, or unclear product behavior.
- **Manual**: present the discovered plan, target files, selectors/actions, and diffs for confirmation before each edit. Still do repo discovery and TestRail reads yourself.

If the user says "auto", "go ahead", "ทำให้เลย", or similar, treat it as Auto. If they ask to review first, say "manual", or ask for step-by-step approval, treat it as Manual.

## Step 1 - Pull the TestRail source

Use the `testrail` skill and `qa_testrail_get` for reads. Never ask for credentials; on `TESTRAIL_NOT_CONFIGURED`, tell the QA to run **"QA Debug: Configure TestRail"** and stop.

Common reads:

- Case by ID: `get_case/{case_id}`.
- BDD/Gherkin by case ID: `get_bdd/{case_id}` when the case references BDD or the QA asks for scenario text.
- Shared steps: read the referenced shared step endpoint when the case content points to shared steps.
- Nearby context: sections, suites, labels, attachments, or recent cases only when needed to understand the case.

Normalize the result into: title, preconditions, test data, ordered actions, expected results, attachments, unknowns, and any non-automatable manual checks.

## Step 2 - Learn the workspace before writing

Inspect the repo before inventing structure. Prefer nearby files over global patterns:

- `package.json`, runner config, WDIO/Playwright/Selenium config, Mocha setup, TypeScript/JavaScript layout.
- Existing specs for the same feature, suite, page, or domain.
- Page objects, screen objects, selector maps, custom element wrappers, fixture builders, login/session helpers, wait helpers, assertion helpers, and test data factories.
- Naming conventions: spec file names, `describe`/`it` wording, tags, TestRail case ID annotations, skipped/quarantined markers.

Record the discovered convention before editing. If the framework or target location is unclear after a reasonable search, ask the QA instead of guessing.

## Step 3 - Convert TestRail steps to an automation plan

For each TestRail step, decide:

- The prerequisite state or fixture setup.
- The UI/API action.
- The expected assertion.
- **The observable post-condition that proves the action took effect** — what the app should *do* in response (modal closes, toast appears, row count changes, route changes). You confirm this against the live app in Step 4, and it becomes the natural wait/assert target.
- The element(s) required.
- Whether the step is automatable, needs user clarification, or should remain as a comment/manual note.

Keep the generated test faithful to the case, but use the repository's established abstractions. Do not create a new helper, selector layer, or fixture pattern unless the existing code has no suitable home and the complexity justifies it.

## Step 4 - Walk every step in the live app (resolve + rehearse)

Go through the plan **one step at a time against the running app**, and for each automatable step do BOTH: resolve the target, then perform the action and watch what happens. Do this even when the repo already hands you the locator — the locator tells you *where* to act; only the running app tells you *what the step does*. This is the step that catches "Apply didn't close the modal" and "the control was below the fold" before they become unreliable code.

This requires an active Live Inspect Session (`qa-debug-cdp`). If none is active, ask the QA to launch/attach (see **Live app access** below). If they can't provide one, you may still write the script from the repo plan — but mark every unrehearsed step `// UNVERIFIED: behavior assumed, not observed live` in the output so the gap is visible, never silent.

### Rehearse the action, capture the real post-condition

For each automatable step, drive the live app through `qa-debug-cdp` and observe the transition:

- `browser_snapshot` the relevant region **before** the action, perform it (`browser_click` / `browser_type` / `browser_press_key` / `browser_select_option`), then snapshot **after** and compare. The difference is the truth you encode.
- **Record the post-condition you actually saw**, not the one you assumed: did the modal/popup close, did a toast/inline error appear, did the list/table settle to a new state, did the route change? That observed condition becomes the wait target and/or the assertion in Step 5.
- **Visibility & scroll**: if the control wasn't in the viewport (the action needed a scroll, or `browser_click` reported it off-screen / intercepted), the script needs an explicit scroll-into-view / "wait until clickable" in the repo's idiom. Note it now.
- **Settling**: if the post-condition appeared only after a beat (animation, network round-trip, re-render), the step is async — note the concrete condition to wait on (element gone, element clickable, text present), not a fixed sleep.
- If the action **didn't** produce the expected post-condition (modal stayed open, nothing happened), do NOT paper over it: re-check the target (wrong element? missing prerequisite?) and, if still stuck, pause and ask the QA (MCP pause gate). A step you can't make work live is a step you can't reliably automate.

**Destructive-action guard.** Rehearsing runs real actions on the QA's real logged-in app. Freely rehearse non-mutating UI (open/close menus and modals, scroll, navigate, expand rows). For actions that mutate or send (submit, save, delete, pay, send message, place order), get the QA's go-ahead before performing it — or ask them to perform it while you observe — and say which step you're about to run. Never trigger an irreversible action just to observe it.

### Existing selectors first

Before using MCP or making a new selector, search the workspace:

- Search existing page objects/selectors/helpers for the screen, label, text, test id, aria name, route, component name, and nearby domain terms.
- Reuse existing element APIs even if a raw CSS selector from MCP looks shorter.
- If a selector exists but looks stale, verify it against the live app before replacing it.
- If a new selector is truly needed, build it from verified facts and place it where the project already stores selectors.

Do not create selectors from memory, screenshots, or TestRail prose alone. A TestRail step such as "Click Submit" is not a locator.

### MCP pause gate

When live-browser inspection is involved, pause and ask the QA before continuing whenever any of these is true:

- More than one element/action could satisfy the TestRail step.
- The live DOM does not obviously match the TestRail wording.
- The action order is unclear, such as whether a prerequisite action must happen first.
- **A rehearsed action did not produce its expected post-condition** and the cause isn't obvious.
- You need the QA to choose between arming the element picker, selecting one observed candidate, performing a destructive step, or putting the app into the right state.
- A frame, tab, window, shadow boundary, canvas surface, or hidden/disabled state makes the target uncertain.
- The final locator would be positional, brittle, or not aligned with the repo's selector strategy.

Ask one concrete question, then continue from the same step after the QA answers. Do not restart the workflow, and do not silently continue by choosing for them.

Good questions:

- "I see two `Submit` buttons, one in the modal and one in the page footer. Which should this case use?"
- "I clicked Apply but the modal stayed open — should I wait for a confirmation toast first, or is there a prerequisite step?"
- "The repo already has `LoginPage.submitButton`, but the live app exposes a unique `[data-testid=primary-submit]`. Reuse and update the page object, or add a new selector?"

### Live app access

Use only the QA Debug CDP-attached server, `qa-debug-cdp`, bound to the active Live Inspect Session's port. If it's unavailable, ask the QA to run **QA Debug: Inspect App** (Web / Electron / OpenFin) or **QA Debug: Attach Existing Inspect App (CDP Port)** before continuing. Do not use a separate generic Playwright MCP server — it may control a different browser.

After launch/attach the app may still be at login or an arbitrary state. Wait for the QA's explicit readiness signal before rehearsing or generating locators; if they need to log in, let them, then continue from the same step. If multiple tabs/windows are exposed, list/select the intended page first; ask if it isn't obvious.

For element **picking**, follow **identify-live** (launched app) or **identify-element** (paused test) — the full picker-output contract, the verify-via-marker recipe, and the investigate-then-build convention steps live there; don't restate them here.

## Step 5 - Generate in the repo's framework

Write the test exactly in the discovered project style:

- Use existing page objects and helper APIs.
- Keep selectors close to the existing selector owner.
- Use existing login/session/data setup helpers.
- Preserve linting, import ordering, async style, assertion style, and TestRail ID annotations.
- Prefer small edits in existing files when the case belongs to an existing suite; create a new spec only when the repo pattern supports that.

### Encode what you observed in Step 4

Every wait, scroll, and post-condition assertion should trace back to something you saw during rehearsal — not a guess:

- **Post-condition → wait/assert.** The transition you observed (modal closed, toast shown, row count changed, route changed) is the thing to wait on before the next action and to assert after it. Prefer waiting on that concrete condition over a fixed sleep.
- **Off-screen target → scroll-into-view.** If the control needed scrolling during rehearsal, emit the project's scroll-into-view / ensure-visible idiom before interacting; don't assume the element is reachable.
- **Modal/overlay close.** If a step closes a dialog, wait for it to be gone before acting on what's behind it — a common source of "popup didn't close" flakiness when omitted.
- Express each in the repo's convention (its wait/visibility helper if one exists); the framework-specific note below covers projects whose commands don't auto-wait.

### WebdriverIO wait rule

WebdriverIO does not auto-wait like Playwright-style locators. In WDIO projects, add explicit waits around UI interactions and assertions unless the project's wrapper already does it.

Use the repo's wait helper if one exists. Otherwise use WDIO waits directly:

- Before reading/clicking/typing into visible UI: `await element.waitForDisplayed(...)`.
- Before clicking an enabled control: `await element.waitForClickable(...)` or `waitForEnabled(...)` if that is the local pattern.
- Before asserting async state: `await browser.waitUntil(...)`, `waitForDisplayed`, `waitForExist`, or the local assertion helper.
- Avoid `browser.pause(...)` except when the project already uses it for a documented external timing limitation.

If the existing WDIO suite relies on implicit waits but the target step is asynchronous, still add an explicit wait in the style closest to surrounding code.

## Step 6 - Self-review against observed behavior, then validate

### Self-review first

Before validating, re-read the script you wrote and confirm each generated action holds up against what you saw live. For every step, check:

- **Locator** — verified against the live app (match count seen), in the repo's convention; not invented from TestRail prose.
- **Post-condition** — there is a wait and/or assertion for the transition you actually observed; no action fires before the previous one's effect has settled.
- **Visibility** — any step that needed a scroll during rehearsal has a scroll-into-view / ensure-visible; nothing assumes an off-screen control is clickable.
- **Assumptions surfaced** — any step you could NOT rehearse live (no session, or a destructive action you didn't run) is marked `// UNVERIFIED` and called out to the QA, not shipped as if confirmed.

Fix what fails this pass before moving on. This is the layer that keeps a plausible-but-untested script from reaching the QA.

### Validate

Run the narrowest useful validation:

- Typecheck/lint for the touched package when available.
- A targeted test command for the new/updated spec when the project exposes one and it will not require unavailable external services.
- If validation requires a live app, credentials, or a long environment setup, state that clearly and provide the exact command the QA should run.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Generating selectors directly from TestRail wording. | TestRail describes intent, not DOM identity. |
| Creating a new selector when an existing page object/helper already represents the element. | It forks the test vocabulary and makes maintenance harder. |
| Using MCP to bypass repo discovery. | The live DOM gives facts, but the repo defines how tests should express those facts. |
| Continuing through an ambiguous MCP observation without asking the QA. | The QA owns product intent; the agent should pause, ask, then continue. |
| Coding an action you never watched take effect in the live app. | "Click Apply → modal closes" is an assumption until observed; unobserved transitions are exactly where popup-stays-open / no-scroll flakiness comes from. |
| Skipping rehearsal because the repo already had the locator. | The locator proves *where*, not *what the step does*. Step 4 confirms the runtime effect regardless of where the selector came from. |
| Shipping an unrehearsed or destructive-but-unrun step as if it were confirmed. | Mark it `// UNVERIFIED` and tell the QA; a silent assumption reads as verified and erodes trust in the whole script. |
| Writing WDIO interactions without waits. | WDIO element commands do not provide the same auto-wait semantics as Playwright locators. |
| Using a generic Playwright MCP browser instead of `qa-debug-cdp`. | It may inspect a fresh or unrelated browser, producing a wrong test. |
