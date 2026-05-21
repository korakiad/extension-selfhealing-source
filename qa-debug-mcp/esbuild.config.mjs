import * as esbuild from 'esbuild';

// Library entrypoint (the extension imports this; consumed via Node require).
await esbuild.build({
  entryPoints: ['src/server.ts', 'src/pause-store.ts'],
  outdir: 'dist',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  // The library bundle must NOT bundle workspace deps that the extension also
  // bundles independently — keep MCP SDK + pause-store-types as externals so
  // they resolve via the extension's own node_modules at runtime.
  external: ['@modelcontextprotocol/sdk', '@qa-debug/pause-store-types', 'zod'],
});

// Stdio CLI binary — for MCP Inspector smoke + evals harness.
// This DOES bundle everything (it's a standalone executable).
await esbuild.build({
  entryPoints: ['src/bin/stdio.ts'],
  outfile: 'dist/qa-debug-mcp.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
});
