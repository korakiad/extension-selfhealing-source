# CR — identify-live: extension-launched Live Inspect Session (v1)

> Architectural CR (Ralph-loop, [[feedback-ralph-loop]]). Structure + contracts, not function bodies
> ([[feedback-plan-style]]). Supersedes the earlier "always-on sibling picker" PLAN. Retire into
> ARCHITECTURE.md / CHANGELOG.md once landed.

## 1. Requirement (QA, 2026-06-09) + locked direction

QA wants the **element picker / inspection tools usable without a paused test** — point them at their own web
or desktop app. Decisions locked over the design conversation:

- **Targets:** web (Chrome/Edge) **and** desktop (Electron/OpenFin).
- **Entry = extension-owned launch via a simple UI.** A button/command launches the QA's app with the debug
  port; because the extension spawned it, it *knows* a debuggable browser exists for this VS Code session.
  That launch is the trigger (the analog of a test-failure event in the pause flow).
- **Web profile = a PER-PROJECT persistent debug profile** (`--user-data-dir = context.storageUri/chrome-debug-profile`,
  which is workspace-scoped). Login once **per project**; persists. Chrome is single-instance **per
  `--user-data-dir`** (independent of port), so a per-project dir is what lets **multiple project windows run
  their own web Chrome in parallel** (chosen 2026-06-09 — "parallel web per project"). A non-default dir is
  required anyway: Chrome 136+ refuses CDP on the **default** profile dir
  (developer.chrome.com/blog/remote-debugging-port — *"These switches will no longer be respected if
  attempting to debug the default Chrome data directory"*). Desktop apps keep their own logins natively (own
  embedded Chromium + data dir), so this is web-only.
- **Port collisions across projects** are avoided by allocating a **free port from a pool per launch**
  (`qaDebug.cdpPorts`), NOT a fixed default — each window owns a distinct port. (Multi-project safety; see §2.)
- **General start verb name = `qa_start_live_session`** (a reusable primitive; not picker-specific).
- **MVP = launch-only entry.** "Attach to an app the QA already started" is a documented follow-up (§7).

## 2. Core idea — a "Live Inspect Session" that mirrors the Pause

The pause flow already surfaces browser tools to a scoped agent. We replicate its shape for a non-failure,
extension-launched session. Two DIFFERENT gating mechanisms are at play in the pause flow; only one transfers
for free:

- **MCP browser tools (`qa-debug-cdp/* → browser_*`)** appear only during a pause because the MCP server is
  **registered** then (`mcpProvider.setPaused(endpoint)` on chrome-select; unregistered on teardown). The
  tools don't exist outside the session. → **Transfers for free**: the live session calls the same
  `setPaused(endpoint)` on launch-up; `browser_*` surface only during the live session.
- **Static LM verbs** (`qa_pick_element`, …) are gated by a `when` **context key** (`qa-debug.paused`), flipped
  by the failure event. → The live flow has no auto event, so the **launch** flips a new `qa-debug.liveSession`
  key. No always-on LM tool is needed: the UI launch is the trigger.

| Aspect | Pause (today) | Live Inspect Session (new) |
|---|---|---|
| Trigger | test fails (`pausePublish` IPC) | QA clicks "Inspect App" → extension spawns the app |
| Context key | `qa-debug.paused` | `qa-debug.liveSession` |
| Browser owner | `framework` (Mode C) | `companion` (extension spawned it) |
| Chrome discovery | probe at pause | probe the spawned app's port until up |
| MCP registration | `mcpProvider.setPaused(endpoint)` | **same call** |
| Custom agent | `qa-debug` (`when: qa-debug.paused`) | `qa-automation` (mode; participant `@qa-agent`; always available) |
| LM-verb gate | `when: qa-debug.paused` | `when: qa-debug.liveSession` |
| Picker target | active pause's selected chrome | active live session's selected chrome |
| Teardown | decision / child-exit | "Stop Inspection" / window close / app exit |

**Concurrency — two distinct scopes:**

**(a) Within ONE window: at most ONE active inspection, enforced by a SHARED BIDIRECTIONAL guard.**
`mcpProvider` holds a single endpoint (`mcp-provider.ts:28` `State = 'idle' | {kind, cdpHttpEndpoint}`;
`setPaused` overwrites) — a pause and a live session in the same ext host would clobber each other. A one-way
guard is NOT enough: `SessionManager.runFixtureSuite` (`session-manager.ts:324`) today only checks its own
`activeRun` and would start a Mocha run (→ pause → `setPaused`) on top of a live session. So both entry points
consult a **single shared "inspection active" arbiter** (a predicate both `SessionManager` and
`LiveSessionManager` query before binding MCP), not two independent flags. The arbiter also drives
**status-bar arbitration** so the live and pause/run items never both show an active inspection.

