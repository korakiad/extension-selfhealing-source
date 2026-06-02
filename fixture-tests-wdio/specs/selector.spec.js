// Deterministic-fail wdio spec — clicks an element that doesn't exist.
// v5.16 — variant A (single chrome at port 22135).
// Mocha-launched chrome simulates the consumer-framework launch pattern;
// wdio attaches via `goog:chromeOptions.debuggerAddress` (no wdio.remote()
// self-launch). qa-hooks' Mode C discovery finds this chrome at /json/version.

const path = require('node:path');
const url = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const ChromeLauncher = require('chrome-launcher');
const wdio = require('webdriverio');

const PORT = 22135;
const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('Mode C wdio fixture — selector not found (port 22135)', function () {
  this.timeout(30_000);

  let chrome;
  let browser;

  before(async function () {
    chrome = await ChromeLauncher.launch({
      port: PORT,
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    });
    // chrome-launcher returns before /json/version is up; poll briefly.
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/json/version`);
        if (res.ok) break;
      } catch {}
      await sleep(250);
    }
    browser = await wdio.remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': { debuggerAddress: `localhost:${PORT}` },
      },
    });
  });

  after(async function () {
    try { if (browser) await browser.deleteSession(); } catch {}
    try { if (chrome) await chrome.kill(); } catch {}
  });

  it('clicks #login-btn (fixed)', async function () {
    await browser.url(siteUrl);
    const el = await browser.$('#login-btnxx');
    await el.click();
  });
});
