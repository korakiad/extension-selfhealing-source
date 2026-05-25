# PLAN — qa-reporter replicates Mocha Base reporter's `test.err = err` assignment

## Problem (root cause confirmed)

`Runner.prototype.fail(test, err)` in `node_modules/.pnpm/mocha@10.8.2/.../lib/runner.js:423-465` sets `test.state = STATE_FAILED` + emits `EVENT_TEST_FAIL` with the err — **but does NOT assign `test.err = err`.**

The assignment lives ONLY in the default `Mocha.reporters.Base` reporter at `node_modules/.pnpm/mocha@10.8.2/.../lib/reporters/base.js:379-390`:

```js
runner.on(EVENT_TEST_FAIL, function (test, err) {
  if (showDiff(err)) stringifyDiffObjs(err);
  if (test.err && err instanceof Error) {
    test.err.multiple = (test.err.multiple || []).concat(err);
  } else {
    test.err = err;
  }
  failures.push(test);
});
```

QA Debug Companion uses `qa-reporter` (per ARCH v5 §3.6) — a standalone class at `mocha-hooks/src/qa-reporter.ts:61` (`export class QaReporter`, does NOT extend Base). Base's constructor never runs → no listener does `test.err = err` → qa-hooks `afterEach` reads `test.err === undefined` on EVERY failure (not just timeout-aborts).

The defensive `serializeError()` (commit `43d87fc`) handled `err == null` with the "(test marked failed but Mocha did not capture an error — likely a timeout abort..." text — empirically reproduced by the user in F5 smoke 2026-05-21. **Memory `[[project-wdio-test-err-undefined]]` attributed this to Theory #1 (Mocha v10 doesn't populate test.err on timeout-abort) — that attribution is WRONG.** Mocha doesn't populate test.err for any failure; it relies on the Base reporter. The fix is one line in qa-reporter.

## Fix shape

Add the `test.err = err` assignment (and multiple-error attach for parity) to `QaReporter`'s existing `EVENT_TEST_FAIL` listener at `mocha-hooks/src/qa-reporter.ts:113-115`.

Defensive `serializeError()` stays as safety net — it handles non-Mocha edge cases (Promise rejection with no/falsy reason, non-Error throws, etc.) and any future regression in this assignment.

## Touchlist

1. **`mocha-hooks/src/qa-reporter.ts`** (lines 113–115) —
   ```ts
   runner.on(C.EVENT_TEST_FAIL, (test: Mocha.Test, err: Error) => {
     // Replicate Mocha Base reporter (reporters/base.js:379-390) standard
     // assignment so consumers reading `test.err` in afterEach hooks see the
     // actual error. We replaced Base with this reporter per ARCH v5 §3.6 and
     // inadvertently dropped this assignment; commit 43d87fc's defensive
     // serializeError stays as safety net for non-Mocha edge cases.
     if (test.err && err instanceof Error) {
       const prior = test.err as Error & { multiple?: Error[] };
       prior.multiple = (prior.multiple ?? []).concat(err);
     } else {
       test.err = err;
     }
     this.notes.set(key(test), err.message ?? String(err));
   });
   ```
   ~6 LOC net add. No type change required — `Mocha.Test.err` is typed `Error | undefined` in @types/mocha.

2. **`mocha-hooks/src/qa-hooks.ts`** (lines 277–281) — the defensive WARN remains, but reword the message to acknowledge the new state of the world (the diagnostic message is no longer specifically pointing at "timeout abort on async wdio test"; it should point at "no EVENT_TEST_FAIL listener set test.err — likely a custom reporter regression"):
   ```ts
   if (test.err == null) {
     process.stderr.write(
       `[qa-hooks] WARN test marked failed but test.err is ${typeof test.err}=${String(test.err)} — ` +
         `Mocha's Runner.fail does NOT set test.err; the active reporter is expected to. ` +
         `qa-reporter (v5.8+) replicates the Base reporter's assignment. ` +
         `If you see this WARN, either the reporter changed, OR the test was failed via a path that bypasses EVENT_TEST_FAIL.\n`,
     );
   }
   ```
   ~3 LOC reword; same diagnostic surface.

3. **No changes to `mocha-hooks/src/protocol.ts`, no IPC change, no schema change, no extension-side change.** This is purely a reporter-internal fix.

## Key design decisions (these need review)

- **Replicate Base's exact behavior (multiple-error attach + plain assignment).** Not a strict subset; respects Mocha's documented behavior for multi-fail tests (rare; happens when a hook also fails after a test fail). Single-line `test.err = err;` would work for the common case but breaks the multi-fail invariant where downstream consumers read `test.err.multiple`.
- **Keep `serializeError`'s `err == null` defensive path.** Edge cases that ALSO bypass the listener (e.g., a future reporter regression, `Runner#uncaught` failing the test outside the EVENT_TEST_FAIL flow, third-party hooks calling `Runner.fail` directly without going through standard paths) stay handled.
- **Rename memory's [[project-wdio-test-err-undefined]] root-cause attribution** — Theory #1 (Mocha timeout abort) is falsified; the actual cause is the missing Base-reporter behavior. Update memory after implementation lands so future sessions don't re-investigate the wrong theory.
- **No changes to qa-reporter's other event listeners** (RUN_BEGIN, TEST_BEGIN, TEST_PASS, TEST_RETRY, TEST_END, RUN_END). They're orthogonal to test.err.

