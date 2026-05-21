// Minimal .mocharc — NO `require:` / `reporter:` entries, intentionally.
// The QA Debug Companion extension injects --require + --reporter via CLI
// flags resolved to absolute bundled paths per ARCHITECTURE-CR-v5.2 §2.1.
// User .mocharc.cjs needs only spec patterns + timeout — transparent use.
module.exports = {
  spec: ['specs/**/*.spec.js'],
  timeout: 15_000,
};
