/**
 * QA Debug Companion — Skill engagement evals (SLICE_PLAN.md §S3(d)).
 *
 * Runs against the user's Claude Code subscription seat via `claude -p` subprocess
 * instead of a raw `@anthropic-ai/sdk` API-key call. Rationale:
 *   - The user authenticates through `claude` CLI (OAuth/keychain); no separate
 *     ANTHROPIC_API_KEY needs to be provisioned.
 *   - `--permission-mode dontAsk` + `--strict-mcp-config` + `--disable-slash-commands`
 *     + `--tools ""` strips the harness down to: (a) the supplied --system-prompt,
 *     (b) the stub MCP server's tool definitions, (c) the user turn. Closest
 *     approximation to "raw API + tools + system prompt" reachable via the CLI.
 *
 * For each scenario × N trials:
 *   - Spawn `claude -p` with the stub MCP server, system prompt = SKILL.md
 *     frontmatter, and the scenario's user prompt (pause notification prepended
 *     for paused scenarios).
 *   - Stream stdout (--output-format stream-json), parse line-by-line.
 *   - Capture the FIRST `tool_use` block; record its bare tool name (strip the
 *     `mcp__<server>__` Claude-Code wrapper); SIGTERM the subprocess.
 *
 * Pass thresholds per SLICE_PLAN §S3 exit criteria:
 *   - Scenarios 1,2,3 (positive): first tool = qa_get_failure_context in ≥4/5 trials per scenario.
 *   - Scenarios 4,5,6 (negative): no qa_* tool call in 5/5 trials per scenario.
 *
 * Usage:
 *   pnpm --filter ./evals engagement
 *   pnpm --filter ./evals engagement -- --scenarios 1,2 --trials 2
 *   pnpm --filter ./evals engagement -- --dry-run
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { qaTools } from '@qa-debug/tool-contracts/tools';

import { PLAYWRIGHT_MCP_TOOLS } from './playwright-mcp-tools.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { loadSkill } from './skill.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(here, '../results.json');
const STUB_MCP_PATH = join(here, 'stub-mcp.ts');
const MCP_CFG_PATH = '/tmp/qa-eval-mcp-cfg.json';

const QA_TOOL_NAMES = new Set(qaTools.map((t) => t.name));

interface Args {
  scenarios?: number[];
  trials: number;
  dryRun: boolean;
  model: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { trials: 5, dryRun: false, model: 'sonnet' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--scenarios') {
      args.scenarios = argv[++i]!.split(',').map((n) => Number.parseInt(n, 10));
    } else if (a === '--trials') {
      args.trials = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--model') {
      args.model = argv[++i]!;
    }
  }
  return args;
}

function ensureMcpConfig() {
  const cfg = {
    mcpServers: {
      qa: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', STUB_MCP_PATH],
      },
    },
  };
  writeFileSync(MCP_CFG_PATH, JSON.stringify(cfg, null, 2));
}

function buildSystemPrompt(
  skill: { name: string; description: string },
  scenario: Scenario,
): string {
  return [
    'You are GitHub Copilot Chat assisting a QA engineer in VS Code (mid-2026).',
    '',
    'The following Skill metadata is available in this session. Engage the Skill only when the user turn matches its description and engagement triggers; otherwise respond as a normal assistant using your other available tools.',
    '',
    `## ${skill.name}`,
    skill.description,
    '',
    'Current chat context:',
    scenario.paused && scenario.pauseNotification
      ? 'A QA Debug Companion pause notification has been surfaced in the chat. See the user message below for the notification text.'
      : '(No QA Debug Companion notification is active. No Mocha test is currently paused.)',
  ].join('\n');
}

function buildUserPrompt(scenario: Scenario): string {
  if (scenario.paused && scenario.pauseNotification) {
    return `${scenario.pauseNotification}\n\n${scenario.userPrompt}`;
  }
  return scenario.userPrompt;
}

function stripMcpPrefix(name: string): string {
  // Claude Code wraps MCP tools as `mcp__<server>__<tool>`. Strip to the bare tool name.
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

function evaluateTrial(scenario: Scenario, firstToolBareName: string | null): boolean {
  if (scenario.expect === 'qa_get_failure_context') {
    return firstToolBareName === 'qa_get_failure_context';
  }
  return firstToolBareName === null || !QA_TOOL_NAMES.has(firstToolBareName);
}

interface TrialResult {
  scenarioId: number;
  trial: number;
  firstToolName: string | null;
  passed: boolean;
  durationMs: number;
  costUsd: number;
  numTurns: number | null;
}

function runTrial(
  scenario: Scenario,
  trial: number,
  skill: { name: string; description: string },
  model: string,
): Promise<TrialResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const system = buildSystemPrompt(skill, scenario);
    const user = buildUserPrompt(scenario);

    const proc = spawn(
      'claude',
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--disable-slash-commands',
        '--tools',
        '',
        '--mcp-config',
        MCP_CFG_PATH,
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
        '--no-session-persistence',
        '--model',
        model,
        '--max-budget-usd',
        '0.10',
        '--system-prompt',
        system,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proc.stdin.write(user);
    proc.stdin.end();

    let firstToolBare: string | null = null;
    let buf = '';
    let costUsd = 0;
    let numTurns: number | null = null;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({
        scenarioId: scenario.id,
        trial,
        firstToolName: firstToolBare,
        passed: evaluateTrial(scenario, firstToolBare),
        durationMs: Date.now() - t0,
        costUsd,
        numTurns,
      });
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          const t = evt.type;
          if (t === 'assistant' && firstToolBare === null) {
            const message = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
            for (const block of message?.content ?? []) {
              if (block.type === 'tool_use') {
                firstToolBare = stripMcpPrefix(block.name as string);
                finish();
                return;
              }
            }
          } else if (t === 'result') {
            costUsd = (evt.total_cost_usd as number) ?? 0;
            numTurns = (evt.num_turns as number) ?? null;
            if (firstToolBare === null) finish();
          }
        } catch {
          // non-JSON line — ignore
        }
      }
    });

    proc.stderr.on('data', () => {
      // Discard stderr; --verbose can be chatty.
    });

    proc.on('close', () => {
      if (!resolved) finish();
    });
    proc.on('error', () => {
      if (!resolved) finish();
    });
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function renderTable(rows: { scenario: Scenario; trials: TrialResult[] }[]): string {
  const lines: string[] = [];
  lines.push(
    pad('#', 3) +
      pad('Scenario', 50) +
      pad('Expected', 24) +
      pad('Result', 14) +
      pad('Cost', 10) +
      'First-tool roll',
  );
  lines.push('-'.repeat(160));
  for (const { scenario, trials } of rows) {
    const passes = trials.filter((t) => t.passed).length;
    const total = trials.length;
    const requiredForTotal = Math.ceil((scenario.passThreshold / 5) * total);
    const verdict =
      passes >= requiredForTotal
        ? `PASS ${passes}/${total}`
        : `FAIL ${passes}/${total}`;
    const expected =
      scenario.expect === 'qa_get_failure_context' ? 'qa_get_failure_context' : 'no qa_* tool';
    const tools = trials.map((t) => t.firstToolName ?? '(none)').join(', ');
    const cost = `$${trials.reduce((s, t) => s + t.costUsd, 0).toFixed(4)}`;
    lines.push(
      pad(String(scenario.id), 3) +
        pad(scenario.name.slice(0, 49), 50) +
        pad(expected, 24) +
        pad(verdict, 14) +
        pad(cost, 10) +
        tools,
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skill = loadSkill();

  if (args.dryRun) {
    ensureMcpConfig();
    console.error('=== DRY RUN — no claude invocations ===');
    console.error(`\nSKILL.md (${skill.description.length} chars):`);
    console.error(`  name: ${skill.name}`);
    console.error(`  description: ${skill.description.slice(0, 200)}...`);
    console.error(`\nMCP config: ${MCP_CFG_PATH}`);
    console.error(`Stub MCP: ${STUB_MCP_PATH} — ${qaTools.length + PLAYWRIGHT_MCP_TOOLS.length} tools`);
    console.error(`Model: ${args.model}`);
    console.error(`\nScenarios: ${SCENARIOS.length}`);
    for (const s of SCENARIOS) {
      console.error(
        `  #${s.id} ${s.name} — paused=${s.paused}, expect=${s.expect}, threshold=${s.passThreshold}/5`,
      );
    }
    return;
  }

  ensureMcpConfig();
  const scenarios = args.scenarios
    ? SCENARIOS.filter((s) => args.scenarios!.includes(s.id))
    : SCENARIOS;

  console.error(
    `Running ${scenarios.length} scenarios × ${args.trials} trials via claude -p (model=${args.model})…`,
  );

  const rows: { scenario: Scenario; trials: TrialResult[] }[] = [];
  for (const scenario of scenarios) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < args.trials; i++) {
      process.stderr.write(`  scenario ${scenario.id} trial ${i + 1}/${args.trials}… `);
      const r = await runTrial(scenario, i + 1, skill, args.model);
      trials.push(r);
      process.stderr.write(
        `${r.passed ? 'PASS' : 'FAIL'} (first=${r.firstToolName ?? 'none'}, ${r.durationMs}ms, $${r.costUsd.toFixed(4)})\n`,
      );
    }
    rows.push({ scenario, trials });
  }

  console.log('\n' + renderTable(rows));

  const totalCost = rows
    .flatMap(({ trials }) => trials)
    .reduce((s, t) => s + t.costUsd, 0);
  console.log(`\nTotal eval cost: $${totalCost.toFixed(4)}`);

  const overall = rows.every(({ scenario, trials }) => {
    const passes = trials.filter((t) => t.passed).length;
    const requiredForTotal = Math.ceil((scenario.passThreshold / 5) * trials.length);
    return passes >= requiredForTotal;
  });
  console.log(`Overall: ${overall ? 'PASS' : 'FAIL'}`);

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        runner: 'claude -p (subscription seat)',
        model: args.model,
        trialsPerScenario: args.trials,
        skillDescriptionChars: skill.description.length,
        toolCount: qaTools.length + PLAYWRIGHT_MCP_TOOLS.length,
        ranAt: new Date().toISOString(),
        totalCostUsd: totalCost,
        rows: rows.map(({ scenario, trials }) => ({
          id: scenario.id,
          name: scenario.name,
          paused: scenario.paused,
          expect: scenario.expect,
          threshold: scenario.passThreshold,
          passes: trials.filter((t) => t.passed).length,
          trials: trials.map((t) => ({
            firstToolName: t.firstToolName,
            passed: t.passed,
            costUsd: t.costUsd,
            durationMs: t.durationMs,
            numTurns: t.numTurns,
          })),
        })),
        overall,
      },
      null,
      2,
    ),
  );
  console.error(`Results → ${RESULTS_PATH}`);

  process.exit(overall ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
