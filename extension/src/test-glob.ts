/**
 * Test-file discovery globs — the single knob that decides which compiled test
 * files appear in the Test Explorer and are watched for changes.
 *
 * Backed by the transparent `qaDebug.testMatch` setting (contributes.configuration
 * in package.json) so the QA can point discovery at their own compiled-output
 * location / suffix WITHOUT editing any Mocha config or adding a file to the
 * consumer's repo — set it at the User (global) scope and the consumer folder is
 * never touched. Accepts a single glob string or an array of them. Read fresh on
 * each call so a settings change takes effect once the watcher + tree are rebuilt
 * (see extension.ts onDidChangeConfiguration).
 *
 * Default covers the common layout `{build,dist}/{e2e,test,tests}/**` (all `.js`,
 * incl. plain unsuffixed test files — safe because those folders are test-only)
 * plus self-labeled `*.{spec,test,e2e}.js` anywhere under build/dist. Existing
 * `.spec.js` consumers keep working; plain-`.js`-in-a-test-folder consumers work
 * with no config at all.
 *
 * NB: match compiled `.js`, not `.ts` sources — Mocha runs the JS, and matching
 * the TS would create duplicate tree items with no runtime full-title id.
 */
import * as vscode from 'vscode';

export const TEST_MATCH_SECTION = 'qaDebug';
export const TEST_MATCH_KEY = 'testMatch';
/** Dotted id for onDidChangeConfiguration().affectsConfiguration() checks. */
export const TEST_MATCH_CONFIG_ID = `${TEST_MATCH_SECTION}.${TEST_MATCH_KEY}`;

/** Used when the setting is unset/blank. Mirror in package.json's `default`. */
export const DEFAULT_TEST_MATCH: readonly string[] = [
  // Every .js under a test-only folder → catches .spec/.test/.e2e AND plain .js.
  '{build,dist}/{e2e,test,tests}/**/*.js',
  // Self-labeled suffixes anywhere under build/dist (back-compat + stray layouts).
  '{build,dist}/**/*.{spec,test,e2e}.js',
];

/** Files under node_modules never count as tests. */
export const TEST_MATCH_EXCLUDE = '**/node_modules/**';

/** Current discovery globs from settings, falling back to the default when blank. */
export function getTestMatchGlobs(): string[] {
  const raw = vscode.workspace
    .getConfiguration(TEST_MATCH_SECTION)
    .get<string | string[]>(TEST_MATCH_KEY);
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const cleaned = list
    .map((g) => (typeof g === 'string' ? g.trim() : ''))
    .filter((g) => g.length > 0);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_TEST_MATCH];
}
