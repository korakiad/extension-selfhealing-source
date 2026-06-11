---
name: identify-element
description: Use during an active Mocha test pause when the agent or QA needs to visually identify a specific element in the held browser. Engages when investigating a selector-related failure (test-bug / code-bug), when the QA says "pick this element" / "show me which element you mean" / "let me identify it" / "the right element is the one labelled X", or when the agent is uncertain which DOM node a failing assertion refers to. Routes to the qa-debug `qa_pick_element` tool, which arms Chrome's native element inspector in the held browser — the QA hovers and clicks one element, the tool returns a verification-ready description (computed role/name, injected marker, match-counted CSS candidates), and the agent VERIFIES the pick through the attached browser tools before building a project-matched locator. Does NOT engage when no Mocha test is paused — the qa-debug companion must be active and a chrome must be selected.
---

# /identify-element — Visual element picker during a Mocha pause

A Mocha test is paused and a browser is held alive (qa-debug companion engaged). When the failing assertion mentions a selector — or you genuinely don't know which DOM node the QA means — use the **`qa_pick_element`** tool to have the QA click the target in the held browser. It arms Chrome's own DevTools element inspector over CDP, so the QA just hovers (Chrome highlights the element) and clicks once, anywhere — the hit-test runs in the browser process, so it transparently pierces **cross-origin iframes, open and closed shadow DOM, web components, and canvas overlays**.

The pick is only half the job. The tool returns **three verification handles** — computed `role`/`accessibleName` (the `browser_snapshot` vocabulary), an injected `marker` attribute, and live **match-counted** CSS candidates — and the same held browser is attached as the browser tools (`browser_snapshot`, `browser_evaluate`, …). **Verify the pick against the live page before proposing anything, and never hand the QA a selector whose match count you haven't seen.**

## Prerequisites

- An active Mocha pause (`qa-debug.paused` context is true).
- A chrome selected (`selected_cdp_port` non-null). If none is selected, `qa_pick_element` returns `BROWSER_NOT_SELECTED` — run the `qa_get_failure_context` → `qa_select_chrome` flow first, then retry. Selecting the chrome is also what attaches the browser tools you'll verify with.

## When to use

- The failure says *"selector resolved to 0 elements"*, *"expected 1 element matching X but found N"*, or similar selector-anchored shape AND the right element isn't obvious from `browser_snapshot` alone.
- The QA explicitly asks: *"pick this element"*, *"let me show you which one"*, *"the right element is the one labelled X"*, *"identify the button I'm clicking"*.
- Before proposing a selector edit, when you'd otherwise be guessing which node a failing assertion refers to.

## When NOT to use

- No Mocha pause is active (the skill description gates this; do not bypass).
- The failure has nothing to do with an element (value mismatch, network 503, runtime exception, missing fixture data, etc.).
- The right element is already unambiguous from `browser_snapshot` AND matches the project's existing selector pattern — don't interrupt the QA for a free move you've already made.
- The QA is in autopilot and has explicitly delegated selector decisions to you for this session.

## How to invoke

### Step 1 — Tell the QA what's about to happen

One short message in chat:

> *"I'm arming the element picker in the held browser. Hover over the element you mean — Chrome will highlight it — then click it. I'll wait."*

### Step 2 — Call `qa_pick_element`

Call the tool (`session_id` optional — omit to target the active pause). It blocks while the QA hovers and clicks, then returns:

```json
{
  "picked": {
    "tag": "button",
    "id": "container",
    "name": "",
    "classes": ["legend-btn"],
    "data": {},
    "aria": { "pressed": "false" },
    "text": "",
    "role": "button",
    "accessibleName": "Add comparison",
    "marker": { "attr": "data-qa-pick", "value": "1c9f1c52-77b1", "selector": "[data-qa-pick=\"1c9f1c52-77b1\"]" },
    "candidates": [
      { "css": "button#container", "matchCount": 94 },
      { "css": "button[aria-label=\"Add comparison\"]", "matchCount": 1 },
      { "css": "button.legend-btn", "matchCount": 12 },
      { "css": "button", "matchCount": 210 }
    ],
    "uniquePath": "div#legend-row-3 > div.actions > button#container",
    "scope": "document",
    "nthOfType": 1,
    "rect": { "x": 412, "y": 188, "width": 24, "height": 24 },
    "isInteractive": true,
    "shadow": "none",
    "inFrame": true,
    "frameUrl": "https://app.example.com/chart/3.8.37/index.html",
    "frameChain": [
      { "selector": "iframe#app-shell", "url": "https://app.example.com/shell" },
      { "selector": "iframe[name=\"chart\"]", "url": "https://app.example.com/chart/3.8.37/index.html" }
    ],
    "frameChainComplete": true,
    "ancestors": [
      { "tag": "div", "id": "", "classes": ["actions"], "data": {}, "role": "", "ariaLabel": "", "name": "", "selector": "div.actions", "matchCount": 12, "nthOfType": 2 },
      { "tag": "div", "id": "legend-row-3", "classes": ["legend-row"], "data": {}, "role": "listitem", "ariaLabel": "", "name": "", "selector": "div#legend-row-3", "matchCount": 1, "nthOfType": 3, "interactive": true }
    ]
  }
}
```

