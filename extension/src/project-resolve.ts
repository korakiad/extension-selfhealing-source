/**
 * Pure project-layout resolution for the mocha run: where to spawn the child
 * (CWD), which mocha JS entry to run, and how the test selection turns into an
 * anchored `--grep`. No vscode imports — unit-testable as plain functions
 * (see test/project-resolve.test.mts).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { RunSelection } from './test-controller.js';

/** MDN-canonical regex metachar escape — used by buildAlternationGrep. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Synthesizes `--grep <regex>` such that:
 *  - Each top-level suite title is its own anchored alternative (`^T$`) — this
 *    satisfies consumer test-framework wrappers (`@tr/mocha-runner-hooks` and
 *    friends) whose sniffer tests `--grep` against `this.suite.suites[].title`
 *    only and would otherwise log `NO TEST CASES MATCHED`. No test's
 *    `fullTitle()` equals a top-level title alone (tests have nested titles)
 *    so this alt doesn't over-select.
 *  - Each full title is anchored (`^F$`) — exact match, no sibling leakage.
 *  - Each describe prefix becomes `^P(?:$| )` — runs every test under that
 *    describe but not under sibling describes whose names start with the
 *    same prefix substring.
 * All inputs are regex-escaped per MDN guidance.
 */
export function buildAlternationGrep(selection: RunSelection): string {
  const alts: string[] = [];
  for (const t of selection.topLevelSuiteTitles) alts.push(`^${escapeRegex(t)}$`);
  for (const f of selection.fullTitles) alts.push(`^${escapeRegex(f)}$`);
  for (const p of selection.describePrefixes) alts.push(`^${escapeRegex(p)}(?:$| )`);
  return alts.length === 1 ? alts[0] : `(?:${alts.join('|')})`;
}

/**
 * Walks upward from `startDir` (inclusive) until it finds a directory that
 * contains a `.mocharc.*` config file or `package.json`. Stops at `boundary`
 * (inclusive). Returns the directory path, or null if nothing was found.
 *
 * Why `.mocharc.*` first: mocha config is the strongest signal that a
 * directory is the intended test-project root. `package.json` is a softer
 * fallback for repos that pass mocha options via CLI / wdio config and don't
 * keep a separate `.mocharc`.
 */
export function findProjectRoot(startDir: string, boundary: string): string | null {
  const mochaRcNames = [
    '.mocharc.cjs',
    '.mocharc.js',
    '.mocharc.mjs',
    '.mocharc.json',
    '.mocharc.jsonc',
    '.mocharc.yaml',
    '.mocharc.yml',
    '.mocharcrc',
  ];
  const norm = (p: string) => path.resolve(p);
  const boundaryNorm = norm(boundary);
  let cur = norm(startDir);
  // Walk only within the boundary subtree.
  while (cur.startsWith(boundaryNorm)) {
    for (const name of mochaRcNames) {
      if (existsSync(path.join(cur, name))) return cur;
    }
    if (existsSync(path.join(cur, 'package.json'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * CWD selection:
 *  - If specFiles[] non-empty: walk UP from the first spec file looking for the
 *    nearest `.mocharc.*` (or `package.json` as a fallback project marker),
 *    stopping at workspaceRoot. Use that dir if found, else workspaceRoot.
 *    This matters because consumer `.mocharc.cjs` files typically reference
 *    paths relative to the project root (e.g. `node_modules/@tr/.../runnerCore.js`)
 *    and mocha resolves them against CWD. Earlier behavior used
 *    `path.dirname(spec)` which for layouts like `<root>/build/test/*.spec.js`
 *    pointed at `<root>/build/test/`, where `node_modules/...` doesn't exist
 *    — mocha then exited with "No test file(s) found".
 *  - Else if `<workspaceRoot>/fixture-tests` exists: legacy demo flow.
 *  - Else: workspaceRoot.
 */
export function resolveCwd(specFiles: readonly string[], workspaceRoot: string): string {
  if (specFiles.length > 0) {
    const found = findProjectRoot(path.dirname(specFiles[0]), workspaceRoot);
    return found ?? workspaceRoot;
  }
  const fixtureDir = path.join(workspaceRoot, 'fixture-tests');
  if (existsSync(fixtureDir)) {
    return fixtureDir;
  }
  return workspaceRoot;
}

/**
 * Look in the chosen CWD's node_modules first, then walk up two levels
 * (works for typical monorepo layouts: cwd/node_modules, cwd/../node_modules,
 * cwd/../../node_modules), then workspaceRoot.
 *
 * Resolve mocha's JS entry (bin/mocha.js on mocha ≥9, bin/mocha on ≤8) —
 * NOT the node_modules/.bin/mocha shim. On Windows that shim is an
 * extensionless sh script CreateProcess can't run (spawn ENOENT even
 * though the file exists), and the .cmd variant can't carry the
 * stdio[3] IPC pipe through cmd.exe.
 */
export function resolveMochaEntry(cwd: string, workspaceRoot: string): string {
  const bases = [cwd, path.join(cwd, '..'), path.join(cwd, '..', '..'), workspaceRoot];
  for (const base of bases) {
    for (const entry of ['mocha.js', 'mocha']) {
      const c = path.join(base, 'node_modules', 'mocha', 'bin', entry);
      if (existsSync(c)) return c;
    }
  }
  throw new Error(
    `Could not find the mocha package near ${cwd} or ${workspaceRoot}. ` +
      `Did the user's project install mocha?`,
  );
}
