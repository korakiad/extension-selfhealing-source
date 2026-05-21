'use strict';
const assert = require('node:assert/strict');

// S5 structural-arm fixture (S5_DESIGN.md §3 Q7 resolution).
//
// Synthetic deterministic structural failure: emulates "first test fails in
// beforeAll on a shared infra dependency" (e.g., postgres unreachable). Every
// other test in this file would hit the same beforeAll error if run.
//
// Intended as a small, isolated fixture for the S5 decision-tree eval's
// structural-arm worked example. NOT included in the main mocha glob during
// regular runs (file name starts with `_` per project convention).
describe('_seed-failure fixture', function () {
  before(function () {
    // Simulate pg_connection_refused on a shared seed dependency. The S5
    // SKILL Step-3 classification should map this signature → structural →
    // qa_propose_abort_suite (since the same beforeAll fires for every test
    // in the suite when seed is unavailable).
    assert.fail('Error: connect ECONNREFUSED 127.0.0.1:5432 (postgres seed unavailable)');
  });

  it('order detail page renders (would-be: structural skip)', function () {
    // Never reached — beforeAll failure cascades.
  });

  it('order edit page renders (would-be: structural skip)', function () {
    // Never reached — beforeAll failure cascades.
  });
});
