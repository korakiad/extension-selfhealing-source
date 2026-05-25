# PLAN — Hook Order Injection (transparent first-position afterEach)

> Iter#1 reviewed by adversarial Anthropic engineer (REQUEST_CHANGES → fixes applied below).
> Iter#2 pending.

## Problem

Current `qa-hooks.ts` registers `mochaHooks.afterEach` at the **root suite**. Mocha's `Runner.prototype.hookUp` (`runner.js:610-619`) iterates suites innermost-first, so the root hook runs **last**. If the user has an `afterEach` in any `describe` block that closes the browser (e.g. `browser.deleteSession()`), the browser is gone before our hook gets to call `getPuppeteer().wsEndpoint()` to publish the pause payload.

This blocks the transparent-debug experience — we can't predict whether users disposed the browser, what API they used, or in which `afterEach` level.

## Goal

Our pause-publishing afterEach must run **before any user `afterEach`**, on every suite that contains a failing test, **without** users editing their tests, `.mocharc`, or browser-launch code. Conforms to [[feedback-transparent-use]].

## Approach — monkey-patch `Suite.prototype.afterEach`

At `--require` time (before any test file loads), wrap `Suite.prototype.afterEach` so that whenever any code calls `suite.afterEach(...)` on a given suite, we **also** push our injected hook and reorder it to `_afterEach[0]` of that suite. Subsequent user `afterEach` calls on the same suite append normally — ours stays at index 0.

Same pattern as the existing `wdio.remote` monkey-patch (`qa-hooks.ts:54-115`).

## Confirmed Mocha invariants (verified against mocha@10.8.2)

These are facts the design relies on. Implementor should re-verify if pinning a different version.

| # | Invariant | Source |
|---|-----------|--------|
| I1 | `Mocha.prototype.rootHooks` calls `this.suite.afterEach(hook)` for each root hook in the array — i.e. the `mochaHooks` export flows through `Suite.prototype.afterEach` (and thus our patched wrapper). | `mocha/lib/mocha.js:1082` (called from constructor at `mocha.js:233-235`) |
| I2 | `handleRequires(argv.require)` runs BEFORE `new Mocha(argv)`. Our IIFE patches the prototype before any `afterEach` call. | `mocha/lib/cli/run-helpers.js:86-108` + `cli/run.js:354,370-372` |
| I3 | Within one test attempt, `self.test` identity is stable across all afterEach suite levels — `hook.ctx.currentTest = self.test` is set on each hook invocation. | `runner.js:494` |
| I4 | On retry, `test.clone()` yields a **new** Test identity. WeakSet keyed on Test → fresh pause per retry by design. | `runner.js:814-823` + `test.js:71-83` |
| I5 | When a user `afterEach` throws, `hookErr(err, errSuite, true)` re-enters `hookUp` from `errSuite.parent`, re-firing our injected hook in every ancestor suite within the same attempt. WeakSet dedupe is **mandatory** to prevent duplicate `pause.publish`. | `runner.js:543, 695-718` |
| I6 | `Suite.prototype.afterEach` early-returns on `this.isPending()` without pushing. Our wrapper must handle this OR the splice corrupts neighbouring data. | `suite.js:319-322` |
| I7 | `_afterEach` is an instance-level array (set in constructor), NOT on prototype. Schema probe must use a fresh `new Suite(...)`. | `suite.js:78` |
| I8 | `interfaces/bdd.js` exposes a global `afterEach` that targets `suites[0]` (top-of-file → root suite). Root-level user `afterEach` IS handled by the wrapper (it lands on root, after our root-mochaHooks injection — splice gate prevents reinjection). | `interfaces/common.js:89` + `interfaces/bdd.js:33` |
| I9 | In `--parallel`, each worker independently runs `handleRequires` + its own `new Mocha(opts)`. `process.send` is defined inside workers but points to the workerpool main, **not the extension**. Hook must detect-and-disable in worker context. | `mocha/lib/nodejs/worker.js:41-104` |

## Contracts

### 1. Module-scope state