**(b) Across windows (multi-project — the consumer juggles many): NO shared arbiter exists** (each window is a
separate ext host with its own `mcpProvider`). Cross-window safety instead comes from **resource isolation**:
each launch allocates a **distinct free port** (§3.1/§3.3) and web uses a **per-project profile dir** (§1), so
two projects never collide on the CDP port or the Chrome single-instance lock. There is deliberately **no**
hard cap on concurrent windows — only the port pool bounds simultaneous sessions (exhaustion → clear error).

## 3. Components & contracts

### 3.1 Config

- **`qaDebug.liveApps`** — `array` of launch specs. Each:
  `{ "label": string, "type": "web"|"desktop", "url"?: string, "binary"?: string, "args"?: string[], "port"?: number }`.
  - `type:"web"` requires `url`; launches the configured browser at `url`.
  - `type:"desktop"` requires `binary`; launches it with `args`.
  - `port` defaults to `qaDebug.cdpPorts[0]`.
- **`qaDebug.webBrowserBinary`** — `string`, path to the Chrome/Edge executable used for `type:"web"` launches
  (QA fills on their laptop; this is the "placeholder" made concrete). Empty → per-OS best-effort default
  lookup, else a clear error.
- **`qaDebug.cdpPorts`** — `array<integer>`, the **port POOL** to allocate from (one per concurrent inspect
  session across all windows). Default widened to `[22135, 22136, 22137, 22138, 22139]` (5 concurrent
  projects); document that a consumer running more simultaneous inspections should extend it. Also discharges
  the standing `qa-hooks.ts:24` "promote to setting" TODO for the ext-host read path (mocha-child keeps
  `QA_DEBUG_CDP_PORTS`).

### 3.2 Launcher UI

- **Status-bar item** "QA Debug: Inspect App" (entry affordance) + **command** `qa-debug.launchInspectApp`
  (palette). Command shows a **QuickPick** over `qaDebug.liveApps` (label + type); on pick →
  `LiveSessionManager.launch(spec)`. (Simple UI; QuickPick mirrors the existing `selectChrome` command.)
- **Stop:** command `qa-debug.stopInspectApp` + a status-bar action shown `when: qa-debug.liveSession` →
  `LiveSessionManager.stop()`.

### 3.3 `LiveSessionManager` (new; sibling to `SessionManager`, or a module within it)

Owns the spawned app + the live-session lifecycle.

