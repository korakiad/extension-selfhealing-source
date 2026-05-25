// Deterministic-fail wdio spec — asserts wrong product version.
// v5.16 PLAN-cdp-port-discovery — variant C (chrome at port 23000, outside
// the default [22135, 22136] discovery set). Smoke path 3: pause publishes
// available_chromes: []; user supplies port via extension input box, then
// qa_discover_chromes re-probes.

const path = require('node:path');
const url = require('node:url');
const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const ChromeLauncher = require('chrome-launcher');
const wdio = require('webdriverio');

const PORT = 23000;
const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('Mode C wdio fixture — value mismatch (port 23000, askUser path)', function () {
  this.timeout(30_000);

  let chrome;
  let browser;

  before(async function () {
    chrome = await ChromeLauncher.launch({
      port: PORT,
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    });
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

  it('reads product name (deterministic fail — site shows v3.2, assertion expects v4.0)', async function () {
    await browser.url(siteUrl);
    const text = await browser.$('.product-name').getText();
    assert.strictEqual(text, 'WidgetPro v4.0', 'product version banner regressed');
  });
});
