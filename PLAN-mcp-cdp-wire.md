# PLAN — wire hook-discovered CDP URL into playwright-mcp `--cdp-endpoint`

## Bug (one-liner)

`session-manager.ts:306` registers playwright-mcp with `this.deps.chrome.cdpHttpEndpoint` (hardcoded `http://localhost:9222`, the extension's Mode B chrome) instead of `wire.cdp_ws_url` that the hook just published. In Mode A — where wdio + chromedriver launched the real test browser on a different port — playwright-mcp attaches to the wrong chrome (extension's empty Mode B chrome, only `chrome://new-tab-page/`) and the agent cannot see the page the test was driving. Symptom matches user-reported "MCP only sees `chrome://new-tab-page/`".

## Root cause

Mode-A/Mode-B asymmetry was never resolved at the MCP registration boundary. Hook discovers the real CDP URL in `qa-hooks.ts:267-284` via `getPuppeteer().wsEndpoint()` (Mode A) or env fallback (Mode B), publishes it in `wire.cdp_ws_url`, session-manager stores it via `wireToStored` (line 492) — but the live `setPaused` call on line 306 throws that value away and uses the hardcoded Mode B HTTP endpoint instead. The stale-resume path (line 175) IS already using `stale.cdp_ws_url` (with naive `ws:`→`http:` replace), so the two paths are inconsistent — fresh pauses are broken, stale-resume is at least pointing at the right port.

## Fix shape

In `wireConnection`'s `pausePublish` handler (`session-manager.ts:300-306`), pass `wire.cdp_ws_url` (after normalization to HTTP root form via `new URL(...).host`) to `mcpProvider.setPaused` instead of `this.deps.chrome.cdpHttpEndpoint`. Add a small `cdpWsUrlToHttpRoot` helper and reuse it from the stale-resume path (line 175) so both fresh and resumed pauses share one canonical conversion. No protocol change, no MCP-provider change, no chrome.ts change.

## Touchlist

