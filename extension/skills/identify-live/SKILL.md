---
name: identify-live
description: Use ONLY when a Live Inspect Session is active (the QA launched their own running web/desktop app via "QA Debug: Inspect App") and the agent or QA needs to visually identify a DOM element — with NO failing test involved. Engages when the QA says "pick this element", "show me which element you mean", "let me identify it on my app", "identify the button" while inspecting a launched app. Routes to the qa-debug `qa_pick_element` tool, which arms Chrome's native element inspector in the launched app — the QA hovers and clicks one element, the tool returns a verification-ready description (computed role/name, injected marker, match-counted CSS candidates), and the agent VERIFIES the pick through the attached qa-debug-cdp browser tools before building a project-matched locator. If a Mocha test IS paused instead, defer to the `identify-element` skill. Does NOT engage when no Live Inspect Session is active — run "QA Debug: Inspect App" first.
---

# /identify-live — Visual element picker on a launched app (no pause)

A **Live Inspect Session** is active: the QA launched one of their own apps (via the **QA Debug: Inspect App** command / status-bar button) so you can identify elements against the **real running app**, with no failing test. Use the **`qa_pick_element`** tool to have the QA click the target. It arms Chrome's own DevTools element inspector over CDP — the QA hovers (Chrome highlights) and clicks once, and the browser-process hit-test transparently pierces **cross-origin iframes, open and closed shadow DOM, web components, and canvas overlays**.

This skill is the no-pause sibling of `identify-element`. The picker tool, its output shape, and the verify → confirm → adapt steps are identical — the only differences are the entry (a launched app, not a paused test) and that the launched browser is auto-selected, so there is no chrome-selection step.

## Prerequisites

- An active **Live Inspect Session** (`qa-debug.liveSession` context is true). If none is active, `qa_pick_element` returns `NO_ACTIVE_INSPECTION` — tell the QA to run **QA Debug: Inspect App** first. No settings are required: it asks inline for the kind (Web / Electron / OpenFin) + the URL or executable path, and the web browser auto-detects.
- The launched browser is auto-selected — no `qa_select_chrome` step — and it is attached as the **`qa-debug-cdp`** browser tools (`browser_snapshot`, `browser_evaluate`, …), which is what you verify the pick with. If the app navigated, opened tabs, or restarted and the picker can't reach it, call **`qa_start_live_session`** to re-probe.

## When to use

- The QA asks: *"pick this element"*, *"let me show you which one"*, *"identify the button I'm clicking"*, *"the right element is the one labelled X"* — while inspecting a launched app.
- You need to know exactly which DOM node the QA means and `browser_snapshot` (via `qa-debug-cdp`) alone doesn't disambiguate.

## When NOT to use

- A Mocha test is paused → use **`identify-element`** + the pause flow instead.
- No Live Inspect Session is active → run **QA Debug: Inspect App** first.
- The right element is already unambiguous from `browser_snapshot` AND matches the project's pattern — don't interrupt the QA for a free read.

## How to invoke

The flow is `identify-element` Steps 1–5 verbatim — read that skill for the full field-by-field contract and the verification recipe. Summary:

1. **Announce**: *"I'm arming the element picker in the inspected app. Hover over the element you mean — Chrome will highlight it — then click it. I'll wait."*
2. **Pick**: call `qa_pick_element` (`session_id` optional). Returns `{ picked: { tag, id, name, classes, data, aria, text, role, accessibleName, marker, candidates, uniquePath, scope, nthOfType, rect, isInteractive, shadow, inFrame, frameUrl, frameChain, frameChainComplete, ancestors } }`, or `{ cancelled: true, reason }` on timeout/cancel. The three verification handles: `role`+`accessibleName` (computed — the `browser_snapshot` vocabulary), `marker` (injected `data-qa-pick` attribute — unique, volatile, never the final locator), and `candidates`/`uniquePath` (plain CSS with **live match counts** — trust the counts, not intuition).
3. **Verify silently** via the `qa-debug-cdp` browser tools: `browser_snapshot` → find the node by role + accessibleName in the right frame → `browser_evaluate` on that ref to check the `data-qa-pick` marker. If role/name are empty (canvas/containers), lean on `uniquePath`/`rect` and the nearest named ancestor. If verification fails, re-pick — don't build on bad data.
4. **Confirm with the QA in plain language** (what was picked + anything you verified, e.g. an ambiguous id), NOT raw JSON. If the leaf wasn't interactive, ask whether the test should target the `interactive: true` ancestor instead.
5. **Investigate the consumer codebase, build in its convention, prove it**: learn the project's selector strategy / element API / frame idiom / shadow handling from its own tests, build the locator from verified facts only (pick hooks by `matchCount`; scope crowded hooks with `ancestors` or use `uniquePath`; walk `frameChain` outer→inner in the project's idiom; surface `shadow: "closed"` honestly; `:nth-of-type` last resort), then check the final locator resolves to the marked element exactly once before handing it over. If the convention isn't discoverable, ask the QA rather than guessing a framework.

Errors: `NO_ACTIVE_INSPECTION` (no live session — launch one), `CDP_CONNECT_FAILED` (the app was unreachable or exposed no page target yet — if it just launched, wait a moment / confirm the URL opened, then retry; or `qa_start_live_session` to re-probe). For a desktop app exposing multiple windows on one port, the picker arms the first one — tell the QA which window is being inspected.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Launching/relaunching the app yourself. | The extension owns the launch (QA Debug: Inspect App). If the session is stale, call `qa_start_live_session`; if absent, ask the QA to launch. |
| Handing over a candidate without reading its `matchCount`, or shipping `marker.selector` as the locator. | Counts are the truth (ids/classes get reused ×dozens); the marker is transient and dies on reload. |
| Skipping verification (Step 3) or QA confirmation (Step 4). | Two silent tool calls catch mis-clicks and stale DOM; only the QA can confirm leaf vs. interactive ancestor. |
| Assuming a framework / pasting a training-data selector. | Output is framework-neutral facts. Investigate the project's existing tests first, build in *that* convention. |
| Using this skill during a Mocha pause. | Use `identify-element` then — the pause flow has its own chrome selection. |

## Reference

- `qa_pick_element` (qa-debug LM tool) — the picker, shared with the pause flow; drives Chrome's CDP `Overlay` inspector + verification-ready extraction (`extension/src/element-picker.ts`).
- `qa_start_live_session` — re-establishes the live CDP target after navigation/restart.
- `extension/skills/identify-element/SKILL.md` — the pause-flow sibling; full picker-output contract + verification recipe + Step 5 detail live there.
