/**
 * Source of truth for the 6 qa_* tool definitions.
 * Imported by:
 *  - qa-debug-mcp.ts to register tools on the McpServer
 *  - @qa-debug/evals to build Anthropic.Tool[] for the engagement evals
 *
 * Description rules:
 *  - Third-person voice (ARCHITECTURE §3.2 R2#NB1; Skills best-practices "Always write in third person").
 *  - "Describe to a new hire" format: (i) when to call, (ii) return shape, (iii) ≥1 named error
 *    per anthropic.com/engineering/writing-tools-for-agents.
 *  - Disambiguates qa_propose_close_browser from playwright-mcp:browser_close to avoid
 *    overlap-induced distraction per Anthropic's "more tools don't always lead to better
 *    outcomes" warning in the same article.
 */

import { z } from 'zod';

export interface QaToolJsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties: false;
}

export interface JsonSchemaProp {
  type: 'string' | 'number' | 'boolean';
  enum?: string[];
  description?: string;
}

/**
 * MCP tool annotations per the canonical schema at
 * github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.json
 * (definitions.ToolAnnotations) and SDK ToolAnnotationsSchema at types.d.ts:2361.
 *
 * Per the spec, `destructiveHint` and `idempotentHint` are "meaningful only
 * when readOnlyHint == false". A read-only tool should therefore OMIT them
 * rather than emit them as defaults (see CR-v5.4 §2.3 + iter#2 NB1).
 */
export interface QaToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface QaToolDef<I = unknown> {
  name: string;
  description: string;
  inputSchemaJson: QaToolJsonSchema;
  inputSchemaZod: z.ZodType<I>;
  /**
   * v5.4 §3.4.3 — VS Code 1.120 consumes ONLY `title` + `readOnlyHint` from
   * MCP annotations; the remaining hints are forward-compat for future MCP
   * clients. Empty/undefined = unannotated tool (the default in MCP).
   */
  annotations?: QaToolAnnotations;
}

const sessionIdProp: JsonSchemaProp = {
  type: 'string',
  description:
    'The session_id from the pause notification, or omit to target the currently-active pause.',
};

