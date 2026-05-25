# ARCHITECTURE v5 Change Request — Mocha state-mutation pattern is empirically broken

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> **Status:** OPEN. Filed during S2 implementation on 2026-05-20.
> Source files referenced: `ARCHITECTURE.md` v4 §3.1, `SLICE_PLAN.md` v4 S2.
> Filed by: implementation pass; awaiting Ralph-loop reviewer.

## 1. Finding

ARCHITECTURE v4 §3.1 prescribes that the Mocha root hook converts test outcomes via `afterEach` state mutation:

```js
beforeEach(function () {
  this.retries(999);
});

afterEach(async function () {
  if (this.currentTest.state !== 'failed') return;
  // ... publish/await ...
  if (decision.kind === 'retry') {
    invalidateRequireCache(this.currentTest.file);
    return;
  }
  if (decision.kind === 'mark_passed') {
    this.currentTest.state = 'passed';
    this.currentTest.err = null;
    this.test.parent.retries(this.currentTest.currentRetry());
    return;
  }
  if (decision.kind === 'give_up') {
    this.test.parent.retries(this.currentTest.currentRetry());
    return;
  }
});
```

**This pattern does not work against Mocha v10 (current GA, `mocha@10.8.2`).** Three independently-verifiable claims, each backed by mocha source line numbers (`node_modules/.pnpm/mocha@10.8.2/node_modules/mocha/lib/runner.js`):

### 1.1 `this.retries(999)` in `beforeEach` is a no-op

`Context.prototype.retries(n)` (mocha `lib/context.js`) calls `this.runnable().retries(n)` — where `runnable()` is the currently executing runnable. Inside `beforeEach`, the running runnable is **the hook itself**, not the upcoming test. The test's `_retries` therefore remains at the default `-1` (unset).

Empirical evidence: `_isolated-mark-passed.spec.js` log line `[isolated] before mutation: state=failed retries=-1 currentRetry=0` (the `retries=-1` reading is `this.currentTest._retries`).

The Mocha-canonical way to enable retries from `beforeEach` would be `this.currentTest.retries(999)` (the test's runnable, not the hook's), or alternatively `this.retries(999)` declared **at suite scope** inside `describe()`.

### 1.2 `Runner#fail` emits `EVENT_TEST_FAIL` **before** `afterEach` runs

In `Runner.prototype.runTests` → the `self.runTest(callback)` block (runner.js lines 800–836), the error branch is:

```js
} else if (err) {
  var retry = test.currentRetry();
  if (retry < test.retries()) {
    var clonedTest = test.clone();
    clonedTest.currentRetry(retry + 1);
    tests.unshift(clonedTest);
    self.emit(constants.EVENT_TEST_RETRY, test, err);
    return self.hookUp(HOOK_TYPE_AFTER_EACH, next);          // ← afterEach runs (no fail emitted)
  } else {
    self.fail(test, err);                                    // ← line 825: 'fail' EMITTED here
  }
  self.emit(constants.EVENT_TEST_END, test);
  return self.hookUp(HOOK_TYPE_AFTER_EACH, next);            // ← line 828: afterEach runs AFTER 'fail'
}
```

`Runner.prototype.fail` (runner.js line 423–465) sets `test.state = STATE_FAILED` and emits `EVENT_TEST_FAIL` — synchronously, before `hookUp(afterEach)` is called. **The reporter has already recorded the failure by the time afterEach can mutate state.** Mutating `test.state = 'passed'` and `test.err = null` in afterEach does not retract the emitted event nor decrement `Runner#failures`.

### 1.3 Clamping `test.retries()` in `afterEach` does not stop further retries

The retry branch (runner.js lines 814–822) creates `clonedTest = test.clone()` and `tests.unshift(clonedTest)` **before** `hookUp(afterEach)` runs (line 823). The clone inherits `_retries` from the source test at clone time. By the time `afterEach` runs and mutates `this.currentTest.retries(currentRetry)`, the next clone is already queued with its own `_retries` snapshot.

Empirical evidence: variant B (`_variant-B-suite-retries.spec.js` with suite-level `this.retries(999)`) shows `currentRetry=999` in afterEach — meaning mocha ran the full 1000 attempts before afterEach ran with the test's final state. The clamp clearly did not propagate.

### 1.4 What does work today (current S2 implementation)

`give_up` decisions currently report as "1 failing" by **accident**, not by design:

