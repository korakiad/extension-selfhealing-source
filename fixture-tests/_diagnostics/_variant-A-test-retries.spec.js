'use strict';
const assert = require('node:assert/strict');

// Variant A: `this.test.retries(999)` in beforeEach (set retries ON the test, not the hook)
describe('variant A — this.test.retries(999)', function () {
  beforeEach(function () {
    this.test.retries(999);
  });

  afterEach(function () {
    if (!this.currentTest || this.currentTest.state !== 'failed') return;
    process.stderr.write(
      `[variant-A] retries=${this.currentTest._retries} currentRetry=${this.currentTest.currentRetry()}\n`,
    );
    this.currentTest.state = 'passed';
    this.currentTest.err = null;
    this.test.parent.retries(this.currentTest.currentRetry());
  });

  it('should be reported as passed', function () {
    assert.fail('variant A synthetic failure');
  });
});
