'use strict';
const assert = require('node:assert/strict');

// Synthetic deterministic failure: emulates a "timeout / element-not-ready"
// situation without an actual browser. The S2 oracle sees the failure and
// drives the pause/decision IPC. Real browser-backed flows land in S6.
describe('timeout fixture', function () {
  it('fails because the target never appears', async function () {
    this.timeout(2_000);
    await new Promise((res) => setTimeout(res, 50));
    assert.fail('TimeoutError: waiting for selector "#never-appears" failed: timeout 50ms exceeded');
  });
});
