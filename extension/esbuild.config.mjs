import * as esbuild from 'esbuild';

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  minify: production,
  sourcemap: production ? false : true,
  logLevel: 'info',
  external: ['vscode'],
});
