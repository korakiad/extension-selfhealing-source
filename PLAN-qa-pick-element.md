# PLAN — `qa_pick_element` (CDP-native element picker)

> **Iter#2 (2026-06-01) — APPROVE-WITH-POLISH.** Re-review confirmed B1 + B2 genuinely fixed in code (session routing, recursive auto-attach, per-emitting-session resolve, ws cleanup all verified correct; no new blockers). Applied the two cheap polish items: guard `r.result?.value` before `JSON.parse` (F2); comment documenting the OOPIF arm-race degrades to "click again", never misfires (F1). Remaining (benign/deferred): Promise.race losers GC'd (no leak — no action); `prepareInvocation` confirmation (F4); multi-tab page-target selection (Q1/F5). `tsc --noEmit` clean, `gen-lm-tools --check` in sync, esbuild OK.

> **Iter#1 (2026-06-01)** — addresses reviewer's iter#0 REQUEST_CHANGES.
> - **B1 (cross-origin OOPIF picking broken — single session, no auto-attach) — FIXED.** `cdp-inspect.ts` rewritten to be session-aware: `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:false})` on the page session (recursively on each child), arms `DOM/Runtime/Overlay`+`setInspectMode` on EVERY attached frame session, routes messages by `sessionId`, and resolves the picked node on the SAME session that emitted `Overlay.inspectNodeRequested`. **Proven live:** (a) auto-attach armed a real cross-site OOPIF (`amers1.identity.ppe.ciam.refinitiv.net`, different eTLD+1 from `workspace.ppe.refinitiv.com`); (b) `DOM.resolveNode`+`Runtime.callFunctionOn` on that OOPIF's child session read its DOM, returning `frameOrigin: https://amers1.identity.ppe.ciam.refinitiv.net`, `inFrame:true` — i.e. the exact resolve path the picker uses works inside a cross-origin OOPIF.
> - **B2 (inFrame/frameUrl wrong in single-session) — FIXED by the same change:** `EXTRACT_FN` now runs via `callFunctionOn` on the owning frame's session, so `window.top!==window.self` / `location.href` report the real owning frame.
> - **F1/F2 — DONE:** `ws.removeAllListeners()` on teardown; all in-flight `pending` rejected on `close()` and on the `ws 'close'` event (no hang past teardown).
> - **F3 — DONE:** deleted the orphaned `browser_evaluate` picker artifacts (`extension/skills/identify-element/pick-element.js`, `extension/tools/identify-element-playground.html`, `evals/src/identify-element.test.ts`, and the `picker-smoke` script).
> - **F4 (prepareInvocation confirmation), F5 (multi-tab page selection = PLAN Q1)** — deferred follow-ups, see below.
> Re-verified: `gen-lm-tools --check` in sync, `tsc --noEmit` clean, esbuild bundle OK, same-origin+shadow pick still resolves (no regression).

> **Iter#0 (2026-06-01)** — initial draft for Ralph-loop review. Implementation already landed in the working tree (uncommitted) and smoke-validated against a live target; this PLAN documents the decision + contracts retroactively so the reviewer can REQUEST_CHANGES against real code, not a sketch. Files: `extension/src/cdp-inspect.ts`, `extension/src/lm-tools/pick-element.ts`, `tool-contracts/src/tools.ts` (+`errors.ts`), `extension/src/lm-tools/index.ts`, `extension/package.json`, `extension/skills/identify-element/SKILL.md`.

## Problem

The `identify-element` skill let the agent visually identify a DOM node by injecting a page-script picker (`document.elementFromPoint`) into the held browser via playwright-mcp `browser_evaluate`. A page-script picker cannot be transparent for the end-user QA because it hits three encapsulation boundaries it can't cross:

1. **Iframes (same- and cross-origin).** Mouse events over an iframe go to the iframe's own document, never the parent; a cross-origin iframe's DOM is unreadable from the parent entirely. Reaching inside needs the picker injected *into each frame*. playwright-mcp `browser_evaluate` with no `target` runs only in the **main frame** (verified: `playwright-core@…/coreBundle.js` `evaluate` handler → `tab.page.evaluate`); with a `target` ref it runs in one frame via `locator.evaluate`. There is no all-frames injection through the MCP, so the prior fix required an agent-driven snapshot→ref→re-inject "Step 2b" — extra clicks and frame-awareness leaked to both agent and QA. Violates the transparent-use mandate.
2. **Open shadow DOM / web components.** `elementFromPoint` stops at the shadow host. Verified live on Refinitiv Workspace: the chart panel is `<chart-web-component>` (open shadow, nested `ef-*` web components); the picker highlighted the whole component and could not reach the toolbar tools. Page script *can* pierce open shadow by recursing `shadowRoot.elementFromPoint`, but…
3. **Closed shadow DOM.** `el.shadowRoot` is `null` for closed roots — page script cannot pierce them at all.

