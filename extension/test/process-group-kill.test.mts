/**
 * Unit test for signalProcessGroup.
 *
 * Run from the extension dir:
 *   node --import tsx test/process-group-kill.test.mts
 *
 * Asserts the Ctrl-C-parity contract: POSIX signals the *group* (negative pid),
 * ESRCH is swallowed, other errors are logged, and Windows shells taskkill /T /F.
 */
import assert from 'node:assert/strict';

import {
  signalProcessGroup,
  type ProcessGroupKillDeps,
} from '../src/process-group-kill.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

interface KillCall {
  pid: number;
  signal: NodeJS.Signals;
}

/** Build a deps stub + the recording arrays it writes to. */
function makeDeps(opts: {
  platform: NodeJS.Platform;
  killThrows?: NodeJS.ErrnoException;
}): {
  deps: ProcessGroupKillDeps;
  killCalls: KillCall[];
  taskkillPids: number[];
  logs: string[];
} {
  const killCalls: KillCall[] = [];
  const taskkillPids: number[] = [];
  const logs: string[] = [];
  const deps: ProcessGroupKillDeps = {
    platform: opts.platform,
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (opts.killThrows) throw opts.killThrows;
    },
    runTaskkill: (pid) => {
      taskkillPids.push(pid);
    },
  };
  return { deps, killCalls, taskkillPids, logs };
}

const log = (logs: string[]) => (m: string): void => {
  logs.push(m);
};

try {
  check('POSIX SIGINT targets the NEGATIVE pid (the group)', () => {
    const { deps, killCalls, taskkillPids, logs } = makeDeps({ platform: 'darwin' });
    signalProcessGroup(4321, 'SIGINT', log(logs), deps);
    assert.deepEqual(killCalls, [{ pid: -4321, signal: 'SIGINT' }]);
    assert.deepEqual(taskkillPids, [], 'taskkill must not run on POSIX');
    assert.deepEqual(logs, [], 'a clean kill logs nothing');
  });

  check('POSIX SIGKILL escalation also targets the group', () => {
    const { deps, killCalls } = makeDeps({ platform: 'linux' });
    signalProcessGroup(99, 'SIGKILL', () => {}, deps);
    assert.deepEqual(killCalls, [{ pid: -99, signal: 'SIGKILL' }]);
  });

  check('ESRCH (group already gone) is swallowed silently', () => {
    const esrch: NodeJS.ErrnoException = Object.assign(new Error('kill ESRCH'), {
      code: 'ESRCH',
    });
    const { deps, logs } = makeDeps({ platform: 'darwin', killThrows: esrch });
    signalProcessGroup(7, 'SIGINT', log(logs), deps);
    assert.deepEqual(logs, [], 'ESRCH must not log — the group simply exited');
  });

  check('a non-ESRCH kill error is logged, not thrown', () => {
    const eperm: NodeJS.ErrnoException = Object.assign(new Error('kill EPERM'), {
      code: 'EPERM',
    });
    const { deps, logs } = makeDeps({ platform: 'darwin', killThrows: eperm });
    assert.doesNotThrow(() => signalProcessGroup(7, 'SIGINT', log(logs), deps));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /group SIGINT pid=-7 failed.*EPERM/);
  });

  check('Windows shells taskkill /T /F and never touches process.kill', () => {
    const { deps, killCalls, taskkillPids } = makeDeps({ platform: 'win32' });
    signalProcessGroup(1234, 'SIGINT', () => {}, deps);
    assert.deepEqual(taskkillPids, [1234], 'taskkill must target the POSITIVE pid');
    assert.deepEqual(killCalls, [], 'process.kill must not run on win32');
  });

  console.log(`\nprocess-group-kill unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nprocess-group-kill unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
