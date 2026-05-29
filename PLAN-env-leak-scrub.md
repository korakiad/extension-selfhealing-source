# PLAN — scrub VS Code ext-host env leakage from the spawned Mocha child

Status: IMPLEMENTED (decisions §4 approved: parity scrub + strip the trio; OpenFin port = follow-up)
Targets: Electron desktop apps (Refinitiv Workspace, `@tr/workspace-driver`) **and** OpenFin / HERE Core.

Landed:
- `extension/src/child-env.ts` — `sanitizeChildEnv()` (pure; returns `{ env, removed }`).
- `extension/src/session-manager.ts:388` — wired into `spawnMochaChild`; logs scrubbed vars.
- `extension/test/child-env.test.mts` — unit test (6 checks); `pnpm run test:unit:env`.
Verified: unit test green, `tsc --noEmit` clean, esbuild bundle ok.
Follow-up (separate): OpenFin CDP port discovery — promote `qa-hooks.ts:25` defaults to a
workspace setting / include OpenFin's `--remote-debugging-port` (commonly 9222).

## 1. Root cause (confirmed)

When VS Code runs its Node-based extension host, it launches that process with
`ELECTRON_RUN_AS_NODE=1` (so the Electron binary behaves as plain Node). The QA
Debug extension copies its **entire** environment into the Mocha child:

- `extension/src/session-manager.ts:380` — `const env = { ...process.env };`
- `extension/src/session-manager.ts:414` — `spawn(opts.mochaBin, args, { cwd, stdio, env })`

Nothing scrubs the inherited vars. Env inheritance is transitive, so
`ELECTRON_RUN_AS_NODE` rides: ext-host → mocha → `@tr/workspace-driver` →
the Electron/OpenFin app. The app then boots in Node mode instead of as a GUI,
so it never opens a `--remote-debugging-port` and CDP discovery
(`qa-hooks.ts:47` `probeChromePort`) finds nothing.

**Fingerprint that confirms it:** under the extension, `RefinitivWorkspace
--version` → `v18.12.1` (that is `node --version` output — the embedded Node);
from a normal terminal → `1.26.714` (the real app). Only `ELECTRON_RUN_AS_NODE`
produces that.

**Not the IPC.** The JSON-RPC channel (`protocol.ts`, `stdio[3]='ipc'`) is
unaffected by this and keeps working (see §5 safety). The casualty is CDP
discovery, upstream of which there is no browser to attach to.

This is a known class VS Code itself guards against — see
microsoft/vscode#137510 ("Eliminate the need for ELECTRON_RUN_AS_NODE"):
*"ELECTRON_RUN_AS_NODE [must be] unset and not inherited by child processes to
not impact the execution of other ELECTRON programs."*

## 2. The full leak surface — "whether any leak"

Authoritative reference: VS Code's own `sanitizeProcessEnvironment` +
`removeDangerousEnvVariables` in `src/vs/base/common/processes.ts`. Because we
copy `process.env` verbatim, **every** var below currently leaks into the child:

| Pattern / var | Source | Impact on an Electron/OpenFin GUI launch | Verdict |
|---|---|---|---|
| `ELECTRON_RUN_AS_NODE` | VS Code ext host | **Breaks launch** — app boots as Node, no GUI, no CDP | scrub (critical) |
| `ELECTRON_NO_ASAR` | (if forked) | Disables ASAR in spawned Electron children → resource-load oddities | scrub |
| other `^ELECTRON_.+$` (logging/behavior) | possible | Noise; no reason to keep | scrub (parity) |
| `^VSCODE_(?!PORTABLE\|SHELL_LOGIN\|ENV_REPLACE\|ENV_APPEND\|ENV_PREPEND).+$` | VS Code | Unlikely to break GUI; pure leak/noise; transparency | scrub (parity) |
| `^SNAP(\|_.*)$` | Linux Snap pkg | Linux-only; can confuse GUI libs | scrub (parity) |
| `^GDK_PIXBUF_.+$` | Linux GTK | Linux-only image-module path | scrub (parity) |
| `NODE_OPTIONS` | possibly ext host | Electron honors a subset; a leaked `--inspect`/`--require` corrupts the app's Node | **decision — see §4** |
| `DEBUG` | possibly ext host | Verbose logging in node launchers (`@tr/workspace-driver`) | **decision — see §4** |
| `LD_PRELOAD` | Linux | Security-relevant injection | scrub (parity, Linux) |

Note: Electron only documents `ELECTRON_RUN_AS_NODE` as **execution-mode**
changing; the rest are behavior/logging. So the launch-blocking culprit is
unambiguously `ELECTRON_RUN_AS_NODE`; the others are scrubbed for parity/hygiene.
(Electron env-var docs.)

## 3. Change (contracts only — no bodies)

New module `extension/src/child-env.ts`:

```
/** Returns a copy of `base` with VS Code ext-host leakage removed, so a spawned
 *  child (and any GUI grandchild it launches) sees a terminal-clean environment.
 *  Mirrors VS Code's sanitizeProcessEnvironment + removeDangerousEnvVariables
 *  (src/vs/base/common/processes.ts). Pure; does not mutate `base`. */
export function sanitizeChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv
```

