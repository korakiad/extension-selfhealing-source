/**
 * Source of truth for the qa_* tool definitions.
 * Imported by:
 *  - qa-debug-mcp server.ts to register tools on the McpServer (stdio/evals host)
 *  - extension/tools/gen-lm-tools.mjs to generate package.json languageModelTools
 *  - @qa-debug/evals to build Anthropic.Tool[] for the engagement evals
 *
 * Verdict verbs removed (2026-05-31): qa_propose_mark_passed, qa_request_give_up,
 * and qa_propose_abort_suite are gone. A pause is now a pure inspection hold (a
 * breakpoint): the agent investigates the held browser, proposes a fix in chat,
 * and the QA re-runs from Test Explorer ▶ or ends the run with Stop. There is no
 * agent- or human-committed pass/fail verdict — the test stands at its natural
 * Mocha outcome. Surviving tools: get_failure_context (read-only grounding),
 * the discover/select chrome pair, and qa_pick_element (CDP-native picker).
 *
 * Description rules:
 *  - Third-person voice (Skills best-practices "Always write in third person").
 *  - "Describe to a new hire" format: (i) when to call, (ii) return shape, (iii) ≥1 named error
 *    per anthropic.com/engineering/writing-tools-for-agents.
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
  // v5.16 — array support for qa_discover_chromes.ports.
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
 * rather than emit them as defaults.
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
   * v5.4 — VS Code 1.120 consumes ONLY `title` + `readOnlyHint` from
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
    'console_logs: { lines (<=100 inline; concise mode <=20), more_at? }, paused_for_ms, retry_count, max_retries_remaining }. ' +
    'A pause is a pure inspection hold (a breakpoint): there is no pass/fail verdict to commit and no decision verb to call. ' +
    'After investigating, propose any fix in chat; the QA re-runs from Test Explorer or ends the run with Stop. ' +
    'Chrome selection branching: ' +
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
  // v5.4 — read-only over MementoPauseStore. destructiveHint /
  // idempotentHint OMITTED per MCP spec "meaningful only when
  // readOnlyHint == false". openWorldHint=false: the tool's domain of
  // interaction is closed (pause store only).
  annotations: { readOnlyHint: true, openWorldHint: false },
};

// ---- v5.16 — Mode C chrome discovery + selection ----

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

export const qa_pick_element: QaToolDef<{ session_id?: string }> = {
  name: 'qa_pick_element',
  description:
    "Arms Chrome's native DevTools element inspector on the pause's selected held browser so the QA can point at the exact element a failing selector should match, then returns that element's structured attributes. " +
    'Call during a pause AFTER a chrome is selected (selected_cdp_port non-null) when the failure is selector-anchored and the right DOM node is not obvious from browser_snapshot, or when the QA says "let me show you which element". ' +
    'Unlike a page-script picker, the inspector runs in the browser process, so it pierces cross-origin iframes, open AND closed shadow DOM, web components, and canvas overlays — the QA just hovers (Chrome highlights the element) and clicks once, anywhere, with no awareness of frames or shadow roots. ' +
    'Blocks until the QA clicks or ~120s elapse. ' +
    'Returns on click: { picked: { tag, id, name, classes, data (data-* map, e.g. data-e2e), aria (incl. role), text, selector, nthOfType, inFrame, frameUrl, frameChain, frameChainComplete, ancestors } }. On timeout/cancel: { cancelled: true, reason }. ' +
    'Output is FRAMEWORK-NEUTRAL — raw DOM facts plus plain CSS selectors; it contains NO ready-made test-framework locator. The caller MUST build the final locator by FIRST investigating the consumer project: read its existing tests / page-objects / helpers to learn the test framework in use, the selector strategy it favours (e.g. data-e2e/data-test/id/role/accessible-name), how its tests reach elements inside iframes, any custom selector wrappers, and its shadow-DOM handling — then replicate that exact convention. Do NOT assume any framework and do NOT copy a selector from training data. selector is a preference-ordered plain CSS selector for the leaf (data-e2e/test → id → name → class → tag:nth-of-type); a hint only — prefer building from the structured attributes (data/aria/role/text) in the project\'s pattern. ' +
    'frameChain is the ordered outer→inner iframe ancestry (each item { selector, url }; selector = plain CSS for the iframe element); it handles arbitrarily nested AND cross-origin (OOPIF) frames. Enter the frames in order using whatever frame-entry idiom the consumer\'s own tests use. Empty means the node is in the top document. If frameChainComplete is false, a frame level could not be resolved (rare same-process cross-origin frame) — identify the missing iframe(s) manually. ' +
    'ancestors is the DOM ancestor chain of the picked node within its frame, nearest→outermost (each item { tag, id, classes, data, role, ariaLabel, name, selector, nthOfType, shadowHost? }), crossing shadow DOM. Use it to scope/disambiguate when the leaf alone is not unique — anchor on the nearest ancestor carrying a stable data-* / id / role and descend to the leaf. NOTE on shadow DOM: open shadow roots are pierced by most modern selector engines; closed shadow roots generally cannot be reached by a selector at all — when shadowHost:true sits on a closed host, surface it and follow however the project handles shadow DOM (or a non-selector strategy). ' +
    'nthOfType (on the leaf and every ancestor) is the 1-based position among same-tag siblings; an element with no stable hook gets a selector like tag:nth-of-type(n) (valid CSS anywhere). Prefer stable attributes/role/text; use nthOfType only as a last-resort disambiguator. ' +
    'Errors: NO_ACTIVE_PAUSE (no Mocha test paused); SESSION_NOT_FOUND (session_id does not match the active pause); BROWSER_NOT_SELECTED (no chrome committed — call qa_select_chrome first); CDP_CONNECT_FAILED (the held browser CDP endpoint was unreachable or exposed no page target).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      session_id: sessionIdProp,
    },
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    session_id: z.string().optional(),
  }),
  // Pure inspection: arms a transient browser overlay and reads what the QA
  // clicks; no page DOM mutation. openWorldHint=false (closed: the held browser).
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const qaTools = [
  qa_get_failure_context,
  qa_discover_chromes,
  qa_select_chrome,
  qa_pick_element,
] as const;

export type QaToolName = (typeof qaTools)[number]['name'];

export const QA_TOOL_NAMES: ReadonlySet<string> = new Set(qaTools.map((t) => t.name));
