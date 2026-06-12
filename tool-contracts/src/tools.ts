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
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  enum?: string[];
  description?: string;
  // v5.16 — array support for qa_discover_chromes.ports.
  items?: { type: 'string' | 'number' | 'boolean'; minimum?: number; maximum?: number };
  minItems?: number;
  maxItems?: number;
  // qa_testrail_post.body — free-form JSON object (TestRail bodies carry
  // markdown/newlines; JSON-in-a-string double-encoding is an escaping-failure
  // source). gen-lm-tools.mjs copies inputSchemaJson verbatim, so this passes
  // through to package.json unchanged.
  additionalProperties?: boolean;
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
    "Arms Chrome's native DevTools element inspector on the active inspection's selected browser so the QA can point at the exact element, then returns a VERIFICATION-READY description of the clicked node: computed accessibility facts, an injected unique marker, and live match-counted CSS candidates. " +
    'Works on EITHER surface: (a) a paused Mocha test\'s held browser, or (b) a running web/desktop app the QA launched for inspection via "QA Debug: Inspect App" (a Live Inspect Session). Call when the right DOM node is not obvious from browser_snapshot, or when the QA says "let me show you which element". For a pause, a chrome must be selected first (selected_cdp_port non-null); a Live Inspect Session auto-selects its launched browser. ' +
    'The hit-test runs in the browser process, so it pierces cross-origin iframes, open AND closed shadow DOM, web components, and canvas overlays — the QA just hovers (Chrome highlights the element) and clicks once, anywhere. Blocks until the QA clicks or ~120s elapse. ' +
    'Returns on click: { picked: { tag, id, name, classes, data, aria, text, role, accessibleName, marker, candidates, uniquePath, scope, nthOfType, rect, isInteractive, shadow, inFrame, frameUrl, frameChain, frameChainComplete, ancestors } }. On timeout/cancel: { cancelled: true, reason }. ' +
    'THE THREE VERIFICATION HANDLES (use them — never hand the QA an unverified guess): ' +
    '(1) role + accessibleName are the COMPUTED accessibility role and name — the exact vocabulary browser_snapshot displays (implicit roles included). Find the picked node in a fresh browser_snapshot by them. ' +
    "(2) marker ({ attr: 'data-qa-pick', value, selector } | null) is a unique attribute injected onto the picked element. Verify any snapshot ref or candidate locator with one browser_evaluate on that ref: el.getAttribute('data-qa-pick') === marker.value (or el.closest(marker.selector) when the snapshot node is a descendant). VOLATILE: cleared by the next pick in the same document, lost on reload/re-render — verify soon after picking, and NEVER ship it as the final locator. " +
    "(3) candidates ([{ css, matchCount }]) are ranked plain-CSS leaf selectors, EACH with matchCount counted LIVE within scope (the leaf's document or innermost shadow root). matchCount 1 = actually unique there; matchCount 94 = ambiguous, do NOT use alone. Trust the counts over intuition — real apps reuse ids and classes freely. uniquePath is a child-combinator CSS path already verified to match EXACTLY ONE node in scope (null only on hostile DOM). " +
    "rect is the border box { x, y, width, height } in the OWNING frame's viewport coordinates (null if not rendered) — the coordinate handle for canvas/chart surfaces with no DOM below the canvas element. " +
    'isInteractive false means the QA clicked a presentational leaf (svg path, span); the nearest ancestors[] entry flagged interactive:true is usually the intended target — confirm with the QA which one they mean. ' +
    'frameChain is the ordered outer→inner iframe ancestry (each { selector, url }; selector = plain CSS for the iframe element), covering arbitrarily nested AND cross-origin (OOPIF) frames; empty = top document. If frameChainComplete is false, a frame level could not be resolved — identify the missing iframe(s) manually. ' +
    'ancestors is the within-frame ancestor chain nearest→outermost (each { tag, id, classes, data, role, ariaLabel, name, selector, matchCount, nthOfType, interactive?, shadowRoot? }), crossing shadow DOM — shadowRoot:"open"|"closed" marks each shadow host crossed. shadow summarizes the worst boundary: "closed" means NO CSS selector can reach the leaf from outside — say so and follow the project\'s escape hatch. scope:"shadowRoot" means candidates/uniquePath resolve inside that root, not from document. ' +
    'Output is FRAMEWORK-NEUTRAL — facts plus plain CSS; it contains NO ready-made test-framework locator. Build the final locator by FIRST investigating the consumer project: read its existing tests / page-objects / helpers to learn the framework, the selector strategy it favours, its frame-entry idiom, and its shadow-DOM handling — then replicate that exact convention, and where possible verify the chosen hook against the live page (marker check / matchCount) before handing it over. Do NOT assume a framework and do NOT copy selectors from training data. ' +
    'Errors: NO_ACTIVE_INSPECTION (no Mocha test is paused AND no Live Inspect Session is active — launch one via "QA Debug: Inspect App"); SESSION_NOT_FOUND (session_id does not match the active inspection); BROWSER_NOT_SELECTED (a pause is active but no chrome committed — call qa_select_chrome first); CDP_CONNECT_FAILED (the target CDP endpoint was unreachable or exposed no page target).',
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
  // Not read-only: each pick injects/refreshes one data-qa-pick attribute on
  // the clicked element (the verification handle). Harmless + transient, but
  // honest per MCP spec. Not idempotent: every pick mints a fresh nonce.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const qa_start_live_session: QaToolDef<{ cdp_port?: number }> = {
  name: 'qa_start_live_session',
  description:
    'Establishes (or refreshes) the CDP target for the active Live Inspect Session — the browser the QA launched via "QA Debug: Inspect App" for inspecting a running web/desktop app WITHOUT a failing test. ' +
    'The launch itself already starts the session and auto-selects its browser; call this only to RE-PROBE after the app navigated, opened tabs, or restarted (it refreshes available_chromes + page titles and re-selects). ' +
    'By default it probes the session\'s configured ports (qaDebug.cdpPorts); pass cdp_port to target one specific port. ' +
    'Returns: { available_chromes: [{port, ws_url, page_titles, tab_count, runtime}, ...], selected_cdp_port }. ' +
    'Errors: NO_ACTIVE_INSPECTION (no Live Inspect Session — start one from "QA Debug: Inspect App"); INVALID_PORT (cdp_port outside 1024-65535); NO_CHROMES_FOUND (nothing answered on the probed port(s) — the app may have closed).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      cdp_port: {
        type: 'number',
        description:
          'Optional single port (1024-65535) to re-probe; omit to probe the session\'s configured qaDebug.cdpPorts.',
      },
    },
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    cdp_port: z.number().int().min(1024).max(65535).optional(),
  }),
  annotations: {
    readOnlyHint: false, // mutates the live-target store
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true, // probes localhost CDP endpoints
  },
};

