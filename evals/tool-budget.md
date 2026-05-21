# `qa-debug` + `playwright-mcp` tool-surface budget

Companion to SLICE_PLAN.md §S3 exit criterion (c) + §4 Phase-1-exclusion list. Produced as part of S3 along with `engagement.ts` + `budget.ts`.

## Sources (per ARCHITECTURE §0.1 capability-claim rule)

- Tool Search Tool thresholds: `https://www.anthropic.com/engineering/advanced-tool-use` (WebFetched 2026-05-20; publication date 2025-11-24).
- Skill description authoring rules: `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` (WebFetched 2026-05-20; "Always write in third person" + "Be specific and include key terms" + 1024-char description cap).
- Tool-description rules: `https://www.anthropic.com/engineering/writing-tools-for-agents` (WebFetched 2026-05-20; "describe to a new hire" framing + namespacing examples + error-message specificity).
- playwright-mcp tool descriptions paraphrased from `github.com/microsoft/playwright-mcp/blob/main/README.md` (queried via context7 `/microsoft/playwright-mcp` on 2026-05-20). The version pinned in `evals/package.json` indirectly is `@playwright/mcp@0.0.75` — see SLICE_PLAN §0 for Phase-1 binding.

## Surface measured

- `qa-debug` MCP server: 6 tools (`qa_get_failure_context`, `qa_request_retry`, `qa_request_give_up`, `qa_propose_mark_passed`, `qa_propose_close_browser`, `qa_propose_abort_suite`).
- `playwright-mcp` curated subset for evals: 14 tools (see "Why curated, not full ~25" below).
- `qa-debug` SKILL.md frontmatter `description` only (body lands in S5 per SLICE_PLAN §S5; not part of this S3 budget).

## Measured budget (cheap chars/4 approximation; rerun `pnpm --filter ./evals run budget` with `ANTHROPIC_API_KEY` set for exact `countTokens` numbers)

| Component                                        | Chars  | Approx tokens |
| ------------------------------------------------ | ------ | ------------- |
| SKILL.md description                             | 927    | ~232          |
| qa-debug 6 tool defs (JSON-serialized)           | 7,496  | ~1,874        |
| playwright-mcp 14 curated tool defs              | 4,758  | ~1,190        |
| **Combined surface (Skill desc + 20 tools)**     | 13,182 | **~3,296**    |

The combined surface is below the 6,000-token ceiling SLICE_PLAN §S3 sets for `qa-debug` alone (~1,874 actual). ARCHITECTURE §3.4 estimates the *live* surface during a pause at ~12K–18K tokens — that bracket assumes the full ~25 playwright-mcp tools at their unedited wire descriptions, not the 14-tool curated subset measured here. The live-surface bracket is the figure to compare against the Tool Search threshold; this file's number is for eval-fidelity tracking, not production sizing.

## Why a curated 14-tool subset, not the full ~25

The eval measures **first-tool-selection accuracy among credible competitors**, not playwright-mcp surface fidelity:

1. The competing-first-call tools for the three positive scenarios are: `browser_snapshot` (selector scenario), `browser_evaluate` (value-mismatch scenario), `browser_console_messages` / `browser_network_requests` (timeout scenario). All four are present in the curated set.
2. Removed tools (`browser_pdf_save`, `browser_drag`, `browser_file_upload`, `browser_tabs`, `browser_handle_dialog`, etc.) do not plausibly compete for "first call after a paused failure," so their absence cannot change the eval signal.
3. Keeping descriptions short (paraphrased from README rather than copy-pasted from `@playwright/mcp@0.0.75` wire output) reduces the budget total, which is acceptable because the eval is testing **which** tool gets picked, not **how cheaply** the surface is loaded. Token economics for the live surface are tracked separately against the ARCHITECTURE §3.4 estimate.
4. The eval harness is a stub — it does not call playwright-mcp; it presents the tool definitions for first-call inspection. Live-surface budget will be measured in S6 once the real registration path is wired in S4.

