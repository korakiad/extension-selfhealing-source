/**
 * Unit tests for the pure TestRail modules: the prefix-tolerant body parser
 * (src/testrail/parse.ts) + the endpoint guard (src/testrail/endpoint.ts).
 *
 * Run from the extension dir:
 *   node --import tsx test/testrail-parse.test.mts
 */
import assert from 'node:assert/strict';
import path from 'node:path';

import { parseTestRailBody, splitGherkin, TestRailParseError } from '../src/testrail/parse.ts';
import {
  classifyVerb,
  isContained,
  isUnsupportedPost,
  sanitizeAttachmentId,
  stripPagingParams,
  validateEndpointSyntax,
} from '../src/testrail/endpoint.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// ---- parseTestRailBody ------------------------------------------------------

check('plain JSON object fast path', () => {
  const r = parseTestRailBody('{"id":1,"title":"x"}');
  assert.deepEqual(r.data, { id: 1, title: 'x' });
  assert.equal(r.prefix, null);
  assert.equal(r.suffix, null);
});

check('plain JSON array fast path', () => {
  const r = parseTestRailBody('[{"id":1}]');
  assert.deepEqual(r.data, [{ id: 1 }]);
});

check('observed gateway shape: PREFIX{...}', () => {
  const r = parseTestRailBody('USERAUTHENSUCESSFULLY{"id":7,"name":"run"}');
  assert.deepEqual(r.data, { id: 7, name: 'run' });
  assert.equal(r.prefix, 'USERAUTHENSUCESSFULLY');
  assert.equal(r.suffix, null);
  assert.equal(r.ambiguousExtents, undefined);
});

check('prefixed array: PREFIX[...]', () => {
  const r = parseTestRailBody('TOKEN[1,2,3]');
  assert.deepEqual(r.data, [1, 2, 3]);
  assert.equal(r.prefix, 'TOKEN');
});

check('prefix containing braces (inline-JS HTML) does not derail the scan', () => {
  const r = parseTestRailBody('<script>var a = {x:1, y:[2]};</script>{"ok":true}');
  assert.deepEqual(r.data, { ok: true });
  assert.ok(r.prefix?.includes('<script>'));
});

check('JSON-shaped envelope PREFIX: payload (end-of-input) wins', () => {
  const r = parseTestRailBody('{"status":"OK"}{"id":1,"cases":[]}');
  assert.deepEqual(r.data, { id: 1, cases: [] });
  assert.equal(r.prefix, '{"status":"OK"}');
  assert.equal(r.ambiguousExtents?.length, 2);
});

check('PINNED LIMIT (PLAN-testrail D6): JSON-shaped SUFFIX mis-selects the trailer + flags ambiguity', () => {
  const r = parseTestRailBody('{"id":1}{"txn":"abc"}');
  assert.deepEqual(r.data, { txn: 'abc' }); // documented mis-selection; revisit on gateway evidence
  assert.equal(r.ambiguousExtents?.length, 2);
});

check('trailing text garbage: parse succeeds, suffix captured', () => {
  const r = parseTestRailBody('{"id":1}TXN-9C2');
  assert.deepEqual(r.data, { id: 1 });
  assert.equal(r.suffix, 'TXN-9C2');
});

check('prefix AND suffix', () => {
  const r = parseTestRailBody('TOKEN{"a":1}EPILOGUE');
  assert.deepEqual(r.data, { a: 1 });
  assert.equal(r.prefix, 'TOKEN');
  assert.equal(r.suffix, 'EPILOGUE');
});

check('braces inside string literals do not close the extent', () => {
  const r = parseTestRailBody('X{"steps":"do { not } trip \\" on this ]"}');
  assert.deepEqual(r.data, { steps: 'do { not } trip " on this ]' });
});

check('nested JSON is not reported as ambiguous', () => {
  const r = parseTestRailBody('TOKEN{"a":{"b":[1,2]}}');
  assert.deepEqual(r.data, { a: { b: [1, 2] } });
  assert.equal(r.ambiguousExtents, undefined);
});

check('BOM + leading whitespace', () => {
  const r = parseTestRailBody('﻿\n  {"a":1}');
  assert.deepEqual(r.data, { a: 1 });
});

check('empty body → data null', () => {
  assert.deepEqual(parseTestRailBody(''), { data: null, prefix: null, suffix: null });
  assert.deepEqual(parseTestRailBody('  \n '), { data: null, prefix: null, suffix: null });
});

check('UTF-8 content (Thai) survives', () => {
  const r = parseTestRailBody('TOKEN{"title":"ทดสอบระบบ {จริง}"}');
  assert.deepEqual(r.data, { title: 'ทดสอบระบบ {จริง}' });
});

check('HTML error page → TestRailParseError with SSO hint', () => {
  assert.throws(
    () => parseTestRailBody('<!DOCTYPE html><html><head><title>SSO Login</title>'),
    (err: unknown) =>
      err instanceof TestRailParseError && err.hint === 'looks like a gateway/SSO login page',
  );
});

check('gateway-token-only body → TestRailParseError, no hint', () => {
  assert.throws(
    () => parseTestRailBody('USERAUTHENFAILED'),
    (err: unknown) => err instanceof TestRailParseError && err.hint === undefined,
  );
});

