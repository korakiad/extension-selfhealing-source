# ARCHITECTURE v5.2 — Change Request: transparent browser ownership + transparent mocha config injection

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> Status: **Iteration #3 draft 2026-05-21**, applies reviewer #2 polish items + Q2 answer. Iteration #2 applied reviewer #1's 5 blockers + 9 non-blockers + closed Q1–Q5. Change tags: **[R#2-Bn]** / **[R#2-NBn]** = iter-2 fixes (preserved); **[R#3-NBn]** = iter-3 polish (this iteration).
>
> Scope: §2 (Architecture decision), §3.1 (hook), §3.2 (tool surface — small Mode-A adjustment), §3.4 (MCP gating & Chrome lifecycle), §3.5 (Pause-store), §4 (Failure-pause loop). No change to §3.3 (SKILL.md), §3.6 (qa-reporter).

## 0. Sources (per ARCHITECTURE v5 §0.1)

### Capability sources

- **Node CJS `require.cache` mutation** — `nodejs.org/api/modules.html` "Caching": *"Modules are cached after the first time they are loaded. … every call to `require('foo')` will get exactly the same object returned, if it would resolve to the same file."* And under `require.cache`: *"Modules are cached in this object when they are required. … Adding or replacing entries is also possible."* Example: mutating `require.cache.fs = { exports: fakeFs };` and asserting subsequent `require('fs')` returns the fake. **Stable documented path; `Module._load` / `Module._cache` are private (underscore-prefixed) and not part of the public API.**