| Symbol | Purpose |
|---|---|
| `OUR_HOOK_TAG: unique symbol` | Marker on `qaAfterEachImpl` to (a) self-recognize when rootHooks-path delivers it back through the wrapper, (b) detect existing presence in `suite._afterEach[]` |
| `QA_PATCH_INSTALLED: unique symbol` | Marker on `Suite.prototype` — guards IIFE against double-install when `qa-hooks` is `--require`d twice (per B4). If present, IIFE no-ops. |
| `pausedTests: WeakSet<Mocha.Test>` | Failed-pause dedupe within one attempt. Load-bearing — protects against nested-suite re-fire (I3) AND `hookErr` ancestor re-entry (I5). Fresh identity on retry (I4) gives natural "pause again on retry" semantics. |
| `passedTests: WeakSet<Mocha.Test>` | Same dedupe for `test.passed` IPC request branch (`qa-hooks.ts:261-276`). Identity stable within attempt → dedupes across nested suite levels. |

**Why WeakSet over Symbol-on-test (answers Q1)**: invisible to qa-reporter / Object.keys; GC-friendly; cross-retry "fresh pause" falls out of `Test.prototype.clone` naturally without extra cleanup.

### 2. Hook body — extracted shared function

Extract the current `mochaHooks.afterEach` body (`qa-hooks.ts:242-390`) into a named module function:

```ts
async function qaAfterEachImpl(this: Mocha.Context): Promise<void>
;(qaAfterEachImpl as any)[OUR_HOOK_TAG] = true
```

Both the root `mochaHooks` export and the injected per-suite copies reference this same function.

**Behavioural additions at the top of the body** (before existing logic):
- Early-return guards:
  - If `!test` → return (existing).
  - On the `test.state === 'passed'` branch, before `await c.request(METHOD.testPassed, ...)`:
    - `if (passedTests.has(test)) return;`
    - `passedTests.add(test);` BEFORE the await (prevents duplicate-send if ancestor re-entry fires while await is in flight).
  - On the `test.state === 'failed'` branch, before `await c.request(METHOD.pausePublish, ...)`:
    - `if (pausedTests.has(test)) return;`
    - `pausedTests.add(test);` BEFORE the await.

No other body changes. `this.timeout(0)` applies to whichever level fires first; for re-entry calls we return early before reaching it (harmless).

### 3. Patch wrapper

Install via IIFE at module top-level (alongside `installWdioPatch`):

```ts
;(function installAfterEachOrderPatch(): void {
  const Suite = require('mocha/lib/suite');  // or Mocha.Suite via main export

  if ((Suite.prototype as any)[QA_PATCH_INSTALLED]) return;  // B4 double-install guard

  // I7 positive schema probe (replaces N1's broken assertion).
  const probe = new Suite('__qa_probe__');
  if (!Array.isArray((probe as any)._afterEach)) {
    throw new Error(
      '[qa-hooks] expected Suite#_afterEach to be an array (mocha 10.x internal). ' +
      'Detected schema drift — pin mocha to ~10.8 or file an issue.'
    );
  }

  // I9 parallel-worker detect: if we're inside a mocha worker, do NOT patch
  // (the pause-publish IPC would target the workerpool main, not the extension).
  if (process.argv.includes('--parallel') || process.env.MOCHA_WORKER_ID) {
    process.stderr.write('[qa-hooks] disabled in parallel-worker context (pause protocol incompatible)\n');
    (Suite.prototype as any)[QA_PATCH_INSTALLED] = true;  // still mark, to skip on re-require
    return;
  }

  const origAfterEach = Suite.prototype.afterEach;
  Suite.prototype.afterEach = function patchedAfterEach(titleOrFn: any, maybeFn?: any) {
    const fn = typeof titleOrFn === 'function' ? titleOrFn : maybeFn;

    // 1. Always delegate the caller's request first — preserves mocha semantics
    //    (push order, EVENT_SUITE_ADD_HOOK_AFTER_EACH emission, pending early-return).
    const result = origAfterEach.call(this, titleOrFn, maybeFn);

    // 2. If the caller IS us (rootHooks delivery, I1), no further work.
    if (fn && (fn as any)[OUR_HOOK_TAG]) return result;

    // 3. If we've already injected into this suite, no further work.
    if ((this as any)._afterEach.some((h: any) => h.fn && (h.fn as any)[OUR_HOOK_TAG])) return result;

    // 4. Inject ours with length-delta guard (handles pending-suite per I6 + N5).
    const before = (this as any)._afterEach.length;
    origAfterEach.call(this, '__qa_pause_publish__', qaAfterEachImpl);  // N4: explicit title
    if ((this as any)._afterEach.length === before + 1) {
      (this as any)._afterEach.unshift((this as any)._afterEach.pop());
    }
    return result;
  };

  (Suite.prototype as any)[QA_PATCH_INSTALLED] = true;
  process.stderr.write('[qa-hooks] Suite#afterEach patched for first-position injection\n');
})();
```

