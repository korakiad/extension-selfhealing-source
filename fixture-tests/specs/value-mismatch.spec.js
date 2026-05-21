'use strict';
const assert = require('node:assert/strict');

describe('value-mismatch fixture', function () {
  it('fails because computed total does not match expected', function () {
    const computed = 41;
    const expected = 42;
    assert.equal(computed, expected, `expected total ${expected} but got ${computed}`);
  });
});
