# QA Debug Companion

Holds Mocha on test failure with the browser alive so a QA can investigate the live page state through GitHub Copilot, then decide to **retry**, **mark passed**, or **give up** — without re-running the suite from scratch.

## What it does

When a Mocha test fails inside a fixture suite:

1. The `qa-hook` afterEach intercepts the failure and pauses the runner.
2. The held browser stays open at the failure point; its CDP endpoint is captured.
3. The extension surfaces the paused test in Test Explorer with inline Retry / Mark Passed / Give Up actions.
4. GitHub Copilot can pick up the failure via the `qa-debug` chat participant and the registered Language Model Tools (`qaFailureContext`, `qaRequestRetry`, `qaRequestGiveUp`, plus three proposal verbs), and inspect the live browser through `playwright-mcp` (auto-wired to the held CDP URL during the pause).

## Requirements

- VS Code `^1.120.0`
- Node `>= 18`
- A Mocha fixture suite that loads `@qa-debug/mocha-hooks` (see the workspace `mocha-hooks` package).
- GitHub Copilot Chat (for the chat participant + LM tools surface).
- `@playwright/mcp` available on PATH (the extension registers it dynamically with the captured CDP endpoint).

## Status

Phase 1, version 0.0.2 — pre-release for internal QA testing. Not yet on the Marketplace.
