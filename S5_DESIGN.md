# S5 — SKILL.md body: full per-failure-mode decision tree

> Status: **Iteration #1** drafted 2026-05-21. Subject of the [[feedback-ralph-loop]] adversarial review (cap=3 per CR-v5.1 / v5.2 / v5.3 / v5.4 / v5.5 precedent). Replaces the S4-shipped stub body at `extension/skills/qa-debug/SKILL.md:6–29` while preserving the S3-APPROVED frontmatter (30/30 engagement evals PASS on 2026-05-21; see [[project-qa-companion]] S3 entry).
>
> Scope: SKILL.md body content + per-decision rationale + named-error handling + Mode A/B awareness + retry exit conditions + escalation paths. NO MCP tool changes; NO architectural changes; NO chat-participant or status-bar changes.
>
> **Process discipline (from CR-v5.4 NB11):** All §0 platform-owned URL citations were WebFetched BEFORE this file was written. Verbatim quotes are inline in §0.

## 0. Sources (per ARCHITECTURE v5 §0.1 / §0.2)

### Agentic-design sources (§0.2)

All WebFetched 2026-05-21.

- **`https://www.anthropic.com/engineering/writing-tools-for-agents`** (cited in ARCH v5 §0.2 and CR-v5.4 §0; re-verified here for S5):

  > Section *"Optimizing tool responses for token efficiency"*: *"If a tool call raises an error (for example, during input validation), you can prompt-engineer your error responses to clearly communicate specific and actionable improvements, rather than opaque error codes or tracebacks."*

  > Section *"Returning meaningful context from your tools"*: *"Tool implementations should take care to return only high signal information back to agents. They should prioritize contextual relevance over flexibility, and eschew low-level technical identifiers (for example: `uuid`, `256px_image_url`, `mime_type`)."*

  Implication for SKILL body: every decision-tree branch terminates in a *specific, falsifiable* call to a `qa_*` verb with a reason/rationale that names what the agent learned, not a generic "investigation complete". The 6 qa-debug tool descriptions already enforce this at the tool level ("specific and falsifiable" / "not 'looks flaky'"); the SKILL body reinforces it at the decision-flow level.

- **`https://www.anthropic.com/research/building-effective-agents`** (cited in ARCH v5 §0.2):

  > Section *"Agents"*: *"During execution, it's crucial for the agents to gain 'ground truth' from the environment at each step (such as tool call results or code execution) to assess its progress."*

  > Section *"Agents"*: *"Agents can then pause for human feedback at checkpoints or when encountering blockers."*

  > Appendix 2: *"Poka-yoke your tools. Change the arguments so that it is harder to make mistakes."*

  Implication for SKILL body: (a) Step 1 ground-via-`qa_get_failure_context` and Step 2 ground-via-`playwright-mcp:browser_*` are non-negotiable; the SKILL body's decision tree fires off the *ground-truth*-shaped context, not the QA's natural-language summary. (b) The propose/commit split (CR-v5.4 §2.3 "two distinct gates") is the human-checkpoint pattern: agent proposes, human commits via UI button. SKILL body must steer the agent toward proposal verbs with rationale, not direct commit attempts.