## Goal

One transparent picker: the QA hovers and clicks **once, anywhere**, with zero awareness of frames or shadow roots, and the agent gets the real leaf element's attributes + a project-buildable locator. Must work for cross-origin iframes, open AND closed shadow DOM, web components, and canvas overlays.

## Approach — Chrome's native DevTools inspector over CDP

Drive the browser's own element inspector via the CDP `Overlay` domain: `Overlay.setInspectMode({mode:'searchForNode'})` → QA hovers (Chrome highlights, browser-process hit-test) → click fires `Overlay.inspectNodeRequested({backendNodeId})` → resolve attributes via `DOM.resolveNode` + `Runtime.callFunctionOn`. Because the hit-test runs in the browser process, it pierces all three boundaries with **zero injection**.

This **cannot be a SKILL-only or `browser_evaluate` change**: `Overlay.setInspectMode` is a CDP command, not page JS, so the agent's only page surface (`browser_evaluate`) can't reach it. The single agent-reachable CDP escape hatch is playwright-mcp `browser_run_code_unsafe` (RCE-equivalent) — rejected as incompatible with the narrowed-MCP / transparent-use posture. Therefore the picker must be **extension-driven**: the extension already owns the held-browser CDP endpoint, so it opens a raw `ws` CDP session and drives Overlay itself, exposing the result as an LM tool.

## Confirmed invariants (verified, not assumed)

- `browser_evaluate` no-`target` → main frame only; `target` → one frame via `locator.evaluate` (`@playwright/mcp@0.0.75` → `playwright-core/lib/coreBundle.js`).
- `Overlay.setInspectMode`/`DOM.getNodeForLocation` pierce iframe + open/closed shadow at the renderer level — verified live: `DOM.getNodeForLocation` at a chart-toolbar point returned `svg#clock` inside the chart's open shadow DOM; the interactive Overlay pick returned `ef-button.event-markers-button` with `data-e2e`, `role`, `inFrame:true` through iframe+shadow.
- A child-frame snapshot/ref carries an `f<seq>` prefix (`refPrefix: frame.seq ? "f"+frame.seq : ""`) — i.e. playwright-mcp snapshots already descend into cross-origin frames (corroborates the boundary analysis).

## Decision

- **Pause-gated** LM tool `qa_pick_element` (`when: qa-debug.paused`), NOT always-on. Rationale: there is no CDP endpoint outside a pause (`cdp_ws_url` is only populated after chrome selection; playwright-mcp/discovery are pause-scoped). An always-on picker would need its own discovery/connection model — out of scope; revisit only if a non-pause use case appears.
- **Reads the committed chrome from the pause store** (no discovery in this tool): selected port → `available_chromes[].ws_url`. Errors `BROWSER_NOT_SELECTED` if no selection.
- **Connects directly** to the real chrome endpoint via raw `ws` (bundled dep), bypassing both playwright-mcp and the cdp-download-shim — Overlay needs neither (no downloads, no Playwright handshake).
- The `identify-element` SKILL is retained but **routes to `qa_pick_element`** (its JS-injection mechanics/inline picker removed).

## Contracts

### Tool `qa_pick_element` (tool-contracts/src/tools.ts → qaTools)
- Input: `{ session_id?: string }` (omit → active pause). zod + JsonSchema, `additionalProperties:false`.
- Output on click: `{ picked: { tag, id, name, classes:string[], data:Record<string,string> (data-* de-prefixed), aria:Record<string,string> (incl. role), text (<=200), inFrame:boolean, frameUrl:string, suggestedLocator:string } }`.
- Output on timeout/cancel: `{ cancelled:true, reason:'timeout'|'cancelled' }`.
- `suggestedLocator` preference: `data-e2e/test/testid/test-id → id → role → first class → tag`; wrapped in `frameLocator(/* iframe at <frameUrl> */)…` when `inFrame`. Hint only — Step 4 builds the project-matched selector.
- Errors: `NO_ACTIVE_PAUSE`, `SESSION_NOT_FOUND`, `BROWSER_NOT_SELECTED`, `CDP_CONNECT_FAILED` (new code in `tool-contracts/src/errors.ts`).
- Annotations: `{ readOnlyHint:true, openWorldHint:false }` (transient overlay; no page DOM mutation; closed world = the held browser).

