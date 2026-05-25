// Deterministic-fail wdio spec — waits for an element that never appears.
// v5.16 PLAN-cdp-port-discovery — variant B (two chromes: 22135 + 22136).
// Verifies multi-chrome askUser flow (smoke paths 2 + 2b). qa-hooks discovery
// publishes both; selection comes via agent (qa_select_chrome) OR extension
// status-bar QuickPick.

const path = require('node:path');
const url = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const ChromeLauncher = require('chrome-launcher');
const wdio = require('webdriverio');

const PORTS = [22135, 22136];
const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('Mode C wdio fixture — timeout (ports 22135 + 22136)', function () {
  this.timeout(30_000);

  const chromes = [];
  let browser;

  before(async function () {
    for (const port of PORTS) {
      const c = await ChromeLauncher.launch({
        port,
        chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
      });
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch(`http://localhost:${port}/json/version`);
          if (res.ok) break;
        } catch {}
        await sleep(250);
      }
      chromes.push(c);
    }
    // Attach wdio to the first chrome; the second exists so discovery sees two.
    browser = await wdio.remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': { debuggerAddress: `localhost:${PORTS[0]}` },
      },
    });
  });

  after(async function () {
    try { if (browser) await browser.deleteSession(); } catch {}
    for (const c of chromes) {
      try { await c.kill(); } catch {}
    }
  });

  it('finds .visible-late within 1s (deterministic fail — element is display:none)', async function () {
    await browser.url(siteUrl);
    const el = await browser.$('.visible-late');
    await el.waitForDisplayed({ timeout: 1_000, reverse: true });
  });
});