export const qa_get_failure_context: QaToolDef<{
  session_id?: string;
  response_format?: 'concise' | 'detailed';
}> = {
  name: 'qa_get_failure_context',
  description:
    'Returns the currently paused Mocha test failure as a structured payload. ' +
    'Callers should invoke this first when entering a debugging session — the QA describes the failure conversationally, ' +
    'but the ground-truth shape (failing assertion, stack frames, console output, browser CDP URL) lives in the pause record. ' +
    'Idempotent and safe to call multiple times. ' +
    'Returns: { test_title, file, line, failing_assertion, stack_trace: { frames (<=50 inline; concise mode <=10), more_at? }, ' +
    "cdp_ws_url (use with playwright-mcp:browser_* tools to inspect the held browser), screenshot_path?, " +
    'console_logs: { lines (<=100 inline; concise mode <=20), more_at? }, paused_for_ms, retry_count, max_retries_remaining, ' +
    "last_proposal_status: 'none' | 'awaiting_human' | 'accepted' | 'rejected' for any in-flight qa_propose_* }. " +
    'Errors: NO_ACTIVE_PAUSE when no Mocha test is currently paused; SESSION_NOT_FOUND when session_id is supplied but does not match the active pause.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: sessionIdProp,
      response_format: {
        type: 'string',
        enum: ['concise', 'detailed'],
        description:
          "Defaults to 'concise' (stack <=10 frames, logs <=20 lines). Use 'detailed' only when the concise view is insufficient.",
      },
    },
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string().optional(),
    response_format: z.enum(['concise', 'detailed']).optional(),
  }),
  // v5.4 §2.3 — read-only over MementoPauseStore. destructiveHint /
  // idempotentHint OMITTED per MCP spec "meaningful only when
  // readOnlyHint == false". openWorldHint=false: the tool's domain of
  // interaction is closed (pause store only).
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const qa_request_retry: QaToolDef<{ session_id: string; reason: string }> = {
  name: 'qa_request_retry',
  description:
    'Re-runs the currently paused Mocha test. The before-each hook re-runs; the held browser at cdp_ws_url stays alive across the retry. ' +
    'Reversible: a subsequent failure simply re-pauses with a fresh session_id. ' +
    'Callers should invoke this after the test selector, asserted value, or production code under test has been edited to address the failure — ' +
    'not as a generic "try again" without a diff. The supplied reason is surfaced verbatim in the chat notification, the Test Explorer annotation, ' +
    'and the audit log; callers should write it for a QA who did not see the conversation (e.g., "selector .submit-btn renamed to .primary-submit"). ' +
    "Returns: { decision: 'retry', accepted_at_ms }. " +
    'Errors: NO_ACTIVE_PAUSE when the pause was already resolved; SESSION_NOT_FOUND when session_id is stale.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { ...sessionIdProp, description: 'The session_id from the pause notification.' },
      reason: {
        type: 'string',
        description:
          'Free-text rationale (1–2 sentences) surfaced to the QA verbatim. Write specifically what was changed; not "let us try again".',
      },
    },
    required: ['session_id', 'reason'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    reason: z.string(),
  }),
  // v5.4 §2.3 — propose verb: creates a proposal, commit happens via UI button.
  // destructiveHint=false because the proposal itself is additive (DecisionRouter
  // enforces single-shot semantics — no overwriting prior proposals).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qa_request_give_up: QaToolDef<{ session_id: string; reason: string }> = {
  name: 'qa_request_give_up',
  description:
    'Marks the paused Mocha test as a final failure and lets Mocha proceed to the next test. The held browser is released and the MCP gate closes. ' +
    'Reversible only by re-running the suite. ' +
    'Callers should invoke this when the failure is genuine and no retry is warranted (e.g., the asserted product behavior is wrong and requires a fix in source). ' +
    'The supplied reason is surfaced verbatim in the chat notification, the Test Explorer annotation, and the audit log. ' +
    "Returns: { decision: 'give_up', accepted_at_ms }. " +
    'Errors: NO_ACTIVE_PAUSE when the pause was already resolved; SESSION_NOT_FOUND when session_id is stale.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { ...sessionIdProp, description: 'The session_id from the pause notification.' },
      reason: {
        type: 'string',
        description:
          'Free-text rationale (1–2 sentences) surfaced to the QA verbatim. State the root cause concretely.',
      },
    },
    required: ['session_id', 'reason'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    reason: z.string(),
  }),
  // v5.4 §2.3 — propose verb (see qa_request_retry rationale).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qa_propose_mark_passed: QaToolDef<{ session_id: string; rationale: string }> = {
  name: 'qa_propose_mark_passed',
  description:
    'Proposes marking the failing test as passed without re-running. Does NOT commit. ' +
    'Surfaces a confirmation button in the Test Explorer and the chat for the human to accept or reject. ' +
    'Callers should reserve this for environmental flake signals (upstream API hiccup, transient infra error, known-broken staging fixture). ' +
    "Callers MUST NOT invoke when the failing assertion's value is derived from production code paths — that is a real bug and should follow qa_request_give_up or a fix-and-retry. " +
    'The supplied rationale is what the QA reads when deciding; be specific and falsifiable (e.g., "intermittent 503 from auth-service at 14:03; subsequent /healthz returns 200"). ' +
    "After calling, the next correct step is to stop and report the proposal in chat; the verdict surfaces via qa_get_failure_context.last_proposal_status: 'accepted' | 'rejected'. " +
    "Returns: { proposal_id, status: 'awaiting_human' }. " +
    'Errors: NO_ACTIVE_PAUSE when no pause is active; SESSION_NOT_FOUND when session_id is stale.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { ...sessionIdProp, description: 'The session_id from the pause notification.' },
      rationale: {
        type: 'string',
        description:
          'Specific, falsifiable rationale the human reads verbatim. Cite concrete signals (timestamps, log lines, observed behavior) — not "looks flaky".',
      },
    },
    required: ['session_id', 'rationale'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    rationale: z.string(),
  }),
  // v5.4 §2.3 — propose verb (see qa_request_retry rationale).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qa_propose_close_browser: QaToolDef<{ session_id: string; rationale: string }> = {
  name: 'qa_propose_close_browser',
  description:
    "Proposes closing the held debugging browser at the pause's cdp_ws_url. Does NOT commit. " +
    'Surfaces a confirmation button for the human. ' +
    "Distinct from playwright-mcp:browser_close: that tool ends the agent's Playwright session against the browser; " +
    "this tool tears down the underlying held-on-failure Chrome process the QA Debug Companion owns. Calling browser_close does NOT close this Chrome. " +
    'Closing this Chrome destroys the QA\'s live inspection asset (DOM, console history, network state). ' +
    'Callers should invoke this only when investigation is genuinely complete or the browser is unrecoverable (e.g., crashed renderer). ' +
    'After calling, stop and report in chat; the verdict surfaces via qa_get_failure_context.last_proposal_status. ' +
    "Returns: { proposal_id, status: 'awaiting_human' }. " +
    'Mode A note (transparent wdio.remote integration, v5.2): when the browser was launched by your test code via webdriverio.remote(), ' +
    "this tool returns { status: 'declined', reason: '...' } immediately because the test code owns the browser lifecycle. " +
    'Close the browser via browser.deleteSession() in your test teardown instead. ' +
    'Errors: NO_ACTIVE_PAUSE when no pause is active; SESSION_NOT_FOUND when session_id is stale.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { ...sessionIdProp, description: 'The session_id from the pause notification.' },
      rationale: {
        type: 'string',
        description:
          "Specific rationale the human reads verbatim (e.g., 'investigation complete; QA confirmed root cause' or 'renderer crashed; CDP unresponsive').",
      },
    },
    required: ['session_id', 'rationale'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    rationale: z.string(),
  }),
  // v5.4 §2.3 — propose verb (see qa_request_retry rationale).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qa_propose_abort_suite: QaToolDef<{ session_id: string; rationale: string }> = {
  name: 'qa_propose_abort_suite',
  description:
    'Proposes aborting the remaining Mocha suite. Does NOT commit. Surfaces a confirmation button for the human. ' +
    'Destroys remaining test work in the current run. ' +
    'Callers should reserve this for cases where continuing the suite is clearly wasted effort: ' +
    'global misconfiguration (wrong staging URL, missing seed data), license/credential failures that block every downstream test, ' +
    'or catastrophic infra outage. NOT for a single failed assertion. ' +
    'After calling, stop and report in chat; the verdict surfaces via qa_get_failure_context.last_proposal_status. ' +
    "Returns: { proposal_id, status: 'awaiting_human' }. " +
    'Errors: NO_ACTIVE_PAUSE when no pause is active; SESSION_NOT_FOUND when session_id is stale.',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: { ...sessionIdProp, description: 'The session_id from the pause notification.' },
      rationale: {
        type: 'string',
        description:
          'Specific rationale citing the cross-test signal (e.g., "all tests fail at fixture seed: pg_connection_refused").',
      },
    },
    required: ['session_id', 'rationale'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    rationale: z.string(),
  }),
  // v5.4 §2.3 — propose verb (see qa_request_retry rationale).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qaTools = [
  qa_get_failure_context,
  qa_request_retry,
  qa_request_give_up,
  qa_propose_mark_passed,
  qa_propose_close_browser,
  qa_propose_abort_suite,
] as const;

export type QaToolName = (typeof qaTools)[number]['name'];

export const QA_TOOL_NAMES: ReadonlySet<string> = new Set(qaTools.map((t) => t.name));
