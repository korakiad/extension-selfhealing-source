/**
 * Token-budget calculator for the qa-debug + playwright-mcp surface + SKILL.md frontmatter.
 *
 * Compared against Anthropic Tool Search Tool thresholds from
 * anthropic.com/engineering/advanced-tool-use (Nov 24, 2025):
 *   - >10K tokens of tool definitions
 *   - 10+ tools available
 *   - MCP-powered systems with multiple servers
 *   - tool-selection accuracy issues
 *
 * Token counts use the Anthropic SDK's count_tokens endpoint when ANTHROPIC_API_KEY is set;
 * fall back to a chars-per-4 approximation (cheap & local) otherwise. The cheap approximation
 * is sufficient for the >10K threshold check (off by ~20% but the surface is in the same order
 * of magnitude regardless).
 */

import Anthropic from '@anthropic-ai/sdk';

import { PLAYWRIGHT_MCP_TOOLS } from './playwright-mcp-tools.js';
import { QA_TOOLS_ANTHROPIC } from './qa-tools.js';
import { loadSkill } from './skill.js';

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function serializeTool(t: Anthropic.Tool): string {
  return JSON.stringify(t);
}

async function maybeCountTokens(system: string, tools: Anthropic.Tool[]): Promise<number | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const resp = await client.messages.countTokens({
      model: 'claude-sonnet-4-5-20250929',
      system,
      messages: [{ role: 'user', content: 'placeholder' }],
      tools,
    });
    return resp.input_tokens;
  } catch (err) {
    console.error(
      'countTokens failed, falling back to approximation:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function main() {
  const skill = loadSkill();

  const qaDebugSerialized = QA_TOOLS_ANTHROPIC.map(serializeTool).join('\n');
  const playwrightSerialized = PLAYWRIGHT_MCP_TOOLS.map(serializeTool).join('\n');
  const all = [...QA_TOOLS_ANTHROPIC, ...PLAYWRIGHT_MCP_TOOLS];
  const allSerialized = all.map(serializeTool).join('\n');

  const skillTokens = approxTokens(skill.description);
  const qaDebugApproxTokens = approxTokens(qaDebugSerialized);
  const playwrightApproxTokens = approxTokens(playwrightSerialized);
  const allApproxTokens = approxTokens(allSerialized);
  const combinedApprox = skillTokens + allApproxTokens;

  console.log('=== qa-debug + playwright-mcp surface budget ===\n');
  console.log(`SKILL.md description: ${skill.description.length} chars, ~${skillTokens} tokens`);
  console.log(
    `qa-debug tools (${QA_TOOLS_ANTHROPIC.length}): ${qaDebugSerialized.length} chars, ~${qaDebugApproxTokens} tokens`,
  );
  console.log(
    `playwright-mcp tools (${PLAYWRIGHT_MCP_TOOLS.length}): ${playwrightSerialized.length} chars, ~${playwrightApproxTokens} tokens`,
  );
  console.log(
    `Combined surface (${all.length} tools + Skill frontmatter): ${allSerialized.length + skill.description.length} chars, ~${combinedApprox} approx tokens`,
  );

  const exactCombined = await maybeCountTokens(
    `## ${skill.name}\n${skill.description}`,
    all,
  );
  if (exactCombined !== null) {
    console.log(`\nExact countTokens result (combined + Skill + 'placeholder' user turn): ${exactCombined} tokens`);
  } else {
    console.log('\n(No ANTHROPIC_API_KEY — exact count via countTokens skipped.)');
  }

  console.log('\n=== Tool Search Tool triggers (anthropic.com/engineering/advanced-tool-use, Nov 24 2025) ===');
  const tokensForGate = exactCombined ?? combinedApprox;
  const above10k = tokensForGate > 10_000;
  const above10tools = all.length >= 10;
  const multiServer = true;
  console.log(`  >10K tokens of tool definitions:   ${above10k ? 'YES' : 'no'} (${tokensForGate})`);
  console.log(`  10+ tools available:               ${above10tools ? 'YES' : 'no'} (${all.length})`);
  console.log(`  MCP-powered multi-server:          ${multiServer ? 'YES' : 'no'} (qa-debug + playwright-mcp)`);
  console.log(`  tool-selection accuracy issues:    measured empirically by evals/engagement.ts`);

  console.log(
    `\nPer SLICE_PLAN §S3(c)+§4 disposition: Phase 1 DEFERS Tool Search Tool conditional on the engagement evals passing the 12/15 + 5/5 + 5/5 + 5/5 bar without it. If those evals miss, Tool Search becomes a blocking Phase 1 add.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
