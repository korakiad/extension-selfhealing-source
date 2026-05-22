// Deterministic-fail wdio spec — waits for an element that never appears.
// Uses NON-destructured `wdio.remote()` form so Mode A engagement works per
// ARCHITECTURE-CR-v5.2 §2.5. Destructured `const { remote } = require(...)`
// would silently fall to Mode B.

const path = require('node:path');
const url = require('node:url');
const assert = require('node:assert');
const wdio = require('webdriverio');

const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('Mode A wdio fixture — timeout', function () {
  this.timeout(15_000);

  let browser;

  before(async function () {
    browser = await wdio.remote({
      logLevel: 'warn',
      capabilities: { browserName: 'chrome' },
    });
  });

  after(async function () {
    if (browser) await browser.deleteSession();
  });

  it('finds .visible-late within 1s (deterministic fail — element is display:none)', async function () {
    await browser.url(siteUrl);
    const el = await browser.$('.visible-late');
    // We expect the element to remain hidden, so we wait for exactly that.
    await el.waitForDisplayed({ timeout: 1_000, reverse: true });
  });
});