## Tool Search Tool disposition

Per `anthropic.com/engineering/advanced-tool-use` (Nov 24 2025), Tool Search Tool is recommended when ANY of these triggers fire:

| Trigger                                | Our surface (eval-set)      | Live-surface bracket (est.)  | Hit?                |
| -------------------------------------- | --------------------------- | ---------------------------- | ------------------- |
| `>10K tokens of tool definitions`      | ~3,296 tokens (combined)    | ~12K–18K (ARCH §3.4)         | LIVE: yes / eval: no |
| `10+ tools available`                  | 20 (eval) / 31 (live)       | 31                           | YES                 |
| `MCP-powered systems with multiple servers` | qa-debug + playwright-mcp = 2 | same                       | YES                 |
| `tool-selection accuracy issues`       | Measured by `engagement.ts` | TBD per evals                | TBD                 |

Three of four triggers fire for the live surface (per ARCHITECTURE §3.4); two fire for the eval surface. Phase 1 nonetheless DEFERS Tool Search Tool per ARCHITECTURE §3.4 / SLICE_PLAN §S3(c) / §4 because:

1. The `qa-debug` SKILL.md decision tree (S5) disambiguates among playwright-mcp tools, so the agent isn't free-form-searching the surface — the Skill body acts as a static router for the live surface.
2. The surface is registered only during paused windows (typically seconds-to-minutes, not the whole session), so per-turn pre-load cost is bounded.
3. S3 engagement evals empirically check that, even without Tool Search, the agent picks the right first tool ≥ 4/5 on positive scenarios and 5/5 on negatives.

**If S3 engagement evals miss the bar, Tool Search Tool becomes a blocking Phase 1 addition** (per SLICE_PLAN §S3 exit criteria + §4 binding). Until then it is a Phase 2 candidate.

## Skill-description quality checks (per Skills best-practices)

- Length: 927 chars (cap is 1,024). ✓
- Voice: third-person ("Investigates…", "Engages when…", "Does NOT engage when…"). ✓ per `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` Warning callout.
- Key terms present: "Mocha", "paused", "browser held", "ws://localhost:9222", "retry", "give-up", "marked-passed" — these are the signal phrases the engagement evals match against.
- Negative discriminators present: "past CI failures", "non-Mocha runners", "unrelated programming questions during a pause window" — these are what scenario #6 (paused=false near-miss) and #4/#5 (paused but off-topic) discriminate on.

## How to run

```bash
# Local-only budget pass (cheap approximation, no API key needed):
pnpm --filter ./evals run budget

# Exact tokens via Anthropic countTokens (counts the same surface with the model's tokenizer):
ANTHROPIC_API_KEY=sk-… pnpm --filter ./evals run budget

# Full engagement eval — 6 scenarios × 5 trials = 30 API calls (~$0.10 against claude-sonnet-4-5):
ANTHROPIC_API_KEY=sk-… pnpm --filter ./evals run engagement

# Subset for fast iteration:
ANTHROPIC_API_KEY=sk-… pnpm --filter ./evals run engagement -- --scenarios 1,2 --trials 2

# Dry run (no API key needed; prints the system prompt + tool list + scenarios):
pnpm --filter ./evals run engagement -- --dry-run
```

Engagement results land in `evals/results.json`. The harness exits 0 only if every scenario clears its per-scenario threshold (4/5 positive, 5/5 negative).

## Open items handed to S5 / S6

- The eval's curated 14-tool playwright-mcp subset must be reconciled with the *live* registered surface in S6. Concretely: at the end of S6, re-run `evals/budget.ts` against the actual @playwright/mcp wire output captured during a real Extension Host pause, and update this file's "Live-surface bracket" column with measured numbers (not the §3.4 estimate).
- If the live surface ends up `>10K` tokens AND the S6 real-agent run shows first-call accuracy regression compared to S3 stub evals, open a Phase 1 CR to enable Tool Search Tool per SLICE_PLAN §S3 fallback clause.
