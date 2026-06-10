/**
 * Unit test for the web-browser auto-detection (Live Inspect Session web launch).
 *
 * Run from the extension dir:
 *   node --import tsx test/web-browser-path.test.mts
 *
 * Injects platform/env/exists so it's deterministic across CI hosts.
 */
import assert from 'node:assert/strict';

import {
  detectWebBrowserBinary,
  knownBrowserPaths,
  type BrowserLookupDeps,
} from '../src/web-browser-path.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

/** Build a deps stub whose `exists` returns true only for paths in `present`. */
const deps = (
  platform: NodeJS.Platform,
  present: string[],
  env: NodeJS.ProcessEnv = {},
): BrowserLookupDeps => ({
  platform,
  env,
  exists: (p) => present.includes(p),
});

try {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const macEdge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

  check('macOS picks Chrome when present', () => {
    assert.equal(detectWebBrowserBinary(deps('darwin', [macChrome, macEdge])), macChrome);
  });

  check('macOS falls back to Edge when Chrome absent', () => {
    assert.equal(detectWebBrowserBinary(deps('darwin', [macEdge])), macEdge);
  });

  check('prefers Chrome over Edge (order matters)', () => {
    const paths = knownBrowserPaths('darwin', {});
    assert.ok(paths.indexOf(macChrome) < paths.indexOf(macEdge));
  });

  check('returns undefined when nothing is installed', () => {
    assert.equal(detectWebBrowserBinary(deps('darwin', [])), undefined);
    assert.equal(detectWebBrowserBinary(deps('linux', [])), undefined);
    assert.equal(detectWebBrowserBinary(deps('win32', [], {})), undefined);
  });

  check('Linux probes the common google-chrome path', () => {
    assert.equal(
      detectWebBrowserBinary(deps('linux', ['/usr/bin/google-chrome'])),
      '/usr/bin/google-chrome',
    );
  });

  check('Windows uses ProgramFiles env for the Chrome path', () => {
    const env = { ProgramFiles: 'D:\\PF' } as NodeJS.ProcessEnv;
    const win = 'D:\\PF\\Google\\Chrome\\Application\\chrome.exe';
    assert.ok(knownBrowserPaths('win32', env).includes(win));
    assert.equal(detectWebBrowserBinary({ platform: 'win32', env, exists: (p) => p === win }), win);
  });

  check('Windows falls back to default Program Files when env unset', () => {
    const paths = knownBrowserPaths('win32', {});
    assert.ok(paths.some((p) => p.includes('C:\\Program Files\\Google\\Chrome')));
  });

  console.log(`\nweb-browser-path unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nweb-browser-path unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
