/**
 * E2E for the stop-button process-group kill.
 *
 * Run from the extension dir:
 *   node --import tsx test/stop-kill-e2e.mts
 *
 * Exercises the REAL signalProcessGroup against REAL OS processes, using the
 * exact `detached: true` spawn the extension uses for the mocha child. Proves
 * the three properties the stop button depends on:
 *
 *   Topology (mirrors a real run):
 *     harness (this process)
 *       ├─ "mocha"   parent   — spawn(detached:true) → its OWN process group
 *       │    └─ "browser" grandchild — plain child → inherits the parent's group
 *       └─ "bystander" control — spawn(detached:true) → a SEPARATE group
 *
 *   A. Ctrl-C parity + no leak: SIGINT to the group kills BOTH mocha and the
 *      browser it launched, while the bystander in another group SURVIVES.
 *   B. Escalation: a parent that TRAPS SIGINT (hung-framework teardown) survives
 *      the polite SIGINT, then the SIGKILL escalation takes the whole group down.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { signalProcessGroup } from '../src/process-group-kill.ts';

const log = (...a: unknown[]): void => console.log('[e2e]', ...a);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True while `pid` still exists (signal 0 probes without delivering). */
function aliveOf(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Poll until `pid` is gone (reaped) or timeout. For non-direct-children only. */
async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!aliveOf(pid)) return true;
    await sleep(50);
  }
  return !aliveOf(pid);
}

/**
 * Spawn a "mocha" parent (detached → own group) that immediately spawns a
 * "browser" grandchild in the same group, then idles. Resolves once the
 * grandchild PID has been reported on stdout.
 *   trapSigint=false → both die on the default SIGINT disposition.
 *   trapSigint=true  → both swallow SIGINT (only SIGKILL ends them).
 */
function spawnParentWithChild(trapSigint: boolean): Promise<{
  parent: ChildProcess;
  grandchildPid: number;
}> {
  const trap = trapSigint ? 'process.on("SIGINT",()=>{});' : '';
  const gcTrap = trapSigint ? 'process.on(\\"SIGINT\\",()=>{});' : '';
  const program =
    `const cp=require('node:child_process');` +
    `const gc=cp.spawn(process.execPath,['-e','${gcTrap}setInterval(()=>{},1e9)'],{stdio:'ignore'});` +
    `${trap}` +
    `process.stdout.write('GC='+gc.pid+'\\n');` +
    `setInterval(()=>{},1e9);`;

  // Exact options from session-manager.ts spawnMochaChild (stdout piped here so
  // the harness can read the grandchild PID; the real run pipes it to a channel).
  const parent = spawn(process.execPath, ['-e', program], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,
  });

  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('parent never reported grandchild PID')), 5000);
    parent.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/GC=(\d+)/);
      if (m) {
        clearTimeout(to);
        resolve({ parent, grandchildPid: Number(m[1]) });
      }
    });
    parent.on('error', reject);
  });
}

/** Resolves with the exit (code, signal) of a direct child — also reaps it. */
function onExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
}

const cleanup: Array<() => void> = [];
let failed = false;
const assert = (cond: boolean, msg: string): void => {
  if (cond) {
    log(`  ok  ${msg}`);
  } else {
    failed = true;
    console.error(`  FAIL ${msg}`);
  }
};

async function scenarioA(): Promise<void> {
  log('Scenario A — Ctrl-C parity + no leakage');
  const { parent, grandchildPid } = await spawnParentWithChild(/* trapSigint */ false);
  const parentPid = parent.pid!;
  log(`    mocha(parent)=${parentPid}  browser(grandchild)=${grandchildPid}`);

  // Bystander in a SEPARATE process group — must be untouched.
  const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
    stdio: 'ignore',
    detached: true,
  });
  const controlPid = control.pid!;
  cleanup.push(() => {
    try {
      control.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  });
  cleanup.push(() => signalProcessGroup(parentPid, 'SIGKILL', () => {}));

  const parentExited = onExit(parent);
  log(`    signalProcessGroup(-${parentPid}, SIGINT)  ← the stop button's first move`);
  signalProcessGroup(parentPid, 'SIGINT', log);

  const exit = await Promise.race([parentExited, sleep(4000).then(() => null)]);
  assert(exit !== null, 'mocha (parent) exited on the group SIGINT');
  if (exit) log(`    parent exit: code=${exit.code} signal=${exit.signal}`);
  assert(await waitDead(grandchildPid, 4000), 'browser (grandchild) was killed by the SAME group signal');
  assert(aliveOf(controlPid), 'bystander in another group SURVIVED (no leakage)');
}

async function scenarioB(): Promise<void> {
  log('Scenario B — SIGKILL escalation against a SIGINT-trapping run');
  const { parent, grandchildPid } = await spawnParentWithChild(/* trapSigint */ true);
  const parentPid = parent.pid!;
  log(`    mocha(parent)=${parentPid}  browser(grandchild)=${grandchildPid}  (both swallow SIGINT)`);
  cleanup.push(() => signalProcessGroup(parentPid, 'SIGKILL', () => {}));

  const parentExited = onExit(parent);
  signalProcessGroup(parentPid, 'SIGINT', log);
  // terminateRun's grace window; the trapped parent should still be alive.
  const earlyExit = await Promise.race([parentExited, sleep(1200).then(() => null)]);
  assert(earlyExit === null, 'parent SURVIVED the polite SIGINT (it trapped it)');

  log(`    grace elapsed; signalProcessGroup(-${parentPid}, SIGKILL)  ← the escalation`);
  signalProcessGroup(parentPid, 'SIGKILL', log);
  const lateExit = await Promise.race([parentExited, sleep(4000).then(() => null)]);
  assert(lateExit !== null, 'parent died on the SIGKILL escalation (unblockable)');
  if (lateExit) log(`    parent exit: code=${lateExit.code} signal=${lateExit.signal}`);
  assert(await waitDead(grandchildPid, 4000), 'browser (grandchild) also killed by the group SIGKILL');
}

(async (): Promise<void> => {
  if (process.platform === 'win32') {
    log('SKIP: this e2e exercises the POSIX negative-pid path; Windows uses taskkill (see unit test).');
    process.exit(0);
  }
  try {
    await scenarioA();
    await scenarioB();
  } catch (err) {
    failed = true;
    console.error('[e2e] threw:', err);
  } finally {
    for (const fn of cleanup) fn();
  }
  await sleep(200);
  if (failed) {
    console.error('\nstop-kill e2e FAILED ❌');
    process.exit(1);
  }
  console.log('\nstop-kill e2e PASSED ✅');
  process.exit(0);
})();
