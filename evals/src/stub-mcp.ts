/**
 * Stub MCP server that exposes the combined qa-debug + playwright-mcp tool surface for
 * evals driven via `claude -p` (subscription seat) rather than the raw Anthropic
 * SDK + API key.
 *
 * Two modes (selected via QA_EVAL_DECISION_SCENARIO_ID env var):
 *
 * 1. Engagement mode (S3) — env var unset. Every tools/call returns DRY_RUN.
 *    The eval harness inspects only the FIRST tool_use the agent emits and
 *    terminates the claude subprocess, so tool bodies don't need to do anything.
 *
 * 2. Decision-tree mode (S5) — env var set to a DECISION_SCENARIOS id.
 *    qa_get_failure_context returns the scripted FailureContextView (or named
 *    error) for that scenario; browser_console_messages returns the scenario's
 *    scripted messages; browser_network_requests returns the scripted requests;
 *    all other tools return DRY_RUN. The S5 harness captures the FIRST
 *    qa_request_* / qa_propose_* call.
 *
 * Run via tsx: `tsx evals/src/stub-mcp.ts`. Designed for use with --mcp-config.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { qaTools } from '../../qa-debug-mcp/src/tools.js';
import { PLAYWRIGHT_MCP_TOOLS } from './playwright-mcp-tools.js';
import { getDecisionScenario } from './decision-tree-scenarios.js';

const server = new McpServer({ name: 'qa-debug-stub', version: '0.0.0-dry-run' });

const scenarioIdRaw = process.env.QA_EVAL_DECISION_SCENARIO_ID;
const decisionScenario = scenarioIdRaw
  ? getDecisionScenario(Number.parseInt(scenarioIdRaw, 10))
  : undefined;

if (scenarioIdRaw && !decisionScenario) {
  console.error(
    `qa-debug-stub: WARN — QA_EVAL_DECISION_SCENARIO_ID=${scenarioIdRaw} did not match any DECISION_SCENARIOS id; falling back to DRY_RUN for all tools.`,
  );
}

const dryRunHandler = (toolName: string) => async () => ({
  content: [
    {
      type: 'text' as const,
      text: `DRY_RUN: ${toolName} (the eval intercepts before execution)`,
    },
  ],
});

const scriptedHandlers: Record<string, () => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>> = {};

if (decisionScenario) {
  // qa_get_failure_context returns scripted context OR named error.
  scriptedHandlers.qa_get_failure_context = async () => {
    const r = decisionScenario.failureContextResponse;
    if (r.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(r.payload, null, 2) }],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ code: r.errorCode, message: r.message }),
        },
      ],
    };
  };

  // browser_console_messages returns scripted lines (or empty).
  scriptedHandlers.browser_console_messages = async () => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(decisionScenario.browserConsoleMessages ?? [], null, 2),
      },
    ],
  });

  // browser_network_requests returns scripted requests (or empty).
  scriptedHandlers.browser_network_requests = async () => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(decisionScenario.browserNetworkRequests ?? [], null, 2),
      },
    ],
  });

  // browser_snapshot returns a synthetic placeholder (the scripted DOM is implied by
  // failing_assertion + console_logs; we just acknowledge the call so the agent
  // doesn't get a hard failure).
  scriptedHandlers.browser_snapshot = async () => ({
    content: [
      {
        type: 'text' as const,
        text: '(stub snapshot — scenario surfaces signal via failing_assertion + console_messages + network_requests)',
      },
    ],
  });
}

for (const t of qaTools) {
  const handler = scriptedHandlers[t.name] ?? dryRunHandler(t.name);
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.inputSchemaZod },
    handler,
  );
}

for (const t of PLAYWRIGHT_MCP_TOOLS) {
  const props = (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
  const required = new Set(
    ((t.input_schema as { required?: string[] }).required ?? []) as string[],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(props)) {
    const s = spec as { type?: string; enum?: string[] };
    let zod: z.ZodTypeAny;
    if (s.type === 'string' && s.enum) zod = z.enum(s.enum as [string, ...string[]]);
    else if (s.type === 'string') zod = z.string();
    else if (s.type === 'number') zod = z.number();
    else if (s.type === 'boolean') zod = z.boolean();
    else zod = z.unknown();
    if (!required.has(key)) zod = zod.optional();
    shape[key] = zod;
  }
  const schema = z.object(shape);
  const handler = scriptedHandlers[t.name] ?? dryRunHandler(t.name);
  server.registerTool(t.name, { description: t.description, inputSchema: schema }, handler);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `qa-debug-stub MCP ready — ${qaTools.length + PLAYWRIGHT_MCP_TOOLS.length} tools (${decisionScenario ? `decision-tree mode, scenario ${decisionScenario.id}` : 'engagement DRY_RUN mode'})`,
);