// ---- qa_testrail_* — company TestRail instance access (PLAN-testrail.md) ----
//
// Two generic tools cover the full 124-endpoint API v2 surface: a free-form
// endpoint string + the shipped `testrail` skill catalog replaces per-endpoint
// verbs. The GET/POST split mirrors TestRail's own protocol (all reads GET,
// all writes POST); a verb-prefix gate in the handlers keeps writes out of the
// frictionless read tool. NOTE: the `annotations` below are MCP-forward-compat
// metadata ONLY — the LM-tool host never sees them (gen-lm-tools emits just
// name/modelDescription/inputSchema); write confirmation is implemented by
// prepareInvocation() in the extension tool class.

export const qa_testrail_get: QaToolDef<{ endpoint: string; paginate?: boolean }> = {
  name: 'qa_testrail_get',
  description:
    "Performs a read (HTTP GET) against the company TestRail instance's API v2 and returns the parsed JSON. " +
    'Callers should use it for any documented read endpoint: get_* plus run_report / run_cross_project_report. ' +
    'The full endpoint catalog (URI templates, filters, body fields, response shapes) ships with the `testrail` skill — consult it before composing a call. ' +
    'Credentials and the instance URL come from VS Code secret storage, configured once via the "QA Debug: Configure TestRail" command — callers must NEVER ask for credentials in chat; on TESTRAIL_NOT_CONFIGURED, relay that command name to the user verbatim. ' +
    "Endpoint syntax: the exact path after /api/v2/ — e.g. 'get_cases/14&suite_id=8&limit=50'. TestRail's whole API path lives in one query string, so extra parameters append with & (NEVER ?), and parameter values containing spaces must be percent-encoded (filter=login%20page). " +
    'Bulk reads return TestRail\'s pagination wrapper { offset, limit, size, _links, <array_key>: [...] } with max 250 records per page; pass paginate=true to auto-collect up to 8 pages / 2000 records (caller-supplied offset/limit are stripped; the result then carries paginated: { pages, truncated, truncatedBy }). ' +
    'Two endpoints return non-JSON by design: get_attachment/{id} saves the file under the workspace .qa-debug/attachments/ dir and returns { saved_to, bytes, content_type, possiblePrefix? }; get_bdd/{case_id} returns the raw Gherkin text as { data, nonJson: true }. ' +
    'Returns otherwise: { data, status, hadPrefix, hadSuffix } (hadPrefix/hadSuffix flag gateway-injected bytes that were stripped; they are diagnostic only). ' +
    'Errors: TESTRAIL_NOT_CONFIGURED (run "QA Debug: Configure TestRail"); WRONG_TOOL_FOR_WRITE (write verb supplied — use qa_testrail_post); UNKNOWN_ENDPOINT_VERB (first path segment matches no documented verb — check the testrail skill catalog); INVALID_ENDPOINT (malformed endpoint string); AUTH_FAILED (401); FORBIDDEN (403); BAD_REQUEST (400, includes TestRail\'s own error message); ENDPOINT_NOT_FOUND (404); MAINTENANCE (409, TestRail Cloud daily maintenance); RATE_LIMITED (429 persisting after one Retry-After wait); SERVER_ERROR (5xx); PARSE_ERROR (unparseable response body — detail in the QA Debug output channel); NETWORK_ERROR (category only: dns | tls | refused | timeout | other); NO_WORKSPACE (attachment save needs an open folder).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string',
        description:
          "Exact path after /api/v2/, e.g. 'get_cases/14&suite_id=8&limit=50'. Append params with & (never ?); percent-encode values containing spaces.",
      },
      paginate: {
        type: 'boolean',
        description:
          'When true, auto-follow TestRail pagination locally (max 8 pages / 2000 records) and return the concatenated result. Defaults to false (single page).',
      },
    },
    required: ['endpoint'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    endpoint: z.string(),
    paginate: z.boolean().optional(),
  }),
  // MCP-forward-compat only (see block comment above): the read tool's domain
  // is open (HTTP to the company TestRail instance).
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export const qa_testrail_post: QaToolDef<{
  endpoint: string;
  body?: Record<string, unknown>;
  attachment_path?: string;
}> = {
  name: 'qa_testrail_post',
  description:
    "Performs a write (HTTP POST) against the company TestRail instance's API v2. " +
    'Callers should use it for documented write endpoints: add_* / update_* / delete_* / close_* / move_* / copy_*. ' +
    'The full endpoint catalog (URI templates + body fields) ships with the `testrail` skill — consult it before composing a call, and BEFORE any call state the exact endpoint + a payload summary in chat and get the user\'s go-ahead (VS Code additionally shows a confirmation dialog). ' +
    'delete_* endpoints are PERMANENT and cascade to child entities (e.g. delete_project removes its suites, runs and results) — treat them with extra care. ' +
    'Credentials come from VS Code secret storage via the "QA Debug: Configure TestRail" command — callers must NEVER ask for credentials in chat. ' +
    "Endpoint syntax is identical to qa_testrail_get: the exact path after /api/v2/ — e.g. 'add_result_for_case/81/1234'; extra params append with & (never ?); percent-encode values containing spaces. " +
    "body is a JSON object matching the endpoint's documented fields. body is IGNORED when attachment_path is set: attachment uploads (add_attachment_to_*) send multipart/form-data with only the file, per the official API. attachment_path must point to a file inside the open workspace. " +
    'Returns: { data, status, hadPrefix, hadSuffix } — many delete endpoints legitimately return data: null. ' +
    'A PARSE_ERROR on a 2xx response means the write MAY have been applied — verify with a qa_testrail_get call before retrying; never blind-retry a write. ' +
    'Errors: TESTRAIL_NOT_CONFIGURED (run "QA Debug: Configure TestRail"); WRONG_TOOL_FOR_READ (read verb supplied — use qa_testrail_get); UNKNOWN_ENDPOINT_VERB (first path segment matches no documented verb); UNSUPPORTED_ENDPOINT (add_bdd is not supported in v1); INVALID_ENDPOINT; ATTACHMENT_OUTSIDE_WORKSPACE (attachment_path resolves outside every workspace folder); NO_WORKSPACE; AUTH_FAILED (401); FORBIDDEN (403); BAD_REQUEST (400, includes TestRail\'s own error message); ENDPOINT_NOT_FOUND (404); MAINTENANCE (409); RATE_LIMITED (429); SERVER_ERROR (5xx); PARSE_ERROR; NETWORK_ERROR (category only).',
  inputSchemaJson: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string',
        description:
          "Exact path after /api/v2/, e.g. 'add_result_for_case/81/1234'. Append params with & (never ?).",
      },
      body: {
        type: 'object',
        additionalProperties: true,
        description:
          "JSON body matching the endpoint's documented fields (see the testrail skill catalog). Ignored when attachment_path is set.",
      },
      attachment_path: {
        type: 'string',
        description:
          'Path to a file inside the open workspace to upload as multipart/form-data (for add_attachment_to_* endpoints). When set, body is ignored.',
      },
    },
    required: ['endpoint'],
    additionalProperties: false,
  },
  inputSchemaZod: z.object({
    endpoint: z.string(),
    body: z.record(z.string(), z.unknown()).optional(),
    attachment_path: z.string().optional(),
  }),
  // MCP-forward-compat only: destructive-capable (delete_* rides POST).
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const qaTools = [
  qa_get_failure_context,
  qa_discover_chromes,
  qa_select_chrome,
  qa_pick_element,
  qa_start_live_session,
  qa_testrail_get,
  qa_testrail_post,
] as const;

export type QaToolName = (typeof qaTools)[number]['name'];

export const QA_TOOL_NAMES: ReadonlySet<string> = new Set(qaTools.map((t) => t.name));
