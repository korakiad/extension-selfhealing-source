---
name: identify-live
description: Use ONLY when a Live Inspect Session is active (the QA launched their own running web/desktop app via "QA Debug: Inspect App") and the agent or QA needs to visually identify a DOM element — with NO failing test involved. Engages when the QA says "pick this element", "show me which element you mean", "let me identify it on my app", "identify the button" while inspecting a launched app. Routes to the qa-debug `qa_pick_element` tool, which arms Chrome's native element inspector in the launched app — the QA hovers and clicks one element, and the tool returns structured DOM attributes for the agent to build a project-matched locator. If a Mocha test IS paused instead, defer to the `identify-element` skill. Does NOT engage when no Live Inspect Session is active — run "QA Debug: Inspect App" first.
---

# /identify-live — Visual element picker on a launched app (no pause)

A **Live Inspect Session** is active: the QA launched one of their own apps (via the **QA Debug: Inspect App** command / status-bar button) so you can identify elements against the **real running app**, with no failing test. Use the **`qa_pick_element`** tool to have the QA click the target. It arms Chrome's own DevTools element inspector over CDP, so the QA just hovers (Chrome highlights the element) and clicks once, anywhere — and because the hit-test runs in the browser process, it transparently pierces **cross-origin iframes, open and closed shadow DOM, web components, and canvas overlays**. **Always confirm the picked element with the QA in plain language before building a selector.**

This skill is the no-pause sibling of `identify-element`. The picker tool, its output shape, and Steps 3–4 are identical — the only differences are the entry (a launched app, not a paused test) and that the launched browser is auto-selected, so there is no chrome-selection step.

## Prerequisites

- An active **Live Inspect Session** (`qa-debug.liveSession` context is true). If none is active, `qa_pick_element` returns `NO_ACTIVE_INSPECTION` — tell the QA to run **QA Debug: Inspect App** first. No settings are required: it asks inline for the kind (Web / Electron / OpenFin) + the URL or executable path, and the web browser auto-detects.
- The launched browser is auto-selected — no `qa_select_chrome` step. If the app navigated, opened tabs, or restarted and the picker can't reach it, call **`qa_start_live_session`** to re-probe.

`qa_pick_element` connects to the launched app's CDP endpoint directly; it does NOT require playwright-mcp.

## When to use

- The QA asks: *"pick this element"*, *"let me show you which one"*, *"identify the button I'm clicking"*, *"the right element is the one labelled X"* — while inspecting a launched app.
- You need to know exactly which DOM node the QA means and `browser_snapshot` (via `qa-debug-cdp`) alone doesn't disambiguate.

## When NOT to use

- A Mocha test is paused → use **`identify-element`** + the pause flow instead.
- No Live Inspect Session is active → run **QA Debug: Inspect App** first.
- The right selector is already obvious from `browser_snapshot` AND matches the project's pattern — don't interrupt the QA for a free read.

## How to invoke

### Step 1 — Tell the QA what's about to happen

> *"I'm arming the element picker in the inspected app. Hover over the element you mean — Chrome will highlight it — then click it. I'll wait."*

### Step 2 — Call `qa_pick_element`

Call the tool (`session_id` optional — omit to target the active Live Inspect Session). It blocks while the QA hovers and clicks, then returns `{ picked: { tag, id, name, classes, data, aria, text, selector, nthOfType, inFrame, frameUrl, frameChain, frameChainComplete, ancestors } }`, or `{ cancelled: true, reason }` on timeout/cancel.

The output is **framework-neutral** — raw DOM facts plus plain CSS selectors, with NO ready-made test-framework locator. **Do not assume any framework.** See `identify-element`'s Step 2 for the full field-by-field contract (`frameChain` = outer→inner iframe ancestry incl. cross-origin OOPIFs; `ancestors` = nearest→outermost within-frame chain crossing shadow DOM; `nthOfType` = last-resort positional; closed-shadow caveat).

Errors: `NO_ACTIVE_INSPECTION` (no live session — launch one), `CDP_CONNECT_FAILED` (the app was unreachable or exposed no page target yet — if it just launched, wait a moment / confirm the URL opened, then retry; or `qa_start_live_session` to re-probe). For a desktop app exposing multiple windows on one port, the picker arms the first one — tell the QA which window is being inspected.

### Step 3 — Confirm with the QA in plain language

Show the QA what got picked, NOT raw JSON:

> *"You picked a `<button>` with data-e2e `event-markers-button`, role 'button', inside the chart iframe. Is this the right element?"*

If they confirm → Step 4. If not → loop back to Step 1 with a fresh `qa_pick_element` call.

### Step 4 — Investigate the consumer codebase, then build in its convention

The picker output tells you *which element*, not *how this repo writes locators*. **Before writing anything, investigate the consumer project** (its existing tests / page-objects / helpers, any locator/selector utilities) and learn its **selector strategy**, **element API**, **frame-entry idiom**, and **shadow-DOM handling**. Then build the locator using ONLY the returned attributes, replicating that convention exactly. Prefer a stable `data-*`/`id`/`role`/accessible-name on the leaf or nearest stable ancestor; walk `frameChain` outer→inner the way the project's own tests enter frames; treat `:nth-of-type(n)` as a last resort and tell the QA it's positional. If you can't determine the convention, ask the QA rather than guessing. (Identical to `identify-element` Step 4.)

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Launching/relaunching the app yourself. | The extension owns the launch (QA Debug: Inspect App). If the session is stale, call `qa_start_live_session`; if absent, ask the QA to launch. |
| Skipping Step 3 (QA confirmation in plain language). | The QA may have mis-clicked (sticky headers, overlays). Always confirm in plain English before building the selector. |
| Assuming a framework / pasting the raw `selector`. | Output is framework-neutral data + plain CSS. Investigate the project's existing tests first (Step 4), then build in *that* convention. |
| Using this skill during a Mocha pause. | Use `identify-element` then — the pause flow has its own chrome selection. |

## Reference

- `qa_pick_element` (qa-debug LM tool) — the picker, shared with the pause flow; drives Chrome's CDP `Overlay` inspector (`extension/src/cdp-inspect.ts`).
- `qa_start_live_session` — re-establishes the live CDP target after navigation/restart.
- `extension/skills/identify-element/SKILL.md` — the pause-flow sibling; full picker-output contract + Step 4 detail live there.
