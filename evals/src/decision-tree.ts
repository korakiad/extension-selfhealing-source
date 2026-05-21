/**
 * QA Debug Companion — S5 decision-tree alignment evals (S5_DESIGN.md §5).
 *
 * Differences from S3 engagement.ts (which this file does NOT replace; both
 * harnesses remain valid for their respective slices):
 *  - System prompt loads the FULL SKILL.md body + frontmatter (engagement
 *    eval used frontmatter only).
 *  - stub-mcp.ts runs with QA_EVAL_DECISION_SCENARIO_ID set per trial; the
 *    stub returns scripted qa_get_failure_context / browser_console_messages
 *    / browser_network_requests payloads from DECISION_SCENARIOS.
 *  - Capture: parse stream-json until the FIRST qa_request_* / qa_propose_*
 *    call (NOT the first qa_get_failure_context). qa_get_failure_context
 *    re-grounds are allowed; playwright tools are allowed; only the decision
 *    verb terminates capture.
 *  - Verdict: per-scenario expectedVerb / expectNoFurtherVerb / forbiddenVerb
 *    (see decision-tree-scenarios.ts). Split-bar aggregate per S5_DESIGN §5.2.
 *
 * Usage:
 *   pnpm --filter ./evals decision-tree
 *   pnpm --filter ./evals decision-tree -- --scenarios 101,201 --trials 2
 *   pnpm --filter ./evals decision-tree -- --dry-run
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { qaTools } from '../../qa-debug-mcp/src/tools.js';

import {
  DECISION_SCENARIOS,
  type DecisionScenario,
  type QaVerb,
} from './decision-tree-scenarios.js';
import { PLAYWRIGHT_MCP_TOOLS } from './playwright-mcp-tools.js';
import { loadSkill } from './skill.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(here, '../decision-tree-results.json');
const STUB_MCP_PATH = join(here, 'stub-mcp.ts');
const MCP_CFG_DIR = '/tmp';
const SKILL_PATH = join(here, '../../extension/skills/qa-debug/SKILL.md');

const QA_DECISION_VERBS = new Set<QaVerb>([
  'qa_request_retry',
  'qa_request_give_up',
  'qa_propose_mark_passed',
  'qa_propose_close_browser',
  'qa_propose_abort_suite',
]);

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

function writeMcpConfig(scenarioId: number): string {
  const cfg = {
    mcpServers: {
      qa: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', STUB_MCP_PATH],
        env: { QA_EVAL_DECISION_SCENARIO_ID: String(scenarioId) },
      },
    },
  };
  const path = join(MCP_CFG_DIR, `qa-eval-decision-${scenarioId}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function stripFrontmatter(skillRaw: string): string {
  const m = skillRaw.match(/^---\n[\s\S]*?\n---\n/);
  return m ? skillRaw.slice(m[0].length) : skillRaw;
}

function buildSystemPrompt(skill: { name: string; description: string }, skillBody: string): string {
  return [
    'You are GitHub Copilot Chat assisting a QA engineer in VS Code (mid-2026).',
    '',
    'A Skill is available in this session. Engage the Skill when the user turn matches its description.',
    '',
    `## Skill metadata: ${skill.name}`,
    skill.description,
    '',
    `## Skill body (qa-debug)`,
    skillBody.trim(),
  ].join('\n');
}

function buildUserPrompt(scenario: DecisionScenario): string {
  return `${scenario.pauseNotification}\n\n${scenario.userPrompt}`;
}

function stripMcpPrefix(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

interface CapturedCall {
  tool: string; // bare tool name
  args: Record<string, unknown>;
}

interface TrialResult {
  scenarioId: number;
  trial: number;
  calls: CapturedCall[];
  firstDecisionVerb: string | null;
  passed: boolean;
  durationMs: number;
  costUsd: number;
  numTurns: number | null;
}

function evaluateTrial(scenario: DecisionScenario, calls: CapturedCall[]): {
  passed: boolean;
  firstDecisionVerb: string | null;
} {
  // Find the first call that is a decision verb (qa_request_* / qa_propose_*).
  // If the scenario's expected verb is qa_get_failure_context (SESSION_NOT_FOUND re-ground),
  // the "first" of interest is the FIRST call after the initial qa_get_failure_context.
  let firstDecisionVerb: string | null = null;
  let afterInitialGround = false;
  for (const c of calls) {
    if (c.tool === 'qa_get_failure_context' && !afterInitialGround) {
      afterInitialGround = true;
      continue;
    }
    if (QA_DECISION_VERBS.has(c.tool as QaVerb)) {
      firstDecisionVerb = c.tool;
      break;
    }
    if (c.tool === 'qa_get_failure_context' && afterInitialGround) {
      // Re-ground call (e.g., after SESSION_NOT_FOUND). Some scenarios expect this.
      firstDecisionVerb = c.tool;
      break;
    }
  }

  if (scenario.expectNoFurtherVerb) {
    return { passed: firstDecisionVerb === null, firstDecisionVerb };
  }
  if (scenario.forbiddenVerb) {
    // Pass if the first decision verb is NOT the forbidden one (and is one of the legal verbs OR null).
    const passed = firstDecisionVerb !== scenario.forbiddenVerb;
    return { passed, firstDecisionVerb };
  }
  if (scenario.expectedVerb) {
    return { passed: firstDecisionVerb === scenario.expectedVerb, firstDecisionVerb };
  }
  return { passed: false, firstDecisionVerb };
}

function runTrial(
  scenario: DecisionScenario,
  trial: number,
  skill: { name: string; description: string },
  skillBody: string,
  model: string,
): Promise<TrialResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const mcpCfgPath = writeMcpConfig(scenario.id);
    const system = buildSystemPrompt(skill, skillBody);
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
        mcpCfgPath,
        '--strict-mcp-config',
        '--permission-mode',
        // S5 decision-tree eval needs actual tool-result chaining (vs S3
        // engagement eval which only captures the FIRST denied tool_use).
        // bypassPermissions lets the MCP tools return their scripted payloads
        // so the agent can reason past qa_get_failure_context to a decision verb.
        'bypassPermissions',
        '--no-session-persistence',
        '--model',
        model,
        '--max-budget-usd',
        '0.15',
        '--system-prompt',
        system,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proc.stdin.write(user);
    proc.stdin.end();

    const calls: CapturedCall[] = [];
    let buf = '';
    let costUsd = 0;
    let numTurns: number | null = null;
    let resolved = false;
    let terminatedEarly = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      const { passed, firstDecisionVerb } = evaluateTrial(scenario, calls);
      resolve({
        scenarioId: scenario.id,
        trial,
        calls,
        firstDecisionVerb,
        passed,
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
          if (t === 'assistant' && !terminatedEarly) {
            const message = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
            for (const block of message?.content ?? []) {
              if (block.type === 'tool_use') {
                const bare = stripMcpPrefix(block.name as string);
                calls.push({ tool: bare, args: (block.input as Record<string, unknown>) ?? {} });
                // Terminate after the FIRST decision verb is captured.
                // For "no further verb" (NO_ACTIVE_PAUSE) scenarios, we let
                // the agent run to natural end (result event).
                if (QA_DECISION_VERBS.has(bare as QaVerb)) {
                  terminatedEarly = true;
                  finish();
                  return;
                }
              }
            }
          } else if (t === 'result') {
            costUsd = (evt.total_cost_usd as number) ?? 0;
            numTurns = (evt.num_turns as number) ?? null;
            if (!resolved) finish();
          }
        } catch {
          // non-JSON line — ignore
        }
      }
    });

    proc.stderr.on('data', () => {
      // discard
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

function renderTable(rows: { scenario: DecisionScenario; trials: TrialResult[] }[]): string {
  const lines: string[] = [];
  lines.push(
    pad('#', 5) +
      pad('Scenario', 50) +
      pad('Cat', 14) +
      pad('Expected', 28) +
      pad('Result', 14) +
      pad('Cost', 10) +
      'First-decision-verb roll',
  );
  lines.push('-'.repeat(180));
  for (const { scenario, trials } of rows) {
    const passes = trials.filter((t) => t.passed).length;
    const total = trials.length;
    const requiredForTotal = Math.ceil((scenario.passThreshold / 5) * total);
    const verdict = passes >= requiredForTotal ? `PASS ${passes}/${total}` : `FAIL ${passes}/${total}`;
    let expected: string;
    if (scenario.expectNoFurtherVerb) expected = 'no further verb';
    else if (scenario.forbiddenVerb) expected = `NOT ${scenario.forbiddenVerb}`;
    else expected = scenario.expectedVerb ?? '(none)';
    const roll = trials.map((t) => t.firstDecisionVerb ?? '(none)').join(', ');
    const cost = `$${trials.reduce((s, t) => s + t.costUsd, 0).toFixed(4)}`;
    lines.push(
      pad(String(scenario.id), 5) +
        pad(scenario.name.slice(0, 49), 50) +
        pad(scenario.category, 14) +
        pad(expected, 28) +
        pad(verdict, 14) +
        pad(cost, 10) +
        roll,
    );
  }
  return lines.join('\n');
}

function computeSplitBars(rows: { scenario: DecisionScenario; trials: TrialResult[] }[]): {
  propose: { pass: number; total: number; rate: number; bar: number; ok: boolean };
  request: { pass: number; total: number; rate: number; bar: number; ok: boolean };
  namedError: { pass: number; total: number; rate: number; bar: number; ok: boolean };
  aggregateScenarios: { pass: number; total: number; rate: number; bar: number; ok: boolean };
} {
  const buckets = {
    propose: { pass: 0, total: 0 },
    request: { pass: 0, total: 0 },
    namedError: { pass: 0, total: 0 },
  };
  let scenarioPasses = 0;
  for (const { scenario, trials } of rows) {
    const trialPasses = trials.filter((t) => t.passed).length;
    const requiredForTotal = Math.ceil((scenario.passThreshold / 5) * trials.length);
    if (trialPasses >= requiredForTotal) scenarioPasses += 1;

    const cat = scenario.category;
    if (cat === 'env-flake' || cat === 'structural') {
      buckets.propose.pass += trialPasses;
      buckets.propose.total += trials.length;
    } else if (cat === 'named-error') {
      buckets.namedError.pass += trialPasses;
      buckets.namedError.total += trials.length;
    } else {
      // code-bug / test-bug / ambiguous / retry-exit — all request-verb arms
      buckets.request.pass += trialPasses;
      buckets.request.total += trials.length;
    }
  }

  // Empty buckets are vacuously OK (no scenarios in this slice → nothing to fail).
  const propose = {
    ...buckets.propose,
    rate: buckets.propose.total ? buckets.propose.pass / buckets.propose.total : 1,
    bar: 0.85,
    ok: false,
  };
  propose.ok = propose.total === 0 || propose.rate >= propose.bar;

  const request = {
    ...buckets.request,
    rate: buckets.request.total ? buckets.request.pass / buckets.request.total : 1,
    bar: 0.95,
    ok: false,
  };
  request.ok = request.total === 0 || request.rate >= request.bar;

  const namedError = {
    ...buckets.namedError,
    rate: buckets.namedError.total ? buckets.namedError.pass / buckets.namedError.total : 1,
    bar: 0.95,
    ok: false,
  };
  namedError.ok = namedError.total === 0 || namedError.rate >= namedError.bar;

  const aggregateScenarios = {
    pass: scenarioPasses,
    total: rows.length,
    rate: rows.length ? scenarioPasses / rows.length : 0,
    bar: 0.9,
    ok: false,
  };
  aggregateScenarios.ok = aggregateScenarios.rate >= aggregateScenarios.bar;

  return { propose, request, namedError, aggregateScenarios };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skill = loadSkill();
  const skillRaw = readFileSync(SKILL_PATH, 'utf8');
  const skillBody = stripFrontmatter(skillRaw);

  if (args.dryRun) {
    console.error('=== DRY RUN — no claude invocations ===');
    console.error(`SKILL: name=${skill.name}, description=${skill.description.length} chars, body=${skillBody.length} chars`);
    console.error(`Stub MCP: ${STUB_MCP_PATH}`);
    console.error(`Model: ${args.model}`);
    console.error(`\nScenarios (${DECISION_SCENARIOS.length}):`);
    for (const s of DECISION_SCENARIOS) {
      const expected = s.expectNoFurtherVerb
        ? 'no further verb'
        : s.forbiddenVerb
          ? `NOT ${s.forbiddenVerb}`
          : (s.expectedVerb ?? '(none)');
      console.error(`  #${s.id} [${s.category}] ${s.name} — expect=${expected}, threshold=${s.passThreshold}/5`);
    }
    return;
  }

  const scenarios = args.scenarios
    ? DECISION_SCENARIOS.filter((s) => args.scenarios!.includes(s.id))
    : DECISION_SCENARIOS;

  console.error(
    `Running ${scenarios.length} decision-tree scenarios × ${args.trials} trials via claude -p (model=${args.model})…`,
  );

  const rows: { scenario: DecisionScenario; trials: TrialResult[] }[] = [];
  for (const scenario of scenarios) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < args.trials; i++) {
      process.stderr.write(`  scenario ${scenario.id} trial ${i + 1}/${args.trials}… `);
      const r = await runTrial(scenario, i + 1, skill, skillBody, args.model);
      trials.push(r);
      process.stderr.write(
        `${r.passed ? 'PASS' : 'FAIL'} (verb=${r.firstDecisionVerb ?? 'none'}, ${r.durationMs}ms, $${r.costUsd.toFixed(4)})\n`,
      );
    }
    rows.push({ scenario, trials });
  }

  console.log('\n' + renderTable(rows));

  const totalCost = rows.flatMap(({ trials }) => trials).reduce((s, t) => s + t.costUsd, 0);
  console.log(`\nTotal eval cost: $${totalCost.toFixed(4)}`);

  const split = computeSplitBars(rows);
  const fmt = (b: { pass: number; total: number; rate: number; bar: number; ok: boolean }) =>
    `${b.pass}/${b.total} = ${(b.rate * 100).toFixed(1)}% vs ${(b.bar * 100).toFixed(0)}% bar [${b.ok ? 'OK' : 'MISS'}]`;
  console.log('\nSplit pass bars (S5_DESIGN §5.2):');
  console.log(`  propose-verb arms:   ${fmt(split.propose)}`);
  console.log(`  request-verb arms:   ${fmt(split.request)}`);
  console.log(`  named-error arms:    ${fmt(split.namedError)}`);
  console.log(`  aggregate scenarios: ${fmt(split.aggregateScenarios)}`);

  const overall = split.propose.ok && split.request.ok && split.namedError.ok && split.aggregateScenarios.ok;
  console.log(`Overall: ${overall ? 'PASS' : 'FAIL'}`);

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        runner: 'claude -p (subscription seat)',
        evalKind: 'decision-tree-alignment',
        model: args.model,
        trialsPerScenario: args.trials,
        skillDescriptionChars: skill.description.length,
        skillBodyChars: skillBody.length,
        toolCount: qaTools.length + PLAYWRIGHT_MCP_TOOLS.length,
        ranAt: new Date().toISOString(),
        totalCostUsd: totalCost,
        rows: rows.map(({ scenario, trials }) => ({
          id: scenario.id,
          name: scenario.name,
          category: scenario.category,
          expectedVerb: scenario.expectedVerb ?? null,
          expectNoFurtherVerb: scenario.expectNoFurtherVerb ?? false,
          forbiddenVerb: scenario.forbiddenVerb ?? null,
          threshold: scenario.passThreshold,
          passes: trials.filter((t) => t.passed).length,
          trials: trials.map((t) => ({
            firstDecisionVerb: t.firstDecisionVerb,
            calls: t.calls,
            passed: t.passed,
            costUsd: t.costUsd,
            durationMs: t.durationMs,
            numTurns: t.numTurns,
          })),
        })),
        splitBars: split,
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
