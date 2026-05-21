#!/usr/bin/env node
// Snapshot integration test for ARCHITECTURE v5 §3.6.
// Runs the oracle against the three fixture tests with the canonical decision
// sequence (mark_passed, give_up, retry) and diffs the qa-reporter stdout
// (ANSI-stripped, oracle stderr-stripped) against
// fixture-tests/snapshots/s2-3-decision-tally.txt.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const SNAPSHOT = resolve(REPO, 'fixture-tests', 'snapshots', 's2-3-decision-tally.txt');

const ANSI = /\x1b\[[0-9;]*m/g;
const ORACLE_LINE = /^\[oracle\] .*$/gm;

function normalize(s: string): string {
  return s.replace(ANSI, '').replace(ORACLE_LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function run(): { stdout: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tools/oracle.ts',
      '--decisions',
      'mark_passed,give_up,retry',
      '--tests',
      'specs/**/*.spec.js',
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  // Reporter writes to stdout; oracle [oracle] logs to stderr.
  return { stdout: result.stdout, status: result.status };
}

const { stdout, status } = run();
const actual = normalize(stdout);
const expected = readFileSync(SNAPSHOT, 'utf8').trimEnd() + '\n';

if (actual === expected) {
  process.stderr.write(`[snapshot] OK — reporter output matches ${SNAPSHOT}\n`);
  process.stderr.write(`[snapshot] reporter exit code: ${status}\n`);
  process.exit(0);
}

process.stderr.write(`[snapshot] FAIL — reporter output diverged from ${SNAPSHOT}\n\n`);
process.stderr.write(`--- expected\n${expected}\n--- actual\n${actual}\n`);
process.exit(1);