- Removal patterns: the four regexes in the §2 table (ELECTRON_*, VSCODE_* with
  the whitelist, SNAP*, GDK_PIXBUF_*), plus the §4-decided members of
  {`NODE_OPTIONS`, `DEBUG`, `LD_PRELOAD`}.
- Must **not** touch: `PATH`, `HOME`, `USER`, `TMPDIR`, `SHELL`, `LANG`/`LC_*`,
  `DISPLAY`, `NODE_*` other than `NODE_OPTIONS` (esp. never `NODE_CHANNEL_FD`),
  and the VSCODE_* whitelist.

Wire-in (single call site — `spawnMochaChild`):

- `session-manager.ts:380` becomes
  `const env = sanitizeChildEnv(process.env);` (keep the existing comment trail).

No other extension spawn exists. The playwright-mcp process is launched by
VS Code's MCP host (`mcp-provider.ts:57`, `npx -y @playwright/mcp --cdp-endpoint`)
and only *attaches* over CDP — it never launches Electron — so it is out of
scope for this fix.

## 4. Decisions to confirm (review gate)

1. **Scrub scope** — recommend **VS Code-parity** (all §2 patterns), not just
   `ELECTRON_RUN_AS_NODE`. You explicitly asked "whether any leak"; parity is the
   battle-tested baseline and removes the whole family at once.
2. **`NODE_OPTIONS` / `DEBUG`** — recommend **strip** (VS Code does, via
   `removeDangerousEnvVariables`). Risk: if a user *intentionally* sets
   `NODE_OPTIONS` in their workspace for their tests, stripping changes behavior.
   Mitigation if you object: strip only when value contains a VS Code marker.
   Default recommendation: strip, document it.
3. **`LD_PRELOAD` / SNAP / GDK_PIXBUF** — Linux-only; you're on macOS. Include the
   patterns anyway for portability (no-op on darwin). Low stakes.

## 5. Safety — why scrubbing breaks nothing we rely on

- **Mocha still runs.** `mochaBin` is `node_modules/.bin/mocha`
  (`session-manager.ts:669`), a `#!/usr/bin/env node` script. `PATH` is preserved,
  so the shebang resolves the real `node`. `ELECTRON_RUN_AS_NODE` only affects
  *Electron* binaries; for real node it is inert. Proof it is unneeded: Mocha runs
  today.
- **The IPC the user worried about keeps working.** Node injects `NODE_CHANNEL_FD`
  into the child at spawn time from the `'ipc'` stdio entry (`stdio[3]='ipc'`),
  independent of the `env` object we pass; none of the scrub patterns match
  `NODE_CHANNEL_FD`. JSON-RPC over the IPC channel is unaffected.
- **GUI launch env intact.** Patterns don't touch `HOME`/`USER`/`TMPDIR`/`DISPLAY`,
  so the GUI app launches normally from the cleaned env.

## 6. OpenFin (second target) — necessary but not sufficient

- OpenFin / HERE Core runtime is built on **Chromium + Electron** (OpenFin Process
  Model; HERE Core runtime page). So the **same `ELECTRON_RUN_AS_NODE` leak can
  break OpenFin** — the §3 fix applies and is required, not optional. Do **not**
  assume OpenFin is immune.
- **But** OpenFin needs a second thing the env fix does not provide: its CDP
  endpoint. OpenFin exposes DevTools only when the runtime is launched with
  `--remote-debugging-port` in the **app manifest's runtime arguments** (commonly
  **9222**; CDP json at `http://localhost:9222/json`).
- Our discovery defaults are `22135, 22136` (`qa-hooks.ts:25`, Refinitiv-Electron
  convention). For OpenFin the user must add the OpenFin port via
  `QA_DEBUG_CDP_PORTS` (`qa-hooks.ts:29`), **or** we promote the hard-coded list to
  a workspace setting and include common OpenFin ports — already flagged as the
  transitional TODO at `qa-hooks.ts:24`. Track as a **follow-up**, separate from
  this env fix.

## 7. Verification

1. **Empirical leak proof (pre/post).** From inside the spawned child (qa-hooks
   startup stderr breadcrumb, behind a debug flag), log whether
   `process.env.ELECTRON_RUN_AS_NODE` is set. Expect `set` before the fix,
   `unset` after.
2. **Unit test** (`child-env` spec): input with
   `{ELECTRON_RUN_AS_NODE, VSCODE_PID, VSCODE_PORTABLE, SNAP, GDK_PIXBUF_MODULE_FILE,
   PATH, HOME, NODE_CHANNEL_FD}` →
   asserts the leak keys are gone and `PATH/HOME/VSCODE_PORTABLE/NODE_CHANNEL_FD`
   survive.
3. **Manual, Electron:** extension-launched run →
   `RefinitivWorkspace --version` reports the app version (not `v18.x`), GUI opens,
   discovery logs a found port (`qa-hooks.ts:343`).
4. **Manual, OpenFin:** with the OpenFin debug port in `QA_DEBUG_CDP_PORTS`,
   discovery finds the OpenFin runtime and playwright-mcp attaches.

## 8. Risks

- A user with an *intentional* `NODE_OPTIONS`/`ELECTRON_*` workspace var (rare).
- Discovery still empty for OpenFin until §6 follow-up / `QA_DEBUG_CDP_PORTS` set —
  call this out so it doesn't read as "fix didn't work."
```
