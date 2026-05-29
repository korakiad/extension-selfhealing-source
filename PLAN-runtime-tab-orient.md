# PLAN — runtime classification + multi-tab orient (Electron / OpenFin)

Status: IMPLEMENTED (Option B approved; design hardened so behavior does not depend on the UA token)
Depends on: [[PLAN-env-leak-scrub]] (so Electron/OpenFin actually launch as GUIs and expose CDP).

Verified: all packages build; extension/mocha-hooks/qa-debug-mcp/evals typecheck clean;
`pnpm test:unit:runtime` (6 checks) + `pnpm test:unit:env` (6 checks) green.
Empirical UA check on the real Refinitiv/OpenFin apps still owed (user).

## 1. Problem

`connectOverCDP` to an Electron / OpenFin runtime surfaces many pages (windows,
webviews). playwright-mcp does not define which page it lands on (README silent),
so `browser_snapshot` may inspect the wrong tab. The agent must pick the right
tab before investigating. For plain Chrome (single tab) there is nothing to pick.

## 2. Signal — what we can and cannot rely on

Verified:
- CDP `/json/version` returns a `User-Agent`; Electron's **default** contains
  `Electron/<v>`, OpenFin's contains `OpenFin`. ✅
- BUT `app.userAgentFallback` lets an app override its UA wholesale
  (electronjs.org/docs/latest/api/app) — a production app (e.g. Refinitiv
  Workspace) may strip the `Electron` token. ✗ not guaranteed.
- `/json/list` page targets are **always** exposed by Electron/OpenFin (that's how
  `chrome://inspect` works) → counting them is override-proof.

Design consequence: **`tab_count` is the load-bearing trigger**; **`runtime` is a
best-effort label** (for QA context + matches the "chrome/Refinitiv/OpenFin"
framing) and is never required for correctness.

## 3. Change

### Data (parity surface)
Add two fields to `AvailableChrome` — **both** definitions must match:
- `mocha-hooks/src/protocol.ts` (zod, wire shape; also add `ChromeRuntime` enum).
- `pause-store-types/src/index.ts` (TS interface; add `ChromeRuntime` type).

New fields (required):
- `tab_count: number` — count of `type === 'page'` targets from `/json/list`.
- `runtime: 'chrome' | 'electron' | 'openfin' | 'unknown'` — from `/json/version`
  `User-Agent` (`openfin` > `electron` > `chrome`; `unknown` if UA absent).

Populate in all **three** parity-locked probes (identical inline logic):
- `mocha-hooks/src/qa-hooks.ts`, `extension/src/lm-tools/probe-ports.ts`,
  `qa-debug-mcp/src/probe-ports.ts`. Each exports `classifyRuntime(ua)`.
- `/json/list` fail → `tab_count = 1` (we know ≥1 since `/json/version` succeeded);
  never forces a false multi-tab.

Migration (`normalizePausePayload`): default missing fields on old stored data —
array passthrough → `tab_count = page_titles.length || 1`, `runtime = 'unknown'`;
legacy single-entry → `tab_count: 1, runtime: 'unknown'`.

The fields flow into `FailureContextView.available_chromes` automatically
(`toFailureContextView` passes the array through) — no view change needed.
`ChromeSelection` unchanged (agent reads the selected chrome's fields from
`available_chromes` via `selected_cdp_port`).

### Guidance
- `extension/skills/qa-debug/SKILL.md` — new **Step 1c "Orient on the runtime,
  land on the right tab"** between 1b and 2: if selected chrome `tab_count > 1`,
  `browser_tabs(action:"list")` → match the page under test (title/URL) → ask the
  QA if ambiguous (mirror the 1b "which chrome?" ask, surface `runtime` + titles)
  → `browser_tabs(action:"select", index)` → then `browser_snapshot`. `tab_count
  <= 1` → snapshot directly (no friction). Checklist line + one anti-pattern row.
- `tool-contracts/src/tools.ts` — update the `available_chromes` return-shape
  strings to `{port, ws_url, page_titles, tab_count, runtime}` and add the
  `tab_count > 1 → browser_tabs` note to the `qa_get_failure_context` branching.

### Tests
- `extension/test/runtime-classify.test.mts` — `classifyRuntime` unit
  (electron/openfin/chrome/unknown + case-insensitivity). `pnpm test:unit:runtime`.

## 4. Verify
- `tsc --noEmit` clean across packages; unit tests green.
- Empirical (user, real apps): `curl -s localhost:<port>/json/version` →
  confirm the `User-Agent` token for Refinitiv / OpenFin (if Refinitiv overrides
  UA, `runtime` shows `chrome`/`unknown` but `tab_count > 1` still triggers 1c).

## 5. Risk
- `browser_tabs` index ordering may differ from `/json/list`; the SKILL gets the
  authoritative index from `browser_tabs(action:"list")`, not from `page_titles`.
- A Chrome test that opens a popup (`tab_count 2`) triggers 1c — correct, just an
  extra ask; not harmful.