- **CJS export-descriptor mutability** **[R#2-NB4]** — esbuild and TypeScript ES-module-to-CJS shims often define exports via non-writable property descriptors (e.g., `Object.defineProperty(exports, 'remote', { enumerable: true, get: () => moduleNs.remote })`). Naked `exports.remote = wrapper` may silently no-op or throw in strict mode. The defensive pattern is `Object.defineProperty(wdio, 'remote', { configurable: true, get: () => wrapper })` — a getter so the binding stays live across re-reads.

- **CJS destructured-import snapshot limitation** **[R#2-B5]** — `const { remote } = require('webdriverio')` resolves the getter ONCE at destructure time and stores the original function value in the local `remote` binding. A later monkey-patch on the exports object does NOT affect already-destructured local bindings. The transparent-integration patch is therefore *best-effort*: it works when callers invoke `wdio.remote(...)` (i.e., do not destructure at module top-level) and degrades silently to Mode B (with a one-line audit-log warning) for destructured callers. See §2.5 for the explicit Phase 1 contract.

- **Node ESM separation** — `nodejs.org/api/esm.html`: *"`require.cache` is not used by `import` as the ES module loader has its own separate cache."* ESM interception requires `module.register()` (Node 20+ stable). **Phase 1 excludes native-ESM user codebases** — see §2.5.

- **WebdriverIO v8.40.6 hybrid CJS/ESM publishing** **[answers Q1]** — `github.com/webdriverio/webdriverio/blob/v8.40.6/packages/webdriverio/package.json` exports field declares both `"import": "./build/index.js"` (ESM) and `"require": "./build/cjs/index.js"` (CJS). Node's CJS loader picks the `"require"` condition even when the user's `package.json` has `"type": "module"`. **A CJS `require('webdriverio')` works against v8.40.6 regardless of the user's `"type"`.** The remaining gap is the ESM-`import`-from-native-ESM-spec case, which bypasses CJS cache (above).

- **WebdriverIO v8.40.6 `remote()` factory** — `webdriverio` package exports `remote`. Verified via `github.com/webdriverio/webdriverio/tree/v8.40.6/packages/webdriverio` and context7 `/webdriverio/webdriverio/v8.40.6` documentation.

- **WebdriverIO v8.40.6 `browser.getPuppeteer()` — cache prelude + four capability-dispatch branches + throw** **[R#2-B1 / R#3-NB1]** — `github.com/webdriverio/webdriverio/blob/v8.40.6/packages/webdriverio/src/commands/browser/getPuppeteer.ts`. The function first checks an existing-session cache (`if (this.puppeteer?.isConnected()) return this.puppeteer;` — no leak on repeated `afterEach` calls). On cache miss, dispatches across four capability branches:
  1. Selenium 4 CDP: `if (cap['se:cdp']) { puppeteer = await PuppeteerCore.connect({ browserWSEndpoint: cap['se:cdp'], ... }); }`
  2. Aerokube vendor caps (Moon / Selenoid): vendor-specific WS endpoint
  3. Chromium-family `debuggerAddress`: `if (cap['goog:chromeOptions']?.debuggerAddress || cap['ms:edgeOptions']?.debuggerAddress) { puppeteer = await PuppeteerCore.connect({ browserURL: 'http://${debuggerAddress}', ... }); }`
  4. Firefox: `if (cap['moz:debuggerAddress']) { puppeteer = await PuppeteerCore.connect({ browserURL, ... }); }`
  
  **If none match, throws: `"Using DevTools capabilities is not supported for this session. This feature is only supported for local testing on Chrome, Firefox and Chromium Edge."`** Mode A's hard precondition: matched capabilities must contain one of these four. Chromedriver populates `goog:chromeOptions.debuggerAddress` in matched-caps empirically (not W3C-spec-mandated) for local Chrome launches; cloud grids (Sauce/BrowserStack/Selenium Grid without CDP) do NOT — see §2.5 exclusions [R#2-NB2].

- **WebdriverIO v8 doc — `getPuppeteer()` cloud caveat** — `webdriver.io/docs/api/browser/getPuppeteer`: *"Note that using Puppeteer requires support for Chrome DevTools protocol and e.g. can not be used when running automated tests in the cloud."* Confirms cloud-grid exclusion.

- **Puppeteer `Browser.wsEndpoint()`** — `pptr.dev`: *"Returns the browser's original launch endpoint URL … This endpoint can be used to reconnect to the browser using `puppeteer.connect()`."* Returns `ws://HOST:PORT/devtools/browser/<id>`. Works for both puppeteer-launched and `puppeteer.connect()`-attached browsers.

- **Mocha `--require` CLI concat semantics** — `node_modules/.pnpm/mocha@10.8.2/.../lib/cli/run-option-metadata.js:16-27` classifies `require` as `array`. `lib/cli/options.js:39-44` configures yargs-parser with `'combine-arrays': true` for array-type options. `lib/cli/options.js:237-269` passes CLI args as the FIRST configObject to `yargs-parser`, which concats CLI then RC values (earlier object wins on conflict but array-types are combined and de-duped). Result: CLI `--require` values appear FIRST in the concatenated require list (run first), then user's `.mocharc require:` values run after. **Behavioural match to the CR's claim.**

- **Mocha `--reporter` precedence — CLI overrides `.mocharc`** **[answers Q2]** — `lib/cli/run-option-metadata.js:54-63` classifies `reporter` as `string` (single-value). `lib/cli/options.js:67-82` coerce for string types is `v => (Array.isArray(v) ? v.pop() : v)`. `lib/cli/options.js:222-228` comment documents *"Priority list: 1. Command-line args 2. MOCHA_OPTIONS environment variable. 3. RC file ..."*. **CLI `--reporter qa-reporter` definitively overrides any `.mocharc.cjs reporter:` value.** The CR injects qa-reporter via CLI and the user's `.mocharc` reporter (if any) is silently superseded — note this in the audit log on activate.

- **Mocha Root Hook Plugins via `--require`** — `mochajs/mocha/docs/index.md`: *"You cannot use `--require` to set hooks. If you want to set hooks to run, e.g., before each test, use a Root Hook Plugin."* Root Hook Plugins (export `mochaHooks`) ARE compatible with `--require` — that's how the current `qa-hooks.ts` already works.

- **Mocha hook execution order** **[R#2-NB7]** — `mochajs/mocha/docs-next/src/content/docs/concepts/hooks.mdx`: `afterEach` runs before `after`. The CR's design captures `cdp_ws_url` inside `afterEach`, so user-test `after()` calls to `browser.deleteSession()` happen LATER and do not race the pause-payload capture.

### Agentic-design sources

Not applicable to this CR — scope is capability-level (process spawn semantics + module loading + browser session discovery). No agentic-design re-decisions.

### Repo-local sources

- `ARCHITECTURE.md` v5.1 §2 / §3.1 / §3.4 / §3.5 / §4.
- `S4_DESIGN.md` (§6.1, §6.3, §6.4 amended via this CR).
- `ARCHITECTURE-CR-v5.1.md` — structure template precedent.
- `extension/src/session-manager.ts:130–199` (`spawnMochaChild`).
- `extension/src/chrome.ts` (`ChromeProcess`).
- `mocha-hooks/src/qa-hooks.ts:127–135`.
- `mocha-hooks/package.json` `exports` — note `./register` and `.` currently collide on `dist/qa-hooks.js`; the CR §3 makes this a deliberate identity (single module file owns both subpaths) [R#2-B2].
- `fixture-tests/.mocharc.cjs` (file that becomes unnecessary post-CR).
- `node_modules/.pnpm/mocha@10.8.2/.../lib/cli/run-option-metadata.js`, `lib/cli/options.js` — Mocha CLI precedence ground truth.
- `node_modules/.pnpm/@types+vscode@1.120.0/.../vscode.d.ts` (S4 cited surface — unchanged).

## 1. The contradiction

ARCHITECTURE v5.1 §2: *"Owns the Mocha lifecycle"* + *"Owns the browser lifecycle (launch headed with `--remote-debugging-port=9222`, never closes on fail)."*

User directive 2026-05-21 (memory `[[feedback-transparent-use]]`): *"end-user QA must not edit specs, .mocharc, browser-launch code, or capabilities."*

Two concrete violations:

### Violation 1 — `.mocharc.cjs` edit burden

`require: [require.resolve('@qa-debug/mocha-hooks/register')]` + `reporter: require.resolve('@qa-debug/mocha-hooks/qa-reporter')` is real install-time friction.

### Violation 2 — browser lifecycle conflict with `webdriverio.remote()`

User calling `const browser = await remote({ capabilities: { browserName: 'chrome' } })` triggers chromedriver to launch its own Chrome. Companion's separately-launched `:9222` Chrome is empty; playwright-mcp inspects the wrong browser during pause.

## 2. The proposal

Re-architect §2 / §3.4 to **discover** the browser session rather than **own** it, and inject mocha config via CLI flags rather than authoring `.mocharc.cjs`.

### 2.1 Mocha config — CLI flag injection with **absolute-path resolution** **[R#2-B4]**

Reviewer #1 B4 surfaced that `--require @qa-debug/mocha-hooks/register` is only resolvable when the user has `@qa-debug/mocha-hooks` installed as a direct dep — which IS a user edit (`pnpm add -D @qa-debug/mocha-hooks` in their `package.json`). To honor the transparent-use mandate fully, the extension passes **absolute filesystem paths** to bundled copies that live in the extension's own installation:

```ts
// extension/src/session-manager.ts:spawnMochaChild (revised)
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const extReq = createRequire(__filename); // resolves from extension's location
const REGISTER_PATH = extReq.resolve('@qa-debug/mocha-hooks/register');
const REPORTER_PATH = extReq.resolve('@qa-debug/mocha-hooks/qa-reporter');

// [R#3-NB2] Defensive: VSIX packaging may not copy the workspace-linked
// mocha-hooks dist into the deployed extension. createRequire.resolve returns
// a path string but does not verify the file exists. Surface the misdeploy
// as a clean activation error rather than a confusing mocha "MODULE_NOT_FOUND
// for /abs/path/..." later.
for (const [label, p] of [['register', REGISTER_PATH], ['reporter', REPORTER_PATH]]) {
  if (!existsSync(p)) {
    throw new Error(
      `qa-debug-companion bundled hook ${label} not found at ${p}. ` +
      `This usually means the VSIX was built without including @qa-debug/mocha-hooks ` +
      `(workspace symlink not followed). See ARCHITECTURE-CR-v5.2 §5 risk row "VSIX packaging".`
    );
  }
}

const args = [
  '--require', REGISTER_PATH,   // absolute /path/to/extension/.../mocha-hooks/dist/qa-hooks.js
  '--reporter', REPORTER_PATH,  // absolute /path/to/extension/.../mocha-hooks/dist/qa-reporter.js
  ...(opts.grep ? ['--grep', opts.grep] : []),
  ...(opts.specFile ? [opts.specFile] : []),
];
```

The extension's bundled `mocha-hooks/dist/qa-hooks.js` is self-contained because `mocha-hooks/esbuild.config.mjs` already builds with `bundle: true` (inlines `zod` and any other transitive deps). Mocha resolves absolute paths directly — no node_modules lookup from the spec's CWD. The user adds **zero** dependencies.

**[R#3-NB7]** The earlier draft promised an audit-log line when CLI `--reporter` overrode a `.mocharc.cjs reporter:` value. That promise cannot be fulfilled from `--require`-order code because the hook runs BEFORE mocha reads `.mocharc.cjs`. The audit-log responsibility moves to the qa-reporter itself: on activate, the reporter reads `process.env.MOCHA_ORIGINAL_REPORTER` (set by a thin extension-side shell if needed) or simply notes in its own header line whether a config-file reporter was suppressed. For Phase 1 we drop the audit-log promise rather than chase the implementation; users with custom reporters can read the qa-reporter banner in stdout.

**[R#3-NB6]** The existing `session-manager.ts:spawnMochaChild` hardcodes `cwd: path.join(workspaceRoot, 'fixture-tests')`. The Mode A flow requires the spec's CWD to be wherever the user's wdio tests live — NOT a fixed `fixture-tests/` directory. This hardcoding is a pre-existing S4 limitation; Task #14 ("Adapt S4 code to v5.2 contract") must replace `FIXTURE_DIR` with spec-derived CWD. **Recommended path** (Task #14 default): derive CWD from the spec file URI passed via the TestController run handler — `path.dirname(specUri.fsPath)` or the nearest ancestor containing `package.json`. S4_DESIGN §7.3 already passes the spec URI via `request.include`, so the wiring is one read in `runFixtureSuite(specFile)`. Alternatives considered and rejected: explicit `qaDebug.fixtureCwd` workspace setting (violates transparent-use mandate); infer from nearest `.mocharc.cjs` (no good for users who don't author `.mocharc` — the whole point of CLI injection); QuickPick at first invocation (interactive friction).

### 2.2 Browser ownership — discover-first model with **module-scope singleton** **[R#2-B2]**

The monkey-patch logic lives **inside `mocha-hooks/src/qa-hooks.ts` module scope** (same file as the existing `mochaHooks` export). Reviewer #1 B2 surfaced that the previous draft's `require('./register')` from a sibling module was broken because `./register` and `.` already collide on `dist/qa-hooks.js` per `mocha-hooks/package.json` exports. The CR makes this collision deliberate: `dist/qa-hooks.js` IS the register entry; the singleton + monkey-patch + Root Hook Plugin all live in one module.

Sketch (incorporates B1 try/catch + B3 cheap-probe + B5 defensive descriptor):

```ts
// mocha-hooks/src/qa-hooks.ts (additions; existing code unchanged)

let currentBrowser: unknown; // wdio Browser instance, opaque typed

// B3: cheap probe first — resolve filename only, do NOT execute the module.
// require.resolve throws if not found; we catch and silently skip.
let wdioInstalled = false;
try {
  require.resolve('webdriverio');
  wdioInstalled = true;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
  // wdio not present — Mode B will engage automatically (no patch needed)
}

if (wdioInstalled) {
  try {
    const wdio = require('webdriverio') as { remote?: Function };
    if (typeof wdio.remote !== 'function') {
      // unexpected shape — skip patch, Mode B
    } else {
      const originalRemote = wdio.remote;
      const patchedRemote: typeof originalRemote = async function (...args) {
        const browser = await originalRemote.apply(this, args as any);
        currentBrowser = browser;
        return browser;
      };
      // B5 defensive: use Object.defineProperty so the binding remains live
      // through esbuild/tsc-generated CJS export descriptors that may be
      // non-writable. Callers using `wdio.remote(...)` see the patch.
      // CALLERS WHO DESTRUCTURE AT MODULE TOP-LEVEL still capture the original
      // value pre-patch — documented in §2.5 as a Phase 1 known limitation.
      Object.defineProperty(wdio, 'remote', {
        configurable: true,
        get: () => patchedRemote,
      });
    }
  } catch (err) {
    // require() actually loaded wdio but threw — leave Mode B as fallback
    process.stderr.write(`[qa-hooks] wdio monkey-patch skipped: ${(err as Error).message}\n`);
  }
}

// Existing serializeError / fileLineFromStack / awaitDecisionWithHeartbeat unchanged.

// The afterEach now consults the singleton first, falling back to env (Mode B):
async function discoverCdpWsUrl(): Promise<string> {
  const browser = currentBrowser as { getPuppeteer?: () => Promise<{ wsEndpoint(): string }> } | undefined;
  if (browser?.getPuppeteer) {
    try {
      // B1: getPuppeteer throws when no capability branch matches (cloud-grid,
      // non-Chromium, etc.). Catch and fall back to Mode B silently with an
      // audit-log line; the next test still gets the env-fallback CDP URL.
      const pup = await browser.getPuppeteer();
      return pup.wsEndpoint();
    } catch (err) {
      process.stderr.write(
        `[qa-hooks] wdio getPuppeteer() failed: ${(err as Error).message}; falling back to QA_DEBUG_CDP_WS_URL\n`,
      );
    }
  }
  return process.env.QA_DEBUG_CDP_WS_URL ?? 'ws://localhost:9222';
}

// In mochaHooks.afterEach: replace the existing `cdp_ws_url: process.env.QA_DEBUG_CDP_WS_URL ?? ...`
// with `cdp_ws_url: await discoverCdpWsUrl()`. The afterEach already runs BEFORE
// the user's `after()` per mocha hook order [R#2-NB7], so the wdio browser is
// guaranteed alive at this moment.
```

### 2.3 Fallback model — companion-launched Chrome when no wdio session detected

If any of the following holds, the hook returns the env-fallback `QA_DEBUG_CDP_WS_URL` and the extension's `ChromeProcess` is responsible for the live browser:
- `webdriverio` not resolvable from the mocha child's process (`MODULE_NOT_FOUND`)
- `wdio.remote` is not a function (unexpected package shape)
- `currentBrowser` was never captured (user destructured `remote` pre-patch, or never called `remote()`)
- `getPuppeteer()` throws (no matching capability branch — cloud grid, non-Chromium, etc.)

In Mode B the companion launches Chrome lazily on suite start (current S4 behavior; no change). The extension exports `QA_DEBUG_CDP_WS_URL=ws://localhost:9222` to the mocha child via `env`.

### 2.4 Chrome lifecycle owner (revised)

| Mode | Trigger | Browser launcher | CDP discovery | Lifecycle owner |
|---|---|---|---|---|
| **A — wdio-discovered** | wdio resolvable + `remote()` patched + getPuppeteer succeeds | user's `remote()` via chromedriver | hook: `browser.getPuppeteer().wsEndpoint()` | user (`browser.deleteSession()` in `after`/`afterAll`) |
| **B — companion-launched** | any of the wdio fallback conditions | extension's `ChromeProcess` on `:9222` | hook: `QA_DEBUG_CDP_WS_URL` env | extension (current S4 behavior) |

The extension launches its own Chrome **eagerly** (current S4 behavior) because the wdio detection happens inside the mocha child, not in the extension. The extension cannot know at suite-spawn time whether Mode A will engage. Pragmatic outcome: in Mode A, the companion's `:9222` Chrome runs but is unused (the hook publishes wdio's CDP URL, not `:9222`). Chrome process is lightweight — accept the dead-weight for Phase 1. Phase 2 may add a mode-probe step (run a tiny probe child first to check for wdio + capabilities, then conditionally launch Chrome).

### 2.5 Phase 1 scope — explicit exclusions **[R#2-B1 / B5 / NB2]**

Mode A engages only when ALL of the following hold:
- The user's project has `webdriverio` v8 installed as a **direct** dependency of the package owning the spec files (transitive-only installs may resolve via different `require.cache` keys due to pnpm symlinks — see Risk §5) **[R#2-NB3]**.
- The user's spec files use CJS `require('webdriverio').remote(...)` OR transpiled-ESM (tsx, ts-node, babel-register, esbuild — these compile `import { remote } from 'webdriverio'` to `require('webdriverio').remote` ONLY IF the call site does not destructure at module top-level).
- The wdio session capabilities yield a `getPuppeteer()`-supported branch — i.e., one of `se:cdp` / Aerokube vendor / `goog:chromeOptions.debuggerAddress` / `ms:edgeOptions.debuggerAddress` / `moz:debuggerAddress`.
- Local Chrome / Firefox / Chromium Edge testing only — cloud grids (Sauce, BrowserStack, Selenium Grid without CDP) hit the `getPuppeteer()` throw and fall back to Mode B silently with an audit-log warning.
- Single browser session per test or suite. The singleton tracks "most recently created"; multi-session tests get only the last one in pause payloads **[R#2-NB6]**.

Mode A explicitly **does NOT** support:
- Native-ESM user codebases (`"type": "module"` + raw `import { remote }`) — Node ESM cache separation makes CJS monkey-patch invisible. Defer to a Phase 2 `module.register()` loader CR.
- **Destructured-at-module-top-level `import { remote } from 'webdriverio'` callers** — the snapshot binding captures the pre-patch value. **This is the canonical wdio docs pattern**; Phase 1 users on this pattern hit Mode B silently. Recommended workaround in user docs: use `const wdio = require('webdriverio'); ... wdio.remote(...)` form, OR wait for Phase 2's deeper-hook approach (patch wdio's internal `webdriver.newSession` instead of the outer `remote`).
- `wdio --parallel` workers (already excluded in v5 §Phase-1-exclusions).
- Cloud / grid wdio runs (per `getPuppeteer()` cloud caveat).

### 2.6 §3.2 tool-surface adjustment for Mode A **[R#2-NB8]**

`qa_propose_close_browser` in Mode A would close a Puppeteer-attached Browser, which would kill the chromedriver session and confuse the user's subsequent `browser.deleteSession()`. **In Mode A, `qa_propose_close_browser` becomes a no-op-with-audit-log-warning: the tool returns `{ status: 'declined', reason: 'browser is owned by your test code; close via browser.deleteSession() in your test teardown' }`.** Mode B preserves current S4 semantics. `qa_propose_mark_passed` and `qa_propose_abort_suite` are unaffected — those concern the run record and Mocha lifecycle, not the browser.

### 2.7 §3.4.1 Mode A — known limitations summary (for in-prose reference)

For readers landing on §3.4.1 directly, the Mode A subsection (per §3 below) closes with this brief table:

| Known Mode A limitation | Effect | Workaround / outlook |
|---|---|---|
| Destructured `import { remote }` at module top-level | Singleton not populated; falls to Mode B silently | Use `wdio.remote()` form, or wait for Phase 2 deeper hook |
| Cloud-grid wdio (no CDP) | `getPuppeteer()` throws; falls to Mode B silently | Phase 2 — different transport for cloud sessions |
| Native-ESM `import` (no transpiler) | CJS patch invisible; falls to Mode B silently | Phase 2 — `module.register()` loader |
| Multiple browsers per test | Singleton tracks latest only | Phase 2 — multi-session API if needed |
| `qa_propose_close_browser` | No-op-with-decline in Mode A | Use `browser.deleteSession()` in test teardown |
| `browser.deleteSession()` mid-pause | Playwright-mcp tools error; investigation surface lost | Acceptable — the user destroyed the asset themselves |
| **[R#3-NB3]** WebDriver Bidi sessions (`wdio:enforceWebDriverClassic: false`) | May or may not populate `goog:chromeOptions.debuggerAddress`; falls to Mode B silently if `getPuppeteer()` throws | Phase 2 — direct Bidi-aware CDP discovery |

## 3. Edits

### ARCHITECTURE.md §2

Replace *"Owns the browser lifecycle (launch headed with `--remote-debugging-port=9222`, never closes on fail)."* with:

> *"Browser lifecycle is dual-mode (see §3.4.1). Mode A — when the user's stack is `mocha + webdriverio.remote()` with capabilities yielding a `getPuppeteer()`-supported branch (Chromium-family with `debuggerAddress`, Firefox `moz:debuggerAddress`, Selenium 4 `se:cdp`, or Aerokube vendor) — the companion discovers the wdio-launched browser via `browser.getPuppeteer().wsEndpoint()` and the user's test code retains full lifecycle ownership. Mode B — for all other stacks (no wdio, cloud grids, non-Chromium without DevTools, native-ESM destructured imports) — the companion launches headed Chrome with `--remote-debugging-port=9222` itself and never closes it on fail (v5.1 behavior). The mode is selected automatically per suite invocation; the user configures nothing."*

### ARCHITECTURE.md §3.1

Add to the pseudocode comment block:

> *"`cdp_ws_url` is discovered via the §3.4.1 mode dispatch: if the qa-hooks module-scope singleton holds a wdio browser (Mode A — populated by the monkey-patched `webdriverio.remote()`), the hook calls `browser.getPuppeteer().wsEndpoint()` wrapped in try/catch (the wdio `getPuppeteer` has four capability-dependent dispatch branches per `webdriverio/v8.40.6/packages/webdriverio/src/commands/browser/getPuppeteer.ts` and throws if none match). On any failure — singleton empty, wdio not installed, getPuppeteer throws — the hook falls back to `process.env.QA_DEBUG_CDP_WS_URL` (Mode B; the extension's pre-launched Chrome at `:9222`). The discovery happens inside `afterEach`, which runs BEFORE the user's `after()` per mocha hook order — guaranteed wdio browser is alive at capture time."*

### ARCHITECTURE.md §3.2

Add to `qa_propose_close_browser` description: *"In Mode A (§3.4.1, wdio-discovered browser), this verb returns `{ status: 'declined' }` with a rationale pointing the agent at the user's test-teardown lifecycle (`browser.deleteSession()`). The companion does not close a browser it does not own."*

### ARCHITECTURE.md §3.4

Add new subsection §3.4.1 "Browser-ownership modes":

> *"The companion supports two browser-ownership modes, selected automatically per suite invocation:*
>
> *Mode A — wdio-discovered (transparent for canonical wdio standalone users): the `--require <abs-path>/qa-hooks.js` entry (injected by the extension at mocha spawn time) probes `require.resolve('webdriverio')` cheaply; if resolvable, `require()`s the package and monkey-patches `wdio.remote` via `Object.defineProperty` getter (defensive against esbuild/tsc non-writable export descriptors). Wrapped `remote()` stores the returned `browser` in a module-scope singleton. The hook's afterEach calls `browser.getPuppeteer()` (whose four-branch dispatch is documented in `webdriverio/v8.40.6/packages/webdriverio/src/commands/browser/getPuppeteer.ts`); on success uses `wsEndpoint()` as the pause-payload CDP URL. Phase 1 known limitations summarized in §3.4.1 inline-table (destructured imports, cloud grids, native-ESM, multi-session, propose_close_browser).*
>
> *Mode B — companion-launched fallback (v5.1 behavior): all wdio-fallback conditions hit this path. Extension launches Chrome `:9222` on suite start; hook reads `QA_DEBUG_CDP_WS_URL` env. Chrome lifecycle per S4_DESIGN §6.3.*
>
> *The extension launches its own Chrome eagerly because mode selection happens inside the mocha child. In Mode A the companion's Chrome is dead-weight but lightweight; Phase 2 may add a probe step.*
>
> *playwright-mcp behavior is unchanged — it connects to whatever cdpEndpoint the provider hands it; the change is only which URL gets surfaced. [R#2-NB9]*
>
> *Known Mode A limitations (summary table):* …[insert §2.7 table]"

### ARCHITECTURE.md §3.5

Add to the IPC paragraph:

> *"Mocha config injection: the extension passes `--require <abs-path>/qa-hooks.js` + `--reporter <abs-path>/qa-reporter.js` as CLI flags resolved via `createRequire(__filename).resolve('@qa-debug/mocha-hooks/register'|'/qa-reporter')` from the extension's own location. The bundled hook/reporter files are self-contained (mocha-hooks's esbuild config bundles transitive deps including zod), so absolute paths work regardless of the spec's CWD or the user's node_modules. The user's `.mocharc.cjs` (if any) is left untouched; per Mocha CLI semantics (`mocha@10.8.2/lib/cli/run-option-metadata.js` + `options.js`), CLI `--require` values run BEFORE config `require:` values, and CLI `--reporter` overrides any config `reporter:`. Users with a custom `.mocharc reporter:` see the qa-reporter stdout banner instead and can infer the override from the missing native reporter output."*

### ARCHITECTURE.md §4 step 2

Replace with:

> *"Extension resolves absolute paths for qa-hooks + qa-reporter via `createRequire` from its own location, then spawns `mocha --require <abs>/qa-hooks.js --reporter <abs>/qa-reporter.js <user's specs>`. The qa-hooks module runs at --require time: probes for `webdriverio` via `require.resolve` (cheap, no execution); if found, monkey-patches `wdio.remote` via Object.defineProperty getter; otherwise leaves Mode B path open. The user's test code then runs unmodified. In Mode A, the user's `beforeAll`/`before` calls `wdio.remote()` and the singleton captures the browser. In Mode B, the extension's pre-launched Chrome `:9222` is the CDP source."*

### ARCHITECTURE.md §6 Status

Append:

> *"v5.2 APPROVED YYYY-MM-DD by Ralph-loop reviewer #N. Scope: §2 / §3.1 / §3.2 (Mode A no-op-with-decline for qa_propose_close_browser) / §3.4 (new §3.4.1 with two-mode dispatch + known-limitations table) / §3.5 (mocha CLI absolute-path injection) / §4. Adds Mode A discover-first browser ownership for wdio v8 standalone users (best-effort transparent; falls to Mode B for destructured imports / native ESM / cloud grids / non-Chromium-without-CDP); preserves Mode B as v5.1 fallback. Honors `[[feedback-transparent-use]]` directive for the canonical Mode A path; documents Phase 2 paths for the silent-Mode-B-fallback cases."*

### S4_DESIGN.md follow-ups (cross-reference)

- §0 add v5.2 supersede note: engines bump rationale stands; v5.2 changes browser ownership model but not the cited API surface.
- §6.1 / §6.3 update to reflect Mode A vs Mode B selection.
- §6.4 (retry respawn) — in Mode A, user's `before/beforeAll` re-creates the browser on respawned mocha child (fresh wdio session). Hook discovers the new session. In Mode B, Chrome stays across respawn (existing v5.1).
- §12 exit-criteria mapping — add Mode A verification (run fixture-tests-wdio suite, verify CDP discovered without companion Chrome use) AND Mode B verification (existing fixture-tests/ suite).

### SLICE_PLAN.md §4 Phase-2 follow-ups

Add three entries:

> *"Native-ESM wdio-discovery — v5.2 §2.5 excludes native-ESM user codebases. Phase 2 may add a `module.register()`-based ESM loader hook."*

> *"Deeper wdio session-creation hook — v5.2 §2.5 excludes destructured `import { remote }` top-level callers (the canonical wdio docs pattern). Phase 2 may monkey-patch wdio's internal `webdriver.newSession` instead of the outer `remote()` to catch all session creations regardless of caller import style."*

> *"Conditional Chrome launch — v5.2 §2.4 has the companion launch its own Chrome eagerly even in Mode A (dead-weight but lightweight). Phase 2 may add a fast wdio-probe spawn before the main mocha spawn, then skip companion-Chrome launch on Mode A detection."*

## 4. Cost analysis

| | Keep v5.1 | Apply v5.2 |
|---|---|---|
| **User edits required at install** | `.mocharc.cjs` + accept `:9222` conflict; manually set `goog:chromeOptions.debuggerAddress` for wdio; install `@qa-debug/mocha-hooks` as a dep. Significant friction. | Zero install-time edits for canonical wdio.remote() usage. Mode B catches the rest transparently with audit warnings. |
| **Runtime cost per Mode A suite** | 1× companion Chrome (orphan) + 1× wdio Chrome | Same (companion still launches eagerly per §2.4). Phase 2 optimization deferred. |
| **Runtime cost per Mode B suite** | Unchanged v5.1 | Identical to v5.1 + ~5–20ms for register-entry `require.resolve('webdriverio')` cheap probe (no module execution unless found) |
| **Cold-start when wdio transitively present but unused** | n/a | ~50–150ms `require('webdriverio')` + `puppeteer-core` module-graph load. Acceptable; alternative is to skip the patch entirely which loses Mode A for legit users. [R#2-B3 mitigation: cheap probe via `require.resolve` first avoids the load when wdio isn't a dep at all.] |
| **Architecture clarity** | Single mode; wrong for wdio users | Two modes, each clearly scoped, with explicit known-limitations table |
| **Phase 1 scope creep** | None | +~30 LOC monkey-patch + ~50 LOC absolute-path resolution + Phase 2 follow-up entries in SLICE_PLAN |
| **Ralph-loop discipline** | Violates `[[feedback-transparent-use]]` silently | Honors mandate via CR + Ralph loop; documents the inherent Phase 1 trade-offs (destructure, ESM, cloud) honestly |

Net: apply now. The "transparent for canonical use, transparent fallback for the rest" framing is the right Phase 1 contract.

## 5. Risk

- **Behavior risk (Mode B fallback)**: zero. Identical to v5.1.
- **Behavior risk (Mode A success path)**: medium. Three dependencies:
  - WDIO v8 `getPuppeteer()` returns Puppeteer Browser with `wsEndpoint()` — verified at source level (cited §0); cached after first call so no `afterEach` leak.
  - Node CJS `require.cache` mutation works for `webdriverio` — verified by documented example (cited §0). Hybrid CJS/ESM publishing (Q1 confirmed) means `require()` works even for user `"type": "module"`.
  - `getPuppeteer()` capability-branch dispatch matches user's stack — try/catch covers the throw; audit log records when fallback engages.
- **pnpm symlink path-mismatch risk** **[R#2-NB3]**: in pnpm workspaces, the qa-hooks's `require('webdriverio')` may resolve to a different `node_modules/.pnpm/webdriverio@*/...` real path than the spec file's `require('webdriverio')` if wdio is only a transitive dep. Node's cache key is the resolved real path; different paths means different cached instances and our patch doesn't propagate. **Mitigation:** document in §2.5 that Mode A requires wdio be a DIRECT dep of the package containing the specs. Verify at runtime: if `currentBrowser` is still empty after the suite's `beforeAll` (best-effort sanity check is hard without hook-into-beforeAll), the audit log records `[qa-hooks] Mode A patch installed but no browser captured; user may have wdio as a transitive-only dep`. Don't crash; Mode B fallback takes over.
- **Destructured-import silent fallback** **[R#2-B5 / R#3-NB6-frame]**: the canonical `import { remote } from 'webdriverio'` pattern bypasses the patch silently. Phase 1 accepts this as a known limitation (§2.5 + §3.4.1 table); the audit log explicitly notes Mode B engagement so the user knows. **Honest framing:** for *new* tests written under qa-debug, the `wdio.remote()` non-destructured form engages Mode A. For *existing* tests already written in destructured form (the canonical wdio docs pattern), switching IS a code edit — those tests silently fall to Mode B with an audit-log warning until Phase 2's deeper `webdriver.newSession` hook lands. The transparent-use mandate is therefore honored for greenfield wdio adopters and partially honored for retrofit users; the gap is Phase 2 work tracked in `SLICE_PLAN.md` §4.
- **Cloud-grid wdio users** **[R#2-NB2]**: `getPuppeteer()` throws; Mode B activates but launches a local `:9222` Chrome that doesn't match the grid session. This produces a confusing UX (notification says "browser held at :9222" but the failing test was running on a remote grid). **Mitigation:** §2.5 lists cloud grids as Mode-A-incompatible; user-facing docs should warn that the companion is local-only in Phase 1.
- **`puppeteer-core` cold-start tax** **[R#2-B3]**: forced load of puppeteer-core when wdio is present adds 50–150ms to Mocha child startup. Acceptable.
- **Object.defineProperty on a non-configurable export descriptor**: throws TypeError. **[R#3-NB4]** WebdriverIO v8 ships its CJS via esbuild-like tooling whose default descriptor sets `configurable: true`, so the dominant case succeeds. tsc-emitted descriptors default to `configurable: false` and throw. **Mitigation:** wrap defineProperty in try/catch; on throw, fall back to naked assignment `wdio.remote = patchedRemote`. **In strict mode (ESM), naked assignment to a read-only data property throws `Cannot assign to read only property`; in sloppy mode (legacy CJS) it silently no-ops without throwing — which means the patch may invisibly fail in sloppy mode**. Mitigation: after both attempts, re-read `wdio.remote === patchedRemote` and log + skip-patch-fallback-to-Mode-B if equality fails. Audit log records the silent-failure branch so the user can diagnose.

- **VSIX packaging discipline** **[R#3-NB2]**: `createRequire(__filename).resolve('@qa-debug/mocha-hooks/register')` returns a path string but does not verify the file exists. In dev (pnpm workspace symlinks) the path is reachable; in a deployed VSIX, this requires `vsce package` to follow workspace deps and include `extension/node_modules/@qa-debug/mocha-hooks/dist/qa-hooks.js` literally — pnpm's symlinked node_modules layout can trip vsce. This is NOT iter#2-introduced (v5.1 baseline also depends on the workspace package) but the absolute-path strategy amplifies the consequence. **Mitigation:** the startup `fs.existsSync` guard in §2.1 surfaces packaging misdeploys as a clean activation error; Task #14 owes a VSIX-packaging smoke (build the VSIX, install it locally, confirm activate() does not throw) as exit criterion.
- **`webdriverio` resolves but is not v8** (user has v7 or v9): the API may differ. **Mitigation:** at patch time, check `wdio.SevereServiceError` or `wdio.VERSION` (if exported) — minor version probing. If not v8, log warning + skip patch.

## 6. Open questions for reviewer (iteration #2)

All five iteration-#1 questions were definitively answered by reviewer #1; the answers are folded into §0 / §2 / §5 above. Iteration #2 raises three NEW open questions:

1. **Should `qa_propose_close_browser` in Mode A return `{ status: 'declined' }` (as §2.6 proposes) or should it silently no-op while logging?** **[Resolved per reviewer #2 Q1]** Decline-with-reason. `anthropic.com/engineering/writing-tools-for-agents` (Sep 11, 2025) prescribes "high signal information back to agents"; a structured `{ status: 'declined', reason: '...' }` lets the agent update its plan, whereas a silent no-op leaves the action ambiguous. The CR §2.6 wording is confirmed.

2. **Should the audit-log warning when Mode A patch is installed but no browser is captured be raised as a chat notification too?** A QA running their suite expecting Mode A to engage may not check the audit log. **[Resolved per reviewer #2 Q2]** Audit-log only by default for Phase 1 (`anthropic.com/research/measuring-agent-autonomy` Feb 18, 2026 cautions friction-without-decision). A chat notification fires ONLY when Mode B *also* fails (i.e., genuine unrecoverable state — no CDP URL surfaced at all). Task #15 evidence may revisit if users miss the audit log.

3. **Should the v5.2 CR include extension-side test for Mode A engagement?** **[Resolved per reviewer #2 Q3]** Defer to Task #15. The CR's job is design correctness; runtime smoke validates the design after approval. Mode A smoke can be a single-spec subset of `fixture-tests-wdio/` landed first (decoupled from the full fixture build-out), then the full suite follows — Task #15 owner can split internally.

## 7. Recommendation

Apply v5.2 iteration-#3 as drafted. Then proceed to Task #14 (adapt S4 code) and Task #15 (fixture-tests-wdio + Mode A smoke).

## 8. Status

- **Iteration #1** — 2026-05-21 draft. Reviewer #1 returned REVISE with 5 blocking + 9 non-blocking + Q1–Q5 answers.
- **Iteration #2** — 2026-05-21. Applied all 5 iter-#1 blockers + all 9 non-blockers + folded Q1–Q5 answers + added three new iter-#2 open questions. Reviewer #2 returned APPROVE-with-polish with 7 polish items (cosmetic + 2 pre-existing-but-CR-amplified — VSIX packaging + FIXTURE_DIR hardcoding) + Q1-Q3 answered.
- **Iteration #3** — 2026-05-21. Applied all 7 reviewer-#2 polish items inline (NB1 cache-prelude framing, NB2 fs.existsSync guard + VSIX risk row, NB3 Bidi limitations-table row, NB4 sloppy-mode silent-failure mitigation, NB5 cast accepted as-is, NB6 FIXTURE_DIR follow-up flagged to Task #14, NB7 audit-log promise dropped) + folded Q2 answer (audit-log-only by default). Reviewer #3 returned APPROVE-with-polish with explicit waiver: *"skipping a fourth Ralph-loop iteration is appropriate per the three-cap convention"*. Polish items: §3.5 edit prose dropped the audit-log promise alignment with §2.1 NB7, §6 Q1/Q3 markers added, §7 iter-ref refreshed, §2.1 NB6 enumerates four CWD options + recommends spec-URI-derived (Task #14 default), §5 destructure-fallback risk row reframes for greenfield-vs-retrofit honestly. Remaining minor polish (§2.2 sketch sloppy-mode equality re-check matching §5; cast `as const`; §2.5 wording slippage on destructure workaround) are implementation-time-fixable per reviewer #3's framing. **ARCHITECTURE-CR-v5.2 APPROVED 2026-05-21** (Ralph loop closed at 3 iterations per `ARCHITECTURE-CR-v5.1.md` precedent + reviewer #3's explicit waiver). Task #14 (adapt S4 code) and Task #15 (fixture-tests-wdio) may begin.
