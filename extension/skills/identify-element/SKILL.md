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
    "selector": "[data-e2e=\"event-markers-button\"]",
    "nthOfType": 1,
    "inFrame": true,
    "frameUrl": "https://app.example.com/rap/financial-chart/3.8.37.1/index.html",
    "frameChain": [
      { "selector": "iframe#app-shell", "url": "https://app.example.com/shell" },
      { "selector": "iframe[name=\"chart\"]", "url": "https://app.example.com/rap/financial-chart/3.8.37.1/index.html" }
    ],
    "frameChainComplete": true,
    "ancestors": [
      { "tag": "div", "id": "", "classes": ["toolbar"], "data": {}, "role": "toolbar", "ariaLabel": "Chart tools", "name": "", "selector": "div[role=\"toolbar\"]", "nthOfType": 2 },
      { "tag": "section", "id": "", "classes": ["chart-panel"], "data": { "e2e": "markers-panel" }, "role": "", "ariaLabel": "", "name": "", "selector": "section[data-e2e=\"markers-panel\"]", "nthOfType": 1 },
      { "tag": "div", "id": "", "classes": [], "data": {}, "role": "", "ariaLabel": "", "name": "", "selector": "div:nth-of-type(3)", "nthOfType": 3, "shadowHost": true },
      { "tag": "body", "id": "", "classes": [], "data": {}, "role": "", "ariaLabel": "", "name": "", "selector": "body", "nthOfType": 1 }
    ]
  }
}
```

The output is **framework-neutral** — raw DOM facts plus plain CSS selectors, with no ready-made test-framework locator baked in. **Do not assume any framework.** Which framework, selector strategy, and frame/shadow idiom to use is something you **discover from the consumer's own codebase** in Step 4 — never guess it.

If the QA doesn't click within ~2 minutes, or the turn is cancelled, it returns `{ "cancelled": true, "reason": "timeout" | "cancelled" }` — fall back to your prior plan (don't loop; ask the QA what they want next). Errors: `NO_ACTIVE_PAUSE`, `SESSION_NOT_FOUND`, `BROWSER_NOT_SELECTED` (select a chrome first), `CDP_CONNECT_FAILED` (the held browser's CDP endpoint was unreachable).

No iframe/shadow handling is needed on your side — the tool resolves straight to the real leaf node regardless of how deeply it's nested. When the node lives inside iframes, **`frameChain`** gives you the full ordered **outer→inner** ancestry — one `{ selector, url }` per `<iframe>`, covering arbitrarily nested AND cross-origin (OOPIF) frames — so you don't have to hunt for the iframe selectors yourself. An empty `frameChain` means the top document. If `frameChainComplete` is `false`, one frame level couldn't be auto-resolved (rare: a same-process cross-origin frame) — identify that iframe manually and treat `frameChain` as best-effort.

**`ancestors`** gives the DOM ancestor chain of the picked node *within its frame*, **nearest→outermost** (immediate parent first, up to `<html>` or ~15 levels), crossing shadow-DOM boundaries (each crossing flagged `shadowHost: true`, so nested shadow roots are walked). Use it when the leaf alone is weak (no stable `data-*`/`id`/`role`, only a tag or utility classes) or ambiguous (the same leaf selector matches many nodes): anchor on the nearest ancestor that carries a stable hook and descend to the leaf. Each entry has `{ tag, id, classes, data, role, ariaLabel, name, selector, nthOfType, shadowHost? }`.

**`nthOfType`** (on the leaf and every ancestor) is the 1-based position among same-tag siblings. When an element has no stable hook, its `selector` already falls back to `tag:nth-of-type(n)` so it's at least locally unique; combine with the ancestor chain for a globally-unique path. Treat positional selectors as a **last resort** — they break on DOM reorder — so prefer a stable `data-*`/`id`/`role`/text on the element or an ancestor whenever one exists.

**Shadow DOM caveat (important).** **Open** shadow roots are pierced by most modern selector engines, so a CSS selector through open shadow usually resolves — but confirm against how the project's own tests deal with shadow DOM. **Closed** shadow roots generally cannot be reached by a selector at all. The picker can still *report* a chain that crosses a closed boundary (it holds the node directly via CDP), but a selector whose path crosses a closed root **will not resolve in the test** — when you see `shadowHost: true` on a closed host, say so to the QA and follow whatever non-selector escape hatch the project uses, rather than handing over a selector that silently fails.

### Step 3 — Confirm with the QA in plain language

Show the QA what got picked, NOT raw JSON:

> *"You picked a `<button>` with data-e2e `event-markers-button`, role 'button', inside the chart iframe. Is this the right element?"*

Wait for confirmation. If QA confirms → Step 4. If QA says no → loop back to Step 1 with a fresh `qa_pick_element` call.

### Step 4 — Investigate the consumer codebase, then build in its convention

The picker output is deliberately framework-agnostic — it tells you *which element*, not *how this repo writes locators*. **Before writing anything, investigate the consumer project** (open a handful of its existing test / page-object / helper files, and any locator/selector utilities) and learn:

- **Selector strategy** — what hook the project anchors on (`data-e2e`, `data-test`, `id`, role/accessible-name, plain CSS, …).
- **Element API** — how it queries an element (a built-in locator API, a custom wrapper/helper, page-object methods).
- **Frames** — how its existing tests reach elements *inside* an iframe (the frame-entry idiom it already uses).
- **Shadow DOM** — whether/how it handles shadow roots.
- **Interaction & assertion style** — so your suggestion reads like the surrounding code.

Then build the locator using ONLY the attributes from Step 2's output, replicating that convention exactly:

- DO NOT assume a framework, and DO NOT copy a selector from training data — the consumer's codebase + the returned attributes are the only sources of truth.
- **Match the project's selector strategy** for the leaf (prefer a stable `data-*`/`id`/`role`/accessible-name; the plain-CSS `selector` field is a fallback hint, not the answer).
- **Frames** (`frameChain` non-empty): walk the iframes **outer→inner**, entering each the way the project's own tests do, then locate the leaf inside the innermost frame. Each `frameChain[i].selector` is plain CSS for the iframe element — reuse it, or rewrite to the project's frame convention using the entry's `url` as a cue. If `frameChainComplete` is `false`, resolve the missing level(s) by hand. (`inFrame`/`frameUrl` are quick "is it framed / innermost URL" signals; `frameChain` is what you build from.)
- **Weak/ambiguous leaf** → scope with `ancestors`: anchor on the nearest ancestor carrying a stable hook (`data-*`/`id`/`role`/`aria-label`) and descend to the leaf, in the project's idiom. Add only as many ancestor levels as needed for uniqueness. Ancestors are also your fallback when the leaf has no usable attribute at all.
- **Last resort only:** when nothing stable exists anywhere on the path, use the `:nth-of-type(n)` selectors (driven by `nthOfType`) and tell the QA the locator is positional and brittle.

If you can't determine the project's convention from the codebase, ask the QA rather than guessing a framework.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Calling `qa_pick_element` before a chrome is selected. | It returns `BROWSER_NOT_SELECTED`. Run `qa_get_failure_context` → `qa_select_chrome` first (qa-debug SKILL Step 1b). |
| Skipping Step 3 (QA confirmation in plain language). | The tool reports *what* the QA clicked, but they may have mis-clicked (sticky headers, overlays, hidden buttons). Always confirm in plain English before building the selector. |
| Assuming a framework / pasting the raw `selector` without matching the project. | The output is framework-neutral data + plain CSS — it does NOT tell you the repo's framework, selector strategy, frame/shadow idiom, or custom wrappers. Investigate the project's existing tests first (Step 4), then build in *that* convention; if unclear, ask the QA. |
| Calling `qa_pick_element` again before the first call returns. | It blocks awaiting the QA's click. Wait for it to return (or time out / cancel) before re-invoking. |
| Using the picker when the right selector is already obvious from `browser_snapshot`. | Free reads of the DOM tree don't need QA interaction; reserve the picker for cases where the snapshot alone doesn't disambiguate. |

## Reference

- `qa_pick_element` (qa-debug LM tool) — the picker. Drives Chrome's CDP `Overlay` inspector from the extension; see `extension/src/cdp-inspect.ts`.
- `extension/skills/qa-debug/SKILL.md` — the qa-debug investigation flow this skill plugs into (Step 1 / Step 1b for failure context + chrome selection, before proposing a selector edit).
