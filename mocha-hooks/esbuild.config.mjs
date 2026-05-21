import * as esbuild from 'esbuild';

const shared = {
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

// IMPORTANT: protocol.js must NOT be bundled into qa-hooks.js or qa-reporter.js.
// Both bundles `require('./protocol')` at runtime so Node's CommonJS module cache
// returns the SAME module instance, which is required for the `inProcBus` singleton
// (a module-level EventEmitter) to actually correlate hook→reporter messages.
// Bundling protocol into each would create two singletons that never see each other.

await esbuild.build({
  ...shared,
  entryPoints: ['src/protocol.ts'],
  outfile: 'dist/protocol.js',
  external: ['mocha'],
});

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ['src/qa-hooks.ts'],
    outfile: 'dist/qa-hooks.js',
    external: ['mocha', './protocol'],
  }),
  // qa-reporter must be loadable by mocha via `require(<path>)` returning the class
  // directly. With `export default Class`, esbuild's CJS output puts the class under
  // `.default`; the footer below re-points module.exports at the class itself so
  // `mocha --reporter @qa-debug/mocha-hooks/qa-reporter` resolves to the constructor.
  esbuild.build({
    ...shared,
    entryPoints: ['src/qa-reporter.ts'],
    outfile: 'dist/qa-reporter.js',
    external: ['mocha', './protocol'],
    footer: {
      js: 'module.exports = module.exports.default || module.exports.QaReporter;',
    },
  }),
]);
