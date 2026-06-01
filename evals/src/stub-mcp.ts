/**
 * Stub MCP server that exposes the combined qa-debug + playwright-mcp tool surface for
 * evals driven via `claude -p` (subscription seat) rather than the raw Anthropic
 * SDK + API key.
 *
 * Engagement mode (S3): every tools/call returns DRY_RUN. The eval harness
 * inspects only the FIRST tool_use the agent emits and terminates the claude
 * subprocess, so tool bodies don't need to do anything — they just need to
 * exist so the agent can see the surface and choose to engage.
 *
 * Run via tsx: `tsx evals/src/stub-mcp.ts`. Designed for use with --mcp-config.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { qaTools } from '@qa-debug/tool-contracts/tools';
import { PLAYWRIGHT_MCP_TOOLS } from './playwright-mcp-tools.js';

const server = new McpServer({ name: 'qa-debug-stub', version: '0.0.0-dry-run' });

const dryRunHandler = (toolName: string) => async () => ({
  content: [
    {
      type: 'text' as const,
      text: `DRY_RUN: ${toolName} (the eval intercepts before execution)`,
    },
  ],
});

for (const t of qaTools) {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.inputSchemaZod },
    dryRunHandler(t.name),
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
  server.registerTool(t.name, { description: t.description, inputSchema: schema }, dryRunHandler(t.name));
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `qa-debug-stub MCP ready — ${qaTools.length + PLAYWRIGHT_MCP_TOOLS.length} tools (engagement DRY_RUN mode)`,
);
