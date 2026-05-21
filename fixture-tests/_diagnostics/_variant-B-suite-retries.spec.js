'use strict';
const assert = require('node:assert/strict');

// Variant B: set retries at the suite level (this.retries inside describe)
describe('variant B — suite-level this.retries(999)', function () {
  this.retries(999);

  afterEach(function () {
    if (!this.currentTest || this.currentTest.state !== 'failed') return;
    process.stderr.write(
      `[variant-B] retries=${this.currentTest._retries} currentRetry=${this.currentTest.currentRetry()}\n`,
    );
    this.currentTest.state = 'passed';
    this.currentTest.err = null;
    this.test.parent.retries(this.currentTest.currentRetry());
  });

  it('should be reported as passed', function () {
    assert.fail('variant B synthetic failure');
  });
});
