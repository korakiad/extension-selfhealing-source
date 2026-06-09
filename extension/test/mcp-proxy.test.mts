/**
 * Unit test for the mcp-proxy rewrite logic.
 *
 * Run from the extension dir:
 *   node --import tsx test/mcp-proxy.test.mts
 *
 * Proves the proxy rewrites ONLY the `initialize` response's serverInfo.name
 * (and drops title), passing every other line through byte-for-byte. The live
 * end-to-end variant (against real @playwright/mcp) is test/mcp-proxy-e2e.mts.
 */
import assert from 'node:assert/strict';

import {
  REWRITTEN_SERVER_NAME,
  rewriteLine,
} from '../src/mcp-proxy-rewrite.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// A realistic @playwright/mcp initialize response (serverInfo.name = "Playwright").
const initResponse = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  result: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'Playwright', version: '1.61.0' },
  },
});

try {
  check('rewrites serverInfo.name → qa-debug-cdp', () => {
    const out = JSON.parse(rewriteLine(initResponse));
    assert.equal(out.result.serverInfo.name, REWRITTEN_SERVER_NAME);
  });

  check('rewritten name fits the VS Code prefix budget (≤13 chars)', () => {
    // McpToolName.MaxPrefixLen(18) - 'mcp_'(4) - trailing '_'(1) = 13.
    assert.ok(REWRITTEN_SERVER_NAME.length <= 13, `name too long: ${REWRITTEN_SERVER_NAME}`);
    assert.equal(REWRITTEN_SERVER_NAME, REWRITTEN_SERVER_NAME.toLowerCase());
  });

  check('drops serverInfo.title (VS Code prefers title for the prefix)', () => {
    const withTitle = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      result: { serverInfo: { name: 'Playwright', title: 'Playwright', version: '1' } },
    });
    const out = JSON.parse(rewriteLine(withTitle));
    assert.equal(out.result.serverInfo.name, REWRITTEN_SERVER_NAME);
    assert.equal('title' in out.result.serverInfo, false);
  });

  check('preserves other serverInfo fields + version', () => {
    const out = JSON.parse(rewriteLine(initResponse));
    assert.equal(out.result.serverInfo.version, '1.61.0');
    assert.equal(out.result.protocolVersion, '2025-06-18');
    assert.equal(out.id, 0);
  });

  check('passes a tools/list response through byte-for-byte', () => {
    const toolsList = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'browser_snapshot', description: 'x' }] },
    });
    assert.equal(rewriteLine(toolsList), toolsList);
  });

  check('passes a request (no result) through unchanged', () => {
    const req = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    assert.equal(rewriteLine(req), req);
  });

  check('result without serverInfo is unchanged', () => {
    const r = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    assert.equal(rewriteLine(r), r);
  });

  check('empty / whitespace line is passed through verbatim', () => {
    assert.equal(rewriteLine(''), '');
    assert.equal(rewriteLine('   '), '   ');
  });

  check('non-JSON line is passed through verbatim', () => {
    assert.equal(rewriteLine('not json at all'), 'not json at all');
  });

  check('rewrites an initialize response inside a JSON-RPC batch array', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 9, result: { serverInfo: { name: 'Playwright', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/ping' },
    ]);
    const out = JSON.parse(rewriteLine(batch));
    assert.equal(out[0].result.serverInfo.name, REWRITTEN_SERVER_NAME);
    assert.equal(out[1].method, 'notifications/ping');
  });

  console.log(`\nmcp-proxy unit test PASSED ✅  (${passed} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nmcp-proxy unit test FAILED ❌');
  console.error(e);
  process.exit(1);
}
