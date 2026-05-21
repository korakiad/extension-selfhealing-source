// Deterministic-fail wdio spec — clicks an element that doesn't exist.

const path = require("node:path");
const url = require("node:url");
const wdio = require("webdriverio");

const siteUrl = url
  .pathToFileURL(path.resolve(__dirname, "..", "site", "index.html"))
  .toString();

describe("Mode A wdio fixture — selector not found", function () {
  this.timeout(15_000);

  let browser;

  before(async function () {
    browser = await wdio.remote({
      logLevel: "warn",
      capabilities: { browserName: "chrome" },
    });
  });

  after(async function () {
    if (browser) await browser.deleteSession();
  });

  it("clicks #login-btn (fixed)", async function () {
    await browser.url(siteUrl);
    const el = await browser.$("#login-btnxx");
    // Click the existing login button.
    await el.click();
  });
});
