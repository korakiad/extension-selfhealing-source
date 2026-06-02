---
name: identify-element
description: Use during an active Mocha test pause when the agent or QA needs to visually identify a specific element in the held browser. Engages when investigating a selector-related failure (test-bug / code-bug), when the QA says "pick this element" / "show me which element you mean" / "let me identify it" / "the right element is the one labelled X", or when the agent is uncertain which DOM node a failing assertion refers to. Routes to the qa-debug `qa_pick_element` tool, which arms Chrome's native element inspector in the held browser — the QA hovers and clicks one element, and the tool returns structured DOM attributes for the agent to build a project-matched locator. Does NOT engage when no Mocha test is paused — the qa-debug companion must be active and a chrome must be selected.
---

# /identify-element — Visual element picker during a Mocha pause

A Mocha test is paused and a browser is held alive (qa-debug companion engaged). When the failing assertion mentions a selector — or you genuinely don't know which DOM node the QA means — use the **`qa_pick_element`** tool to have the QA click the target in the held browser. It arms Chrome's own DevTools element inspector over CDP, so the QA just hovers (Chrome highlights the element) and clicks once, anywhere — and because the hit-test runs in the browser process, it transparently pierces **cross-origin iframes, open and closed shadow DOM, web components, and canvas overlays** with no descend step and no awareness of frames from the QA. **Always confirm the picked element with the QA in plain language before building a selector.**

## Prerequisites

- An active Mocha pause (qa-debug companion engaged); `qa-debug.paused` context is true.
- A chrome selected (qa-debug SKILL Step 1b ran; `selected_cdp_port` is non-null). If none is selected, `qa_pick_element` returns `BROWSER_NOT_SELECTED` — run the `qa_get_failure_context` → `qa_select_chrome` flow first, then retry.

`qa_pick_element` connects to the held browser's CDP endpoint directly; it does NOT require playwright-mcp (no `browser_evaluate`, no injection).

## When to use

- The failure says *"selector resolved to 0 elements"*, *"expected 1 element matching X but found N"*, or similar selector-anchored shape AND the right element isn't obvious from `browser_snapshot` alone.
- The QA explicitly asks: *"pick this element"*, *"let me show you which one"*, *"the right element is the one labelled X"*, *"identify the button I'm clicking"*.
- Before proposing a selector edit, when you'd otherwise be guessing which node a failing assertion refers to.

## When NOT to use

- No Mocha pause is active (the skill description gates this; do not bypass).
- The failure has nothing to do with an element (value mismatch, network 503, runtime exception, missing fixture data, etc.).
- The right selector is already obvious from `browser_snapshot` AND matches the project's existing selector pattern — don't interrupt the QA for a free move you've already made.
- The QA is in autopilot and has explicitly delegated selector decisions to you for this session.

## How to invoke

### Step 1 — Tell the QA what's about to happen

One short message in chat:

> *"I'm arming the element picker in the held browser. Hover over the element you mean — Chrome will highlight it — then click it. I'll wait."*

This sets expectations so the QA isn't surprised when the inspector cursor appears.

### Step 2 — Call `qa_pick_element`

Call the `qa_pick_element` tool (`session_id` is optional — omit to target the active pause). It blocks while the QA hovers and clicks, then returns:

```json
{
  "picked": {
    "tag": "ef-button",
    "id": "",
    "name": "",
    "classes": ["event-markers-button"],
    "data": { "e2e": "event-markers-button" },
    "aria": { "role": "button", "pressed": "false" },
    "text": "",
    "inFrame": true,
    "frameUrl": "https://app.example.com/rap/financial-chart/3.8.37.1/index.html",
    "suggestedLocator": "frameLocator(/* iframe at https://app.example.com/rap/financial-chart/... */).locator('[data-e2e=\"event-markers-button\"]')"
  }
}
```

If the QA doesn't click within ~2 minutes, or the turn is cancelled, it returns `{ "cancelled": true, "reason": "timeout" | "cancelled" }` — fall back to your prior plan (don't loop; ask the QA what they want next). Errors: `NO_ACTIVE_PAUSE`, `SESSION_NOT_FOUND`, `BROWSER_NOT_SELECTED` (select a chrome first), `CDP_CONNECT_FAILED` (the held browser's CDP endpoint was unreachable).

No iframe/shadow handling is needed on your side — the tool resolves straight to the real leaf node regardless of how deeply it's nested. `inFrame`/`frameUrl` simply tell you the picked node lives inside an iframe so you can anchor a `frameLocator`.

### Step 3 — Confirm with the QA in plain language

Show the QA what got picked, NOT raw JSON:

> *"You picked a `<button>` with data-e2e `event-markers-button`, role 'button', inside the chart iframe. Is this the right element?"*

Wait for confirmation. If QA confirms → Step 4. If QA says no → loop back to Step 1 with a fresh `qa_pick_element` call.

### Step 4 — Build a project-matched selector

Before writing the diff, read 2–3 of the project's existing test / page-object files to learn the project's selector pattern (`data-e2e`, `data-test`, plain `css`, `aria` / `getByRole`, a custom wrapper like `Ws.instance.client.$()`, etc.). Build the locator using ONLY the attributes from Step 2's output, in the project's pattern.

- DO NOT paste `suggestedLocator` as the final selector — it's a *hint* showing preference order (data-e2e/test → id → role → class → tag), not a project-matched expression.
- DO NOT build a selector from training data — the returned attributes are the only source of truth.
- DO match whatever pattern the project already uses.
- If `inFrame` is true, wrap the locator in a `frameLocator(...)` anchored on an `iframe` selector you derive from the page (e.g. `iframe[src*="financial-chart"]`); `frameUrl` tells you which frame.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Calling `qa_pick_element` before a chrome is selected. | It returns `BROWSER_NOT_SELECTED`. Run `qa_get_failure_context` → `qa_select_chrome` first (qa-debug SKILL Step 1b). |
| Skipping Step 3 (QA confirmation in plain language). | The tool reports *what* the QA clicked, but they may have mis-clicked (sticky headers, overlays, hidden buttons). Always confirm in plain English before building the selector. |
| Pasting `suggestedLocator` as the final selector. | It's a hint, not a project-matched expression. The QA's project may use `data-e2e`, `data-test`, `getByRole`, a wrapper like `Ws.instance.client.$()`, or a custom CSS scheme. Read the project's tests first. |
| Calling `qa_pick_element` again before the first call returns. | It blocks awaiting the QA's click. Wait for it to return (or time out / cancel) before re-invoking. |
| Using the picker when the right selector is already obvious from `browser_snapshot`. | Free reads of the DOM tree don't need QA interaction; reserve the picker for cases where the snapshot alone doesn't disambiguate. |

## Reference

- `qa_pick_element` (qa-debug LM tool) — the picker. Drives Chrome's CDP `Overlay` inspector from the extension; see `extension/src/cdp-inspect.ts`.
- `extension/skills/qa-debug/SKILL.md` — the qa-debug investigation flow this skill plugs into (Step 1 / Step 1b for failure context + chrome selection, before proposing a selector edit).