- `this.retries(999)` in beforeEach is a no-op (§1.1)
- The test's `_retries` therefore stays at `-1`
- `Runner.runTests` evaluates `retry < test.retries()` as `0 < -1` → **false**
- mocha takes the fail branch (line 825) with `self.fail` → "1 failing"

If we *did* fix `this.retries(999)` to actually take effect on the test, then `give_up`'s clamp would *also* not work for the reasons in §1.3, and the test would loop 1000 times before naturally exhausting the retry budget.

So:

| Decision | ARCHITECTURE v4 intent | Empirical behavior with v4 code | Why |
|---|---|---|---|
| `retry` | mocha retries the test | Test does **not** retry (only 1 attempt) | §1.1: `_retries=-1` → no retry path |
| `mark_passed` | "1 passed" in mocha tally | Reports "1 failing" | §1.2: fail emitted before afterEach |
| `give_up` | "1 failing", mocha moves on | Reports "1 failing", moves on (correct outcome by accident) | §1.1: no retries to clamp; fail path taken naturally |

## 2. Why this survived ARCHITECTURE v1–v4

The previous Ralph-loop reviewers were grounded in Anthropic agentic-design URLs (per [[reference-anthropic-agentic-docs]]). Mocha runtime semantics — `Runner.runTests`, `Runner.fail`, the clone-on-retry behavior — are **capability claims** about mocha, not agentic-design claims. They were never WebFetched/grepped against Mocha v10 source. The v3 → v4 transition explicitly invoked the same lesson for VS Code `chatSkills` schema (see ARCHITECTURE.md v4 commentary). The same lesson applies here, one layer down.

## 3. Proposed fix options

User has already chosen **Ralph-loop now** as the resolution path (rather than picking one of the four options below silently). The four options remain on the table for the reviewer's consideration.

### Option A — Custom Mocha reporter (`@qa-debug/mocha-hooks/qa-reporter`)

- Ship a `Reporter` class that subscribes to `EVENT_TEST_FAIL`, `EVENT_TEST_PASS`, `EVENT_TEST_RETRY`, `EVENT_TEST_END`, plus our own IPC-driven decision events from the hook.
- Translate outcomes: a test that failed but has a `mark_passed` decision is rendered as `✓ marked-passed` in stdout AND counted as passed in the final tally.
- mocha command line: `mocha --reporter @qa-debug/mocha-hooks/qa-reporter --require @qa-debug/mocha-hooks/register …`.
- **Tradeoff:** custom reporters are well-documented in mocha and are the canonical extension point for this kind of outcome translation. Adds ~150 LOC; reuses mocha's event surface; doesn't fight retry/clone internals.

### Option B — Oracle/extension-tally only; mocha's tally is informational

- Don't try to translate mocha's stdout. Accept that mocha will print "1 failing" for mark_passed tests.
- The **user-facing** tally is rendered by the oracle (S2) and the extension's Test Explorer + audit log (S4+). The QA never sees raw mocha stdout in normal use; they see Test Explorer.
- ARCHITECTURE §3.1 drops the `currentTest.state = 'passed'` lines and the `parent.retries(currentRetry)` clamp lines. `mark_passed`/`give_up` decisions are just IPC verbs that update PauseStore + UI; the hook just returns.
- **Tradeoff:** simplest. Honest about what mocha can do. Loses the "looks like a normal mocha success" property for non-Test-Explorer consumers (e.g., CI logs of mocha stdout, third-party reporters). May surprise QAs who tail mocha stderr/stdout.

### Option C — Custom Mocha interface (`mocha --ui qa-debug`)

- Replace `mocha.interfaces.bdd` with a `qa-debug` interface that wraps every `it(...)` registration. The wrapper takes the user's test fn and replaces it with a version that: runs the original, catches its throw, asks the oracle/extension for a decision, and EITHER re-throws (give_up) OR returns cleanly (mark_passed) OR re-runs (retry).
- This gets the test's pass/fail to flow through mocha's normal path — no event-suppression trickery.
- **Tradeoff:** invasive — every consumer of mocha-hooks must opt into `--ui qa-debug`. Custom UIs are second-class in mocha tooling (IDE Mocha integrations, Test Explorer extensions, etc.). Combined with `--parallel` it gets exotic (phase 1 excludes parallel — so this is a phase-1-only constraint).

### Option D — Retry-budget consumption trick

