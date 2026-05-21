// Deterministic-fail wdio spec — asserts wrong product version.

const path = require('node:path');
const url = require('node:url');
const assert = require('node:assert');
const wdio = require('webdriverio');

const siteUrl = url.pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).toString();

describe('Mode A wdio fixture — value mismatch', function () {
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

  it('reads product name (deterministic fail — site shows v3.2, assertion expects v4.0)', async function () {
    await browser.url(siteUrl);
    const text = await browser.$('.product-name').getText();
    assert.strictEqual(text, 'WidgetPro v4.0', 'product version banner regressed');
  });
});
