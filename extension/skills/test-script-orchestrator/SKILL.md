---
name: test-script-orchestrator
description: Orchestrates generating or updating UI automation scripts from TestRail test cases in VS Code. Use when the QA asks to pull a TestRail case, BDD, or step list and create or modify Mocha/WebdriverIO/Playwright/Selenium tests by learning the current workspace's patterns. Enforces auto/manual mode selection, reuses existing page objects/selectors/helpers, never invents unverified locators, pauses to ask the user whenever MCP/live-browser inspection is ambiguous, and adds explicit waits for WebdriverIO projects that do not auto-wait. Does NOT engage for paused failure root-cause debugging; use qa-debug for that.
---

# Test Script Orchestrator

Create or update test automation from a TestRail case while matching the consumer workspace. Treat TestRail as the test intent, the workspace as the implementation convention, and the live app/MCP as evidence only when the repo cannot answer a UI question.

The browser MCP is the QA Debug Live Inspect Session, not a standalone browser launcher. `qa-debug-cdp` exists only after the QA has launched or attached a Web, Electron, or OpenFin app through **QA Debug: Inspect App**, **QA Debug: Attach Existing Inspect App (CDP Port)**, or `@qa-testcase`. A long-lived logged-in app may be reused by attaching to its existing CDP port; do not relaunch it unless the QA chooses launch. If no Live Inspect Session is active, work repo-first and ask the QA to launch or attach inspection before any browser/MCP step.

## Workflow checklist

- [ ] Step 0: Ask the QA to choose **Auto** or **Manual**, unless their words already decide it
- [ ] Step 1: Read and normalize the TestRail case
- [ ] Step 2: Learn the workspace's test framework, selector strategy, page-object/helper style, waits, assertions, and data setup
- [ ] Step 3: Map each TestRail step to a repo-matched action/assertion plan
- [ ] Step 4: Resolve every element through existing repo selectors first; use MCP only for missing or uncertain UI facts
- [ ] Step 5: Generate or update the script in the discovered convention
- [ ] Step 6: Validate with the narrowest useful command and report what ran

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
- The element(s) required.
- Whether the step is automatable, needs user clarification, or should remain as a comment/manual note.

Keep the generated test faithful to the case, but use the repository's established abstractions. Do not create a new helper, selector layer, or fixture pattern unless the existing code has no suitable home and the complexity justifies it.

## Step 4 - Locator and MCP rules

### Existing selectors first

Before using MCP or making a new selector, search the workspace:

- Search existing page objects/selectors/helpers for the screen, label, text, test id, aria name, route, component name, and nearby domain terms.
- Reuse existing element APIs even if a raw CSS selector from MCP looks shorter.
- If a selector exists but looks stale, verify it against the live app before replacing it.
- If a new selector is truly needed, build it from verified facts and place it where the project already stores selectors.

Do not create selectors from memory, screenshots, or TestRail prose alone. A TestRail step such as "Click Submit" is not a locator.

### MCP pause gate

When MCP/live-browser inspection is involved, pause and ask the QA before continuing whenever any of these is true:

- More than one element/action could satisfy the TestRail step.
- The live DOM does not obviously match the TestRail wording.
- The action order is unclear, such as whether the QA should perform a prerequisite action first.
- You need the QA to choose between arming the element picker, injecting/marking an element for verification, selecting one observed candidate, or letting the QA put the app into the right state.
- A frame, tab, window, shadow boundary, canvas surface, or hidden/disabled state makes the target uncertain.
- The final locator would be positional, brittle, or not aligned with the repo's selector strategy.

Ask one concrete question, then continue from the same step after the QA answers. Do not restart the workflow, and do not silently continue by choosing for them.

Good questions:

- "I see two `Submit` buttons, one in the modal and one in the page footer. Which should this case use?"
- "Should I arm the element picker so you can click the target, or do you want to perform the prerequisite action first?"
- "The repo already has `LoginPage.submitButton`, but the live app exposes a unique `[data-testid=primary-submit]`. Should I reuse the existing page object and update it, or create a new selector?"

### Live app access

Use only the QA Debug CDP-attached MCP server, `qa-debug-cdp`, for browser inspection. It is bound to the currently active Live Inspect Session's specific CDP port. If it is unavailable, ask the QA to start **QA Debug: Inspect App** for the correct app type (Web / Electron / OpenFin), or run **QA Debug: Attach Existing Inspect App (CDP Port)** for an already-running logged-in app before continuing. Do not use a separate generic Playwright MCP server; that may control a different browser.

After launch or attach, the app may still be at a login page or an arbitrary state. Wait for the QA's explicit readiness signal before using MCP to generate locators/actions. If the user needs to log in, let them do it in the opened app, then continue from the same orchestration step after they confirm.

If a Live Inspect Session is active, use `browser_snapshot`, targeted `browser_evaluate`, screenshots, and `qa_pick_element` as needed. If multiple tabs/windows are exposed, list/select the intended page before inspecting; ask the QA if the intended page is not obvious.

For element picking, follow `identify-live`: have the QA click the element, verify the marker or match count in the same live page, confirm the picked target in plain language, then translate it into the repository's selector convention.

## Step 5 - Generate in the repo's framework

Write the test exactly in the discovered project style:

- Use existing page objects and helper APIs.
- Keep selectors close to the existing selector owner.
- Use existing login/session/data setup helpers.
- Preserve linting, import ordering, async style, assertion style, and TestRail ID annotations.
- Prefer small edits in existing files when the case belongs to an existing suite; create a new spec only when the repo pattern supports that.

### WebdriverIO wait rule

WebdriverIO does not auto-wait like Playwright-style locators. In WDIO projects, add explicit waits around UI interactions and assertions unless the project's wrapper already does it.

Use the repo's wait helper if one exists. Otherwise use WDIO waits directly:

- Before reading/clicking/typing into visible UI: `await element.waitForDisplayed(...)`.
- Before clicking an enabled control: `await element.waitForClickable(...)` or `waitForEnabled(...)` if that is the local pattern.
- Before asserting async state: `await browser.waitUntil(...)`, `waitForDisplayed`, `waitForExist`, or the local assertion helper.
- Avoid `browser.pause(...)` except when the project already uses it for a documented external timing limitation.

If the existing WDIO suite relies on implicit waits but the target step is asynchronous, still add an explicit wait in the style closest to surrounding code.

## Step 6 - Validate

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
| Writing WDIO interactions without waits. | WDIO element commands do not provide the same auto-wait semantics as Playwright locators. |
| Using a generic Playwright MCP browser instead of `qa-debug-cdp`. | It may inspect a fresh or unrelated browser, producing a wrong test. |
