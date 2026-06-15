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

**v5.18 adds a second transport for the task-terminal mode.** The extension now
runs mocha inside a VS Code task terminal, where the pty host — not the
extension — is the parent, so no `'ipc'` stdio entry can exist. The extension
listens on a per-run named pipe (win32) / tmpdir unix socket (POSIX) and the
hook dials back to the path in `QA_DEBUG_IPC_ENDPOINT`, speaking the same
JSON-RPC envelopes as NDJSON lines (`ndjsonSocketTransport` in `protocol.ts`).
The env var wins over `process.send` when both are present; with neither, the
hook stays a no-op. Reason 1 above still holds (stdout stays mocha's); reason 2
is paid for with ~30 lines of newline framing.

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

## Q2 follow-up: `require.cache` invalidation for retry decisions (v5.1 removed)

**Status (v5.1, 2026-05-21).** The `invalidateRequireCache(file)` call has been
removed from `qa-hooks.ts` and from ARCHITECTURE.md §3.1
(Ralph-loop reviewer #6 APPROVE clean). The evidence below explains *why* it was
safe to remove and *what would re-introduce the need*.

### Evidence (retained from S2 verification; load-bearing for Phase 2 re-add)

In the v5 retry flow, mocha does not natively retry the test (see ARCHITECTURE v5
§3.1's "Why no native mocha retries?"). Instead, the extension (S4) or the
oracle (S2 simulation) re-spawns mocha against the same test file via
`--grep <test title>` in a fresh `child_process.spawn` call. A fresh child Node
process has a fresh module cache **by construction** — `require.cache` starts
empty. Therefore in-process `require.cache` invalidation in the original mocha
process has no addressable target: there is no shared module cache that an
invalidation call on one side reaches the other.

This is confirmed by `node_modules/.pnpm/mocha@10.8.2/.../lib/runner.js:814–823`
(retry branch clones the test in-process) and `lib/test.js:71–83` (clone snapshots
retries at clone time) — both of which describe *in-process* native retry, which
v5 does NOT use. The v5 retry path skips this code entirely; the extension owns
the retry by spawning a new mocha invocation.

### Phase 2 follow-up — restore on in-process retry

**If Phase 2 introduces an in-process Mocha retry mechanism** (not currently
designed, not in Phase 1 scope), the require.cache
invalidation becomes load-bearing again: an in-process retry runs in the same
Node process whose `require.cache` may hold stale modules from the first
attempt, and the QA may have edited a source file between attempts.

In that future, the re-add steps are:

1. Restore `invalidateRequireCache(file)` helper in `qa-hooks.ts`.
2. Call it from the `retry` branch with the failing test's source file.
3. Update ARCHITECTURE.md §3.1 "Why no `require.cache` invalidation in the retry
   branch?" paragraph to reflect the new in-process retry pathway.
4. Document the re-add as a v5.x CR per ARCHITECTURE.md §0.3.

The Phase 2 backlog entry tracking this requirement has a bidirectional
cross-reference to this block and ARCHITECTURE.md §3.1 — both entry points
(Phase 2 design and ARCHITECTURE §3.1) surface the requirement, so the re-add
cannot be silently skipped.

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

The hook finds its channel one of two ways: a `QA_DEBUG_IPC_ENDPOINT` env var
holding a pipe/socket path to dial (task-terminal mode — the VS Code extension
does this), or a `process.send` from being spawned with
`stdio: ['inherit', 'inherit', 'inherit', 'ipc']` (the oracle does this). With
neither, the hook is a no-op (mocha just runs normally).