**Splice mechanism rationale**: no public Suite API exposes "prepend hook" (verified in `suite.js` — only `getHooks(name)` returns the array). `unshift(pop())` is the minimum-surface mutation. Length-delta guard ensures we never splice if `origAfterEach` no-op'd (pending suite).

**Why `OUR_HOOK_TAG` is load-bearing**: per I1, rootHooks calls `this.suite.afterEach(qaAfterEachImpl)` AFTER our patch is installed. Without the tag check at step 2, the wrapper would see qaAfterEachImpl as "user code," look for tag-presence in `_afterEach` (none yet), inject + splice. The two pushes (rootHooks's + our wrapper's inject) would BOTH land in `_afterEach` → duplicate registration on root. Tag check shortcircuits this.

### 4. Keep the root `mochaHooks` export

Why (answers Q3): defence-in-depth. Two reasons:
1. Per I1, the root-mochaHooks call flows through the patched wrapper and is correctly tag-deduped — zero extra cost.
2. If the patch fails to install (Q2 hard-fail, env opt-out, future Mocha rename), root export still gives "fires last, captures pause for users with NO afterEach" — softer failure mode than nothing.

### 5. Edge cases (mapped to mocha invariants)

| Case | Behaviour | Invariant |
|---|---|---|
| Test at root suite, no `describe` | rootHooks (I1) → wrapper sees own tag → delegates → root `_afterEach=[ours]`. If user adds top-level `afterEach(userFn)` via bdd (I8), it lands on root: wrapper sees no tag on userFn, sees tag present in `_afterEach`, delegates only → `_afterEach=[ours, userFn]`. ✓ ours first. | I1, I8 |
| Nested `describe('a', () => describe('b', () => it()))` with user afterEach in both | Suite 'a' and 'b' each get an injected copy at index 0 via wrapper. Order on failure: ours-b → user-b → ours-a (`pausedTests.has` → return) → user-a → mochaHooks-root (`pausedTests.has` → return). | I3 + WeakSet |
| User afterEach throws after ours ran | `hookErr` re-enters `hookUp` from ancestor (I5), our injected hook fires again in each ancestor suite. WeakSet returns true → return early. Single pause per attempt. | I5 + WeakSet |
| Test on retry (clone) | New identity (I4) → WeakSet misses → fresh pause. Desired. | I4 |
| Pending suite (`describe.skip`) | `origAfterEach` early-returns (I6) → length unchanged → splice gate skips. No corruption. | I6 |
| User uses arrow vs `function`-form afterEach | Patch wraps prototype, fn style irrelevant. | — |
| qa-hooks `--require`d twice | IIFE sees `QA_PATCH_INSTALLED` → no-op. | B4 |
| `--parallel` mode | IIFE detects worker context → skips patch entirely; also disables IPC connection in worker. **Documented as unsupported for v1**; full parallel-mode support is a follow-up. | I9 |
| Beforeach failure → test.state='failed' set without test body running | `this.currentTest` still set (I3); WeakSet path identical to test-body failure. | I3 |
| User calls `this.skip()` in their afterEach | Mocha sets `test.pending=true`; our hook's existing `if (test.state !== 'failed') return` skip path triggers. | existing guard |

### 6. Out of scope

- `beforeEach` ordering — not needed; pause happens after test runs.
- `before`/`after` (per-suite) — fire after the entire afterEach chain (mocha invariant), already run after our decision returns.
- Detecting which user API closes the browser — irrelevant once we run first.
- `--parallel` end-to-end support — disabled gracefully; separate design needed.

