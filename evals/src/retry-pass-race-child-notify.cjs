// Race-test child — notification (fire-and-forget) shape.
// Mirrors what the bare `c.notify(...)` shape would do: process.send the wire
// envelope, then let the event loop drain immediately. With channel.unref()
// the loop has nothing pinning it alive → drains within a few ticks. Node
// provides NO 'message'-before-'exit' invariant for the parent, so some
// fraction of runs lose the message from the parent's exit-handler POV.
//
// CommonJS to avoid ESM resolution complexity in the forked child.

'use strict';

if (typeof process.channel?.unref === 'function') process.channel.unref();

process.send({
  jsonrpc: '2.0',
  method: 'test.passed',
  params: { full_title: 'race-child-notify > pass', test_file: null },
});

// No await; no exit; let the loop drain naturally — exactly what would happen
// inside afterEach if we used c.notify instead of c.request.