## Acceptance gates

1. **Unit test (new):** Construct a `Mocha.Runner` + `QaReporter` instance. Synthesize an EVENT_TEST_FAIL emission with a fake Test + Error. Assert `test.err === err` after the event. ~15 LOC. Adds to `evals/src/race-test.ts`-style standalone tsx-runnable. Hard gate: must exit 0.

2. **F5 smoke (manual):** Re-run `fixture-tests-wdio/specs/selector.spec.js` `clicks #login-btnxxx` (deterministic-fail). Expected: agent's `qa_get_failure_context` returns `failing_assertion` containing the actual wdio error (e.g., `"element ('#login-btnxxx') still not displayed"` or `"Timeout 5000ms exceeded"` from wdio) — NOT the defensive "(test marked failed but Mocha did not capture an error..." text. stack_trace populated (no longer empty).

3. **S2 reporter snapshot regression:** `node --import tsx tools/snapshot-check.ts` continues to PASS. The snapshot includes `errMessage` rendering via `this.notes` map; the new `test.err = err` assignment does NOT affect that path because notes.set still runs.

4. **race-test regression:** `pnpm --filter @qa-debug/evals run race-test` continues to PASS (independent of reporter behavior).

5. **Build + type-check:** `pnpm -r build` + `pnpm -r build:check` green across 7 workspaces.

6. **Memory update:** After implementation, rewrite `[[project-wdio-test-err-undefined]]` to attribute root cause to qa-reporter's missing assignment; mark Theory #1 as FALSIFIED; keep diagnostic playbook for future regressions of this kind.

## Risks

- `test.err.multiple` attachment requires `test.err` to be an `Error` instance. If qa-reporter receives a non-Error err on a SECOND fail (rare), the cast fails. Base reporter's code has the same fragility — replicating its exact behavior keeps parity.
- Type-checker may complain about `(prior as Error & { multiple?: Error[] })`. If so, declare an inline interface (`interface ErrorWithMultiple extends Error { multiple?: Error[]; }`) or use `as any` with a justifying comment. Mocha's own code uses untyped JS so this is a TypeScript-side concession.
- A test using the v5.5 retry mechanism that re-fails after retry: each fail emits EVENT_TEST_FAIL; the multi-attach kicks in. Confirmed correct behavior (matches Base).
- The serializeError defensive path now fires only on TRUE edge cases (non-EVENT_TEST_FAIL failure paths). Frequency drops to ~0 in normal flow; WARN diagnostic still informative if it does fire.

## Out of scope (Phase 2)

- **Phase-2 Base parity sweep trimmed (Ralph iter#1 NB#1):** Reviewer verified Base subscribes to ONLY two runner events — `EVENT_TEST_PASS` (sets `test.speed`, cosmetic) and `EVENT_TEST_FAIL` (sets `test.err` + pushes to internal `failures[]`). No hidden Base listeners on `EVENT_HOOK_END` / `EVENT_TEST_PENDING` / `EVENT_SUITE_END`. The only remaining Base parity item is `test.speed` (low value). Phase-2 is "consider porting `test.speed` if a consumer needs it" — not an open audit.
- Bundling Mocha's `Base` reporter as a parent class via `class QaReporter extends Mocha.reporters.Base`. Heavier refactor; risk of inheriting unwanted Base side effects (console output, exit-code logic). Deferred until a concrete second missing-Base-behavior surfaces.

## References

- Mocha source: `node_modules/.pnpm/mocha@10.8.2/.../lib/runner.js:423-465` (Runner.fail) + `lib/reporters/base.js:379-390` (test.err assignment).
- Existing qa-reporter: `mocha-hooks/src/qa-reporter.ts:113-115` (current EVENT_TEST_FAIL listener that stores in notes map only).
- Existing defensive: `mocha-hooks/src/qa-hooks.ts:138-149` (serializeError null path) + `:277-281` (WARN stderr).
- Memory to amend: `[[project-wdio-test-err-undefined]]` (Theory #1 attribution).
- Architecture context: `ARCHITECTURE.md §3.6` (qa-reporter rationale).
