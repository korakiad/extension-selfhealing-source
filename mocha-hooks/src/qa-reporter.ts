// qa-reporter — Mocha reporter implementing ARCHITECTURE v5 §3.6.
// Single source of truth for human-facing outcome rendering.
//
// Subscribed events (Mocha v10 names via `Runner.constants`):
//   EVENT_RUN_BEGIN, EVENT_TEST_BEGIN, EVENT_TEST_PASS, EVENT_TEST_FAIL,
//   EVENT_TEST_RETRY, EVENT_TEST_END, EVENT_RUN_END.
//
// Correlation with hook decisions: the hook (qa-hooks.cjs) emits a `final_decision`
// JSON-RPC notification over the IPC channel after every pause it resolves; the
// reporter consumes those notifications via a JsonRpcConnection sharing the same
// `process` and renders the tri-state outcome at EVENT_TEST_END.

import type * as Mocha from 'mocha';
// Resolve mocha via require.main so we bind to the SAME instance the user's
// mocha bin loaded — same rationale as qa-hooks.ts. Bare `require('mocha')`
// fails in the shipped vsix because this file lives under the extension dir
// with no mocha up the parent chain.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mocha: typeof Mocha = require.main?.require('mocha') ?? require('mocha');
import {
  DecisionKind,
  FinalDecisionParams,
  inProcBus,
} from './protocol';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

type Outcome = 'passed' | 'failed' | 'marked-passed';

interface RecordedDecision {
  kind: DecisionKind;
  reason: string;
  by: 'agent' | 'human' | 'hook';
  session_id: string;
}

interface ReporterOptions {
  treatMarkedAsPassing?: boolean;
}

function key(test: Mocha.Test): string {
  return `${test.file ?? '<inline>'} :: ${test.fullTitle()}`;
}

function parseOptions(opts: unknown): ReporterOptions {
  if (typeof opts === 'object' && opts !== null && 'reporterOptions' in opts) {
    const ro = (opts as { reporterOptions?: Record<string, unknown> }).reporterOptions;
    if (ro && typeof ro === 'object') {
      return {
        treatMarkedAsPassing:
          ro['qa-treat-marked-as-passing'] === true ||
          ro['qa-treat-marked-as-passing'] === 'true',
      };
    }
  }
  if (process.env.QA_TREAT_MARKED_AS_PASSING === '1') {
    return { treatMarkedAsPassing: true };
  }
  return {};
}

export class QaReporter {
  private readonly decisions = new Map<string, RecordedDecision>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly notes = new Map<string, string>();
  private readonly retriesByKey = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private readonly options: ReporterOptions;

  // Final tally (rendered at EVENT_RUN_END):
  private passed = 0;
  private failed = 0;
  private markedPassed = 0;

  constructor(runner: Mocha.Runner, opts?: unknown) {
    this.options = parseOptions(opts);

    // Subscribe to the in-process bus that the hook (qa-hooks.cjs) emits to after
    // every resolved pause. This is the in-process correlation channel that the
    // mocha child process cannot get via `process.on('message')` (that only carries
    // messages sent FROM the parent).
    this.unsubscribe = inProcBus.onFinalDecision((params: FinalDecisionParams) => {
      // v5.5 §2.4: field renamed test_title → full_title; correlation key is
      // unchanged (it was always the full title — just the field name shifts).
      const k = `${params.test_file ?? '<inline>'} :: ${params.full_title}`;
      this.decisions.set(k, {
        kind: params.kind,
        reason: params.reason,
        by: params.by,
        session_id: params.session_id,
      });
    });

    const C = mocha.Runner.constants;

    runner.on(C.EVENT_RUN_BEGIN, () => {
      this.write(`\n${BOLD}qa-reporter${RESET} — v5 tri-state outcome renderer\n\n`);
    });

    runner.on(C.EVENT_TEST_BEGIN, (test: Mocha.Test) => {
      // Drain any pending render from the previous test: by now the previous
      // test's afterEach has run to completion (mocha invokes the next test
      // synchronously inside the afterEach completion callback in runner.js:828),
      // so any final_decision from the hook is already in the decisions map.
      this.flushPending();
      this.write(`  ${DIM}▶ ${test.fullTitle()}${RESET}\n`);
    });

    runner.on(C.EVENT_TEST_PASS, (test: Mocha.Test) => {
      this.outcomes.set(key(test), 'passed');
    });

    runner.on(C.EVENT_TEST_FAIL, (test: Mocha.Test, err: Error) => {
      // v5.8 — replicate Mocha Base reporter's `test.err = err` assignment
      // (node_modules/mocha/lib/reporters/base.js:379-390). Runner.fail does
      // NOT set test.err — only the Base reporter does, via this same event.
      // We replaced Base with this reporter per ARCH v5 §3.6 and inadvertently
      // dropped the assignment; qa-hooks afterEach reads test.err to ground the
      // agent's failing_assertion. Multi-attach (test.err.multiple) is
      // load-bearing not dead-code: runner.js:505,543 call `self.fail(hook,
      // err)` when a beforeEach/afterEach hook fails AFTER the test fails,
      // firing a SECOND EVENT_TEST_FAIL for the SAME test in the SAME process
      // (no respawn needed). The multi-attach prevents the hook-failure error
      // from clobbering the test-body error.
      interface ErrorWithMultiple extends Error {
        multiple?: Error[];
      }
      if (test.err && err instanceof Error) {
        const prior = test.err as ErrorWithMultiple;
        prior.multiple = (prior.multiple ?? []).concat(err);
      } else {
        test.err = err;
      }
      this.notes.set(key(test), err.message ?? String(err));
    });

    runner.on(C.EVENT_TEST_RETRY, (test: Mocha.Test) => {
      this.retriesByKey.set(key(test), (this.retriesByKey.get(key(test)) ?? 0) + 1);
    });

    runner.on(C.EVENT_TEST_END, (test: Mocha.Test) => {
      // EVENT_TEST_END fires BEFORE afterEach (runner.js:827 vs :828). We cannot
      // render yet because the hook's final_decision notification has not arrived.
      // Queue the test for rendering at the next EVENT_TEST_BEGIN or at EVENT_RUN_END.
      this.pendingTest = test;
    });

    runner.on(C.EVENT_RUN_END, () => {
      this.flushPending();
      this.renderTally();
      this.setExitCode();
      this.unsubscribe();
    });
  }