check('hostile many-brace input hits the work cap (bounded, throws)', () => {
  const hostile = '{'.repeat(60_000);
  const started = Date.now();
  assert.throws(
    () => parseTestRailBody(hostile),
    (err: unknown) => err instanceof TestRailParseError && err.hint === 'scan work cap exceeded',
  );
  assert.ok(Date.now() - started < 5_000, 'must fail fast, not hang');
});

check('large legitimate prefixed body still parses (body-length-aware cap)', () => {
  const big = 'TOKEN' + JSON.stringify({ cases: Array.from({ length: 20_000 }, (_, i) => ({ id: i, t: 'case' })) });
  const r = parseTestRailBody(big);
  assert.equal((r.data as { cases: unknown[] }).cases.length, 20_000);
});

// ---- splitGherkin (get_bdd route) ------------------------------------------

check('same-line glued gateway prefix splits at Feature:', () => {
  const r = splitGherkin('USERAUTHENSUCESSFULLYFeature: login\n  Scenario: ok');
  assert.ok(r);
  assert.equal(r.prefix, 'USERAUTHENSUCESSFULLY');
  assert.ok(r.text.startsWith('Feature: login'));
});

check('comment/tag lines are not split anchors; JSON docstring stays intact', () => {
  const body = 'TOKENFeature: x\n# a comment\n@smoke\nScenario: s\n"""\n{"a":1}\n"""';
  const r = splitGherkin(body);
  assert.ok(r);
  assert.ok(r.text.includes('# a comment'));
  assert.ok(r.text.includes('@smoke'));
  assert.ok(r.text.includes('{"a":1}'));
});

check('# language: directive is an opener', () => {
  const r = splitGherkin('GATEWAY# language: th\nFeature: x');
  assert.ok(r);
  assert.ok(r.text.startsWith('# language: th'));
});

check('no opener anywhere → null (caller must PARSE_ERROR, never return raw bytes)', () => {
  assert.equal(splitGherkin('USERAUTHENSUCESSFULLY'), null);
  assert.equal(splitGherkin('<html>nope</html>'), null);
});

// ---- endpoint guard ----------------------------------------------------------

check('classifyVerb: complete GET surface', () => {
  assert.equal(classifyVerb('get_cases/3&suite_id=8'), 'read');
  assert.equal(classifyVerb('run_report/42'), 'read');
  assert.equal(classifyVerb('run_cross_project_report/7'), 'read');
});

check('classifyVerb: write verbs incl. move/copy/close', () => {
  for (const e of ['add_run/1', 'update_cases/1', 'delete_project/3', 'close_plan/9', 'move_section/5', 'copy_cases_to_section/2']) {
    assert.equal(classifyVerb(e), 'write', e);
  }
});

check('classifyVerb: typo → unknown (not bounced to the other tool)', () => {
  assert.equal(classifyVerb('gett_cases/3'), 'unknown');
  assert.equal(classifyVerb('run_reportx/3'), 'unknown');
});

check('add_bdd is the deny-set', () => {
  assert.equal(isUnsupportedPost('add_bdd/12'), true);
  assert.equal(isUnsupportedPost('add_case/12'), false);
});

check('validateEndpointSyntax rejects injection shapes', () => {
  for (const bad of ['http://evil/x', '/get_cases/1', 'get cases/1', 'get_cases/1#frag', 'get_cases/1?x=1', '../etc&x=1', 'get_cases/../1', '']) {
    assert.throws(() => validateEndpointSyntax(bad), /INVALID_ENDPOINT|endpoint/, bad);
  }
});

check('validateEndpointSyntax allows legit shapes incl. ".." in filter values', () => {
  for (const ok of ['get_cases/3&suite_id=8&limit=50', 'get_cases/3&filter=1..5', 'add_result_for_case/81/1234', 'get_cases/3&filter=login%20page']) {
    validateEndpointSyntax(ok);
  }
});

check('stripPagingParams removes caller offset/limit, keeps the rest', () => {
  assert.equal(stripPagingParams('get_cases/3&offset=500&suite_id=8&limit=250'), 'get_cases/3&suite_id=8');
  assert.equal(stripPagingParams('get_cases/3'), 'get_cases/3');
});

check('sanitizeAttachmentId: UUIDs keep hyphens; separators stripped; empty → fallback', () => {
  assert.equal(sanitizeAttachmentId('2ec27be4-812f-4b3a'), '2ec27be4-812f-4b3a');
  assert.equal(sanitizeAttachmentId('abc/def'), 'abcdef');
  assert.equal(sanitizeAttachmentId('../..'), 'attachment');
});

check('isContained: normal + prefix-boundary + root-itself', () => {
  assert.equal(isContained('/ws', '/ws/sub/f.png'), true);
  assert.equal(isContained('/ws', '/ws-evil/f.png'), false, 'prefix-boundary bug');
  assert.equal(isContained('/ws', '/etc/passwd'), false);
  assert.equal(isContained('/ws', '/ws'), false, 'the root itself is not a file');
});

check('isContained: Windows cross-drive hole is closed (isAbsolute check)', () => {
  assert.equal(isContained('C:\\ws', 'D:\\secrets\\f.txt', path.win32), false);
  assert.equal(isContained('C:\\ws', 'C:\\ws\\shot.png', path.win32), true);
});

console.log(`\ntestrail-parse: ${passed} checks passed`);
