'use strict';
const assert = require('node:assert/strict');

// Variant C: suite-level retries(999) + clamp currentTest's retries
describe('variant C — suite retries + currentTest clamp', function () {
  this.retries(999);

  afterEach(function () {
    if (!this.currentTest || this.currentTest.state !== 'failed') return;
    process.stderr.write(
      `[variant-C] before: state=${this.currentTest.state} retries=${this.currentTest._retries} currentRetry=${this.currentTest.currentRetry()}\n`,
    );
    this.currentTest.state = 'passed';
    this.currentTest.err = null;
    this.currentTest.retries(this.currentTest.currentRetry());
    process.stderr.write(
      `[variant-C] after: state=${this.currentTest.state} retries=${this.currentTest._retries}\n`,
    );
  });

  it('should be reported as passed', function () {
    assert.fail('variant C synthetic failure');
  });
});
