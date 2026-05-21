---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a retry, give-up, or marked-passed decision. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held at ws://localhost:9222" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, requesting retry, give-up, or marked-passed, or describing what they changed before retrying). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

<!--
S4 ships this one-paragraph stub body so an S4-only smoke run does not leave
the agent unguided after Step 1. The full per-failure-mode decision tree lands
in S5 per SLICE_PLAN.md §S5 + S4_DESIGN.md §7.6 [R#2-NB9].
-->

This Skill engages when a Mocha test is currently paused at a failure with a
held debugging browser available. Step 1: call `qa-debug:qa_get_failure_context`
(concise) to ground. Step 2: investigate via the held browser using
`playwright-mcp:browser_snapshot`, `playwright-mcp:browser_evaluate`, and
`playwright-mcp:browser_console_messages`. Step 3: report a one-line conclusion
in chat, then either edit the test or source and call
`qa-debug:qa_request_retry` with a specific `reason` (what was changed), or
call `qa-debug:qa_request_give_up` with a `reason` if no retry is warranted.
Reserve `qa-debug:qa_propose_mark_passed` for environmental flake signals
(transient infra, upstream 503s, known-broken staging fixtures) and provide a
specific, falsifiable rationale. Do NOT invoke `qa_propose_mark_passed` when
the failing assertion's value is derived from production code paths — that is
a real bug and should follow `qa_request_give_up` or a fix-and-retry. After
any `qa_propose_*` call, stop and report in chat; the human commits or rejects
via Test Explorer, and the verdict surfaces via
`qa-debug:qa_get_failure_context.last_proposal_status`.

(S5 will replace this stub with the full per-failure-mode decision tree.)
