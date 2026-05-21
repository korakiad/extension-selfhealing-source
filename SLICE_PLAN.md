# QA Debug Companion — Phase 1 Implementation Slice Plan v5

> Companion to `ARCHITECTURE.md` v5 (APPROVE-with-polish applied 2026-05-20, pending final sign-off). Source of truth for *what* to build is `ARCHITECTURE.md`. This document is the source of truth for *the order in which to build it* and the exit criteria per slice.
>
> Change tags: **[B1]/[B2]/[B3]** = Ralph-loop iteration-1 blockers (resolved in v2). **[B4]/[B5]** = iteration-2 blockers (resolved in v3). **[NB-v2-1..5]** = iteration-2 polish. **v4 final** = harmonization with ARCHITECTURE v4 (path-points-at-file, R3 resolutions). **[Q1]/[Q3]/[Q5]** = answers baked into the slice scope. **[v5#n]** = v4→v5 follow-ups (Mocha state-mutation finding; ARCHITECTURE §3.6 reporter adopted).

## 0. Inputs

- `ARCHITECTURE.md` v5 — single VS Code extension owning Mocha lifecycle + Chrome `:9222` + gated `vscode.lm.registerMcpServerDefinitionProvider`; `qa-debug` MCP exposes propose-only verbs for irreversible actions, commit verbs are wired to UI buttons; `chatSkills` SKILL.md is contributed by the extension (path points at the `SKILL.md` file); custom `qa-reporter` Mocha reporter is the single source of truth for human-facing outcome rendering (§3.6). [v5#1]
- Phase 1 exclusions (binding): no `chrome-devtools-mcp`, no `mocha --parallel`, no multi-window/context Playwright.
- Mocha target: `^10.7` (verified against `mocha@10.8.2`'s runner.js capabilities per ARCHITECTURE §0.1; only Node ≥ 18 matters).
- Stack: TypeScript, `@modelcontextprotocol/sdk` (stdio), `@playwright/mcp` (consumed, not authored), `vscode` ^1.95+ (for `lm.registerMcpServerDefinitionProvider` + `chatSkills`).

### 0.1 Conventions (v3)

**MCP FQN inside SKILL.md uses `<registered-server-id>:<tool>`** — where `<registered-server-id>` is the string the extension passes to `vscode.lm.registerMcpServerDefinitionProvider` (or the name the MCP server registers under its `serverInfo`). The Skills best-practices page (`https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`) writes the format as `ServerName:tool_name` and shows CapitalCase worked examples (`BigQuery:bigquery_schema`, `GitHub:create_issue`). **CapitalCase is illustrative, not syntactic** — the server segment is literally whatever the server registers as. We use lowercase/hyphenated server IDs (`qa-debug`, `playwright-mcp`) because (a) `@playwright/mcp` is a published package whose server self-identifies with that lowercase form and we cannot rename it, and (b) lowercase/hyphenated is the dominant convention in the MCP ecosystem. Therefore the agent-facing FQNs throughout this plan are `qa-debug:qa_get_failure_context` and `playwright-mcp:browser_snapshot`. [**B3**, **B4**]

The legacy double-underscore form `mcp__server__tool` is the Claude Code internal logging/permission form and does NOT belong in author-facing Skill content.

**Third-person voice applies to:** Skill `description`, MCP tool descriptions. **Not** to the SKILL.md body — imperative ("Call …", "Verify …") is fine there per the published examples. [**NB1**]

## 1. Sequencing principle

Each slice must produce a **runnable, demoable artifact** with explicit exit criteria. Slices are ordered so that load-bearing risks land first:

1. The Mocha hook + IPC + reporter spine (S2). If the `afterEach` IPC round-trip + `final_decision` notification + `qa-reporter` tri-state rendering don't compose correctly, nothing downstream stands up. (v4's version of this risk was "fixture-emulation via `this.retries(999)` + `afterEach` mutation"; v5 retired that pattern per the §0.3 lesson and ARCHITECTURE §3.6.) [v5#1]
2. **Agent-side ergonomics in parallel with tool surface (S3)** — tool descriptions, Skill description, and Skill-engagement evals are written and verified against a stub PauseStore *before* the full SKILL.md body is committed. This front-loads B1/B2 risks per Anthropic Skills best-practices: *"Build evaluations BEFORE writing extensive documentation."*
3. Extension wiring (S4) and full Skill body + decision tree (S5) ride on top of validated tool/Skill ergonomics.
4. Real-agent E2E (S6) is the integration-confidence step, not the place where description bugs are first discovered.

## 2. Slices

### S1 — Project scaffolding

**Scope.**
- pnpm workspace at repo root.
- Packages: `extension/` (VS Code extension), `qa-debug-mcp/` (stdio MCP server), `mocha-hooks/` (the `qa-hooks.js` root hook plugin as a published-style package), `fixture-tests/` (Mocha suite with intentionally-flaky tests for smoke), `evals/` (Anthropic-style Skill/tool evaluations).
- `tsconfig.base.json` + per-package `tsconfig.json` with project references.
- `esbuild` bundler for extension (single `dist/extension.js`) and MCP server (`dist/qa-debug-mcp.js` shebang'd).
- `extension/package.json` `contributes`:
  - `chatSkills`: see §0.1 / S5 — pointing to the **file** `./skills/qa-debug/SKILL.md`, no `when`, no `id`. [**B5**]
  - `commands`: `qa-debug.runFixture`, `qa-debug.retry`, `qa-debug.markPassed`, `qa-debug.giveUp`. Command enablement uses the `qa-debug.paused` context key (see S4 — context key now governs **UI command enablement only**, not Skill engagement). [**B5**]
- `.vscode/launch.json` Extension Development Host config.

**Exit criteria.**
- `pnpm build` clean.
- F5 opens Extension Host with the empty extension activated (`onStartupFinished`); `chatSkills` contribution is visible in `Developer: Show Running Extensions` / MCP-status output.
- `evals/` skeleton compiles (no scenarios yet — they land in S3).
- No behavior beyond activation logging.

**Out of scope here.** Any logic, any MCP registration, any Mocha invocation.

---

### S2 — Mocha root hook + IPC protocol + qa-reporter (fake oracle) [v5#1]

**Scope.**
- `mocha-hooks/src/qa-hooks.ts` (compiled to `dist/qa-hooks.cjs`): `afterEach` checks `currentTest.state === 'failed'` and runs the publish/await/dispatch loop from ARCHITECTURE v5 §3.1. **Does NOT** set retries on the test or mutate `state`/`err`/`parent.retries` — those calls would be no-ops or futile per the v4→v5 finding (see ARCHITECTURE §0 lessons + §3.1's "Why no state mutation?"). [v5#1]
- `mocha-hooks/src/qa-reporter.ts` (compiled to `dist/qa-reporter.cjs`): Mocha reporter implementing ARCHITECTURE v5 §3.6 — subscribes to `EVENT_RUN_BEGIN`, `EVENT_TEST_BEGIN`, `EVENT_TEST_PASS`, `EVENT_TEST_FAIL`, `EVENT_TEST_RETRY`, `EVENT_TEST_END`, `EVENT_RUN_END`; intercepts `EVENT_TEST_FAIL` and defers tri-state rendering until correlated with the hook's decision via the IPC `final_decision` notification. Renders passed / failed / **marked-passed** with rationale inline. CI-conservative exit code: non-zero unless `--qa-treat-marked-as-passing` is set. [v5#1]
- IPC: JSON-RPC 2.0 envelopes carried over Node's built-in `ipc` channel (parent spawns mocha child with `stdio: [..., 'ipc']`). Methods:
  - `pause.publish(payload)` → returns `{ session_id }`.
  - `decision.await(session_id, { heartbeat_ms, on_abandoned })` → returns `{ kind: 'retry' | 'mark_passed' | 'give_up', reason, by }`.
  - Server-pushed `heartbeat` every 5s; hook resolves locally as `{ kind: 'give_up', reason: 'abandoned', by: 'hook' }` if it misses 3 in a row.
  - **`final_decision`** notification from oracle/extension → reporter, immediately after `decision.await` responds, so the reporter can render the tri-state outcome at `EVENT_TEST_END`. [v5#1]
- Decision dispatch in `afterEach` (post-v5):
  - `retry` → invalidate `require.cache` for `currentTest.file` then return. **Note:** mocha will *not* re-run the test in S2 (no native-retry budget); the oracle re-spawns mocha against the same test in a follow-up child if it wants to simulate the S4 retry flow. The require-cache invalidation is retained per ARCHITECTURE v5 §3.1 because S4's `--grep` respawn relies on a fresh require resolution for the test file across the same Node process — Q2 verification is still binding. [v5#1]
  - `mark_passed` → return. The reporter renders the test as `✓ marked-passed by <user>: <rationale>` at `EVENT_TEST_END`.
  - `give_up` → return. The reporter renders the test as failed at `EVENT_TEST_END`.
- **Fake decision oracle:** a standalone Node CLI (`tools/oracle.ts`) that spawns mocha as a child with `stdio: [..., 'ipc']`, drives a scripted decision sequence per `--decisions` arg, and emits `final_decision` notifications for the reporter to consume. Not shipped in the extension bundle.
- `fixture-tests/` adds three intentionally-failing tests (timeout, bad selector, value mismatch) for use in S2/S3/S5/S6.

**Exit criteria.**
- `node tools/oracle.ts --decisions mark_passed,give_up,retry --tests 'specs/**/*.spec.js'` reaches `afterEach`, publishes pauses, blocks on `decision.await`, accepts the three decision kinds, and produces a `qa-reporter` tally on stdout consistent with the decisions: 1 marked-passed, 1 failed, 1 retried (simulated by oracle as a follow-up mocha invocation). [v5#1]
- Unit tests cover the heartbeat-timeout path (`onAbandoned: 'give_up'`).
- IPC schemas (Zod) exported from `mocha-hooks/src/protocol.ts` for reuse by S3 / S4 / qa-reporter.
- **Reporter integration test:** the reporter's stdout for the 3-decision exit-criteria run matches a snapshot (committed) showing `1 passing, 1 failing, 1 marked-passed (rationale: ...)`. CI exit code: 1 (because failed + marked-passed > 0 and the relaxed flag is not set). [v5#1]
- **Q2 verification artifact:** the require-cache invalidation behavior is exercised by editing a test file before a simulated `--grep` respawn; document the observed behavior in `mocha-hooks/README.md`. **If the verification shows `require.cache` invalidation is unnecessary in the respawn flow, raise an ARCHITECTURE v5.1 change request** rather than silently simplifying. The call remains in ARCHITECTURE v5 §3.1. [**NB-v2-3** revised]

**Out of scope here.** No real MCP server. No VS Code involvement. No Chrome. No `qa-debug` Skill engagement evals (S3).

---

### S3 — `qa-debug` MCP server **+ agent ergonomics evals** (stub pause-store)

> v2 restructure preserved: per [**B1**] and [**B2**], the agent-ergonomics surface (tool descriptions, Skill description, and engagement evals against a stub MCP) is built and verified BEFORE the SKILL.md body lands in S5.

**Scope.**

**(a) MCP server.** `qa-debug-mcp/` over stdio (`@modelcontextprotocol/sdk`), capabilities = `tools`. Self-identifies as server `qa-debug` (lowercase, hyphenated — see §0.1).

Tools (6 total — `qa_wait_for_pause` removed per [**Q3**]):
- `qa_get_failure_context` (read; `response_format` enum).
- `qa_request_retry`, `qa_request_give_up` (commit-by-MCP for reversible verbs).
- `qa_propose_mark_passed`, `qa_propose_close_browser`, `qa_propose_abort_suite` (propose-only).

All tool input schemas declared with strict JSON Schema; error codes per ARCHITECTURE §3.2 (`NO_ACTIVE_PAUSE`, `SESSION_NOT_FOUND`).

Internal `PauseStore` interface (read + propose-set + verdict-poll); S3 ships an in-memory implementation. S4 will swap it for the extension-backed durable store via dependency injection at extension-launch time.

**(b) Authoring.** Every MCP tool description is written to:
- include (i) when to call it, (ii) what it returns, (iii) at least one named error condition — per `https://www.anthropic.com/engineering/writing-tools-for-agents` "describe to a new hire" guidance; [**NB4**]
- use third-person voice (per Skills best-practices, same convention applied here); [**NB1**]
- avoid semantic overlap with playwright-mcp tools (e.g., `qa_propose_close_browser` description must distinguish itself from `browser_close`).

**(c) Skill SKILL.md frontmatter (file: `extension/skills/qa-debug/SKILL.md`).** Write the **frontmatter only** — `name: qa-debug`, `description: <one paragraph>`. Do NOT write the body yet (the body lands in S5). Required frontmatter fields per `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` are `name` and `description` only (no `when`). Description text must satisfy the engagement evals below.

**(d) Engagement evals (`evals/`).** Six scenarios per [**B2**] / [**NB-v2-2**]:

| # | User prompt | Pause state | Expected first MCP call | Tests |
|---|---|---|---|---|
| 1 | "the timeout test just failed, what's going on" | paused (timeout) | `qa-debug:qa_get_failure_context` | Skill engaged, Step-1 honored |
| 2 | "this assertion's wrong, can you look" | paused (value mismatch) | `qa-debug:qa_get_failure_context` | Step-1 vs. `browser_evaluate` distraction |
| 3 | "I think the selector changed" | paused (selector) | `qa-debug:qa_get_failure_context` | Step-1 vs. `browser_snapshot` distraction |
| 4 | "how do I write a select-all query in postgres" | paused | **no qa-debug tool call** | Negative — Skill must not engage on unrelated prompt during a pause |
| 5 | "what's the weather" | paused | **no qa-debug tool call** | Negative — same |
| 6 | "my postgres test is failing in CI" | **NO pause** | **no qa-debug tool call** | **Near-miss** — description must discriminate on "currently paused" signal, not just "test/debug" keyword [**NB-v2-2**] |

Run the evals against a Claude API session with: a stub MCP serving canned `qa_get_failure_context` payloads, the playwright-mcp tool definitions (read from `@playwright/mcp`'s schema export — no live browser needed), and the `qa-debug` SKILL.md frontmatter under review. Track per-scenario pass/fail across 5 trials each.

**Exit criteria.**
- Inspector run with `npx @modelcontextprotocol/inspector dist/qa-debug-mcp.js`: 6 tools listed.
- Tool-description token cost sum ≤ **6,000 tokens** for the `qa-debug` surface alone. Combined with `@playwright/mcp` (~25 tools), measured total surface (qa-debug + playwright-mcp + SKILL.md frontmatter) is documented in `evals/tool-budget.md`.
  - **Tool Search disposition [NB-v2-1]:** Anthropic's `https://www.anthropic.com/engineering/advanced-tool-use` (Nov 24, 2025) cites `>10K tokens` and `10+ tools` as the threshold where Tool Search Tool becomes recommended. Phase 1's combined surface (estimated 12K–18K tokens, ~31 tools) is above that threshold. We deliberately defer Tool Search to Phase 2 because: (i) the qa-debug SKILL.md disambiguates among the playwright-mcp tools so the agent isn't free-form-searching the surface, (ii) the surface is only registered during paused windows (typically seconds-to-minutes, not the whole session), and (iii) the eval bar in this slice empirically verifies the agent picks the right tool ≥ 4/5 even without Tool Search. If the eval bar fails to clear in (3) below, Tool Search becomes a blocking add for Phase 1 instead. [**NB-v2-1**, **B2**]
- Engagement evals: scenarios 1–3 each show the agent's first MCP call is `qa-debug:qa_get_failure_context` in ≥ 4 of 5 trials per scenario (≥ 12/15 overall). Scenarios 4–6 must hit 5/5 each — Skill must not engage on unrelated or no-pause prompts. [**B1**, **B2**, **NB-v2-2**]
- If any eval fails below threshold: the fix is in description text first, tool-description text second. Document each description revision in `evals/description-history.md`. If the fix cannot land within the description budget, raise a Phase 1 scope question (Tool Search? smaller playwright-mcp surface?).

**Out of scope here.** Wiring into IPC or Mocha — done in S4. No actual playwright-mcp registration. SKILL.md body (S5).

---

### S4 — Extension activation, provider gating, UI commits

**Scope.**
- `extension/src/extension.ts` `activate()`:
  - Construct durable `PauseStore` over `ExtensionContext.globalState` (`Memento`).
  - Register `vscode.lm.registerMcpServerDefinitionProvider('qa-debug', provider)`; provider returns `[]` at idle.
  - **Chrome lifecycle [Q5]:** spawn headed Chrome with `--remote-debugging-port=9222` on Mocha *suite start* (not on extension activation). Single-file Test Explorer runs still launch a suite-scoped Chrome. Reuse the same Chrome across tests within the invocation. Teardown on Mocha process exit unless a pause is unresolved (in which case Chrome stays up; the abandoned-heartbeat path eventually cleans up).
  - Spawn Mocha as a child with `--require <mocha-hooks/qa-hooks.js>`; pipe IPC stdio to the extension's IPC server using the same JSON-RPC contract from S2.
  - On `pause.publish` from hook:
    - store in PauseStore;
    - **flip `qa-debug.paused` context key — this controls UI command enablement and Test Explorer button visibility, NOT Skill engagement;** [**B5**]
    - provider re-emits `onDidChangeMcpServerDefinitions` with `[playwright-mcp(cdpEndpoint=ws://localhost:9222), qa-debug]`.
  - On any commit: clear pause; flip context key off; provider re-emits with `[]`.
- **UI surface [Q1]:** VS Code notification + Test Explorer failure annotation + three inline command links (`qa-debug.retry`, `qa-debug.markPassed`, `qa-debug.giveUp`). The Test Explorer annotation is the **only** commit path for `mark_passed` / `close_browser` / `abort_suite`. **No `vscode.chat.createChatParticipant`** in Phase 1.
  - Inline `reason`/`rationale` rendering per ARCHITECTURE §3.5.
- Wire `qa_propose_*` MCP calls → PauseStore proposal → UI button → on click → IPC `decision.await` returns the matching kind.
- Wire `qa_request_retry` / `qa_request_give_up` → PauseStore → IPC immediately (no UI commit step).
- **Skill engagement comes from the SKILL.md `description` matching the user's chat turn (per Anthropic Skills semantics)**, not from a VS Code context-key gate. The `qa-debug.paused` context key only gates *UI affordances*, not Skill loading. [**B5**]

**Exit criteria.**
- F5 Extension Host: run a fixture test → fail → MCP gate opens (verify via `Developer: Show MCP Status` / equivalent that `playwright-mcp` and `qa-debug` appear in the registered MCP servers list, then disappear after commit) [**NB-v2-4**] → click Mark Passed in Test Explorer → Test Explorer renders the test as `marked-passed` (NOT mocha's stdout — see [v5#2]) → gate closes.
- Same flow with Retry: click Retry → extension respawns mocha child with `--grep <test title>` (Chrome `:9222` stays up) → second-failure pause re-opens gate. [v5#2]
- Same flow with Give Up: click Give Up → Test Explorer renders the test as failed → gate closes.
- VS Code Reload mid-pause: PauseStore survives (Memento), pause is re-bound on activation, gate re-opens.
- Chrome lifecycle: verify Chrome launches on suite start (not on activation); verify Chrome stays up on test failure; verify Chrome teardown on Mocha process exit when no pause is outstanding; verify Chrome stays up when a pause is outstanding and Mocha is killed externally (abandoned path).
- **Test Explorer outcome rendering matches `qa-reporter` output** for all three decision kinds (passed/failed/marked-passed). Tested by running each decision and diffing the Test Explorer state against the reporter's stdout snapshot from S2. [v5#2]

**Out of scope here.** SKILL.md body (S5). E2E with real Copilot agent (S6).

---

### S5 — `chatSkills` SKILL.md (body)

> S3 already shipped the SKILL.md frontmatter and verified description-engagement. S5 writes the body — the decision tree the agent actually consults during a pause.

**Scope.**

- File: `extension/skills/qa-debug/SKILL.md` (already created with frontmatter in S3; S5 appends the body).
- Body authoring:
  - Imperative voice throughout (per [**NB1**]).
  - FQN format `qa-debug:qa_get_failure_context`, `playwright-mcp:browser_snapshot`, etc. (per §0.1).
  - Step 1: call `qa-debug:qa_get_failure_context` (concise).
  - Decision tree:
    - Timeout → `playwright-mcp:browser_snapshot` + `playwright-mcp:browser_console_messages`.
    - Selector-not-found → `playwright-mcp:browser_snapshot` + `playwright-mcp:browser_evaluate` with `document.querySelectorAll(...)`.
    - Value mismatch → `playwright-mcp:browser_evaluate` reading the asserted value live; compare to expected.
  - Guardrail: callers must not invoke `qa-debug:qa_propose_mark_passed` when the failing assertion's value is derived from production code paths. Mark-passed is reserved for environment/flake signals.
  - Output style: agents should produce a one-line conclusion first, then evidence.
  - After calling any `qa_propose_*` tool, the agent should pause and report in chat; verdicts surface via `qa-debug:qa_get_failure_context.last_proposal_status`.
- **`chatSkills` contribution in `package.json` (definitive shape, matching the canonical example in `code.visualstudio.com/docs/copilot/customization/agent-skills` 5/20/2026):** [**B5**]
  ```json
  {
    "contributes": {
      "chatSkills": [
        { "path": "./skills/qa-debug/SKILL.md" }
      ]
    }
  }
  ```
  - `path` points directly at the `SKILL.md` file. (The VS Code page contains contradictory prose elsewhere about a directory; the canonical example and the package.json registration section both use the file path. ARCHITECTURE v4 §3.3 records the same finding.)
  - **No `when` clause** — VS Code's `chatSkills` contribution schema does not document one. Engagement is description-driven via Anthropic Skills semantics. [**B5**]
  - **No `id` field** — also not in the documented schema.

**Exit criteria.**
- With no pause active: Skill is registered with VS Code (verify via Copilot Chat skill picker / `Developer: Inspect Context Keys` ≠ Skill activation; the Skill description should not match unrelated user prompts).
- With a pause active: re-run the S3 engagement evals — same threshold (12/15 on golden, 5/5 on each of the three negative scenarios) must still pass after the body is added. Body must not regress description-engagement.
- New eval, "decision-tree alignment": for each of the three fixture failures (timeout, selector, value mismatch), the agent's *second* MCP call (after `qa_get_failure_context`) matches the decision tree branch ≥ 4/5 trials.

---

### S6 — End-to-end smoke with real agent + real browser

**Scope.**
- `fixture-tests/`: 3 deterministic-fail tests (timeout, missing selector, value mismatch) hitting a tiny static HTML site served from `fixture-tests/site/`.
- Run the full loop in the Extension Host: launch fixture → fail → MCP gate opens → playwright-mcp registers with `cdpEndpoint=ws://localhost:9222` → use Copilot Chat (real agent) to:
  - For test 1: invoke `browser_snapshot`, identify why the selector never resolved, propose `mark_passed` with a clearly flaky rationale (human rejects).
  - For test 2: invoke `browser_snapshot` + `browser_evaluate('document.querySelectorAll(...)')`, edit the test selector, click Retry, suite passes.
  - For test 3: invoke `browser_evaluate` to read the live value, edit the assertion, Retry, suite passes.
- Observability log channel shows the full decision trail with `reason` for each.

**Exit criteria.**
- The three flows above complete without manual intervention beyond the human committing UI buttons.
- **Registered MCP servers list is empty at idle** before and after each pause (proxy for "tool count is 0 at idle" — the public Copilot/VS Code surface exposes the registered list, not the active per-turn tool count). [**NB-v2-4**]
- `Memento` PauseStore is empty at end-of-suite.
- **Audit-log usefulness [NB3]:** all three flows produce `reason`/`rationale` payloads where the cause is identifiable to a QA who did not write the test. Spot-check by handing the audit log to one person on the team who hasn't seen the fixture code; they must be able to summarize each failure in one sentence.

---

## 3. ARCHITECTURE v4→v5 alignment (R4 follow-ups — RESOLVED)

All five v4→v5 follow-ups have been applied to ARCHITECTURE v5 (APPROVE-with-polish from Ralph-loop reviewer #5 iteration #1 on 2026-05-20; pending final sign-off pass):

- **R4#A. RESOLVED.** ARCHITECTURE v5 §0 codifies the capability-claim-citation rule (0.1) and agentic-design-source restriction (0.2). The v3→v4 (chatSkills schema) and v4→v5 (mocha runtime) lessons are recorded in §0.3 so future reviewers don't relearn them. SLICE_PLAN §0 unaffected.
- **R4#B. RESOLVED.** ARCHITECTURE v5 §3.1 drops state-mutation lines; adds explanation citing mocha runner.js:825/828 and context.js:80–86. New §3.6 specifies the `qa-reporter` Mocha reporter as the single source of truth for human-facing outcome rendering, with tri-state tally (passed/failed/marked-passed) and CI-conservative exit-code semantics. SLICE_PLAN S2/S4 updated (this iteration) to add the reporter to scope and pin the Test-Explorer-matches-reporter exit criterion.
- **R4#C. RESOLVED.** ARCHITECTURE v5 §3.5 IPC clarified: JSON-RPC envelopes carried over Node's `ipc` channel, not stdin/stdout. SLICE_PLAN S2 IPC bullet updated to match.
- **R4#D. RESOLVED.** ARCHITECTURE v5 §3.6 explicitly separates human observation (reporter stdout) from agent observation (`qa_get_failure_context.last_proposal_status`) per `anthropic.com/engineering/writing-tools-for-agents` (Sep 11 2025) high-signal principle. No SLICE_PLAN change.
- **R4#E. RESOLVED.** ARCHITECTURE v5 §3.6 covers reporter↔hook coordination in S2 (oracle emits `final_decision` IPC notification) vs S4 (in-process PauseStore query). SLICE_PLAN S2 IPC bullet adds the `final_decision` notification method; reporter integration test added to S2 exit criteria.

### Prior alignment (R3 follow-ups — RESOLVED in v4)

- **A.** `chatSkills.when` claim dropped; engagement description-driven; `qa-debug.paused` context key gates UI affordances only. Iteration #3 fix: `path` points at SKILL.md file (not directory).
- **B.** MCP FQN form switched to `server:tool`.
- **C.** `qa_wait_for_pause` removed; tool count cap dropped from ~32 to ~31.
- **D.** `qa_propose_close_browser` UI commit gate preserved with asset-destruction-asymmetry defense paragraph.

## 4. Out of phase 1 (binding)

- `chrome-devtools-mcp` integration.
- `mocha --parallel`.
- Multi-window / multi-context Playwright sessions.
- VS Code Debug API (`vscode.debug.*`) — phase 2.
- Restart-across-VS-Code-restart pause durability (intentionally not handled; pause-store survives chat restart only).
- Chat-participant (`vscode.chat.createChatParticipant`) — Phase 2 if needed for `@qa run` user-driven invocation.
- **Tool Search Tool** — deferred to Phase 2 conditional on S3 engagement evals clearing the 12/15 + 5/5 + 5/5 + 5/5 bar without it. If those evals miss, Tool Search becomes a blocking Phase 1 addition. [**NB-v2-1**]

## 5. Status

v5 of the slice plan applies all v4 prior work plus:
- v5#1: S2 scope adds the `qa-reporter.cjs` reporter alongside `qa-hooks.cjs`; IPC adds the `final_decision` notification; S2 exit criteria rephrased so the tri-state tally comes from the reporter, not from mutated mocha-native state.
- v5#2: S4 exit criteria adds Test-Explorer-matches-reporter check and Retry-via-`--grep`-respawn flow.

All R3 follow-ups (A/B/C/D) remained applied from v4. All R4 follow-ups (A/B/C/D/E) are applied in ARCHITECTURE v5 (APPROVED 2026-05-20 by Ralph-loop reviewer #5; iteration #1 APPROVE-with-polish → iteration #2 APPROVE clean). S2 implementation resumes against the revised exit criteria (reporter snapshot test + `final_decision` IPC notification + Q2 verification under the `--grep`-respawn flow).
