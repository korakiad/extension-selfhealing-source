#!/usr/bin/env tsx
/**
 * v5.6 regression test — qa_request_retry onDecision race-loss path.
 *
 * Bug target: pre-v5.6, agent-driven `qa_request_retry` wrote to MementoPauseStore
 * but never reached DecisionRouter.commit; the mocha child sat forever paused
 * and the v5.4 status-bar never hid. v5.6 introduces the `onDecision` callback
 * in createQaDebugServer; this test exercises it via a scripted callback that
 * returns true once then false (simulating UI-button-beats-agent on the
 * second attempt against the same session_id), and asserts the server throws
 * PAUSE_ALREADY_RESOLVED on the race-loss path.
 *
 * Per PLAN-onDecision-wire.md acceptance gate #1.
 *
 * Run: `pnpm --filter @qa-debug/evals run race-test`
 */

import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createQaDebugServer } from '@qa-debug/qa-debug-mcp/server';
import { InMemoryPauseStore } from '@qa-debug/qa-debug-mcp/pause-store';
import type { PausePayload } from '@qa-debug/pause-store-types';

const SESSION_ID = 'test-session-001';
const REASON = 'test rationale for the race test';

const SEED: PausePayload = {
  session_id: SESSION_ID,
  test_title: 'race test fixture',
  full_title: 'parent > race test fixture',
  file: '/tmp/fixture.spec.js',
  line: 10,
  failing_assertion: 'fake assertion',
  stack_trace: { frames: [] },
  cdp_ws_url: 'ws://127.0.0.1:9222/devtools/browser/abc',
  mode: 'B',
  console_logs: { lines: [], bytes: 0 },
  paused_at_ms: Date.now(),
  retry_count: 0,
  max_retries_remaining: 0,
};

interface OnDecisionCall {
  sessionId: string;
  kind: 'retry' | 'give_up';
  reason: string;
}

async function main(): Promise<void> {
  const store = new InMemoryPauseStore();
  store.setActivePause(SEED);

  const onDecisionCalls: OnDecisionCall[] = [];
  const onDecisionReturns: boolean[] = [];

  // Scripted: first call wins (committed=true); second loses (committed=false)
  // — simulating a UI button click between the two agent attempts.
  let callIndex = 0;
  const onDecision = (
    sessionId: string,
    kind: 'retry' | 'give_up',
    reason: string,
  ): boolean => {
    onDecisionCalls.push({ sessionId, kind, reason });
    const ret = callIndex === 0;
    onDecisionReturns.push(ret);
    callIndex++;
    return ret;
  };

  const server = createQaDebugServer({ pauseStore: store, onDecision });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  const client = new Client({ name: 'race-test-client', version: '0.0.0' });
  await client.connect(clientT);

  // First call — onDecision returns true → success payload
  const first = await client.callTool({
    name: 'qa_request_retry',
    arguments: { session_id: SESSION_ID, reason: REASON },
  });
  assert.notEqual(first.isError, true, 'First call: isError must NOT be true');
  const firstText = (first.content as Array<{ type: string; text: string }>)?.[0]?.text;
  assert.ok(firstText, 'First call: content[0].text present');
  const parsed = JSON.parse(firstText) as { decision: string; accepted_at_ms: number };
  assert.equal(parsed.decision, 'retry', 'First call: payload.decision === "retry"');
  assert.equal(
    typeof parsed.accepted_at_ms,
    'number',
    'First call: payload.accepted_at_ms is a number',
  );

  // Second call — onDecision returns false → server throws PAUSE_ALREADY_RESOLVED
  const second = await client.callTool({
    name: 'qa_request_retry',
    arguments: { session_id: SESSION_ID, reason: REASON },
  });
  assert.equal(second.isError, true, 'Second call: isError MUST be true');
  const secondText = (second.content as Array<{ type: string; text: string }>)?.[0]?.text;
  assert.ok(secondText, 'Second call: content[0].text present');
  assert.match(
    secondText,
    /^PAUSE_ALREADY_RESOLVED:/,
    'Second call: error text starts with PAUSE_ALREADY_RESOLVED:',
  );

  // onDecision call shape — assert args, not just count (Reviewer iter#1 B2)
  assert.equal(onDecisionCalls.length, 2, 'onDecision called exactly twice');
  for (const [i, call] of onDecisionCalls.entries()) {
    assert.equal(call.sessionId, SESSION_ID, `call[${i}].sessionId matches active pause`);
    assert.equal(call.kind, 'retry', `call[${i}].kind === 'retry'`);
    assert.equal(call.reason, REASON, `call[${i}].reason matches input`);
  }
  assert.deepEqual(
    onDecisionReturns,
    [true, false],
    'onDecision returns [true, false] in order',
  );

  // Store contract — active pause persists; session-manager retains sole
  // ownership of clearing post-IPC-round-trip.
  const active = store.getActivePause();
  assert.equal(
    active?.session_id,
    SESSION_ID,
    'Active pause persists after both calls; session-manager owns clearing',
  );

  await client.close();
  await server.close();

  console.log('OK: race-test passed all assertions');
}

main().catch((err: unknown) => {
  console.error('FAIL:', err);
  process.exit(1);
});