- **`launch(spec)`** (contract):
  1. Guard (per-window): throw/notify if a pause OR live session is already active in THIS window (§2a).
  2. **Allocate a free port from the pool:** pick the first `qaDebug.cdpPorts` entry that (a) has nothing
     answering `/json/version` AND (b) is OS-bindable (quick `net` bind-check, released immediately). None
     free → `LIVE_PORTS_EXHAUSTED` ("all N debug ports busy — other inspect sessions are running; extend
     qaDebug.cdpPorts"). This is the cross-window collision guard (§2b).
  3. **Always spawn our own browser** on the allocated port (`weSpawned=true`; NO arbitrary probe-reuse — that
     would attach to another project's browser; attach-to-running is the §5 follow-up, port-explicit):
     - web: `<webBrowserBinary> --remote-debugging-port=<port> --user-data-dir=<perProjectProfileDir> "<url>"`.
       **`perProjectProfileDir = context.storageUri/chrome-debug-profile`** (workspace-scoped → per-project
       profile; persists that project's login; distinct dir per project ⇒ parallel Chrome instances, no
       single-instance handoff). If `storageUri` is undefined (no folder open), fall back to a
       `globalStorageUri/chrome-debug-profiles/<workspace-hash>` dir, or refuse with a clear message.
     - desktop: `<binary> --remote-debugging-port=<port> <...args>`.
     - Spawn with `sanitizeChildEnv(process.env)` (reuse `child-env.ts` — verified safe for a GUI launch: does
       NOT strip DISPLAY/XDG/DBUS/WAYLAND) and `detached:true` (process-group leader; `process-group-kill.ts`).
  4. Poll `probePorts([port])` until one `AvailableChrome` returns or a ~15s timeout → on timeout, kill the
     spawned group + surface `LIVE_APP_NOT_READY`.
  5. Store the **live target** (§3.4): `{ session_id:"live-<uuid>", available_chromes:[chrome],
     selected_cdp_port:port, chrome_owner:"companion", spawnedPid, weSpawned:true }`.
  6. Flip `qa-debug.liveSession = true` (setContext).
  7. Bind MCP: reuse the pause path's `bindMcpToSelection` logic (CDP download-shim + `mcpProvider.setPaused`).
     → factor that method out of `SessionManager` into something both managers call.
  8. Switch into the QA agent: `chat.open({ mode: 'qa-automation' })` (+ prefilled prompt to engage
     the identify-live skill). Feature-detect like `openChatForPausedCmd`.
- **`stop()`**: clear `qa-debug.liveSession`; `mcpProvider.setIdle()` + stop shim; **kill the process group
  only if `weSpawned`** (`signalProcessGroup` is `process.kill(-pid)` with NO ownership check
  (`process-group-kill.ts`) — `weSpawned` is the SOLE invariant guarding against killing a browser we didn't
  spawn). In MVP `weSpawned` is always true (we always spawn — §3.3.3); the flag stays load-bearing for the
  §5 attach-to-running follow-up. Clear the live target. Idempotent.
- **Lifecycle hooks:** register a `dispose()` in `context.subscriptions` that mirrors `SessionManager.dispose`
  (force teardown on extension deactivate / window close); on the spawned child `exit` → `stop()` (app closed
  by user). The `weSpawned`-gated kill applies in BOTH `stop()` and the deactivate path.

### 3.4 Live-target store + picker generalization

- **Live-target state:** a small `LiveTargetStore` (or a second slot beside the pause) holding
  `{ session_id, available_chromes, selected_cdp_port, chrome_owner }` — the SAME sub-shape the picker reads
  from a pause. NOT a synthetic `PausePayload` (avoids polluting failure-context readers).
- **Resolver** `resolveInspectTarget(sessionId?)` → returns that sub-shape from the active **pause** OR the
  active **live** session (whichever is set), else throws **`NO_ACTIVE_INSPECTION`**.
- **`LmToolDeps` MUST gain the live-target source (CR previously omitted this).** `base.ts` injects only
  `{ pauseStore, auditChannel }` and `pick-element.ts` reads `deps.pauseStore.getActivePause()`. Add
  `liveTargetStore` (or a combined `inspectTarget` resolver dep) to `LmToolDeps` and thread it at the single
  registration site `lm-tools/index.ts` + the construction in `extension.ts`. Without this the generalized
  picker literally cannot see the live target.
- **Generalize `qa_pick_element`** (NO sibling tool — user: "not specify on picker"):
  - `when`: change `"qa-debug.paused"` → `"qa-debug.paused || qa-debug.liveSession"`. **Edit this directly in
    package.json** — `gen-lm-tools.mjs` preserves `when` (it overwrites only `modelDescription`+`inputSchema`).
  - body: replace `pauseStore.getActivePause(...)` with `resolveInspectTarget(...)`; everything downstream
    (`selected_cdp_port` → `chrome.ws_url` → `pickElementViaOverlay`) is unchanged.
  - **SSOT description + errors are a CORRECTNESS change, not just a reword** (`tools.ts` currently hardcodes
    "on the pause's selected held browser" + errors `NO_ACTIVE_PAUSE`/`SESSION_NOT_FOUND`/`BROWSER_NOT_SELECTED`;
    the body throws `NO_ACTIVE_PAUSE`/`BROWSER_NOT_SELECTED`). Rework in tool-contracts: lead "...on the held
    browser (paused test) **or a running app you launched for inspection**..."; **the not-active error becomes
    `NO_ACTIVE_INSPECTION`** (replacing `NO_ACTIVE_PAUSE` in this tool's path); keep `BROWSER_NOT_SELECTED`
    (no chrome committed) + `CDP_CONNECT_FAILED`. Framework-neutral output contract unchanged
    ([[feedback-framework-neutral]]). Regen package.json after (§4 ordering note).

### 3.5 `qa_start_live_session` LM verb (the named primitive)

- Gated `when: "qa-debug.liveSession"` (visible only inside an active inspect session).
- Role: **(re)establish/refresh** the live target — probe `qaDebug.cdpPorts` (or an optional `cdp_port`),
  update `available_chromes`, (auto-)select. Useful when the app navigated/restarted or wasn't ready at launch.
  Returns `{ available_chromes, selected_cdp_port }`.
- The **core** (`startLiveSessionCore(port)`) is shared: the launcher (§3.3 step 5-7) and this verb both call
  it. This is the "reusable for other skills/tools" primitive the QA asked for.
- Errors: `NO_ACTIVE_INSPECTION` (no live session), `NO_CHROMES_FOUND` (reuse), `INVALID_PORT`.
- Only ONE new entry in the `QaErrorCode` union (`tool-contracts/src/errors.ts`): `NO_ACTIVE_INSPECTION`
  (used by both `qa_pick_element` and `qa_start_live_session`). The **launcher** failures
  (`LIVE_PORTS_EXHAUSTED`, `LIVE_APP_NOT_READY`, missing binary/url, `storageUri` undefined) are surfaced as
  **UI notifications** from the command (`window.showErrorMessage`), NOT `QaErrorCode`s — the launcher is a VS
  Code command, not an LM tool, so they don't touch the union.

**Build-ordering note (gen-lm-tools `--check` guard).** `gen-lm-tools.mjs` THROWS if a `qaTools` entry has no
pre-existing package.json `languageModelTools` block. So the implementor sequence is: (1) add the
`qa_start_live_session` `QaToolDef` to `qaTools`; (2) hand-add its FULL presentation block to package.json
(`tags`, `toolReferenceName`, `displayName`, `userDescription`, `canBeReferencedInPrompt`, `icon`,
`when: "qa-debug.liveSession"`); (3) edit `qa_pick_element`'s `when` directly in package.json; (4) run
`pnpm gen:lm-tools` (overwrites only `modelDescription`+`inputSchema`, preserves all `when`/presentation);
(5) `pnpm build` (runs `--check`) passes.

### 3.6 QA agent — `agents/qa-agent.agent.md` (+ `contributes.chatAgents`, always available)

> **Update:** the original `qa-debug-inspect` agent (live-inspection only, `when: qa-debug.liveSession`) was merged with `qa-testcase-writer` into a single **`qa-automation`** agent (reached via the `@qa-agent` participant) that does both live inspection and testcase authoring. It is always available (no `when`); its tools are the union below plus `qaTestRailGet`.


- `tools:` allowlist: `qa-debug-cdp/*`, `qaPickElement`, `qaStartLiveSession`, + built-in groups
  (`read` REQUIRED so `<skills>` loads — per the existing agent), `edit search execute web vscode todo agent
  browser`. (Allowlist is inbound-scoping only; it does NOT hide tools from default mode — that's the `when`
  key's job. Verified via VS Code custom-agents docs.)
- Body: "You inspect a running app the QA launched for inspection (no failing test). Follow the identify-live
  skill. Do NOT launch the app yourself — the extension owns the launch." Mirror the qa-debug agent's
  "inspect only through qa-debug-cdp" warning.

### 3.7 Skill — `skills/identify-live/SKILL.md` (+ `contributes.chatSkills`)

- Description-driven (no `when` on chatSkills). First-sentence disambiguator: "Use when a **Live Inspect
  Session** is active (the QA launched an app via QA Debug: Inspect App) — NOT during a Mocha pause (use
  `identify-element` then)."
- Steps: (1) confirm the live session is active / which app; (2) `qa_pick_element` (or `browser_*` /
  `qa_start_live_session` to re-probe); (3) confirm the picked element with the QA in plain language (reuse
  `identify-element` Step 3); (4) investigate the consumer codebase, build a framework-neutral locator (reuse
  `identify-element` Step 4 verbatim — [[feedback-framework-neutral]]). Does NOT instruct a terminal launch
  (extension owns it). Cross-link `identify-element` + `qa-debug`.

## 4. Reuse map (most infra already exists)

| Need | Reused from |
|---|---|
| spawn + detached process group + group-kill | `session-manager.ts` spawn pattern, `process-group-kill.ts` |
| env scrub (ELECTRON_RUN_AS_NODE) | `child-env.ts` `sanitizeChildEnv` |
| CDP probe → AvailableChrome | `lm-tools/probe-ports.ts` (→ `@qa-debug/mocha-hooks/probe`) |
| MCP bind + CDP download-shim | `mcpProvider.setPaused`/`setIdle`, `cdp-download-shim.ts`, factor out `bindMcpToSelection` |
| Overlay picker | `cdp-inspect.ts` `pickElementViaOverlay` (unchanged) |
| Status bar + QuickPick + chat.open(mode) | `pause-status-bar.ts`, `selectChrome` cmd, `commands.ts` `chat.open` |
| Custom agent + chatAgents `when` | `agents/qa-debug.agent.md`, `package.json` chatAgents |
| LM-tool SSOT → package.json (guarded) | `tool-contracts/src/tools.ts` + `tools/gen-lm-tools.mjs --check` |

## 5. Out of scope / follow-ups
- Attach-to-already-running-app as an explicit agent entry (always-on tool) — MVP uses launch-only + the
  probe-first reuse in §3.3.3.
- Multi-window/tab orient for desktop apps (picker arms the first real page target arbitrarily — same
  limitation as the pause-less picker analysis).
- Multiplexed simultaneous pause + live sessions (MVP = single active inspection).
- ARCHITECTURE.md note when landing ([[feedback-transparent-use]]): "identify-live is a QA-initiated
  standalone-inspect path; the extension launches the QA's OWN app on request — the no-launch-edit mandate
  governs the test-debug flow, not this."

## 6. Risks / open questions — RESOLVED (CR review iter#1, APPROVE-WITH-POLISH, no blockers)
- **R-CONC** — RESOLVED → §2: single active inspection via a SHARED BIDIRECTIONAL arbiter (both
  `runFixtureSuite` and `LiveSessionManager.launch` consult it) + status-bar arbitration. `mcpProvider` is
  confirmed single-endpoint (`mcp-provider.ts:28`).
- **R-PICKER-GATE** — RESOLVED → `||` is valid when-clause grammar (code.visualstudio.com when-clause-contexts).
- **R-PROFILE-PATH** — RESOLVED + VERIFIED → use **`context.storageUri`** (workspace-scoped) for the
  per-project profile, NOT `globalStorageUri`. Confirmed via `@types/vscode/index.d.ts:8496-8508`: storageUri is
  "a **workspace specific** directory… creation is up to the extension… parent directory is guaranteed to be
  existent… `undefined` when no workspace nor folder has been opened" — so it's a writable per-project
  `--user-data-dir`, with the no-folder fallback per §3.3.3. **Caveat to document:** each profile dir gets its OWN Chrome
  Safe-Storage encryption key (developer.chrome.com blog), so on macOS expect a **first-launch Keychain prompt
  per project**; logins persist because the dir is reused per project — promise "log in once per project," not
  "frictionless SSO from your normal Chrome."
- **R-PROFILE-LOCK** — RESOLVED by design: per-project profile dirs mean each window's Chrome has a distinct
  `--user-data-dir`, so the single-instance/ProcessSingleton handoff does NOT fire across projects (that was the
  whole point of "parallel web per project"). MVP always spawns our own (no arbitrary reuse), so the handoff
  hazard is gone for the launch path; it only re-enters with the §5 attach follow-up.
- **R-WEBBIN** — accept `qaDebug.webBrowserBinary` (require the setting; per-OS auto-detect is a nice-to-have,
  not MVP).
- **R-MCP-RENAME** — MINOR, no action required. `setPaused(endpoint)` only stores the endpoint + fires the
  change event (`mcp-provider.ts:91`); nothing reads a `PausePayload`, so it is semantically safe outside a
  pause and the inspect agent sees `mcp_qa-debug-cdp_browser_*` identically. Optional readability rename to
  `setActiveEndpoint`.
- **R-SECURITY** — extension spawns a QA-configured binary. Acceptable (QA owns `liveApps` in
  workspace/user settings); validate the binary/url exists and surface a clear error if not.
- **R-SKILL-ROUTING** — disambiguation rides on pause-vs-liveSession in both skill descriptions (first
  sentence); same pattern accepted in the prior PLAN review.
- **R-CHATMODE** — ⚠️ **UNVERIFIED-by-spec** (works by existing usage, NOT documented): the `mode` param on
  `workbench.action.chat.open` has no official doc (open VS Code issues still request programmatic mode
  select). MITIGATION: reuse the EXISTING `commands.ts` contract verbatim — feature-detect + benign no-op
  fallback (the pause agent already ships `mode:'qa-debug'` this way). No new risk vs. what ships today.
- **R-PROFILE-LOCK** — ⚠️ **UNVERIFIED-by-official-source** (corroborated, not doc-rendered): Chromium's
  ProcessSingleton hands a second `--user-data-dir=<same>` launch to the running instance and the new process
  exits, so if the original lacks `--remote-debugging-port` there is NO CDP. MITIGATION (already in design):
  probe-first-then-spawn (§3.3.3) + reuse with `weSpawned=false`; and the picker/`qa_start_live_session`
  validate the reused endpoint via `resolvePageWsUrl` (`cdp-inspect.ts`), so a handed-off non-CDP instance
  surfaces `CDP_CONNECT_FAILED` cleanly instead of hanging.

**Verified clean by review:** `globalStorageUri`, Chrome-136 default-dir refusal, `||` when-clause, custom-agent
`tools:` allowlist semantics, single-endpoint `mcpProvider`, `child-env` safe for GUI launch (does NOT strip
DISPLAY/XDG/DBUS/WAYLAND), 15s/500ms probe-loop fine.

**Status: APPROVED to implement** (no blockers; all 8 polish items folded into §2–§4 above).