- Set `parent.retries(999)` in a `before()` (suite-level) hook so tests genuinely have a retry budget.
- In `afterEach`, on `mark_passed`, do *not* mutate `currentTest.state` (won't work — §1.2). Instead, monkey-patch `this.currentTest.fn` to a no-op before mocha clones it for the next retry. The clone inherits the patched fn; mocha re-runs the test, the no-op succeeds, mocha emits `EVENT_TEST_PASS`.
- **Tradeoff:** depends on internal `test.clone()` semantics that mocha doesn't promise; brittle. Adds one extra retry per mark_passed (the no-op pass), which the audit trail must account for. Likely the wrong answer; included for completeness.

## 4. Recommendation

**Option A (custom reporter)** is the recommended fix to put before the reviewer:

1. mocha exposes reporters as a documented extension point; we are using it for its intended purpose (custom outcome rendering).
2. Doesn't fight runtime internals (`Runner.fail`, `test.clone()`); we layer on top of the events mocha already emits.
3. Reuses the existing IPC channel for the reporter↔hook coordination — no new transport.
4. Maps cleanly to the S4 extension architecture: the extension's Test Explorer integration consumes the same reporter events directly.

**Option B (oracle-tally-only)** is the recommended fallback if the reviewer pushes back on the reporter as ARCHITECTURE-creep. It preserves ARCHITECTURE v4's tool surface and IPC contract; it just drops the state-mutation lines from §3.1.

## 5. Knock-on changes if Option A is adopted

- ARCHITECTURE.md §3.1 hook code block: drop `state = 'passed'`, `err = null`, and `parent.retries(currentRetry())` lines. The hook only publishes pauses and dispatches retry/no-op based on decision kind. Add a sentence: *"The user-facing pass/fail tally is produced by the `qa-reporter` mocha reporter (§3.6), not by state mutation in this hook."*
- ARCHITECTURE.md needs a new **§3.6 Reporter**: scope = consume mocha runner events + IPC decision payloads → render passed/failed/marked-passed inline and in a final tally. Lifecycle: instantiated once per mocha run.
- SLICE_PLAN.md S2 exit criteria: rephrase "retry re-invokes the test; mark_passed reports 1 passed; give_up reports 1 failed" to be reporter-emitted lines rather than mocha-native tally.
- SLICE_PLAN.md S2 scope: add reporter package or reporter source file alongside the hook.
- `qa-debug.paused` context key and SKILL.md description-driven engagement are **unaffected**. The qa-debug MCP tool surface (`qa_propose_mark_passed` etc.) is **unaffected** — it still funnels decisions through PauseStore + IPC.

## 6. Knock-on changes if Option B is adopted

- ARCHITECTURE.md §3.1 hook code block: drop state-mutation lines, document that mocha's stdout will show failures for mark_passed tests.
- ARCHITECTURE.md add a paragraph: *"User-facing pass/fail tally is rendered by the extension's Test Explorer (S4) and audit log channel; mocha's stdout tally is informational and may diverge."*
- No reporter package required.
- SLICE_PLAN.md S2 exit criteria rephrased toward oracle-tally output rather than mocha-tally.

## 7. Open questions for the reviewer

1. **Anthropic-design consistency:** is "mocha's stdout disagrees with Test Explorer" a violation of any Anthropic agentic-design principle (transparency, single-source-of-truth for outcomes)? Or is the Test-Explorer-canonical framing fine because that's the QA's actual interaction surface?
2. **Reporter as an Anthropic-style "observation interface":** the writing-tools-for-agents and effective-context-engineering pages emphasize *high-signal feedback to the agent*. Is the reporter the right place to surface decisions back to the agent (via stdout), or does that belong only in `qa-debug:qa_get_failure_context.last_proposal_status`?
3. **Reversibility framing:** ARCHITECTURE v4 §3.2's `qa_propose_close_browser` defense (asset-destruction asymmetry) was framed around human investigation context. Does the **mocha state-mutation pattern doesn't actually work** finding change anything about the propose-vs-commit verb split? (It shouldn't — the split is enforced at the MCP boundary, not at the mocha boundary — but flag it explicitly.)
4. **Phase 1 scope creep:** adding a reporter package is one more thing to build and test. Is the reviewer comfortable bundling it into S2/S4, or should it land in a new S2.5 / S4.5?
5. **Capability-claim verification mandate:** the ARCHITECTURE.md v3 → v4 lesson was "WebFetch `chatSkills` source before relying on it." The corresponding mandate for v5 should be: "grep installed mocha source for any retry/state-mutation claim before relying on it." Worth codifying in ARCHITECTURE.md as a standing engineering rule?