## Files touched

- `mocha-hooks/src/qa-hooks.ts` — extract `qaAfterEachImpl`, add `OUR_HOOK_TAG` + `QA_PATCH_INSTALLED` + WeakSets, add `installAfterEachOrderPatch()` IIFE.

No changes to `protocol.ts`, `qa-reporter.ts`, extension, or tool-contracts.

## Verification

1. **End-to-end fixture** in `fixture-tests-wdio/`: nested describe where inner `afterEach` calls `browser.deleteSession()` then `it('fails', () => expect.fail())`. Without patch → Mode B with dead URL. With patch → Mode A, real CDP URL, decision flow completes.
2. **Dedupe counter**: instrument `pausedTests.add` increment; nested 3-level describe + intentional throw-in-user-afterEach must emit exactly **one** `pause.publish` per failing attempt.
3. **No-afterEach regression**: existing fixture-tests-wdio (no user `afterEach`) must still work — confirms root-mochaHooks path unaffected by tag check.
4. **Schema probe**: `new Suite('__qa_probe__')._afterEach instanceof Array` asserted at install — fail-loud on version drift.
5. **Double-require**: smoke test with `--require qa-hooks --require qa-hooks` to confirm IIFE no-ops on second pass (no double-wrap).
6. **Pending suite**: `describe.skip('x', () => { afterEach(() => {}) })` — confirm no errors thrown and `_afterEach` of the pending suite stays `[]`.
7. **Top-level user afterEach (I8)**: `afterEach(() => {})` at file top + `it('fails')` — confirm ours runs first.
8. **`--parallel` skip**: invoke with `--parallel` and confirm stderr "disabled in parallel-worker context" + tests run to completion (without pause).

## Open questions — RESOLVED

| Q | Resolution |
|---|---|
| Q1: WeakSet vs Symbol-on-test? | **WeakSet.** Invisible; GC-friendly; cross-retry semantics fall out of `Test.prototype.clone`. |
| Q2: Hard-fail or warn on Mocha schema drift? | **Hard-fail at install.** Silent degradation gives engineers a "Chrome unreachable" red herring. Loud failure tells them to pin mocha. |
| Q3: Keep root `mochaHooks` export? | **Keep.** Defence-in-depth; zero extra cost given tag-dedupe; softer failure if patch ever doesn't install. |

## Counter-designs considered and rejected (per Ralph iter#1)

- **Patch `Runner.prototype.hookUp` directly**: synthetic Hook with no real parent breaks `setHookTitle` (runner.js:553) and `hookErr` ancestor traversal. Rejected.
- **EVENT_HOOK_BEGIN reporter interception**: reporters can't block runner progression; observation-only. Rejected.
- **Wrap `browser.deleteSession`**: couples to wdio's specific teardown API, fails for raw CDP/puppeteer/playwright disposal. Wrong altitude. Rejected.
- **EVENT_SUITE_ADD_SUITE listener-based injection**: viable but N-listener-per-suite vs single prototype patch; equally fragile splice; misses programmatic `suite.afterEach()` callers. Rejected.

## Reviewer source citations (Mocha 10.8.2)

- `mocha/lib/mocha.js:1062-1085, 233-235` — rootHooks → suite.afterEach
- `mocha/lib/suite.js:38-44, 78, 319-333, 524` — Suite.create event, `_afterEach` init, afterEach + pending guard, getHooks
- `mocha/lib/runner.js:494, 543, 610-619, 695-718, 814-823` — currentTest binding, hook-failure path, hookUp reverse order, hookErr re-entry, retry clone
- `mocha/lib/test.js:71-83` — `Test.prototype.clone` fresh identity
- `mocha/lib/cli/run-helpers.js:86-108` + `cli/run.js:354, 370-372` — handleRequires precedes Mocha ctor
- `mocha/lib/nodejs/worker.js:41-104` — per-worker bootstrap
- `mocha/lib/interfaces/common.js:89` + `interfaces/bdd.js:33` — top-level `afterEach` global → root suite
