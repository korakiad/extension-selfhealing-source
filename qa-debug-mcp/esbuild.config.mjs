import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/qa-debug-mcp.ts'],
  outfile: 'dist/qa-debug-mcp.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
});
