// Pre-implementation spike per PLAN-cdp-port-discovery.md §"Pre-implementation spike".
// Verifies wdio (attach mode via debuggerAddress) and puppeteer-core can coexist as
// concurrent CDP clients on the same Chrome under read AND active commands.
//
// Verdict gates:
//   Pass — no errors, both puppeteer-core commands observed, wdio resumes cleanly,
//          chrome stderr contains no CDP-channel errors → unblocks Task #3 implementation.
//   Fail — any wdio resume error, OR any chrome CDP error, OR puppeteer active throws
//          → blocks PLAN, requires new CR.

const path = require('node:path');
const url = require('node:url');
const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const ChromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer-core');
const wdio = require('webdriverio');

const PORT = 22135;
const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('CDP coexistence spike — wdio + puppeteer-core on same Chrome', function () {
  this.timeout(60_000);

  let chrome;
  let browser; // wdio
  let puppeteerBrowser;
  const chromeStderr = [];

  before(async function () {
    // Step 1: launch chrome via chrome-launcher with fixed remote-debugging-port
    chrome = await ChromeLauncher.launch({
      port: PORT,
      chromeFlags: [
        '--enable-logging',
        '--v=1',
        // headless still exposes /json/version + accepts CDP
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
    // Capture chrome stderr so we can grep for CDP errors in step 5.
    if (chrome.process && chrome.process.stderr) {
      chrome.process.stderr.on('data', (chunk) => {
        chromeStderr.push(chunk.toString());
      });
    }
    process.stderr.write(`[spike] chrome launched pid=${chrome.pid} port=${chrome.port}\n`);
    // Settle: poll /json/version until ready (chrome-launcher returns slightly before /json is up).
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/json/version`);
        if (res.ok) break;
      } catch {}
      await sleep(250);
    }
  });

  after(async function () {
    try { if (puppeteerBrowser) await puppeteerBrowser.disconnect(); } catch {}
    try { if (browser) await browser.deleteSession(); } catch {}
    try { if (chrome) await chrome.kill(); } catch {}
  });

  it('step 2 — wdio attach mode connects', async function () {
    browser = await wdio.remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          debuggerAddress: `localhost:${PORT}`,
        },
      },
    });
    await browser.url(siteUrl);
    const title = await browser.getTitle();
    process.stderr.write(`[spike] wdio session attached; page title="${title}"\n`);
    assert.ok(typeof title === 'string', 'wdio should report a title from the fixture');
  });

  it('step 3 — puppeteer-core connects via /json/version and runs read+active commands', async function () {
    const versionRes = await fetch(`http://localhost:${PORT}/json/version`);
    const versionJson = await versionRes.json();
    const wsEndpoint = versionJson.webSocketDebuggerUrl;
    assert.ok(wsEndpoint, '/json/version must expose webSocketDebuggerUrl');
    process.stderr.write(`[spike] /json/version webSocketDebuggerUrl=${wsEndpoint}\n`);

    puppeteerBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const pages = await puppeteerBrowser.pages();
    assert.ok(pages.length >= 1, 'puppeteer-core must see at least the wdio-opened page');
    const page = pages[0];

    // READ command — get current URL via puppeteer (mirrors browser_snapshot intent)
    const readUrl = await page.url();
    process.stderr.write(`[spike] puppeteer read page.url()=${readUrl}\n`);
    assert.ok(readUrl.includes('index.html'), 'puppeteer should see the wdio-opened page URL');

    // ACTIVE command — navigate to about:blank then back
    await page.goto('about:blank', { waitUntil: 'load' });
    const afterNav = await page.url();
    process.stderr.write(`[spike] puppeteer active page.goto → ${afterNav}\n`);
    assert.strictEqual(afterNav, 'about:blank', 'puppeteer navigate should succeed');

    // Restore page for wdio resume test
    await page.goto(siteUrl, { waitUntil: 'load' });
  });

  it('step 4 — wdio session resumes cleanly after puppeteer active command', async function () {
    let resumeError = null;
    try {
      // Issue a fresh wdio command — must not throw session closed / target not found.
      await browser.url(siteUrl);
      const elemExists = await browser.$('body').isExisting();
      assert.ok(elemExists, 'wdio should still see DOM after puppeteer activity');
      process.stderr.write(`[spike] wdio resumed; body exists=${elemExists}\n`);
    } catch (err) {
      resumeError = err;
    }
    assert.strictEqual(resumeError, null, `wdio resume must not throw — got: ${resumeError?.message}`);
  });

  it('step 5 — chrome stderr has no CDP-channel errors', async function () {
    const log = chromeStderr.join('');
    // Heuristic patterns indicating CDP-level disruption.
    const badPatterns = [
      /Devtools client error/i,
      /Target closed unexpectedly/i,
      /Protocol error.*invalid session/i,
      /Failed to dispatch CDP/i,
    ];
    const hits = badPatterns
      .map((re) => ({ re: re.toString(), match: log.match(re)?.[0] }))
      .filter((h) => h.match);
    if (hits.length > 0) {
      process.stderr.write(`[spike] chrome stderr contained CDP-error pattern hits: ${JSON.stringify(hits, null, 2)}\n`);
    }
    assert.strictEqual(hits.length, 0, `chrome stderr must not contain CDP-channel errors — hits=${hits.length}`);
  });
});
