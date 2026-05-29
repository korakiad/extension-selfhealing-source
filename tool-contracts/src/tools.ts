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
  type: 'string' | 'number' | 'boolean' | 'array';
  enum?: string[];
  description?: string;
  // v5.16 PLAN-cdp-port-discovery §3.11.0 — array support for qa_discover_chromes.ports.
  items?: { type: 'string' | 'number' | 'boolean'; minimum?: number; maximum?: number };
  minItems?: number;
  maxItems?: number;
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
    'cdp_ws_url (DERIVED from selection; null until a chrome is selected — see selection branching below), ' +
    'available_chromes: [{port, ws_url, page_titles, tab_count, runtime}, ...] (discovered via /json/version + /json/list probe at pause time; runtime is a best-effort chrome|electron|openfin|unknown label, tab_count is the page-target count), ' +
    "selected_cdp_port (null until qa_select_chrome commits), screenshot_path?, " +
    'console_logs: { lines (<=100 inline; concise mode <=20), more_at? }, paused_for_ms, retry_count, max_retries_remaining, ' +
    "last_proposal_status: 'none' | 'awaiting_human' | 'accepted' | 'rejected' for any in-flight qa_propose_* }. " +
    'Chrome selection branching (v5.16 PLAN-cdp-port-discovery): ' +
    '(1) selected_cdp_port non-null AND cdp_ws_url non-null → selection already committed; playwright-mcp is auto-registered against the held browser — just call browser_snapshot (no attach step; cdp_ws_url is informational, not passed to any tool). ' +
    '(2) selected_cdp_port null AND available_chromes.length === 1 → call qa_select_chrome(session_id, available_chromes[0].port); no user confirmation needed. ' +
    '(3) selected_cdp_port null AND available_chromes.length >= 2 → STOP, ask the user in chat which chrome to use (surface page_titles for context), then call qa_select_chrome with their pick. ' +
    "(4) selected_cdp_port null AND available_chromes.length === 0 → STOP, ask the user 'I couldn't find Chrome at the default debug ports. What port(s) does your test framework launch Chrome on?', then call qa_discover_chromes(session_id, [user-ports]) and re-enter this branching. " +
    'Multi-tab orient: if the selected chrome has tab_count > 1 (Electron / OpenFin desktop runtimes expose many windows/webviews), the page playwright-mcp lands on is arbitrary — call browser_tabs(action:"list") then browser_tabs(action:"select", index) to land on the page under test BEFORE browser_snapshot. (runtime electron/openfin is a hint; tab_count > 1 is the trigger.) ' +
    'Until selection commits, playwright-mcp is NOT registered, so the browser_* tools have no target — selecting a chrome is what registers it. ' +
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

export const qa_request_give_up: QaToolDef<{ session_id: string; reason: string }> = {
  name: 'qa_request_give_up',
  description:
    'Marks the paused Mocha test as a final failure and lets Mocha proceed to the next test. The held browser is released and the MCP gate closes. ' +
    'Reversible only by re-running the suite. ' +
    'Callers should invoke this when the failure is genuine and no retry is warranted (e.g., the asserted product behavior is wrong and requires a fix in source). ' +
    'The supplied reason is surfaced verbatim in the chat notification, the Test Explorer annotation, and the audit log. ' +
    "Returns: { decision: 'give_up', accepted_at_ms }. " +
    'Errors: NO_ACTIVE_PAUSE when no pause is active; SESSION_NOT_FOUND when session_id is stale; ' +
    'PAUSE_ALREADY_RESOLVED when another caller committed the verb first.',
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
  // v5.6 — request verb (see qa_request_retry rationale): auto-commits via
  // DecisionRouter; returns PAUSE_ALREADY_RESOLVED on lost-race.
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

// ---- v5.16 PLAN-cdp-port-discovery — Mode C chrome discovery + selection ----

export const qa_discover_chromes: QaToolDef<{ session_id: string; ports: number[] }> = {
  name: 'qa_discover_chromes',
  description:
    "Re-probes a user-supplied list of ports for active Chrome CDP endpoints, then replaces the current pause's available_chromes with the result. " +
    'Use when qa_get_failure_context.available_chromes is empty (defaults unreachable) OR when the previously-selected Chrome appears dead (e.g., playwright-mcp returns "target closed"). ' +
    'Callers MUST ask the user for the port list — do NOT guess or scan. ' +
    'Side-effects on the active pause: REPLACES available_chromes; CLEARS selected_cdp_port IFF the prior selection\'s port is not present in the new list. ' +
    'Callers must call qa_select_chrome after this tool to commit a selection. ' +
    'Idempotent: calling twice with the same ports yields the same available_chromes result. ' +
    'Returns: { available_chromes: [{port, ws_url, page_titles, tab_count, runtime}, ...] }. ' +
    'Errors: NO_ACTIVE_PAUSE (session_id stale); INVALID_PORT (any port outside 1024-65535); ' +
    'NO_CHROMES_FOUND (none of the supplied ports responded — re-ask the user or surface the framework launch failure).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Active pause session_id from qa_get_failure_context.',
      },
      ports: {
        type: 'array',
        items: { type: 'number', minimum: 1024, maximum: 65535 },
        minItems: 1,
        maxItems: 8,
        description: 'Integer port numbers (1024-65535) the test framework launched Chrome on.',
      },
    },
    required: ['session_id', 'ports'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    ports: z.array(z.number().int().min(1024).max(65535)).min(1).max(8),
  }),
  annotations: {
    readOnlyHint: false, // mutates pause-store
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true, // HTTP fetches localhost; outside qa-debug closed world
  },
};

export const qa_select_chrome: QaToolDef<{ session_id: string; port: number }> = {
  name: 'qa_select_chrome',
  description:
    "Commits the chosen Chrome from available_chromes as the pause's active browser. " +
    'After this tool returns, qa_get_failure_context will surface cdp_ws_url populated with the selected chrome\'s URL, and the extension will register playwright-mcp against it. ' +
    'Until this commits, cdp_ws_url is null and playwright-mcp is NOT registered. ' +
    'If available_chromes.length === 1 you may select that port without asking the user. ' +
    'If length >= 2, ask the user which chrome (use page_titles for context) and call with their pick. ' +
    'Idempotent within a pause: calling twice with different ports replaces the selection and re-registers playwright-mcp at the new endpoint. ' +
    'Returns: { cdp_ws_url, port, page_titles }. ' +
    'Errors: NO_ACTIVE_PAUSE; SESSION_NOT_FOUND; INVALID_PORT (port not in current available_chromes — call qa_discover_chromes first if the framework rev\'d ports).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Active pause session_id from qa_get_failure_context.',
      },
      port: {
        type: 'number',
        description: "Port from available_chromes[].port (the user's pick).",
      },
    },
    required: ['session_id', 'port'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string(),
    port: z.number().int().min(1024).max(65535),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const qaTools = [
  qa_get_failure_context,
  qa_request_give_up,
  qa_propose_mark_passed,
  qa_propose_abort_suite,
  qa_discover_chromes,
  qa_select_chrome,
] as const;

export type QaToolName = (typeof qaTools)[number]['name'];

export const QA_TOOL_NAMES: ReadonlySet<string> = new Set(qaTools.map((t) => t.name));
