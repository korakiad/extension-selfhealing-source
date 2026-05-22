'use strict';
// v5.15 hook-order injection verification (PLAN-hook-order-injection.md §7.2).
//
// Without the patch: user afterEach in nested describes runs BEFORE root
// mochaHooks.afterEach (Mocha walks innermost-first per runner.js:610). With
// the patch: our hook is at _afterEach[0] of every suite that registers an
// afterEach, so it runs first at each level. The WeakSet dedupe (pausedTests)
// must collapse the resulting 3+ re-fires into ONE pause.publish per failure.
//
// Also exercises the hookErr re-entry path (runner.js:695-718) by throwing in
// the outermost user afterEach AFTER our hook would have paused — without
// dedupe, hookErr would re-walk hookUp from the parent and re-fire ours.
//
// Run via: pnpm run test:fake-oracle --decisions give_up --tests '_diagnostics/_hook-order-nested-aftereach.spec.js'
// Expected stderr from oracle: exactly ONE `[oracle] pause #0 …` line.

const assert = require('node:assert/strict');

describe('hook-order outer', function () {
  this.timeout(20_000);

  afterEach(function userOuter() {
    if (this.currentTest && this.currentTest.state === 'failed') {
      process.stderr.write('[hook-order-test] userOuter afterEach fired\n');
      // Triggers hookErr re-entry into hookUp from outer.parent.
      throw new Error('user-outer afterEach throw (simulated teardown error)');
    }
  });

  describe('hook-order middle', function () {
    afterEach(function userMiddle() {
      if (this.currentTest && this.currentTest.state === 'failed') {
        process.stderr.write('[hook-order-test] userMiddle afterEach fired\n');
      }
    });

    describe('hook-order inner', function () {
      afterEach(function userInner() {
        if (this.currentTest && this.currentTest.state === 'failed') {
          process.stderr.write('[hook-order-test] userInner afterEach fired\n');
        }
      });

      it('intentionally fails for hook-order dedupe verification', function () {
        assert.fail('boom');
      });
    });
  });
});
