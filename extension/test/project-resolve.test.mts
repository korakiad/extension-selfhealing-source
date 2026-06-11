/**
 * Unit test for project-resolve — CWD/mocha-entry resolution + anchored --grep
 * synthesis (extracted from session-manager).
 *
 * Run from the extension dir:
 *   node --import tsx test/project-resolve.test.mts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildAlternationGrep,
  findProjectRoot,
  resolveCwd,
  resolveMochaEntry,
} from '../src/project-resolve.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const root = mkdtempSync(path.join(tmpdir(), 'qa-debug-resolve-'));
const touch = (...rel: string[]): string => {
  const p = path.join(root, ...rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, '');
  return p;
};

try {
  check('grep: single full title is anchored, regex chars escaped', () => {
    const grep = buildAlternationGrep({
      topLevelSuiteTitles: [],
      fullTitles: ['suite test (1+1)'],
      describePrefixes: [],
    });
    assert.equal(grep, '^suite test \\(1\\+1\\)$');
    assert.match('suite test (1+1)', new RegExp(grep));
    assert.doesNotMatch('suite test (1+1) extra', new RegExp(grep));
  });

  check('grep: describe prefix selects children but not sibling prefix-substring suites', () => {
    const grep = buildAlternationGrep({
      topLevelSuiteTitles: ['login'],
      fullTitles: [],
      describePrefixes: ['login'],
    });
    const re = new RegExp(grep);
    assert.match('login accepts a user', re);
    assert.doesNotMatch('login-v2 accepts a user', re);
  });

  check('findProjectRoot: .mocharc wins over package.json on the walk up', () => {
    touch('proj', 'package.json');
    touch('proj', 'sub', '.mocharc.cjs');
    const specDir = path.join(root, 'proj', 'sub', 'build', 'test');
    mkdirSync(specDir, { recursive: true });
    assert.equal(findProjectRoot(specDir, root), path.join(root, 'proj', 'sub'));
  });

  check('findProjectRoot: respects the boundary (no marker → null)', () => {
    const bare = path.join(root, 'bare', 'deep');
    mkdirSync(bare, { recursive: true });
    assert.equal(findProjectRoot(bare, path.join(root, 'bare')), null);
  });

  check('resolveCwd: spec file → nearest project root; no specs → workspaceRoot', () => {
    const spec = touch('proj', 'sub', 'build', 'test', 'a.spec.js');
    assert.equal(resolveCwd([spec], root), path.join(root, 'proj', 'sub'));
    // `root` has no fixture-tests dir → falls back to workspaceRoot itself.
    assert.equal(resolveCwd([], root), root);
  });

  check('resolveCwd: no specs prefers <workspaceRoot>/fixture-tests when present', () => {
    const ws = path.join(root, 'with-fixtures');
    mkdirSync(path.join(ws, 'fixture-tests'), { recursive: true });
    assert.equal(resolveCwd([], ws), path.join(ws, 'fixture-tests'));
  });

  check('resolveMochaEntry: finds mocha.js up the node_modules walk; throws when absent', () => {
    const entry = touch('proj', 'node_modules', 'mocha', 'bin', 'mocha.js');
    assert.equal(resolveMochaEntry(path.join(root, 'proj', 'sub'), path.join(root, 'proj')), entry);
    assert.throws(
      () => resolveMochaEntry(path.join(root, 'bare'), path.join(root, 'bare')),
      /Could not find the mocha package/,
    );
  });

  console.log(`\nproject-resolve unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nproject-resolve unit test FAILED ❌');
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
