# @qa-debug/mocha-hooks

Mocha root hook plugin (`qa-hooks.js`), shared IPC protocol module (`protocol.js`),
and custom Mocha reporter (`qa-reporter.js`) for the QA Debug Companion.

Implements ARCHITECTURE.md v5 §3.1, §3.5, §3.6.

## What it does

`afterEach` checks if the current test failed. If so, it publishes a `pause`
event to the parent (extension or fake oracle) over Node's IPC channel,
awaits a decision (`retry` / `mark_passed` / `give_up`) with heartbeat-based
abandonment, and broadcasts the resolved decision both on the IPC channel
(for the parent) and on an in-process EventEmitter (for the `qa-reporter`,
which lives in the same mocha process and renders the tri-state outcome).

The hook does **NOT** mutate `test.state` / `test.err` / `parent.retries` /
`currentTest.retries`. ARCHITECTURE v5 §3.1 documents why — Mocha v10's
`Runner.fail` emits `EVENT_TEST_FAIL` synchronously at runner.js:825 *before*
`hookUp(afterEach)` at runner.js:828, so afterEach can't retract the failure.
See `ARCHITECTURE-CR-v5.md` for the empirical investigation history.

## IPC channel choice

ARCHITECTURE v4 §3.5 said "JSON-RPC over the mocha child's stdin/stdout."
Implementation switched to **Node's built-in `ipc` channel** (`stdio: [..., 'ipc']`,
delivered via `process.send` / `process.on('message')`) for two reasons:

1. Mocha writes its own output to stdout (reporter output, progress, summary).
   Sharing that channel with JSON-RPC envelopes would require either framing tricks
   or suppressing mocha's output — both worse than just using a dedicated channel.
2. Node's IPC channel auto-serializes objects, removing the need for newline-
   delimited JSON framing. The wire shape is still JSON-RPC 2.0 envelopes; only
   the transport changes.

ARCHITECTURE v5 §3.5 codifies this. R4#C records the alignment.

## Heartbeat abandonment (env-tunable)

`HEARTBEAT_MS` (default 5000) is the interval the hook expects from the parent.
After `3 * HEARTBEAT_MS` without one, the hook resolves locally as
`{ kind: 'give_up', reason: 'abandoned (3 heartbeats missed; ...)', by: 'hook' }`.

For testing the abandonment path without waiting 15s, set
`QA_DEBUG_HEARTBEAT_MS=200`. With the S2 oracle, pair it with
`--starve-after-decision <index>` to hold a specific pause indefinitely without
sending heartbeats:

```bash
QA_DEBUG_HEARTBEAT_MS=200 node --import tsx tools/oracle.ts \
  --decisions mark_passed \
  --tests 'specs/timeout.spec.js' \
  --heartbeat-ms 200 \
  --starve-after-decision 0
```

The hook abandons after ~600ms, the reporter renders the test as failed, mocha
exits cleanly.

## Q2 verification: `require.cache` invalidation for retry decisions

ARCHITECTURE v4 §3.1 unconditionally specified `invalidateRequireCache(file)`
inside the hook's `retry` branch. v5 §3.1 retains this call. Empirical observation
from S2 implementation:

**Observation.** In the v5 retry flow, mocha does not natively retry the test
(see ARCHITECTURE v5 §3.1's "Why no native mocha retries?"). Instead, the
extension (S4) or the oracle (S2 simulation) re-spawns mocha against the same
test file via `--grep <test title>` in a fresh child process. A fresh child has
a fresh Node module cache, so `require.cache` invalidation **inside the original
process** has no effect on the re-spawn's resolution.

**Conclusion.** The `invalidateRequireCache(file)` call in the hook is presently
a no-op for the v5 retry flow. It is retained because:

1. Phase 2 may consider an in-process retry mechanism (not yet designed). If so,
   `require.cache` invalidation will be load-bearing.
2. Removing it without an ARCHITECTURE v5.1 CR would violate the standing rule
   in ARCHITECTURE v5 §0.3 ("don't silently simplify"). The cost is one
   `require.resolve()` + one `delete require.cache[...]` per retry decision —
   negligible at the per-second timescale this hook operates at.

**Recommendation.** Open an ARCHITECTURE v5.1 CR if Phase 2 retains the
`--grep` respawn flow exclusively. For Phase 1, leave the call in.

## Build

```bash
pnpm --filter ./mocha-hooks run build
```

Outputs:
- `dist/protocol.js` — Zod schemas + JSON-RPC + `inProcBus` singleton.
- `dist/qa-hooks.js` — Mocha root hook plugin (mocha `--require` target).
- `dist/qa-reporter.js` — Mocha reporter (mocha `--reporter` target).

`protocol.js` is NOT bundled into the others; both `require('./protocol')` at
runtime so Node's CommonJS cache returns the same module instance — required
for the in-proc `inProcBus` to actually correlate hook→reporter messages.

## Use from mocha

In `.mocharc.cjs`:

```js
module.exports = {
  require: [require.resolve('@qa-debug/mocha-hooks/register')],
  reporter: require.resolve('@qa-debug/mocha-hooks/qa-reporter'),
  spec: ['specs/**/*.spec.js'],
  timeout: 10_000,
};
```

The parent must spawn mocha with `stdio: ['inherit', 'inherit', 'inherit', 'ipc']`
for the hook to find a `process.send`. Without it, the hook is a no-op (mocha
just runs normally).
