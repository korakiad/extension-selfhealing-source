/**
 * Unit test for classifyRuntime.
 *
 * Run from the extension dir:
 *   node --import tsx test/runtime-classify.test.mts
 *
 * Tests the extension's copy; the qa-hooks + qa-debug-mcp copies are byte-identical
 * by contract (see the "MUST stay identical" comment in each probe-ports.ts).
 */
import assert from 'node:assert/strict';

import { classifyRuntime } from '../src/lm-tools/probe-ports.ts';

// Representative real-world /json/version User-Agent strings.
const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  electron:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) RefinitivWorkspace/1.26.714 Chrome/114.0.5735.289 Electron/25.3.1 Safari/537.36',
  openfin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OpenFin/33.117.74.6',
  // OpenFin runtime is Chromium+Electron — if a UA somehow carries both tokens,
  // OpenFin must win (it's the more specific runtime).
  openfinAndElectron: 'Chrome/120 Electron/25 OpenFin/33 Safari/537.36',
};

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

try {
  check('plain Chrome → chrome', () => {
    assert.equal(classifyRuntime(UA.chrome), 'chrome');
  });

  check('Electron UA → electron', () => {
    assert.equal(classifyRuntime(UA.electron), 'electron');
  });

  check('OpenFin UA → openfin', () => {
    assert.equal(classifyRuntime(UA.openfin), 'openfin');
  });

  check('OpenFin wins over Electron when both tokens present', () => {
    assert.equal(classifyRuntime(UA.openfinAndElectron), 'openfin');
  });

  check('missing/empty UA → unknown', () => {
    assert.equal(classifyRuntime(undefined), 'unknown');
    assert.equal(classifyRuntime(''), 'unknown');
  });

  check('case-insensitive matching', () => {
    assert.equal(classifyRuntime('foo electron/25 bar'), 'electron');
    assert.equal(classifyRuntime('foo OPENFIN/33 bar'), 'openfin');
  });

  console.log(`\nruntime-classify unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nruntime-classify unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
