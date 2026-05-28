# QA Debug Companion: User Guide

> **TL;DR for people who know what they're doing:**
> You don't need this. Drop a `debugger;` in your test, attach Chrome over CDP, and point `@playwright/mcp` at it yourself.
>
> **This guide is for everyone else.** If reading a stack trace gives you a headache, this tool is for you.

---

## Who this is for

This tool is for the QA or test owner who:

- Owns a Mocha test suite but doesn't like reading stack traces.
- Wants to click around the live browser when a test breaks, to see what really happened.
- Would rather ask GitHub Copilot "why did this fail?" than dig through logs.

If that sounds like you, keep reading.

---

## What it does

When a Mocha test fails, this tool:

1. Freezes the test instead of letting Mocha shut the browser down.
2. Keeps the browser open on the failing page.
3. Tells GitHub Copilot what broke: the assertion, the stack, the console output.
4. Lets Copilot drive the live browser for you. It can look at the DOM, click things, take screenshots.
5. Gives you three buttons in the Test Explorer:
   - **Retry**: try the test again.
   - **Mark Passed**: call it a flake and move on.
   - **Give Up**: accept the failure as real and continue the suite.

You stay in the conversation. Copilot does the technical reading.

---

## Installation

You only do this once.

### 1. Check you have these things ready

- VS Code 1.120 or newer.
- GitHub Copilot Chat installed and signed in.
- Node.js 18 or newer.
- Any Mocha test project. You do **not** need to install anything inside it. You also do **not** need to edit your `.mocharc` file. The extension hooks itself into your tests when it runs them.

### 2. Download the extension

1. Go to the releases page: **https://github.com/korakiad/extension-selfhealing/releases**
2. Find the most recent stable release (no "Pre-release" label).
3. Under **Assets**, download the file called `qa-debug-companion-X.Y.Z.vsix`.

### 3. Install it in VS Code

1. Open VS Code.
2. Open the **Extensions** panel on the left (or press `Cmd+Shift+X`).
3. Click the **`...`** menu at the top of the panel.
4. Pick **"Install from VSIX…"**.
5. Choose the file you just downloaded.
6. Reload VS Code when it asks.

You're done.

### 4. Staying up to date (optional)

The tool checks for new releases on its own. When one is out, you'll see a pop-up with an **"Install & Reload"** button. Click it and you're updated.

You can also check by hand. Open the Command Palette (`Cmd+Shift+P`) and run **"QA Debug: Check for Updates"**.

---

## How to use it

### Step 1: Run your tests through the extension

This part is important. The tool only works when you run your tests **through the extension**. If you start Mocha from a terminal (like `npx mocha`), the tool is not in the loop and nothing will pause when a test fails.

Two ways to start a run the right way:

- **From the Test Explorer:** open the Testing panel on the left and click the play button on a suite.
- **From the Command Palette:** press `Cmd+Shift+P` and run **"QA Debug: Run Fixture Suite"**.

You can watch the test output in the **"QA Debug Mocha"** output channel at the bottom of VS Code.

### Step 2: Wait for a test to fail

When something breaks:

- The failing test gets a red mark in the Test Explorer.
- The browser stays open on the failing page. Don't close it.
- A small pop-up appears at the bottom-right of VS Code.

### Step 3: Ask Copilot what happened

Three ways:

- **Easiest:** right-click the failed test in the Test Explorer, then pick **"QA Debug: Ask Copilot About This Failure"**.
- Or open Copilot Chat and type `@qa-debug` followed by your question, like `@qa-debug what went wrong?`.
- Or just open Copilot Chat. It will usually notice you're in a debug session and offer to look.

Copilot will:

- Read the error and stack for you.
- Look at the live browser, click things, read the page, and tell you what it sees.
- Explain the failure in plain words.

You can keep asking follow-up questions like:

- *"What does the login button look like right now?"*
- *"Is there an error message on the page?"*
- *"Why did the click fail?"*

### Step 4: Decide what to do

Once you know what broke, pick one of three actions from the Test Explorer or Command Palette:

| Action          | When to use it                                                              |
| --------------- | --------------------------------------------------------------------------- |
| **Retry**       | The failure looked like a one-off (slow page, flaky network). Try again.   |
| **Mark Passed** | The test failed but the product is fine. It was a flake.                   |
| **Give Up**     | The failure is real. There's a bug to file. The suite moves on.            |

Copilot can also suggest **Mark Passed** or **Give Up** for you. You'll see a Continue / Cancel button in the chat before anything happens.

---

## Picking the right browser (if you're asked)

Some test setups open more than one Chrome window. If the tool can't figure out which one to attach to, it will ask:

1. A pop-up asks for the **Chrome debug ports** your test used.
2. Type the port numbers, like `9222, 9223`.
3. If more than one browser shows up, pick the one whose page title matches your failing test.

If you don't know the ports, ask your test lead. It's a one-time setup per project.

---

## Stopping a running suite

Changed your mind in the middle of a run? Two ways:

- Click the **stop icon** at the top of the Test Explorer.
- Command Palette → **"QA Debug: Cancel Running Suite"**.

---

## Troubleshooting

**The browser closed when the test failed.**
You probably started Mocha from a terminal instead of through the extension. Stop the run, then start it again from the Test Explorer or from the "QA Debug: Run Fixture Suite" command. The tool only pauses on failure when it launched the run itself.

**Copilot doesn't seem to know there's a paused test.**
Make sure GitHub Copilot Chat is installed and signed in. Then right-click the paused test and pick **"Ask Copilot About This Failure"**. That hands the context over directly.

**I clicked Retry, Mark Passed, or Give Up and nothing happened.**
Open the **"QA Debug Mocha"** output channel (View > Output, then pick "QA Debug Mocha" from the dropdown). The error will be in there. Show it to your test lead.

**I'm on an old version.**
Run **"QA Debug: Check for Updates"** from the Command Palette. Or just download the latest `.vsix` from the releases page.

---

## Quick reference: commands

All commands live under the `QA Debug:` prefix in the Command Palette (`Cmd+Shift+P`):

- **Run Fixture Suite**: start a test run.
- **Cancel Running Suite**: stop the current run.
- **Ask Copilot About This Failure**: hand the paused test to Copilot Chat.
- **Mark Paused Test as Passed**: accept the failure as a flake.
- **Give Up on Paused Test**: accept the failure as real.
- **Select Chrome for Paused Test**: pick which browser to attach to.
- **Enter Chrome Debug Ports**: tell the tool which ports your test framework used.
- **Check for Updates**: look for a newer release by hand.

---

## Need help?

Ping your test lead, or open an issue at **https://github.com/korakiad/extension-selfhealing/issues**.
