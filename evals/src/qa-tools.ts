import type Anthropic from '@anthropic-ai/sdk';
import { qaTools, QA_TOOL_NAMES } from '../../qa-debug-mcp/src/tools.js';

export const QA_TOOLS_ANTHROPIC: Anthropic.Tool[] = qaTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchemaJson as unknown as Anthropic.Tool['input_schema'],
}));

export { QA_TOOL_NAMES };
