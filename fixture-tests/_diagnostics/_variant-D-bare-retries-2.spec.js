'use strict';
const assert = require('node:assert/strict');

// Variant D: small retries(2) — confirm whether mocha defers fail emission to final attempt
describe('variant D — suite retries(2), no clamp', function () {
  this.retries(2);

  let attempts = 0;
  beforeEach(function () {
    attempts++;
  });

  afterEach(function () {
    if (!this.currentTest || this.currentTest.state !== 'failed') return;
    process.stderr.write(
      `[variant-D] attempt=${attempts} state=${this.currentTest.state} currentRetry=${this.currentTest.currentRetry()}\n`,
    );
    // mark passed on attempt 2 (currentRetry == 1)
    if (this.currentTest.currentRetry() === 1) {
      this.currentTest.state = 'passed';
      this.currentTest.err = null;
      this.currentTest.retries(this.currentTest.currentRetry());
    }
  });

  it('should be reported as passed on attempt 2', function () {
    assert.fail(`variant D synthetic failure attempt=${attempts}`);
  });
});
