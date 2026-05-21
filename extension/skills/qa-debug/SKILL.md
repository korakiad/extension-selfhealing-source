---
name: qa-debug
description: Investigates a paused Mocha test failure through the QA Debug Companion. The failing browser is held alive at a Chrome DevTools endpoint so the agent can inspect the live DOM, console, network, and asserted values via playwright-mcp tools, then propose a retry, give-up, or marked-passed decision. Engages when a Mocha test is currently paused — a QA Debug Companion notification such as "Test <title> failed at <file>:<line>, browser held at ws://localhost:9222" is present in the chat context and the user is engaging with that pause (asking why the test failed, what the held browser shows, requesting retry, give-up, or marked-passed, or describing what they changed before retrying). Does NOT engage when no Mocha test is currently paused — past CI failures, generic test-writing questions, non-Mocha runners, or unrelated programming questions asked during a pause window route through normal Copilot tools, not qa-debug.
---

<!--
S3 ships frontmatter only. The decision tree the agent consults during a pause
lands in S5 per SLICE_PLAN.md §S5.

S5 will append imperative-voice content covering:
- Step 1 (always): call qa-debug:qa_get_failure_context (concise) to ground the investigation.
- Decision tree mapping failure kind → playwright-mcp:browser_* tool sequence.
- Guardrail: do not propose qa_propose_mark_passed for assertion failures rooted in production code.
- Output style: one-line conclusion first, then evidence.
- After any qa_propose_* call: stop and report; verdict surfaces via qa_get_failure_context.last_proposal_status.
-->
