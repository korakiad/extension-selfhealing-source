/**
 * Unit test for InspectionArbiter — the run-vs-live mutual-exclusion guard.
 *
 * Run from the extension dir:
 *   node --import tsx test/inspection-arbiter.test.mts
 */
import assert from 'node:assert/strict';

import { InspectionArbiter } from '../src/inspection-arbiter.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

try {
  check('idle: both can start', () => {
    const a = new InspectionArbiter();
    assert.equal(a.canStart('run'), true);
    assert.equal(a.canStart('live'), true);
    assert.equal(a.blockingReason(), undefined);
  });

  check('live active blocks a run AND a second live', () => {
    const a = new InspectionArbiter();
    a.setLiveActive(true);
    assert.equal(a.canStart('run'), false);
    assert.equal(a.canStart('live'), false);
    assert.match(a.blockingReason() ?? '', /Live Inspect Session/);
  });

  check('run active blocks a live (run can be re-checked too)', () => {
    const a = new InspectionArbiter();
    a.setRunActive(true);
    assert.equal(a.canStart('live'), false);
    // a run already guards itself via activeRun; canStart('run') stays true so
    // the arbiter never blocks the pause flow that owns it.
    assert.equal(a.canStart('run'), true);
    assert.match(a.blockingReason() ?? '', /Mocha suite run/);
  });

  check('releasing live frees both', () => {
    const a = new InspectionArbiter();
    a.setLiveActive(true);
    a.setLiveActive(false);
    assert.equal(a.canStart('run'), true);
    assert.equal(a.canStart('live'), true);
  });

  check('run-active reason takes precedence in blockingReason', () => {
    const a = new InspectionArbiter();
    a.setRunActive(true);
    a.setLiveActive(true);
    assert.match(a.blockingReason() ?? '', /Mocha suite run/);
  });

  console.log(`\ninspection-arbiter unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\ninspection-arbiter unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
