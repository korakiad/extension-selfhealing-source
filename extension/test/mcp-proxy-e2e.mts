/**
 * E2E for the mcp-proxy against the REAL @playwright/mcp.
 *
 * Build first, then run from the extension dir:
 *   node esbuild.config.mjs
 *   node --import tsx test/mcp-proxy-e2e.mts
 *
 * Spawns `node dist/mcp-proxy.js --cdp-endpoint <bogus>` (the endpoint is never
 * used — playwright-mcp connects lazily on the first tool call, and we only do
 * the `initialize` handshake), sends an MCP `initialize`, and asserts the
 * response's serverInfo.name was rewritten to `qa-debug-cdp`. Proves the stdio
 * plumbing + rewrite work end-to-end. Requires network the first time (npx
 * fetches @playwright/mcp).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REWRITTEN_SERVER_NAME } from '../src/mcp-proxy-rewrite.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyJs = path.join(here, '..', 'dist', 'mcp-proxy.js');

const TIMEOUT_MS = 90_000;

async function main(): Promise<void> {
  const child = spawn('node', [proxyJs, '--cdp-endpoint', 'http://127.0.0.1:9222'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no initialize response within ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const result = msg.result as { serverInfo?: Record<string, unknown> } | undefined;
        if (result?.serverInfo) {
          clearTimeout(timer);
          resolve(result.serverInfo);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`proxy exited early (code ${code})`)));
  });

  // MCP initialize request.
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-proxy-e2e', version: '0' },
      },
    }) + '\n',
  );

  try {
    const serverInfo = await done;
    console.log(`  serverInfo: ${JSON.stringify(serverInfo)}`);
    assert.equal(
      serverInfo.name,
      REWRITTEN_SERVER_NAME,
      `serverInfo.name should be rewritten to ${REWRITTEN_SERVER_NAME}`,
    );
    assert.equal('title' in serverInfo, false, 'serverInfo.title should be dropped');
    console.log(`\nmcp-proxy e2e PASSED ✅  (serverInfo.name = ${REWRITTEN_SERVER_NAME})`);
  } finally {
    child.kill('SIGTERM');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nmcp-proxy e2e FAILED ❌');
    console.error(e);
    process.exit(1);
  });
