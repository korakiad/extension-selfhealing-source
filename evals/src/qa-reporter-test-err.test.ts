#!/usr/bin/env tsx
/**
 * v5.8 regression test — qa-reporter's EVENT_TEST_FAIL listener MUST assign
 * test.err = err (replicating Mocha Base reporter's reporters/base.js:387)
 * so qa-hooks afterEach sees the actual error.
 *
 * Bug target: pre-v5.8, qa-reporter only stored err.message in its internal
 * notes map; test.err stayed undefined; qa-hooks defensive serializeError()
 * returned the "(test marked failed but Mocha did not capture an error...)"
 * placeholder for EVERY failure (not just timeout-aborts).
 *
 * Also asserts multi-attach parity with Base for the second-fail case
 * (runner.js:505,543 — hook-after-test failure fires a SECOND EVENT_TEST_FAIL
 * for the same test in the same process).
 *
 * Run: `pnpm --filter @qa-debug/evals run qa-reporter-test-err`
 */

import assert from 'node:assert/strict';

import * as Mocha from 'mocha';

import { QaReporter } from '../../mocha-hooks/src/qa-reporter.js';

interface ErrorWithMultiple extends Error {
  multiple?: Error[];
}

function fakeTest(title: string): Mocha.Test {
  // Construct a real Test instance with a placeholder fn; we only need the
  // .err / .state / .fullTitle() surface for this test, which the standard
  // constructor provides.
  const test = new Mocha.Test(title, () => undefined);
  // Attach a fake parent so fullTitle() doesn't blow up on missing suite ref.
  const suite = new Mocha.Suite('root');
  test.parent = suite;
  return test;
}

function main(): void {
  // Construct a real Runner + QaReporter against a real Suite so the reporter's
  // constructor wires `runner.on(...)` listeners correctly (validates the real
  // wiring, not a hand-rolled event emitter).
  const rootSuite = new Mocha.Suite('root');
  const runner = new Mocha.Runner(rootSuite);
  // Instantiate the reporter — constructor subscribes to EVENT_TEST_FAIL etc.
  // We don't need to retain a reference; the listener stays on the runner.
  new QaReporter(runner);

  const C = Mocha.Runner.constants;

  // Case 1 — first EVENT_TEST_FAIL emission: test.err must be assigned.
  const test1 = fakeTest('first failure');
  const err1 = new Error('the actual wdio click() rejection');
  assert.equal(test1.err, undefined, 'precondition: test.err starts undefined');
  runner.emit(C.EVENT_TEST_FAIL, test1, err1);
  assert.equal(
    test1.err,
    err1,
    'After EVENT_TEST_FAIL, test.err MUST equal the emitted err',
  );

  // Case 2 — SECOND emission for the SAME test: multi-attach kicks in.
  // Models the runner.js:505,543 path where a beforeEach/afterEach hook fails
  // AFTER the test body failed; same mocha process, same test, second emit.
  const err2 = new Error('hook failed after test body');
  runner.emit(C.EVENT_TEST_FAIL, test1, err2);
  assert.equal(
    test1.err,
    err1,
    'After second emit, test.err stays the FIRST err (Base parity)',
  );
  const prior = test1.err as ErrorWithMultiple;
  assert.ok(Array.isArray(prior.multiple), 'test.err.multiple is an array after second emit');
  assert.equal(prior.multiple?.length, 1, 'test.err.multiple has exactly one entry');
  assert.equal(prior.multiple?.[0], err2, 'test.err.multiple[0] is the second err');

  // Case 3 — separate test: independence (no bleed across tests).
  const test3 = fakeTest('independent test');
  const err3 = new Error('third test failure');
  runner.emit(C.EVENT_TEST_FAIL, test3, err3);
  assert.equal(test3.err, err3, 'Independent test gets its own err');
  assert.equal(
    (test3.err as ErrorWithMultiple).multiple,
    undefined,
    'Independent test does NOT inherit multiple from test1',
  );

  console.log('OK: qa-reporter-test-err passed all assertions');
}

try {
  main();
} catch (err) {
  console.error('FAIL:', err);
  process.exit(1);
}
