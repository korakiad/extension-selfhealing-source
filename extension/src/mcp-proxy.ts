/**
 * mcp-proxy — thin stdio MCP proxy that wraps `@playwright/mcp --cdp-endpoint`.
 *
 * Sole job: rewrite the wrapped server's `initialize` response so that
 * `result.serverInfo.name` becomes a short, unique value, giving the agent a
 * distinct tool-name prefix (`mcp_qa-debug-cdp_browser_*`) that cannot collide
 * with a QA's own playwright-mcp (which reports `serverInfo.name: "Playwright"`
 * → `mcp_playwright*_browser_*`). Fixes "Mode B". The rewrite logic lives in
 * ./mcp-proxy-rewrite.ts; every other message is forwarded untouched.
 *
 * This sits at the MCP/JSON-RPC layer (VS Code <-> playwright-mcp). It is
 * independent of, and composes with, the CDP-layer download-shim
 * (playwright-mcp <-> Chrome): the `--cdp-endpoint` value handed to us is
 * already the shim's http root and we just forward it.
 *
 *   VS Code spawns:  node <this> --cdp-endpoint <httpRoot>
 *   which spawns:    npx -y @playwright/mcp@latest --cdp-endpoint <httpRoot>
 *
 * See reference-vscode-mcp-collision-mechanics.
 */
import { spawn } from 'node:child_process';

import { rewriteLine } from './mcp-proxy-rewrite.js';

const child = spawn('npx', ['-y', '@playwright/mcp@latest', ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.on('error', (err) => {
  process.stderr.write(`[mcp-proxy] failed to spawn @playwright/mcp: ${err.message}\n`);
  process.exit(1);
});

// VS Code -> child: raw passthrough (requests are never rewritten).
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {
  /* ignore EPIPE once the child has exited */
});

// child -> VS Code: newline-delimited JSON-RPC. Rewrite only the initialize
// response; forward every other line byte-for-byte.
let buf = '';
child.stdout.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8');
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    process.stdout.write(rewriteLine(line) + '\n');
  }
});
child.stdout.on('end', () => {
  if (buf.length > 0) process.stdout.write(rewriteLine(buf));
});

// Mirror the child's lifecycle so VS Code observes the server stopping.
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => child.kill(sig));
}