1. **`extension/src/session-manager.ts`** — add module-private helper:
   ```typescript
   /**
    * Convert a CDP WebSocket URL (e.g. `ws://127.0.0.1:12345/devtools/browser/<UUID>`
    * or `ws://localhost:9222`) to the HTTP root form (`http://host:port`).
    * Playwright connectOverCDP accepts BOTH ws-with-path AND http-root forms per
    * its docs (playwright/class-browsertype.md). We canonicalize to http-root to
    * stay aligned with chrome.ts:138 (Mode B's `cdpHttpEndpoint`) — single shape
    * across both modes simplifies the audit log + diagnostic surface.
    */
   function cdpWsUrlToHttpRoot(wsUrl: string): string {
     const u = new URL(wsUrl);
     return `http://${u.host}`;
   }
   ```
   ~6 LOC. Place above `wireToStored` (line 480) — module-private helpers cluster there already.

2. **`extension/src/session-manager.ts:306`** — replace:
   ```typescript
   this.deps.mcpProvider.setPaused(this.deps.chrome.cdpHttpEndpoint);
   ```
   with:
   ```typescript
   this.deps.mcpProvider.setPaused(cdpWsUrlToHttpRoot(wire.cdp_ws_url));
   ```
   `wire` is already in scope (line 301: `const wire = WirePausePayload.parse(raw);`). 1 LOC change.

3. **`extension/src/session-manager.ts:175`** — replace:
   ```typescript
   this.deps.mcpProvider.setPaused(stale.cdp_ws_url.replace(/^ws:/, 'http:'));
   ```
   with:
   ```typescript
   this.deps.mcpProvider.setPaused(cdpWsUrlToHttpRoot(stale.cdp_ws_url));
   ```
   Single conversion path. 1 LOC change.

4. **`extension/src/session-manager.ts`** — at line 306 area, add one `appendInfo` audit line so the wire-discovered URL is visible in the Output Channel for diagnostics:
   ```typescript
   appendInfo(
     this.deps.channel,
     `[session-manager] mcpProvider.setPaused endpoint=${cdpWsUrlToHttpRoot(wire.cdp_ws_url)} mode=${wire.mode}`,
   );
   ```
   Mirrors the existing positive-logging convention in `qa-hooks.ts:272`. ~4 LOC.

5. **No change to `chrome.ts`** — `cdpHttpEndpoint` getter (line 138) stays. It's still used for the env-var injection at line 241 (`QA_DEBUG_CDP_WS_URL`) which seeds the Mode B fallback for hooks that can't reach `getPuppeteer()`. Touching it is out-of-scope.

6. **No change to `mcp-provider.ts`** — `setPaused(cdpHttpEndpoint: string)` signature is unchanged; we just pass a different (correct) value into it.

## Key design decisions (these need review)

- **Convert to HTTP root form, not pass ws-with-path through.** Both work per Playwright docs (BrowserType.connectOverCDP accepts `http://localhost:9222/` OR `ws://127.0.0.1:9222/devtools/browser/<UUID>`). Choosing HTTP root because: (a) it matches the existing `cdpHttpEndpoint` shape and the parameter name `cdpHttpEndpoint` in `mcp-provider.setPaused`; (b) `/devtools/browser/<UUID>` is brittle — if the browser's default target changes between discovery and Playwright connect, the UUID can mismatch; HTTP root lets Playwright re-discover via `/json/version`.
- **Apply the conversion at the registration site, not in `wireToStored`.** Stored payload keeps the ws form (canonical) — only the MCP-bound copy gets converted. Reason: `cdp_ws_url` field in PausePayload is also surfaced in chat-participant.ts:55 + pause-status-bar.ts:60 + test-controller.ts:539 messages where a ws URL is what the user expects to copy/paste into devtools. Don't mutate canonical storage to serve one consumer.
- **Trust `wire.cdp_ws_url` even in Mode B.** In Mode B the hook falls back to `process.env.QA_DEBUG_CDP_WS_URL` (`qa-hooks.ts:283`) which session-manager injected from `chrome.cdpWsEndpoint` (line 241). So `wire.cdp_ws_url` in Mode B == `ws://localhost:9222` == round-trip of what we used to pass directly. The conversion is a no-op-equivalent in Mode B and a correctness fix in Mode A. No mode-branch needed.
- **Use `URL` constructor, not regex.** Node 18+ guarantees `URL` is global. Handles both `ws://host:port` (no path) and `ws://host:port/devtools/browser/<UUID>` (with path) uniformly via `.host` (host:port).

## Acceptance gate

1. **Manual repro on `fixture-tests-wdio/specs/selector.spec.js`:**
   - Pre-fix: F5 reload → run fixture → on pause, ask agent to navigate browser → agent reports `chrome://new-tab-page/` only. Failure mode confirmed.
   - Post-fix: same flow → agent sees the actual file URL the test navigated to (`file://.../site/index.html` per `selector.spec.js:7-9`). Page DOM accessible via Playwright MCP tools.
   - Output Channel "QA Debug Companion" shows `[session-manager] mcpProvider.setPaused endpoint=http://127.0.0.1:<port> mode=A`.
2. **Mode B fallback unchanged:** if `getPuppeteer()` fails (forced via a wdio capability that triggers the four-branch dispatch throw), hook emits ws URL = `ws://localhost:9222`; conversion yields `http://localhost:9222`; playwright-mcp connects to extension's chrome as before. No regression.
3. **Stale-resume path:** kill the Extension Host mid-pause, reactivate. `resumeStalePauseIfAny` fires; Output Channel shows the same `http://host:port` form passed to `setPaused`. Decision path completes (mark_passed / give_up clears).
4. **TS build:** `pnpm -r build` + `pnpm -r build:check` green. No new type errors. `URL` is in `lib.dom.d.ts` / Node types — no import needed.
5. **No reporter / hook / protocol churn.** `mocha-hooks/` and `pause-store-types/` workspaces unchanged. S2 reporter snapshot untouched.

## Out of scope

- Eliminating the extension's Mode B chrome spawn when Mode A is in use (chrome.ts:5-7 unconditionally spawns on suite start). Separate concern; track for v5.9+ if memory churn becomes an issue.
- Surfacing the discovered Mode A port in the status-bar tooltip distinctly from Mode B 9222.
- Auto-detection of port conflicts (e.g., the custom framework's locked port already in use by another process).
- Unit test for `cdpWsUrlToHttpRoot` — it's 2 LOC of `URL` parsing; the integration test in the acceptance gate exercises it end-to-end.

## Risks

- **`URL` parser throws on malformed input.** If `wire.cdp_ws_url` is somehow not a valid URL (shouldn't happen — `WirePausePayload` is zod-parsed and the hook only ever writes ws-formatted strings), the throw bubbles up out of the `pausePublish` handler. Mitigation: existing JsonRpcConnection handler wraps in try/catch and returns an error response to the hook; pause never registers; user sees test fail without companion engagement. Acceptable failure mode (loud, not silent).
- **Playwright-mcp version drift.** `npx -y @playwright/mcp@latest` (mcp-provider.ts:45) pulls latest. Playwright connectOverCDP URL semantics are documented since v1.8 (launchServer doc) and have been stable; risk is low but not zero. If `latest` ever rejects http-root form, fall back to passing `wire.cdp_ws_url` verbatim (Playwright accepts ws form too per the same doc).
- **Mode field is informational only.** `wire.mode` is logged but not branched on. Reason: the URL itself is correct in both modes; branching adds surface area without behavior gain.

## References

- Playwright `BrowserType.connectOverCDP` endpoint URL spec — accepts http-root OR ws-full-path: https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsertype.md (via context7 `/microsoft/playwright`, 2026-05-21).
- Playwright MCP `cdpEndpoint` config field — passes through to connectOverCDP: https://github.com/microsoft/playwright-mcp/blob/main/README.md (via context7 `/microsoft/playwright-mcp`, 2026-05-21).
- Hook discovery path: `mocha-hooks/src/qa-hooks.ts:265-284`.
- Wire payload shape: `mocha-hooks/src/protocol.ts` (`PausePayload` zod schema).
- Mode A engagement contract: ARCHITECTURE-CR-v5.2 §2.2-§2.5 (transparent-use mandate; `[[feedback-transparent-use]]`).
