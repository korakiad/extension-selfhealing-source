'use strict';
const assert = require('node:assert/strict');

describe('selector fixture', function () {
  it('fails because the selector resolved to no elements', function () {
    const matched = 0; // simulated document.querySelectorAll('.submit-btn').length
    assert.equal(matched, 1, 'expected 1 element matching ".submit-btn" but found 0');
  });
});
