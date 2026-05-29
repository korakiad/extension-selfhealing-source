# QA Debug Companion

Holds Mocha on test failure with the browser alive so a QA can investigate the live page state through GitHub Copilot, then decide to **mark passed** or **give up** — without re-running the suite from scratch. To re-run after a fix, the QA just hits **▶ Run** in the Test Explorer.

## What it does

When a Mocha test fails inside a fixture suite:

1. The `qa-hook` afterEach intercepts the failure and pauses the runner.
2. The held browser stays open at the failure point; its CDP endpoint is discovered per-pause via `/json/version` (Mode C — the browser is framework-owned).
3. The extension surfaces the paused test in Test Explorer with inline **Mark Passed** / **Give Up** actions.
4. GitHub Copilot can pick up the failure via the `qa-debug` chat participant and the registered Language Model Tools (`qa_get_failure_context`, `qa_discover_chromes`, `qa_select_chrome`, `qa_propose_mark_passed`, `qa_propose_abort_suite`, `qa_request_give_up`), and inspect the live browser through `playwright-mcp` (auto-wired to the held CDP endpoint during the pause).

## Requirements

- VS Code `^1.120.0`
- Node `>= 18`
- A Mocha test suite, launched **through the extension** (Test Explorer ▶ or "QA Debug: Run Fixture Suite") — not a standalone terminal `mocha`. You don't add `@qa-debug/mocha-hooks` as a dependency or edit `.mocharc`; the extension injects the hook + reporter at launch via `--require`/`--reporter`.
- GitHub Copilot Chat (for the chat participant + LM tools surface).
- `@playwright/mcp` added as a VS Code MCP server (Command Palette → "MCP: Add Server" → `npx @playwright/mcp@latest`). The extension wires it to the captured CDP endpoint during the pause.

## Status

Phase 1, version `0.0.5-beta.13` — pre-release for internal QA testing. Not yet on the Marketplace; distributed as a `.vsix` and updated via the in-extension stable-channel update checker. See [CHANGELOG.md](./CHANGELOG.md) for the release history.
