import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  external: ['vscode'],
});
