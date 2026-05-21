export type ScenarioExpectation = 'qa_get_failure_context' | 'no_qa_tool';

export interface Scenario {
  id: number;
  name: string;
  paused: boolean;
  pauseNotification?: string;
  userPrompt: string;
  expect: ScenarioExpectation;
  passThreshold: number;
  isNegative: boolean;
  rationale: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: 'timeout (positive)',
    paused: true,
    pauseNotification:
      '[QA Debug Companion] Test "user dashboard loads within 5s" failed at fixture-tests/specs/timeout.spec.js:18 — TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms. Browser held at ws://localhost:9222. Session sid_timeout_001.',
    userPrompt: 'the timeout test just failed, what\'s going on',
    expect: 'qa_get_failure_context',
    passThreshold: 4,
    isNegative: false,
    rationale: 'Step-1 honored: ground via qa_get_failure_context before any browser_* tool.',
  },
  {
    id: 2,
    name: 'value mismatch (positive, browser_evaluate distractor)',
    paused: true,
    pauseNotification:
      '[QA Debug Companion] Test "cart total reflects discount" failed at fixture-tests/specs/value-mismatch.spec.js:24 — AssertionError: expected "$80.00" but got "$90.00". Browser held at ws://localhost:9222. Session sid_value_002.',
    userPrompt: "this assertion's wrong, can you look",
    expect: 'qa_get_failure_context',
    passThreshold: 4,
    isNegative: false,
    rationale:
      'browser_evaluate is the tempting first call to read the live value; Skill Step-1 requires grounding via qa_get_failure_context first.',
  },
  {
    id: 3,
    name: 'selector (positive, browser_snapshot distractor)',
    paused: true,
    pauseNotification:
      '[QA Debug Companion] Test "checkout submit succeeds" failed at fixture-tests/specs/selector.spec.js:31 — Error: locator(".submit-btn") resolved to 0 elements. Browser held at ws://localhost:9222. Session sid_selector_003.',
    userPrompt: 'I think the selector changed',
    expect: 'qa_get_failure_context',
    passThreshold: 4,
    isNegative: false,
    rationale:
      'browser_snapshot is the tempting first call to dump the DOM; Skill Step-1 requires grounding first.',
  },
  {
    id: 4,
    name: 'unrelated postgres query (negative, paused)',
    paused: true,
    pauseNotification:
      '[QA Debug Companion] Test "user dashboard loads within 5s" failed at fixture-tests/specs/timeout.spec.js:18 — TimeoutError. Browser held at ws://localhost:9222. Session sid_timeout_004.',
    userPrompt: 'how do I write a select-all query in postgres',
    expect: 'no_qa_tool',
    passThreshold: 5,
    isNegative: true,
    rationale:
      'Skill must not engage on a generic SQL question even while a pause is active. The qa-debug Skill is for engaging with the pause, not all conversation during it.',
  },
  {
    id: 5,
    name: 'weather (negative, paused)',
    paused: true,
    pauseNotification:
      '[QA Debug Companion] Test "user dashboard loads within 5s" failed at fixture-tests/specs/timeout.spec.js:18 — TimeoutError. Browser held at ws://localhost:9222. Session sid_timeout_005.',
    userPrompt: "what's the weather",
    expect: 'no_qa_tool',
    passThreshold: 5,
    isNegative: true,
    rationale: 'Off-topic chit-chat must not engage the Skill.',
  },
  {
    id: 6,
    name: 'postgres test failing in CI (near-miss, NOT paused)',
    paused: false,
    userPrompt: 'my postgres test is failing in CI',
    expect: 'no_qa_tool',
    passThreshold: 5,
    isNegative: true,
    rationale:
      'Description must discriminate on "currently paused" signal — not the "test/debug" keyword. A failing CI test that the user is asking about retrospectively is not a paused-session-with-held-browser case.',
  },
];
