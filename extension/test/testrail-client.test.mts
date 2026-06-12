/**
 * Unit tests for TestRailClient (src/testrail/client.ts) against a local HTTP
 * stub that emits company-gateway-prefixed bodies. No network, no vscode.
 *
 * Run from the extension dir:
 *   node --import tsx test/testrail-client.test.mts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { TestRailClient } from '../src/testrail/client.ts';

const PREFIX = 'USERAUTHENSUCESSFULLY';
const logLines: string[] = [];
const tmpAttach = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-attach-'));
const sleeps: number[] = [];

type Handler = (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
const requests: string[] = [];

const server = http.createServer((req, res) => {
  requests.push(req.url ?? '');
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => handler(req, Buffer.concat(chunks), res));
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const client = new TestRailClient(
  { baseUrl: `http://127.0.0.1:${port}`, username: 'qa@example.com', apiKey: 'KEY123' },
  {
    log: (l) => logLines.push(l),
    attachmentsDir: () => tmpAttach,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  },
);

let passed = 0;
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  requests.length = 0;
  sleeps.length = 0;
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const endpointOf = (url: string): string => url.split('/api/v2/')[1] ?? '';

await check('auth header + Content-Type sent on GET; URL composed with & not ?', async () => {
  handler = (req, _body, res) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('qa@example.com:KEY123').toString('base64'));
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.url, '/index.php?/api/v2/get_cases/3&suite_id=8');
    res.end(`${PREFIX}{"offset":0}`);
  };
  const r = await client.getJson('get_cases/3&suite_id=8');
  assert.equal(r.status, 200);
});

await check('prefixed body parses; NO gateway bytes in the resolved response (booleans only)', async () => {
  handler = (_req, _body, res) => res.end(`${PREFIX}{"id":7,"title":"run"}`);
  const r = await client.getJson('get_run/7');
  assert.deepEqual(r.data, { id: 7, title: 'run' });
  assert.equal(r.hadPrefix, true);
  assert.equal(r.hadSuffix, false);
  assert.ok(!JSON.stringify(r).includes(PREFIX), 'gateway bytes leaked into the response object');
  assert.ok(logLines.some((l) => l.includes('gateway prefix')), 'prefix must be logged');
});

await check('paginate: recompose locally, strip caller offset/limit, never fetch _links.next', async () => {
  handler = (req, _body, res) => {
    const ep = endpointOf(req.url ?? '');
    if (!ep.includes('offset=')) {
      assert.equal(ep, 'get_cases/3&suite_id=8', 'caller offset/limit must be stripped');
      res.end(`${PREFIX}{"offset":0,"limit":2,"size":2,"_links":{"next":"http://127.0.0.1:1/evil&offset=2","prev":null},"cases":[{"id":1},{"id":2}]}`);
    } else {
      assert.ok(ep.startsWith('get_cases/3&suite_id=8&offset=2&limit=250'), `unexpected page-2 endpoint: ${ep}`);
      res.end(`${PREFIX}{"offset":2,"limit":250,"size":1,"_links":{"next":null,"prev":"x"},"cases":[{"id":3}]}`);
    }
  };
  const r = await client.getJson('get_cases/3&offset=99&suite_id=8&limit=7', { paginate: true });
  const data = r.data as { cases: Array<{ id: number }> };
  assert.deepEqual(data.cases.map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(r.paginated, { pages: 2, truncated: false, truncatedBy: undefined });
  assert.ok(requests.every((u) => !u.includes('evil')), 'client must never fetch the _links.next URL');
});

await check('paginate: bare-array endpoint degrades to single page', async () => {
  handler = (_req, _body, res) => res.end(`${PREFIX}[{"id":1,"name":"High"}]`);
  const r = await client.getJson('get_priorities', { paginate: true });
  assert.deepEqual(r.data, [{ id: 1, name: 'High' }]);
  assert.deepEqual(r.paginated, { pages: 1, truncated: false });
});

await check('429: integer Retry-After honored (capped), single retry succeeds', async () => {
  let calls = 0;
  handler = (_req, _body, res) => {
    if (++calls === 1) {
      res.writeHead(429, { 'retry-after': '2' });
      res.end();
    } else res.end('{"ok":1}');
  };
  const r = await client.getJson('get_case/1');
  assert.deepEqual(r.data, { ok: 1 });
  assert.deepEqual(sleeps, [2000]);
});

await check('429: HTTP-date / absent Retry-After → 5s default; second 429 → RATE_LIMITED', async () => {
  handler = (_req, _body, res) => {
    res.writeHead(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    res.end();
  };
  await assert.rejects(
    () => client.getJson('get_case/1'),
    (err: unknown) => err instanceof QaToolError && err.code === 'RATE_LIMITED',
  );
  assert.deepEqual(sleeps, [5000]);
});

await check('error mapping: 400 carries TestRail message through the gateway prefix', async () => {
  handler = (_req, _body, res) => {
    res.writeHead(400);
    res.end(`${PREFIX}{"error":"Field :title is a required field."}`);
  };
  await assert.rejects(
    () => client.postJson('add_case/1', {}),
    (err: unknown) =>
      err instanceof QaToolError && err.code === 'BAD_REQUEST' && err.message.includes('Field :title'),
  );
});

await check('error mapping: 401/403/404/409/500', async () => {
  const cases: Array<[number, string]> = [
    [401, 'AUTH_FAILED'],
    [403, 'FORBIDDEN'],
    [404, 'ENDPOINT_NOT_FOUND'],
    [409, 'MAINTENANCE'],
    [500, 'SERVER_ERROR'],
  ];
  for (const [status, code] of cases) {
    handler = (_req, _body, res) => {
      res.writeHead(status);
      res.end('NOPE');
    };
    await assert.rejects(
      () => client.getJson('get_case/1'),
      (err: unknown) => err instanceof QaToolError && err.code === code,
      `status ${status}`,
    );
  }
});

await check('NETWORK_ERROR: category only, no host/IP in the model-visible message', async () => {
  const dead = new TestRailClient(
    { baseUrl: 'http://127.0.0.1:1', username: 'u', apiKey: 'k' },
    { log: (l) => logLines.push(l), attachmentsDir: () => tmpAttach },
  );
  await assert.rejects(
    () => dead.getJson('get_case/1'),
    (err: unknown) =>
      err instanceof QaToolError &&
      err.code === 'NETWORK_ERROR' &&
      !/127\.0\.0\.1|localhost/.test(err.message),
  );
});

await check('UNEXPECTED_BINARY on a JSON route', async () => {
  handler = (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  };
  await assert.rejects(
    () => client.getJson('get_case/1'),
    (err: unknown) => err instanceof QaToolError && err.code === 'UNEXPECTED_BINARY',
  );
});

await check('PARSE_ERROR on POST 2xx carries the verify-before-retry caveat, no body bytes', async () => {
  handler = (_req, _body, res) => res.end('GATEWAYTOKENONLY');
  await assert.rejects(
    () => client.postJson('delete_case/5'),
    (err: unknown) =>
      err instanceof QaToolError &&
      err.code === 'PARSE_ERROR' &&
      err.message.includes('may have been applied') &&
      !err.message.includes('GATEWAYTOKENONLY'),
  );
});

await check('empty 200 body on POST → data null (delete_* success shape)', async () => {
  handler = (_req, _body, res) => res.end('');
  const r = await client.postJson('delete_case/5');
  assert.equal(r.data, null);
});

await check('multipart upload uses form field "attachment"; body JSON not sent', async () => {
  const file = path.join(tmpAttach, 'shot.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  handler = (req, body, res) => {
    assert.ok(String(req.headers['content-type']).startsWith('multipart/form-data'));
    assert.ok(body.toString('latin1').includes('name="attachment"'), 'official form field name');
    assert.ok(body.toString('latin1').includes('filename="shot.png"'));
    res.end(`${PREFIX}{"attachment_id":11}`);
  };
  const r = await client.postAttachment('add_attachment_to_result/1', file);
  assert.deepEqual(r.data, { attachment_id: 11 });
});

await check('getBinary: saves by sanitized id, flags suspected gateway prefix on binary', async () => {
  handler = (_req, _body, res) => {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-disposition': 'attachment; filename="../evil name.png"',
    });
    res.end(Buffer.concat([Buffer.from('GATEWAYJUNKTOKEN'), Buffer.from([0x89, 0x50, 0x4e, 0x47])]));
  };
  const r = await client.getBinary('get_attachment/2ec27be4-812f');
  assert.equal(path.basename(r.saved_to), '2ec27be4-812f.png');
  assert.ok(r.saved_to.startsWith(tmpAttach));
  assert.equal(r.possiblePrefix, true);
  assert.equal(r.display_name, '../evil name.png'); // metadata only, never the path
  assert.ok(fs.existsSync(r.saved_to));
});

await check('getBinary: clean magic bytes → no possiblePrefix', async () => {
  handler = (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  };
  const r = await client.getBinary('get_attachment/9');
  assert.equal(r.possiblePrefix, undefined);
});

await check('getText (get_bdd): same-line glued prefix split; JSON docstring intact; scanner skipped', async () => {
  handler = (_req, _body, res) =>
    res.end(`${PREFIX}Feature: login\n  Scenario: a\n    """\n    {"a":1}\n    """`);
  const r = await client.getText('get_bdd/12');
  assert.equal(r.nonJson, true);
  assert.equal(r.hadPrefix, true);
  const text = r.data as string;
  assert.ok(text.startsWith('Feature: login'));
  assert.ok(text.includes('{"a":1}'), 'JSON docstring must stay inside the Gherkin text');
});

await check('getText: opener-less body → PARSE_ERROR, gateway bytes only in the log', async () => {
  handler = (_req, _body, res) => res.end('USERAUTHENFAILEDNOBODY');
  await assert.rejects(
    () => client.getText('get_bdd/12'),
    (err: unknown) =>
      err instanceof QaToolError && err.code === 'PARSE_ERROR' && !err.message.includes('USERAUTHENFAILEDNOBODY'),
  );
});

server.close();
console.log(`\ntestrail-client: ${passed} checks passed`);
