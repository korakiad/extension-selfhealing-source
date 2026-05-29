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
5. Gives you a button in the Test Explorer to stop the pause when you're done looking.

You stay in the conversation. Copilot does the technical reading.

---

## Installation

You only do this once.

### 1. Check you have these things ready

- VS Code 1.120 or newer.
- GitHub Copilot Chat installed and signed in.
- Node.js 18 or newer.
- **playwright-mcp added to VS Code.** This is what lets Copilot see the live browser. Add it once:
  1. In VS Code, open the Command Palette (`Cmd+Shift+P`).
  2. Search for **"MCP: Add Server"** and pick it.
  3. Choose **Command (stdio)** when asked how to launch it.
  4. Paste this as the command: `npx @playwright/mcp@latest`
  5. Name it `playwright` and confirm.

  You only do this once. VS Code remembers it.
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

It's basically three steps:

1. **Click the play button in the Test Explorer** to run your tests. (Or use the Command Palette and run **"QA Debug: Run Fixture Suite"**. Same thing.)
2. **Wait.** When a test fails, it pauses. The browser stays open. You'll see a pop-up at the bottom-right of VS Code.
3. **Open Copilot Chat and just ask.** Type whatever you want to know:
   - *"what happened?"*
   - *"what does the login button look like right now?"*
   - *"is there an error on the page?"*
   - *"why did the click fail?"*

   Copilot reads the error for you, looks at the live browser, and answers in plain words.

When you're done looking, click any button next to the paused test in the Test Explorer to stop. There's a couple of them (Mark Passed, Give Up) but for most cases it doesn't really matter which one you click. They both stop the pause and let you move on.

Once you've made a fix and want to try again, just hit the **▶ Run** button in the Test Explorer to run the suite afresh.

That's it.

> **Tip:** if Copilot doesn't seem to know about the paused test, right-click the paused test in the Test Explorer and pick **"QA Debug: Ask Copilot About This Failure"**. That hands it the context.

---

## Picking the right browser (if you're asked)

Most of the time you won't be. The tool finds the failing test's browser on its own and attaches to it.

You'll only see a prompt in two cases:

- **It found several browsers.** A picker appears listing them by page title. Pick the one that matches your failing test. (Or just tell Copilot in chat which one, and it can pick for you.)
- **It found none.** A box asks for the **Chrome debug ports** your test framework uses. Type them comma-separated, like `22135, 22136`. The tool checks those ports and attaches.

If you don't know the ports, ask your test lead; it's a one-time thing per project. You can also re-open either prompt any time from the Command Palette: **"QA Debug: Select Chrome for Paused Test"** and **"QA Debug: Enter Chrome Debug Ports"**.

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

**I clicked the stop button and nothing happened.**
Open the **"QA Debug Mocha"** output channel (View > Output, then pick "QA Debug Mocha" from the dropdown). The error will be in there. Show it to your test lead.

**I'm on an old version.**
Run **"QA Debug: Check for Updates"** from the Command Palette. Or just download the latest `.vsix` from the releases page.

---

## Quick reference: commands

All commands live under the `QA Debug:` prefix in the Command Palette (`Cmd+Shift+P`):

- **Run Fixture Suite**: start a test run.
- **Cancel Running Suite**: stop the current run.
- **Ask Copilot About This Failure**: hand the paused test to Copilot Chat.
- **Mark Paused Test as Passed** / **Give Up on Paused Test**: both stop the pause and move on. Pick whichever.
- **Select Chrome for Paused Test**: pick which browser to attach to.
- **Enter Chrome Debug Ports**: tell the tool which ports your test framework used.
- **Check for Updates**: look for a newer release by hand.

---

## How it finds the browser (the technical bit, skip if you don't care)

*For test leads and developers. If you're just running tests, ignore this. The tool handles it for you.*

When a test fails, the extension doesn't guess a browser URL. It **discovers** the live Chrome over the DevTools Protocol (CDP):

1. **Probe.** It checks a short list of debug ports (default **`22135` and `22136`**) by fetching `http://localhost:<port>/json/version` and `/json/list` (500 ms timeout each, in parallel). Every port that answers becomes a candidate, tagged with its open page titles.
2. **Select.**
   - 1 candidate → attached automatically, no prompt.
   - 2 or more → you (or Copilot) pick one.
   - 0 → you're asked for the ports, which it then re-probes.
3. **Attach.** Only *after* a browser is selected does the extension point playwright-mcp at it. Until then nothing is connected, so Copilot can't attach to the wrong window.

**Using different ports.** If your framework launches Chrome on other ports, set the `QA_DEBUG_CDP_PORTS` environment variable (comma-separated, e.g. `QA_DEBUG_CDP_PORTS=9222,9223`) before launching VS Code. No spec, `.mocharc`, or launch-flag edits needed.

> The old `QA_DEBUG_CDP_WS_URL` variable is gone. If you still have it set, the tool warns once on startup; switch to `QA_DEBUG_CDP_PORTS` instead.

In short: **probe ports → pick a browser → attach.** No hard-coded URLs, and it re-discovers on every pause, so a restarted browser just works.

---

## Need help?

Ping your test lead, or open an issue at **https://github.com/korakiad/extension-selfhealing/issues**.
