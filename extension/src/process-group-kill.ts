/**
 * Signal an entire process group the way a terminal Ctrl-C does, instead of a
 * single PID.
 *
 * The mocha child is spawned `detached: true` (see session-manager.ts) so its
 * PID is also its PGID; everything it launches (the Electron / OpenFin / Chrome
 * the framework drives, any wdio worker, wrapper shells) inherits that group.
 *
 * POSIX: `process.kill(-pid, sig)` delivers `sig` to every member of group
 *   `pid`. SIGINT mirrors Ctrl-C (frameworks key graceful teardown off it);
 *   SIGKILL is the unblockable escalation.
 * Windows: a negative pid is unsupported — `taskkill /pid <pid> /T /F`
 *   force-kills the whole tree (`/T`). There is no SIGINT-equivalent graceful
 *   step there.
 *
 * Lives in its own vscode-free module so the platform branching (negative-pid,
 * ESRCH-swallow, win32 taskkill) is unit-testable without the extension host.
 */

import { spawn } from 'node:child_process';

/** Injection seam so unit tests can stub the platform + the actual kill calls. */
export interface ProcessGroupKillDeps {
  platform: NodeJS.Platform;
  /** Wraps `process.kill`; may throw (ESRCH when the group is already gone). */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Wraps the Windows `taskkill /T /F` spawn; reports async spawn failure. */
  runTaskkill(pid: number, onError: (err: Error) => void): void;
}

const defaultDeps: ProcessGroupKillDeps = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  runTaskkill: (pid, onError) => {
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    tk.on('error', onError);
  },
};

/**
 * Deliver `signal` to the whole process group led by `pid`. Never throws:
 * ESRCH (group already exited) and a missing taskkill are swallowed to `log` —
 * callers treat termination as best-effort.
 */
export function signalProcessGroup(
  pid: number,
  signal: 'SIGINT' | 'SIGKILL',
  log: (m: string) => void,
  deps: ProcessGroupKillDeps = defaultDeps,
): void {
  if (deps.platform === 'win32') {
    // `/F` is force (no graceful analogue on Windows); `/T` walks the tree.
    deps.runTaskkill(pid, (err) =>
      log(`[session-manager] taskkill failed pid=${pid}: ${err.message}`),
    );
    return;
  }
  try {
    // Negative pid = the process group. -pid signals every member at once.
    deps.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // group already exited — nothing to do
    log(`[session-manager] group ${signal} pid=-${pid} failed: ${(err as Error).message}`);
  }
}
