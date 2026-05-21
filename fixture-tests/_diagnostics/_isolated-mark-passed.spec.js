'use strict';
// Isolated repro: no IPC, just exercise mocha's retry + afterEach-state-mutation
// pattern from ARCHITECTURE.md §3.1 to confirm it works against Mocha v10.
const assert = require('node:assert/strict');

describe('isolated mark_passed', function () {
  beforeEach(function () {
    this.retries(999);
  });

  afterEach(function () {
    if (!this.currentTest || this.currentTest.state !== 'failed') return;
    process.stderr.write(
      `[isolated] before mutation: state=${this.currentTest.state} retries=${this.currentTest._retries} currentRetry=${this.currentTest.currentRetry()}\n`,
    );
    this.currentTest.state = 'passed';
    this.currentTest.err = null;
    this.test.parent.retries(this.currentTest.currentRetry());
    process.stderr.write(
      `[isolated] after mutation: state=${this.currentTest.state} parent.retries=${this.test.parent._retries}\n`,
    );
  });

  it('should be reported as passed despite failing', function () {
    assert.fail('synthetic failure to be marked passed');
  });
});