### `extension/src/cdp-inspect.ts` (host-agnostic; no `vscode` import)
- `resolvePageWsUrl(httpRoot): Promise<string>` — `/json/list` → first non-blank `type==='page'`'s `webSocketDebuggerUrl`. Throws `CDP_CONNECT_FAILED` on unreachable/no-page.
- `pickElementViaOverlay(selectedChromeWsUrl, opts?: { timeoutMs?=120000, signal?:AbortSignal, log? }): Promise<PickResult>` — derives http root from the browser ws_url, resolves a page ws, enables `DOM/Runtime/Overlay`, `setInspectMode(searchForNode)`, races click vs timeout vs abort, always restores `setInspectMode(none)`, extracts attributes via `DOM.resolveNode`+`Runtime.callFunctionOn(EXTRACT_FN)`.

### `extension/src/lm-tools/pick-element.ts`
- `PickElementTool` reads `pauseStore.getActivePause(session_id)` → `selected_cdp_port` → `available_chromes` entry → `ws_url`; bridges `CancellationToken`→`AbortController`; returns `jsonResult`/`toErrorResult` per the base helpers.

### Registration / manifest
- `lm-tools/index.ts`: `vscode.lm.registerTool('qa-debug_qa_pick_element', new PickElementTool(deps))`.
- `package.json`: entry `qa-debug_qa_pick_element`, `when: qa-debug.paused`, `icon:$(inspect)`; `modelDescription`+`inputSchema` generated by `gen-lm-tools.mjs` from the contract (verified `--check` in sync).

## Touch points
- NEW `extension/src/cdp-inspect.ts`, `extension/src/lm-tools/pick-element.ts`.
- EDIT `tool-contracts/src/{tools.ts,errors.ts}`, `extension/src/lm-tools/index.ts`, `extension/package.json`, `extension/skills/identify-element/SKILL.md`.
- ORPHANED by the SKILL rewrite (no longer referenced): `extension/skills/identify-element/pick-element.js`, `extension/tools/identify-element-playground.html`, `evals/src/identify-element.test.ts` (+`picker-smoke` script). Recommend removal — see Open Q3.

## Verification done
- `gen-lm-tools --check` in sync; `tsc -p tsconfig.json --noEmit` clean; `esbuild` bundle OK (ws bundles under CJS).
- Smoke (real module, esbuild CJS bundle, live Chrome): returned `ef-button.event-markers-button` `{ data-e2e, role:button, inFrame:true, frameUrl, suggestedLocator: frameLocator(...).locator('[data-e2e="event-markers-button"]') }` — pierced iframe + open shadow, zero injection.

## Open questions / risks (for the reviewer)
- **Q1 page-target selection.** v1 picks the first non-blank `type==='page'` from `/json/list`. Multi-tab/Electron/OpenFin (the same case the `qa_get_failure_context` multi-tab-orient note warns about) may arm the inspector on the wrong page. Mitigation options: accept an optional target index, or reuse the orient hint. Decision needed.
- **Q2 security/isolation.** The tool opens a raw CDP connection to the browser, bypassing the narrowed playwright-mcp gate + the cdp-download-shim. Is direct extension-owned CDP acceptable given the org's MCP restrictions (CDP ≠ MCP; the extension already probes `/json/*` and binds the shim)? Confirm no policy conflict.
- **Q3 orphaned JS picker.** Delete `pick-element.js` + playground + `identify-element.test.ts` now, or keep as a documented fallback? Keeping them is dead code + drift (their shadow-piercing change was never synced to the old SKILL inline copy). Recommend delete.
- **Q4 timeout/UX.** 120s fixed timeout; no in-browser "Esc to cancel" affordance (Overlay searchForNode doesn't emit a cancel event). Acceptable, or add a status-bar cancel?
- **Q5 verb surface.** This is the 4th pause-gated verb on a deliberately tight surface. Justified by transparency win? (The 3-verb "pure inspection hold" framing — a picker is inspection, so it arguably fits.)
- **Q6 page lifecycle.** If the page navigates between `resolvePageWsUrl` and the click, the session may drop. Currently surfaces as `CDP_CONNECT_FAILED`/timeout. Acceptable for v1?
