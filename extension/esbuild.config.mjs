import * as esbuild from 'esbuild';

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

const shared = {
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  minify: production,
  sourcemap: production ? false : true,
  logLevel: 'info',
};

await esbuild.build({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

// Standalone stdio MCP proxy spawned by the MCP provider (node <this> ...).
// Separate process / separate bundle — not part of the extension host bundle.
await esbuild.build({
  ...shared,
  entryPoints: ['src/mcp-proxy.ts'],
  outfile: 'dist/mcp-proxy.js',
});
