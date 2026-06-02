/**
 * Unit test for sanitizeChildEnv.
 *
 * Run from the extension dir:
 *   node --import tsx test/child-env.test.mts
 *
 * Asserts the VS Code ext-host leak family is stripped while the vars mocha +
 * the GUI app + the Node IPC channel rely on survive untouched.
 */
import assert from 'node:assert/strict';

import { sanitizeChildEnv } from '../src/child-env.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// A representative leaked ext-host env + the vars we must preserve.
const INPUT: NodeJS.ProcessEnv = {
  // ── must be removed ──
  ELECTRON_RUN_AS_NODE: '1', // the launch-killer
  ELECTRON_NO_ASAR: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  VSCODE_PID: '12345',
  VSCODE_IPC_HOOK: '/tmp/vscode.sock',
  VSCODE_NLS_CONFIG: '{}',
  SNAP: '/snap/code/x',
  SNAP_NAME: 'code',
  GDK_PIXBUF_MODULE_FILE: '/usr/lib/loaders.cache',
  NODE_OPTIONS: '--require=/vscode/bootstrap.js',
  DEBUG: '*',
  LD_PRELOAD: '/usr/lib/libfoo.so',
  // ── must be preserved ──
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/qa',
  USER: 'qa',
  TMPDIR: '/var/folders/tmp',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  NODE_CHANNEL_FD: '3', // node IPC — never strip
  VSCODE_PORTABLE: '/portable', // whitelisted VSCODE_ var
  VSCODE_ENV_REPLACE: 'x', // whitelisted VSCODE_ var
  QA_DEBUG_CDP_PORTS: '22135,9222', // our own var must survive
};

const { env, removed } = sanitizeChildEnv(INPUT);

const MUST_REMOVE = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'VSCODE_PID',
  'VSCODE_IPC_HOOK',
  'VSCODE_NLS_CONFIG',
  'SNAP',
  'SNAP_NAME',
  'GDK_PIXBUF_MODULE_FILE',
  'NODE_OPTIONS',
  'DEBUG',
  'LD_PRELOAD',
];
const MUST_PRESERVE = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'SHELL',
  'LANG',
  'NODE_CHANNEL_FD',
  'VSCODE_PORTABLE',
  'VSCODE_ENV_REPLACE',
  'QA_DEBUG_CDP_PORTS',
];

try {
  check('strips the full leak family', () => {
    for (const k of MUST_REMOVE) {
      assert.equal(env[k], undefined, `${k} should be stripped`);
      assert.ok(removed.includes(k), `${k} should be in removed[]`);
    }
  });

  check('preserves vars mocha / GUI / IPC need', () => {
    for (const k of MUST_PRESERVE) {
      assert.equal(env[k], INPUT[k], `${k} should be preserved with its value`);
      assert.ok(!removed.includes(k), `${k} should NOT be in removed[]`);
    }
  });

  check('removed[] is exactly the leak family, sorted', () => {
    assert.deepEqual(removed, [...MUST_REMOVE].sort());
  });

  check('does not mutate the input', () => {
    assert.equal(INPUT.ELECTRON_RUN_AS_NODE, '1', 'input must be untouched');
    assert.equal(Object.keys(INPUT).length, MUST_REMOVE.length + MUST_PRESERVE.length);
  });

  check('drops undefined-valued keys', () => {
    const { env: e2 } = sanitizeChildEnv({ FOO: undefined, BAR: 'x' });
    assert.ok(!('FOO' in e2));
    assert.equal(e2.BAR, 'x');
  });

  check('empty env yields empty result', () => {
    const { env: e3, removed: r3 } = sanitizeChildEnv({});
    assert.deepEqual(Object.keys(e3), []);
    assert.deepEqual(r3, []);
  });

  console.log(`\nchild-env unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nchild-env unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