  private pendingTest?: Mocha.Test;

  private flushPending(): void {
    const test = this.pendingTest;
    if (!test) return;
    this.pendingTest = undefined;

    const k = key(test);
    const decision = this.decisions.get(k);
    const errMessage = this.notes.get(k);

    let outcome: Outcome = this.outcomes.get(k) ?? 'failed';
    if (test.state === 'passed') outcome = 'passed';
    else if (test.state === 'failed') {
      if (decision?.kind === 'mark_passed') outcome = 'marked-passed';
      else outcome = 'failed';
    }

    this.outcomes.set(k, outcome);
    this.renderEnd(test, outcome, decision, errMessage);
  }

  private renderEnd(
    test: Mocha.Test,
    outcome: Outcome,
    decision: RecordedDecision | undefined,
    errMessage: string | undefined,
  ): void {
    const retries = this.retriesByKey.get(key(test)) ?? 0;
    const retrySuffix = retries > 0 ? ` ${DIM}(${retries} retries)${RESET}` : '';

    if (outcome === 'passed') {
      this.passed++;
      this.write(`    ${GREEN}✓${RESET} ${test.title}${retrySuffix}\n`);
      return;
    }
    if (outcome === 'marked-passed') {
      this.markedPassed++;
      const by = decision?.by ?? 'human';
      const reason = decision?.reason ?? '<no rationale>';
      this.write(
        `    ${YELLOW}✓ marked-passed${RESET} ${test.title}${retrySuffix} ${DIM}— by ${by}: ${reason}${RESET}\n`,
      );
      if (errMessage) {
        this.write(`      ${DIM}(original failure: ${errMessage})${RESET}\n`);
      }
      return;
    }
    // failed
    this.failed++;
    const reasonStr = decision ? ` ${DIM}— ${decision.kind} by ${decision.by}: ${decision.reason}${RESET}` : '';
    this.write(`    ${RED}✗${RESET} ${test.title}${retrySuffix}${reasonStr}\n`);
    if (errMessage) {
      this.write(`      ${DIM}${errMessage}${RESET}\n`);
    }
  }

  private renderTally(): void {
    const parts: string[] = [
      `${GREEN}${this.passed} passing${RESET}`,
      `${RED}${this.failed} failing${RESET}`,
      `${YELLOW}${this.markedPassed} marked-passed${RESET}`,
    ];
    this.write(`\n${BOLD}Tally:${RESET} ${parts.join(', ')}\n`);
    if (this.markedPassed > 0 && !this.options.treatMarkedAsPassing) {
      this.write(
        `${DIM}(marked-passed tests do NOT relax the CI exit code; pass --reporter-options qa-treat-marked-as-passing=true to opt in)${RESET}\n`,
      );
    }
  }

  private setExitCode(): void {
    const breakingFailures = this.options.treatMarkedAsPassing
      ? this.failed
      : this.failed + this.markedPassed;
    if (breakingFailures > 0) {
      process.exitCode = 1;
    }
  }

  private write(s: string): void {
    process.stdout.write(s);
  }
}

// Mocha resolves a reporter by `require`-ing the module and using the default export
// (or `module.exports`). esbuild's CJS output writes `module.exports.QaReporter = ...`;
// we also need a plain `module.exports = QaReporter` shape so `--reporter <path>` works.
// Done in the bundle wrapper post-processing (see esbuild.config.mjs banner / footer).
export default QaReporter;