- **`https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`** (cited in [[reference-anthropic-agentic-docs]]):

  > Section *"Set appropriate degrees of freedom"*: *"Match the level of specificity to the task's fragility and variability."* High-freedom = text-based instructions when multiple approaches valid; low-freedom = specific scripts when consistency critical.

  > Section *"Use workflows for complex tasks"*: *"Break complex operations into clear, sequential steps. For particularly complex workflows, provide a checklist that Claude can copy into its response and check off as it progresses."*

  > Section *"Implement feedback loops"*: *"Common pattern: Run validator → fix errors → repeat. This pattern greatly improves output quality."*

  > Section *"Conditional workflow pattern"*: provides a `Determine the modification type: Creating new content? → Follow "Creation workflow" below / Editing existing content? → Follow "Editing workflow" below` template — directly the shape the v5.5 decision tree needs.

  > Section *"MCP tool references"*: *"Format: `ServerName:tool_name`"* + warning that without server prefix, Claude may fail to locate tool. v5.5 SKILL body uses `qa-debug:qa_get_failure_context` / `playwright-mcp:browser_snapshot` FQN form per ARCH v5 §3.2.

  > Section *"Token budgets"*: *"Keep SKILL.md body under 500 lines for optimal performance."*

  > Section *"Build evaluations first"*: *"Create evaluations BEFORE writing extensive documentation. This ensures your Skill solves real problems rather than documenting imagined ones."*

  Implication for SKILL body: (a) S5 uses the **conditional workflow pattern** as the spine (Failure-class classification → branch). (b) Mix of degrees-of-freedom: high-freedom on investigation (multiple browser-* paths valid); low-freedom on commit (specific verb per classification). (c) Body stays under 500 lines (current S4 stub: 24 lines; S5 target: ~200–300 lines). (d) The decision-tree alignment eval (Task #22.4) is the implementation of "Build evaluations first" — written AFTER design APPROVED but BEFORE iterating on SKILL body.

- **`https://www.anthropic.com/research/measuring-agent-autonomy`** (cited in ARCH v5 §3.2 / CR-v5.3 §0 / CR-v5.4 §0):

  > *"only 0.8% of actions appear to be irreversible (such as sending an email to a customer)."*

  > *"Oversight requirements that prescribe specific interaction patterns, such as requiring humans to approve every action, will create friction without necessarily producing safety benefits."*

  > *"effective oversight doesn't require approving every action but being in a position to intervene when it matters."*

  Implication for SKILL body: The propose verbs (`qa_propose_mark_passed`, `qa_propose_close_browser`, `qa_propose_abort_suite`) ARE the "irreversible action gate" — UI commit is the intervention point per ARCH §3.2. The non-propose verbs (`qa_request_retry`, `qa_request_give_up`) are reversible-equivalent (retry → next pause re-fires; give_up → next run can re-run the test). v5.5 SKILL body MUST distinguish these in its decision tree language: "request" verbs flow without per-call confirmation pause; "propose" verbs explicitly tell the agent to stop and report.

### Repo-local sources (§0.1)

- `extension/skills/qa-debug/SKILL.md:1–29` — current frontmatter (S3 APPROVED) + S4 stub body to be replaced.
- `qa-debug-mcp/src/tools.ts:44–227` — the 6 qa_* tool definitions S5 SKILL body references (descriptions are tool-level; SKILL body is flow-level).
- `evals/src/scenarios.ts` — S3's 6-scenario engagement eval set; the S5 decision-tree eval extends this with ~14 new scenarios (~20 total).
- `evals/src/engagement.ts` — S3's `claude -p` subprocess + stub MCP harness; S5 eval reuses with multi-turn extension (capture FINAL qa_* call, not first).
- `evals/src/stub-mcp.ts` — stub MCP returning DRY_RUN for all tools; S5 eval extends to script `qa_get_failure_context` responses per scenario.
- `ARCHITECTURE.md` v5.1 §3.2 (propose/commit gates) + v5.5 §3.8 (Test Explorer surface) + CR-v5.2 §2.6 (Mode A close_browser decline) + CR-v5.4 §3.4.3 (MCP annotations).
- `pause-store-types/src/index.ts` `PausePayload` + `FailureContextView` — the ground-truth shape the agent reads at Step 1.

### Memory cross-references

- [[user-profile]] — user is Thai-speaking; QA tooling builder. Decision-tree examples use English (consistent with chat-participant + Output Channel).
- [[feedback-ralph-loop]] — adversarial review pattern + cap=3.
- [[feedback-research-source]] — Anthropic-owned URLs only for agentic-design claims; verify recency.
- [[feedback-transparent-use]] — SKILL body must NOT instruct the QA to edit specs / mocharc / browser-launch (those are extension responsibilities).
- [[feedback-chat-not-launcher]] — SKILL body must NOT instruct chat-as-command-launcher (no `@qa-debug run X` patterns); chat = conversation/investigation, Test Explorer = run surface.
- [[reference-subscription-eval-pattern]] — `claude -p` subprocess + stub MCP; Task #22.4 eval methodology.
- [[reference-anthropic-agentic-docs]] — canonical URL list (re-cited above).
- [[project-qa-companion]] — S3 evals + v5.4/v5.5 implementations landed; this is the next slice in the SLICE_PLAN.

## 1. The contradiction

The S4-shipped SKILL stub (24 lines) gives the agent Step 1 (ground via `qa-debug:qa_get_failure_context`), Step 2 (investigate via `playwright-mcp:browser_*`), and Step 3 (report + retry/give-up/mark-passed). It does NOT specify *which* of retry/give-up/mark-passed to choose per failure class, *when* to escalate to `qa_propose_abort_suite`, *what* to do when `qa_get_failure_context` returns `NO_ACTIVE_PAUSE` mid-flow, *how* to handle the Mode A close_browser decline, or *what counts* as a falsifiable mark-passed rationale.

Empirically, the S3 engagement eval shows the agent reliably engages (30/30 PASS on positive + negative scenarios). But engagement is necessary-not-sufficient: a Skill that engages correctly but commits the wrong decision verb (e.g., proposes `mark_passed` for a concrete bug, or calls `qa_request_retry` without a code change) regresses the QA's audit trail and produces noisier-than-Mocha-baseline behavior.

S5 closes this gap by adding the decision tree + named-error handling + Mode A/B awareness + retry exit conditions + escalation paths, while preserving the frontmatter that S3 already validated.

The S5 body is the "checkpoint" surface from the building-effective-agents quote: the per-decision branches make explicit when the agent should stop-and-report (propose verbs + low-confidence give_up) vs proceed-with-grounding (request verbs + concrete-bug retry).

## 2. The proposal

### 2.1 Body structure — conditional workflow pattern

The body opens with a four-step checklist (per agent-skills/best-practices "Use workflows for complex tasks") and branches at Step 3 (classify) into 4 decision arms (per the conditional workflow pattern). Final commit step is per-arm.

```
## Workflow checklist (copy into your reply)

- [ ] Step 1: Ground via qa-debug:qa_get_failure_context (concise)
- [ ] Step 2: Investigate via playwright-mcp:browser_* against the held browser
- [ ] Step 3: Classify failure (one of: code-bug / test-bug / env-flake / structural)
- [ ] Step 4: Commit decision per Step-3 classification (see decision tree)
- [ ] Step 5: Report decision and rationale in chat (one-line conclusion)
```

The checklist is verbatim-copyable per the best-practices guidance; the agent's response carries it and ticks each item, giving the human a visible progress trace. Steps 1, 2, and 5 are unchanged from the S4 stub; Steps 3–4 are the new substance.

### 2.2 Step 1 + Step 2 (preserved from S4 stub, tightened)

> *"Step 1: Call `qa-debug:qa_get_failure_context` (response_format: `concise`) to ground in the failure shape. The returned `failing_assertion`, `stack_trace.frames` (concise: first 10), and `cdp_ws_url` are the ground truth; the QA's natural-language description may be incomplete or speculative."*

> *"Step 2: Investigate the held browser at `cdp_ws_url` via `playwright-mcp:browser_snapshot` (DOM state), `playwright-mcp:browser_evaluate` (asserted value resolution), `playwright-mcp:browser_console_messages` (in-page errors), and `playwright-mcp:browser_network_requests` (XHR/fetch). The browser is held — multi-call investigation is the point. Do NOT call `playwright-mcp:browser_close`; closing destroys the QA's live inspection asset."*

The Step 2 paragraph also notes the Mode A vs Mode B distinction:

> *"Mode A note (transparent wdio integration, v5.2): when `qa_get_failure_context` returns `cdp_ws_url` on a non-`:9222` port (random ephemeral port via `wdio.remote().getPuppeteer().wsEndpoint()`), the browser is owned by the QA's test code. Investigate freely; do NOT call `qa-debug:qa_propose_close_browser` (it returns `{ status: 'declined' }` because user's `browser.deleteSession()` in test teardown closes it). Mode B (`cdp_ws_url` on `:9222`) — companion owns the browser; `qa_propose_close_browser` may be appropriate after investigation completes."*

### 2.3 Step 3 — failure classification (the decision spine)

Four mutually-exclusive classes the agent picks from based on Step 2 investigation:

| Class | Signal pattern | Examples |
|---|---|---|
| **code-bug** | The asserted production behavior is wrong (the test caught a real defect) | `expected 1 element matching ".submit-btn" but found 0` AND `browser_snapshot` confirms .submit-btn is missing because the recent commit renamed it to .primary-submit; `expected $80 but got $90` AND `browser_evaluate(window.computedDiscount)` returns 10% not 20%, matching a production logic regression |
| **test-bug** | The assertion logic is wrong; the asserted value is correct (test is stale w.r.t. product spec change) | Selector outdated after intentional rename per product spec; magic constant in test (`assert.equal(total, 80)`) hasn't been updated for new pricing; brittle timing-based wait now flakes against intentionally-slowed loader animation |
| **env-flake** | A *specific*, *named*, *transient* environmental signal explains the failure; product code paths are NOT involved | Upstream auth-service returned 503 at the assertion moment per `browser_network_requests`; staging seed data missing one row per `qa_get_failure_context.failing_assertion` cross-checked against the seed manifest; renderer crash mid-assertion per `browser_console_messages` containing "Renderer process gone" |
| **structural** | The failure is a cross-test signal (every test in the suite will hit the same blocker) | First-test fixture seed fails with `pg_connection_refused`; license-server unreachable so every test's beforeAll(login) fails; wrong staging URL produces 404 on every navigation |

The classification is *the* hinge. The body emphasizes that the agent MUST NOT skip to commit verbs without first articulating which class the failure falls in (poka-yoke: the wrong-class commit is the dominant failure mode of an under-guided agent).

### 2.4 Step 4 — commit decision per class (the four decision arms)

Each arm specifies (a) the verb to call, (b) the rationale shape, (c) the prerequisite action (if any), and (d) the named-error paths.

#### 2.4.1 code-bug arm → `qa-debug:qa_request_retry` after source edit

> **Verb:** `qa-debug:qa_request_retry`
>
> **Prerequisite:** Edit the production source file fixing the defect. The retry runs against the freshly-edited code. Do NOT call retry without an actual diff; "let's try again" is not a code-bug signal.
>
> **Rationale shape:** What was changed, by file and what behavior is now correct. Example: *"Fixed `src/auth/login.ts` so the JWT decoder accepts the new RS256 signing alg (was hard-coded to HS256 in the matching branch); test should now pass because the assertion checks for `decoded.sub` which the decoder now produces."*
>
> **Named-error paths:**
>  - If `qa_request_retry` returns `NO_ACTIVE_PAUSE`, the pause was already resolved (likely by the human via Test Explorer Give Up). STOP — do not re-call. Report to the QA: *"Pause was already resolved; my code-bug analysis stands, please review the source edit at <file>:<line>."*
>  - If `SESSION_NOT_FOUND`, your session_id is stale (rare; happens when a fresh pause superseded the one you were investigating). Re-call `qa_get_failure_context` (no `session_id`) to ground in the current pause, then re-classify.

#### 2.4.2 test-bug arm → `qa-debug:qa_request_retry` after test edit

> **Verb:** `qa-debug:qa_request_retry`
>
> **Prerequisite:** Edit the test spec file fixing the stale assertion / selector / constant. Same "no diff, no retry" rule.
>
> **Rationale shape:** What in the test was wrong vs the product spec, by line. Example: *"Updated `fixture-tests/specs/checkout.spec.js:42` selector from `.submit-btn` to `.primary-submit` per the product-side rename in commit 1a2b3c4; the assertion logic is unchanged."*
>
> **Named-error paths:** Same as code-bug arm.

#### 2.4.3 env-flake arm → `qa-debug:qa_propose_mark_passed` (stop and report)

> **Verb:** `qa-debug:qa_propose_mark_passed`
>
> **Rationale shape:** A *falsifiable* signal — concrete timestamp, log line, network response, or service-status reference. The rationale is what the human reads when accepting/rejecting the proposal. Examples:
>  - *"`browser_network_requests` shows auth-service returned HTTP 503 at 14:03:42.117 mid-login; the same auth-service `/healthz` returned 200 at 14:04:01.039 (one second after the test failed) — transient upstream blip, not a product regression."*
>  - *"Renderer crashed mid-assertion per `browser_console_messages: 'Renderer process (pid 4892) gone'`; the asserted DOM was never reachable. Re-render in a fresh browser session is the right next step (Test Explorer Run)."*
>
> **Anti-rationale (must not invoke):**
>  - *"Test seems flaky"* — no concrete signal.
>  - *"The failure is intermittent"* — `qa_get_failure_context.retry_count` is the right place to check intermittency; "intermittent" alone is not a falsifiable signal.
>  - Any rationale where the asserted value is derived from production code paths under test. That is a code-bug, not a flake.
>
> **Stop-and-report contract:** After calling `qa_propose_mark_passed`, STOP issuing tool calls. Report in chat: *"Proposed mark-passed pending your review; rationale: <text>. Click Approve or Reject in Test Explorer."* The verdict surfaces via `qa-debug:qa_get_failure_context.last_proposal_status` when next called. Do NOT poll it in a tight loop; the human commit is event-driven, not a clock.
>
> **Named-error paths:** Same NO_ACTIVE_PAUSE / SESSION_NOT_FOUND handling as code-bug arm.

#### 2.4.4 structural arm → `qa-debug:qa_propose_abort_suite` (stop and report)

> **Verb:** `qa-debug:qa_propose_abort_suite`
>
> **Rationale shape:** Cite the cross-test signal that explains why continuing the suite is wasted: *"All tests will fail at fixture seed: `pg_connection_refused` on `postgres://localhost:5432/staging`; per `browser_network_requests` the auth-service is also unreachable. Continuing the suite produces N more identical failures with no diagnostic value."*
>
> **Anti-rationale (must not invoke):**
>  - A single failed assertion in one test. Use `qa_request_give_up` instead.
>  - "The codebase is broken" — too vague; cite the specific shared dependency.
>  - "Tests are slow" — orthogonal to suite-abort.
>
> **Stop-and-report contract:** Same as env-flake — STOP after the call, report rationale in chat, await human commit.
>
> **Named-error paths:** Same NO_ACTIVE_PAUSE / SESSION_NOT_FOUND.

#### 2.4.5 Cannot-classify / cannot-fix → `qa-debug:qa_request_give_up`

> **Verb:** `qa-debug:qa_request_give_up`
>
> **When to use:**
>  - Investigation completed and the agent's confident the failure is real (one of code-bug / test-bug) but the agent cannot make the source edit (e.g., the fix requires a backend change outside the QA's repository; the spec needs a product manager's decision; the failing test asserts ambiguous behavior).
>  - The browser session is in an unrecoverable state (renderer crashed AND another tab also crashed) AND the failure is not classifiable as env-flake.
>  - Repeated retry would not help (e.g., retry_count from `qa_get_failure_context` ≥ 2 and same failure shape) AND env-flake doesn't fit.
>
> **Rationale shape:** State the root cause concretely. Examples:
>  - *"Selector `.checkout-cta` doesn't exist in DOM (snapshot confirmed); the recent product spec calls for `.proceed-to-checkout` rename but the new branch is not yet merged. Test will pass once the rename lands in main."*
>  - *"The asserted value `Promise-pending` indicates the production code returns an unresolved promise; the fix requires an `await` in `src/cart/total.ts:42`. Cannot edit (file is in a different repo); reporting for the backend engineer."*
>
> **NOT for "I don't know":** if the agent genuinely cannot diagnose, the rationale must say so concretely: *"Investigation inconclusive — `browser_snapshot` shows expected DOM, `browser_console_messages` empty, `browser_network_requests` all 200s; the assertion `expected X but got Y` does not match anything visible from the held browser. Suggest re-running with verbose logging or a fresh QA pair of eyes."*
>
> **Named-error paths:** Same NO_ACTIVE_PAUSE / SESSION_NOT_FOUND.

### 2.5 Retry exit conditions

> *"`qa_get_failure_context.retry_count` is the number of retries Mocha has already performed for this test. If `retry_count >= 2` AND the failure shape (`failing_assertion` + top stack frame file:line) is identical to the prior pause, the agent SHOULD NOT propose a third retry without a fundamentally different diagnosis. Either: (a) re-classify (the failure may be env-flake or structural that masqueraded as code-bug on first investigation), or (b) call `qa_request_give_up` with rationale citing the recurrence pattern."*

The retry-count check is mechanical and easy to verify in the eval — see §5 test scenario.

### 2.6 Escalation paths

> *"If during investigation the agent observes signals that suggest multiple tests will fail with the same root cause (e.g., `browser_network_requests` shows auth-service unreachable; `browser_console_messages` shows a global JS error like `Uncaught TypeError: window.app is undefined`), classify as `structural` and call `qa_propose_abort_suite` per §2.4.4 — even if only one test has paused so far. Pausing on N more tests with the same root cause produces audit-log noise without diagnostic value."*

### 2.7 Mode A vs Mode B sidebar

A short call-out box (~5 lines) in the body summarizing the v5.2 mode distinction so the agent doesn't have to re-derive it from the Step 1 ground-truth shape:

> **Browser ownership (v5.2):** `qa_get_failure_context.cdp_ws_url` reveals the mode:
>  - Random ephemeral port (e.g., `ws://localhost:54321`) → **Mode A** (your test code's `wdio.remote()` launched it). User owns lifecycle via `browser.deleteSession()` in teardown. `qa_propose_close_browser` returns `{ status: 'declined' }` — do not call.
>  - `:9222` → **Mode B** (companion-launched). `qa_propose_close_browser` may be called after investigation completes; the human commit closes via CDP `Browser.close`.

### 2.8 Frontmatter — UNCHANGED

The S3-APPROVED frontmatter (description-driven engagement, 30/30 evals PASS) stays exactly as-is. v5.5 body changes do NOT touch the discovery surface; only the post-engagement decision flow.

### 2.9 What the body explicitly DOES NOT say (anti-patterns)

Codified per the best-practices "Avoid offering too many options" guidance:

| Anti-pattern | Reason |
|---|---|
| Pseudo-code for "how to investigate" (e.g., "first run `browser_snapshot`, then `browser_evaluate`") | High-freedom investigation per the degrees-of-freedom guidance; multiple paths are valid; over-prescribing causes the agent to skip the right tool when the failure shape suggests it. |
| Instructions to edit `.mocharc.cjs` / spec / SKILL itself | Violates [[feedback-transparent-use]] — the QA owns specs; the extension owns hook injection. |
| Instructions to invoke chat as launcher (e.g., "type @qa-debug run X") | Violates [[feedback-chat-not-launcher]] — Test Explorer is the run surface; chat is investigation/agentic. |
| Specific Mocha CLI flags (e.g., "use --bail to stop after first fail") | Out of scope; the extension constructs the mocha command line per CR-v5.2 §2.1. |
| Mention of context-window management or "compress context" advice | Skill bodies should assume Claude is already very smart per best-practices "Default assumption"; per-call context management is a harness concern, not a Skill concern. |
| Instructions for the QA (e.g., "ask the QA to confirm") | The chat-participant is the QA-interaction surface; SKILL body addresses the agent, not the QA. |

## 3. Failure-mode classification — worked examples

The S5 SKILL body includes 4 concrete worked examples (one per class) inline so the agent has anchors. These examples reuse the fixture-tests existing failures so the eval can re-use them:

| Class | Fixture | Failure shape | Decision tree path |
|---|---|---|---|
| code-bug | `fixture-tests/specs/value-mismatch.spec.js` | `expected "$80.00" but got "$90.00"` | Edit `src/cart/discount.ts` to apply 20% (was 10%); call `qa_request_retry` with diff-citing rationale. |
| test-bug | `fixture-tests/specs/selector.spec.js` | `locator(".submit-btn") resolved to 0 elements` (when product spec rename to .primary-submit is intentional) | Edit selector in spec; call `qa_request_retry` with spec-citing rationale. |
| env-flake | `fixture-tests/specs/timeout.spec.js` with synthetic upstream 503 in `browser_network_requests` | `TimeoutError: page.waitForSelector(".welcome") exceeded 5000ms` AND network 503 from `/auth/login` at the assertion moment | Call `qa_propose_mark_passed` with falsifiable rationale citing the 503 timestamp + healthz 200 a second later. |
| structural | (new fixture for S5) `fixture-tests/specs/_seed-failure.spec.js` — first test fails on `pg_connection_refused` in beforeAll | Same `pg_connection_refused` would fire on every test in the suite | Call `qa_propose_abort_suite` with rationale citing the shared seed dependency. |

The worked examples are NOT prescriptive scripts (degrees-of-freedom: medium). They show the *shape* of the decision-tree → verb mapping; the eval (§5) verifies the agent generalizes.

## 4. Token budget + structure

Target body size: **~250 lines** (well under the 500-line cap per best-practices). Structure:

- Header (1 line): `# QA Debug Companion — debugging a paused failure`
- Workflow checklist (10 lines)
- Step 1 + Step 2 (20 lines; preserved from S4 stub, tightened)
- Step 3 — failure classification (40 lines; the 4-class table + signals)
- Step 4 — decision tree (110 lines; 5 sub-arms with verb / rationale / named-errors)
- Retry exit conditions (15 lines)
- Escalation paths (10 lines)
- Mode A vs Mode B sidebar (10 lines)
- Worked examples (4 × 8 lines = 32 lines)
- Anti-patterns (table; 10 lines)

Total budget ~258 lines. Under 500-line cap; comfortable for context budget.

No bundled separate files (no `REFERENCE.md`, `EXAMPLES.md`) — the body is self-contained per the "Avoid deeply nested references" best-practices guidance for Phase 1 Skills of this scope.

## 5. Decision-tree alignment eval (Task #22.4)

### 5.1 Eval methodology

Reuses [[reference-subscription-eval-pattern]] (`claude -p` subprocess + stub MCP) with two extensions:

1. **Multi-turn capture.** S3 captured the FIRST tool call; S5 captures the FIRST `qa_request_*` / `qa_propose_*` call after `qa_get_failure_context` resolves. Implementation: parse the stream-json output until the first qa-verb call (not the first qa_get_failure_context); SIGTERM at that point.

2. **Scripted `qa_get_failure_context` responses.** Stub MCP returns scenario-specific failure context (failing_assertion, stack_trace, network log signals) rather than the S3 DRY_RUN payload. The agent then has ground-truth shape to classify against.

   Implementation: stub-mcp gains a `--scenario-file <path>` arg pointing to a JSON map `scenario_id → { failing_assertion, stack_trace, console_logs, network_requests, retry_count }`. The eval harness writes a per-trial scenario file before each `claude -p` invocation; the stub reads it and returns the matching payload.

### 5.2 Scenario set — 20 scenarios

Distribution per class, with positive + negative + named-error trials:

| Bucket | Count | Description |
|---|---|---|
| code-bug → expect retry | 4 | One per "first-pause", "second-pause-same-shape", "edge-case-stack-trace", "Mode-A-cdp" |
| test-bug → expect retry | 3 | Selector-rename, magic-constant-stale, timing-brittle |
| env-flake → expect propose_mark_passed | 4 | Upstream 503, renderer-crash, staging-seed-row-missing, transient-network-blip |
| structural → expect propose_abort_suite | 2 | pg_connection_refused on beforeAll, license-server-unreachable cross-test |
| cannot-fix → expect request_give_up | 2 | Cross-repo dependency, ambiguous-spec |
| Retry exit (retry_count=2, same shape) → expect give_up NOT retry | 2 | Code-bug-shape, test-bug-shape |
| Named-error robustness | 3 | qa_get_failure_context returns NO_ACTIVE_PAUSE → expect graceful-stop-no-verb; SESSION_NOT_FOUND → expect re-ground-then-classify; Mode-A-close_browser-decline → expect no-retry-of-close_browser |

Total: 20. Pass threshold: ≥18/20 (90%) per the handoff's `≥90%` target.

Per-scenario `passThreshold` per the S3 convention:
- Decision-arm scenarios: ≥4/5 trials hit the expected verb (1 retry-allowed for stochasticity).
- Named-error scenarios: 5/5 trials handle the error path correctly (stricter — error paths must not regress).

### 5.3 Iteration loop

If eval misses the 90% bar:
1. Inspect failing scenarios; identify the pattern (e.g., agent confused env-flake with code-bug when network signal was ambiguous).
2. Refine the SKILL body section that addresses that pattern (e.g., strengthen the "anti-rationale" list in §2.4.3).
3. Re-run eval. Cap at 3 iterations per [[feedback-ralph-loop]] convention.
4. If still failing after 3 iterations: raise as blocker; do not lower the bar (per the S3 precedent — adjusting passThreshold to fit the result reverses the value of the eval).

### 5.4 Eval cost estimate

- 20 scenarios × 5 trials = 100 trials.
- Per-trial cost (S3 baseline: $0.116 for 30 trials with Sonnet) ≈ $0.004 per trial. S5 multi-turn raises this to ~$0.012 per trial (3× more tokens for ground-truth-shape contextualization).
- Total eval cost: ~$1.20 per full run. Three iterations × $1.20 = $3.60 cap.

## 6. Open questions for reviewer

1. **Should the SKILL body include the worked-example fixture file paths verbatim, or abstract to "your failing spec file"?** Recommendation: include verbatim. The fixture-tests path is stable in the project; the agent's pattern-matching benefits from concrete anchors. Counter-argument: future projects using this Skill won't have `fixture-tests/specs/value-mismatch.spec.js`; abstracting would generalize. Resolution: verbatim for v5.5 (Phase 1 has one consumer = this monorepo); generalize at Phase 2 packaging.

2. **Should the env-flake arm list specific upstream services (auth-service, staging, etc.) or abstract to "external dependency"?** Recommendation: abstract (the SKILL body is project-agnostic in spirit; the fixture-tests already provide concrete examples). Counter-argument: agents pattern-match on specific service names. Resolution: abstract in the prose, concrete in the worked example (§3).

3. **Should the body include a "what if the agent is wrong" recovery section?** I.e., if the agent calls `qa_propose_mark_passed` and the human rejects via Test Explorer, what should the agent do next? Recommendation: yes, brief. *"Rejection means the human disagrees with the env-flake classification. Re-classify as code-bug or test-bug and follow §2.4.1 / §2.4.2."* Counter-argument: adds 3–5 lines; the chat-participant or follow-up turn typically supplies the human's pushback text directly. Resolution: include as a 3-line sub-paragraph in §2.4.3.

4. **Should the cap-the-conversation behavior be specified?** I.e., should the SKILL body tell the agent "stop after the verb call" explicitly, or rely on the agent's natural turn-end behavior? Recommendation: explicit. The "Stop-and-report contract" sub-paragraph in §2.4.3 + §2.4.4 already specifies this; extend to all 5 arms.

5. **Should retry_count > 5 be a hard ceiling triggering automatic give_up?** Recommendation: NO. Retry count is a *signal* for the agent's judgment, not a mechanical cap. A code-bug arm with retry_count=5 might be the agent's 5th fix attempt against a stubborn-but-real bug; mechanical cap would lose the audit trail. Phase 2 may add telemetry to surface "abnormal retry density" without enforcing.

6. **Should the SKILL body mention the chat-participant `@qa-debug` or assume the agent doesn't know?** Recommendation: do NOT mention. The agent is invoked via Agent mode (auto-invocation on MCP gate per v5.4 §3.4.3) OR by free-form chat in `@qa-debug` participant scope; the body should not assume which. The decision tree is the same either way.

7. **Worked-example for the structural arm requires a new fixture (`_seed-failure.spec.js`).** Should we add it now or defer? Recommendation: add now, in the same commit as the SKILL body. The fixture is small (~15 lines), serves the eval directly (eval scenario #15 references it), and rounds out the four-class example set.

## 7. Recommendation

Apply S5_DESIGN as drafted. Cap=3 per CR-v5.4 precedent. Iter#2 reviewer should focus on:
- Whether the four-class taxonomy is exhaustive (are there real-world failure shapes that don't fit?).
- Whether the "stop-and-report contract" prose is strong enough to prevent the agent from polling `last_proposal_status` in a tight loop (a real failure mode in S3-era unsupervised loops).
- Whether the retry-exit-condition predicate (retry_count ≥ 2 + identical failure shape) is the right granularity (vs purely retry_count, vs purely identical-shape regardless of count).
- Whether the eval's 90% bar is the right target (vs 95% — given the propose verbs are human-committed, an agent error is recoverable).

Per [[feedback-ralph-loop]] NB11: reviewer should NOT have to WebFetch the §0 sources; they were verified at iter#1 file write. Reviewer may WebFetch additional Anthropic URLs if a new agentic-design claim is in scope, but the iter#1 author already did the homework for the cited rules.

## 8. Status

- **Iteration #1 (this file)** — 2026-05-21 file write. All §0 platform-owned URLs WebFetched + verbatim quotes inlined per CR-v5.4 NB11 process discipline. Q1–Q7 open for iter#2.
- **Iteration #2** — pending. Spawn `general-purpose` Agent with persona prompt per [[feedback-ralph-loop]] step 2; hand the URL list from [[reference-anthropic-agentic-docs]] + this file.
- **Iteration #3** — if iter#2 returns APPROVE-with-polish ≤5 NBs, apply inline and converge; else continue per cap=3.

## 9. Next steps after APPROVE

1. **Task #22.3 — Write SKILL.md body** per §2 structure; ~250 lines; preserve frontmatter.
2. **Task #22.4 — Extend eval harness** per §5 (multi-turn capture + scripted `qa_get_failure_context`); add 14 new scenarios to `evals/src/scenarios.ts`.
3. **Task #22.4 cont. — Add `fixture-tests/specs/_seed-failure.spec.js`** for the structural-arm worked example (Q7 resolution).
4. **Task #22.4 cont. — Run eval.** Target ≥18/20 PASS. If miss: iterate per §5.3 (cap=3).
5. **Task #22.5 — Commit S5 implementation.** Bundle SKILL.md body + scenarios.ts + new fixture + eval results JSON.
6. **Update [[project-qa-companion]] with S5 status; update [[reference-subscription-eval-pattern]] if the multi-turn extension surfaces new harness invariants.**