On timeout (~2 min) or a cancelled turn it returns `{ "cancelled": true, "reason": "timeout" | "cancelled" }` — fall back to your prior plan (don't loop; ask the QA what they want next). Errors: `NO_ACTIVE_PAUSE`, `SESSION_NOT_FOUND`, `BROWSER_NOT_SELECTED` (select a chrome first), `CDP_CONNECT_FAILED`.

**How to read the result:**

- **`role` / `accessibleName`** — the COMPUTED accessibility role and name, exactly what `browser_snapshot` shows (implicit roles included, e.g. `<button>` with no role attribute). This is your bridge into the snapshot.
- **`marker`** — a `data-qa-pick="<nonce>"` attribute injected onto the picked element. The one handle that is unique no matter how hostile the page's own attributes are. **Volatile**: cleared by the next pick in the same document, lost on reload/re-render. Use it to verify; never ship it.
- **`candidates`** — leaf CSS selectors, each with `matchCount` counted **live in the page** within `scope` (the leaf's document or innermost shadow root). The counts are the truth: in the example above, `button#container` looks specific but matches **94** nodes — only the aria-label candidate is unique. **Trust counts over intuition; real apps reuse ids and classes freely.**
- **`uniquePath`** — a `>`-combinator CSS path already verified to match **exactly one** node in `scope`. Your guaranteed-correct plain-CSS answer when no single candidate is unique. `null` only on hostile DOM (fall back to marker + ancestors).
- **`rect`** — border box in the **owning frame's** viewport coordinates (`null` if not rendered). For canvas/chart surfaces there is no DOM below the canvas element — the canvas node + a position relative to `rect` is the locator; say so to the QA instead of inventing a selector for a drawn pixel.
- **`isInteractive`** — `false` means the QA clicked a presentational leaf (an svg path, a span). The nearest `ancestors[]` entry flagged `interactive: true` is usually the element a test should target; raise this in Step 4.
- **`frameChain`** — ordered **outer→inner** iframe ancestry (`{ selector, url }` per `<iframe>`), covering nested AND cross-origin frames. Empty = top document. `frameChainComplete: false` means a level couldn't be resolved — identify that iframe manually.
- **`ancestors`** — within-frame ancestor chain, nearest→outermost, crossing shadow roots (each crossed host flagged `shadowRoot: "open" | "closed"`). Each has its own `selector` + `matchCount` for scoping.
- **`shadow`** — worst shadow boundary on the path: `"closed"` means **no CSS selector can reach the leaf from outside**, and closed-shadow content may be missing from `browser_snapshot` too. Surface this honestly and follow the project's escape hatch (Step 4); don't hand over a selector that silently fails.

### Step 3 — Verify the pick against the live page

The browser tools are attached to the **same held browser** — use them silently before talking to the QA:

1. Call `browser_snapshot` and locate the picked node by `role` + `accessibleName`, inside the right frame (follow `frameChain` / `frameUrl` to the right part of the snapshot).
2. Pin the identity with the marker: `browser_evaluate` on that snapshot ref with a function like `(el) => el.getAttribute('data-qa-pick') || (el.querySelector('[data-qa-pick]')?.getAttribute('data-qa-pick'))` and compare to `marker.value`. (When the QA clicked a presentational leaf, the snapshot node may be the interactive ancestor and the marked node its descendant — that's what the `querySelector` fallback catches.)
3. If `role`/`accessibleName` are empty (canvas, generic containers): skip snapshot correlation — the tool's `uniquePath`/`matchCount` facts were verified live at pick time. Correlate via the nearest ancestor that *does* have a role/name, and use `rect` for position.

If verification fails (no matching ref, marker mismatch), the page likely changed or the click landed off — re-run from Step 1 rather than building on bad data.

### Step 4 — Confirm with the QA in plain language

Show the QA what got picked and what you verified, NOT raw JSON:

> *"You picked the 'Add comparison' button (24×24, in the chart iframe). Heads-up: its id `container` is reused by 94 elements, but its aria-label is unique. Is this the right element?"*

If the leaf wasn't interactive, ask which they mean:

> *"You clicked an svg icon inside the 'Add comparison' button — should the test target the button?"*

Wait for confirmation. If QA says no → loop back to Step 1 with a fresh `qa_pick_element` call.

### Step 5 — Investigate the consumer codebase, build in its convention, prove it

The picker output is deliberately framework-agnostic — it tells you *which element* (verified), not *how this repo writes locators*. **Before writing anything, investigate the consumer project** (a handful of its existing test / page-object / helper files, any locator/selector utilities) and learn:

- **Selector strategy** — what hook the project anchors on (`data-*` test attributes, `id`, role/accessible-name, plain CSS, …).
- **Element API** — how it queries an element (built-in locator API, custom wrapper/helper, page-object methods).
- **Frames** — how its existing tests reach elements *inside* an iframe (the frame-entry idiom it already uses).
- **Shadow DOM** — whether/how it handles shadow roots.
- **Interaction & assertion style** — so your suggestion reads like the surrounding code.

Then build the locator using ONLY verified facts from Steps 2–3, replicating that convention exactly:

- DO NOT assume a framework, and DO NOT copy a selector from training data — the consumer's codebase + the verified pick are the only sources of truth.
- **Pick the hook by match count, in the project's preferred order.** A candidate with `matchCount: 1` in the project's favoured strategy wins; a crowded hook (like the 94× id) needs scoping via `ancestors` (anchor on the nearest ancestor with `matchCount: 1` and descend) or use `uniquePath`.
- **Frames** (`frameChain` non-empty): enter the iframes **outer→inner** the way the project's own tests do. Each `frameChain[i].selector` is plain CSS for the iframe element — reuse it, or rewrite to the project's frame convention using the entry's `url` as a cue.
- **Closed shadow** (`shadow: "closed"`): a CSS path cannot cross it — tell the QA and follow the project's existing escape hatch (or a non-selector strategy). Don't silently emit a selector that can't resolve.
- **Last resort:** `:nth-of-type(n)` paths (the tool only emits them when nothing stable exists). Tell the QA the locator is positional and brittle.
- **Prove before handing over:** when the final locator's target is expressible as CSS or role+name, check it against the live page (find its ref in `browser_snapshot`, or `browser_evaluate` a match count) and confirm it resolves to the marked element, exactly once. If the page was reloaded since the pick (marker gone), say so — or re-pick.

If you can't determine the project's convention from the codebase, ask the QA rather than guessing a framework.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Handing over `candidates[0].css` without reading its `matchCount`. | The counts exist because "specific-looking" hooks are routinely reused (id `container` ×94). A selector with `matchCount > 1` used alone WILL act on the wrong node. |
| Shipping `marker.selector` (`[data-qa-pick=…]`) as the final locator. | The marker is a transient verification handle — cleared on the next pick, gone on reload. Tests built on it fail tomorrow. |
| Skipping Step 3 verification when `role`/`accessibleName` are present. | Snapshot + marker check costs two silent tool calls and catches mis-clicks, stale DOM, and wrong-frame confusion before the QA sees a wrong answer. |
| Skipping Step 4 (QA confirmation in plain language). | The QA may have mis-clicked (sticky headers, overlays); and when the leaf is presentational, only the QA knows whether the test should target the leaf or the interactive ancestor. |
| Calling `qa_pick_element` before a chrome is selected. | Returns `BROWSER_NOT_SELECTED` — and without the selection the browser tools you verify with aren't attached either. |
| Calling `qa_pick_element` again before the first call returns. | It blocks awaiting the QA's click. Wait for it to return (or time out / cancel) before re-invoking. |
| Assuming a framework / pasting a training-data selector. | Output is framework-neutral facts. Investigate the project's existing tests first (Step 5), build in *that* convention; if unclear, ask the QA. |

## Reference

- `qa_pick_element` (qa-debug LM tool) — the picker. Drives Chrome's CDP `Overlay` inspector + verification-ready extraction; see `extension/src/element-picker.ts`.
- `extension/skills/qa-debug/SKILL.md` — the qa-debug investigation flow this skill plugs into (Step 1 / Step 1b for failure context + chrome selection, before proposing a selector edit).
