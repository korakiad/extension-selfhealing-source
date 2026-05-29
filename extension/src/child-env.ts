/**
 * Sanitize the environment handed to a spawned child (the Mocha runner) so it —
 * and any GUI app it launches downstream (Refinitiv Workspace / Electron,
 * OpenFin / HERE Core) — sees a terminal-clean environment rather than the
 * VS Code extension-host's.
 *
 * Why: VS Code runs its Node-based extension host with `ELECTRON_RUN_AS_NODE=1`
 * (so the Electron binary behaves as plain Node). If we copy `process.env`
 * verbatim into the Mocha child, that flag — and the rest of VS Code's injected
 * vars — are inherited transitively: ext-host → mocha → test-framework driver →
 * the Electron/OpenFin app. The app then boots in Node mode instead of as a GUI,
 * so it never opens a `--remote-debugging-port` and CDP discovery finds nothing.
 * (Fingerprint: `RefinitivWorkspace --version` returns a `v18.x` node version
 * instead of the real app version.) Both targets are Electron-based, so both are
 * affected — OpenFin / HERE Core is built on Chromium + Electron.
 *
 * The removal set mirrors VS Code's own `sanitizeProcessEnvironment` +
 * `removeDangerousEnvVariables` (src/vs/base/common/processes.ts), the
 * battle-tested baseline VS Code applies before it spawns shells / debug
 * adapters / tasks. See microsoft/vscode#137510 ("Eliminate the need for
 * ELECTRON_RUN_AS_NODE"): the flag "[must be] unset and not inherited by child
 * processes to not impact the execution of other ELECTRON programs."
 *
 * Safe by construction:
 *  - `PATH` is preserved, so the `node_modules/.bin/mocha` `#!/usr/bin/env node`
 *    shebang still resolves the real node (ELECTRON_RUN_AS_NODE is inert there).
 *  - The Node IPC channel is unaffected: `NODE_CHANNEL_FD` is injected by
 *    child_process at spawn time from the `'ipc'` stdio entry, independent of
 *    this env, and no pattern below matches `NODE_*` (except NODE_OPTIONS).
 */

/** Prefix/shape patterns removed wholesale. Mirrors VS Code's sanitizeProcessEnvironment. */
const REMOVE_PATTERNS: readonly RegExp[] = [
  // All Electron vars — incl. the launch-killer ELECTRON_RUN_AS_NODE and
  // ELECTRON_NO_ASAR (which alters ASAR resolution in spawned Electron children).
  /^ELECTRON_.+$/,
  // VS Code's own vars, except the few it intentionally preserves for portable /
  // login-shell / env-modifier flows.
  /^VSCODE_(?!(PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)).+$/,
  // Linux Snap packaging vars (no-op off Linux).
  /^SNAP(|_.*)$/,
  // Linux GTK image-loader module path (no-op off Linux).
  /^GDK_PIXBUF_.+$/,
];

/** Exact-name vars removed unconditionally. Mirrors VS Code's removeDangerousEnvVariables. */
const REMOVE_EXACT: ReadonlySet<string> = new Set([
  'NODE_OPTIONS', // Electron honors a subset; a leaked --require/--inspect corrupts the app's node.
  'DEBUG', // flips verbose logging in node-based launchers (e.g. the workspace driver).
  'LD_PRELOAD', // Linux library injection (no-op off Linux); strip for parity + safety.
]);

export interface ChildEnvResult {
  /** Sanitized copy of the input, safe to hand to `spawn(..., { env })`. */
  env: NodeJS.ProcessEnv;
  /** Names that were removed, sorted. Doubles as leak-proof for the audit log. */
  removed: string[];
}

function shouldRemove(key: string): boolean {
  if (REMOVE_EXACT.has(key)) return true;
  return REMOVE_PATTERNS.some((re) => re.test(key));
}

/**
 * Return a sanitized copy of `base` (never mutates `base`) plus the list of
 * removed var names. Keys whose value is `undefined` are dropped (they were not
 * really set), matching `{ ...process.env }` spread semantics.
 */
export function sanitizeChildEnv(base: NodeJS.ProcessEnv): ChildEnvResult {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (shouldRemove(key)) {
      removed.push(key);
      continue;
    }
    env[key] = value;
  }
  removed.sort();
  return { env, removed };
}
