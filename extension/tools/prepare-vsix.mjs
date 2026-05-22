// Stages a .vsix-ready tree at extension/_vsix-staging/ with real (non-symlink)
// node_modules/@qa-debug/mocha-hooks/ so vsce package --no-dependencies ships
// the hook + reporter standalone files that mocha --require / --reporter need
// at runtime (see session-manager.ts:73-74).
//
// Why staging: pnpm symlinks extension/node_modules/@qa-debug/mocha-hooks to
// ../../mocha-hooks. vsce doesn't reliably follow that into a workspace
// package. Replacing the symlink in-place would break the dev workspace.

import { mkdirSync, copyFileSync, rmSync, cpSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..');
const repoRoot = resolve(extDir, '..');
const staging = join(extDir, '_vsix-staging');

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

function copyTree(src, dst, skip = () => false) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d, skip);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    } else if (entry.isSymbolicLink()) {
      // realpath via statSync follow + cp
      cpSync(s, d, { recursive: true, dereference: true });
    }
  }
}

const skipDev = (name) =>
  name === 'node_modules' ||
  name === 'src' ||
  name === '_vsix-staging' ||
  name === 'tools' ||
  name === 'tsconfig.json' ||
  name === 'tsconfig.tsbuildinfo' ||
  name === 'esbuild.config.mjs' ||
  name === '.gitignore' ||
  name === '.vscodeignore' ||
  name.endsWith('.map');

copyTree(extDir, staging, skipDev);

const hooksSrc = join(repoRoot, 'mocha-hooks');
const hooksDst = join(staging, 'node_modules', '@qa-debug', 'mocha-hooks');
mkdirSync(join(hooksDst, 'dist'), { recursive: true });
copyFileSync(join(hooksSrc, 'package.json'), join(hooksDst, 'package.json'));
for (const f of readdirSync(join(hooksSrc, 'dist'))) {
  if (f.endsWith('.map')) continue;
  copyFileSync(join(hooksSrc, 'dist', f), join(hooksDst, 'dist', f));
}

// Rewrite the staging package.json to drop all workspace:* + bundled deps so
// vsce doesn't try to resolve them via npm list. Everything end-users need is
// either bundled into dist/extension.js (zod, tool-contracts, pause-store-types)
// or shipped as standalone files (mocha-hooks → node_modules/@qa-debug/mocha-hooks).
// Top-level: declare ONLY the runtime-resolved hook as a dep (its dir is the
// only thing in node_modules vsce should ship). Drop everything else — bundled.
{
  const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
  pkg.dependencies = { '@qa-debug/mocha-hooks': '0.0.0' };
  delete pkg.devDependencies;
  delete pkg.scripts;
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

// Shipped mocha-hooks/package.json: drop zod (bundled into qa-hooks.js) +
// devDeps so vsce's `npm list --production` walk doesn't complain about
// missing/extraneous packages. Keep name/version/main/exports — node's
// resolver needs `exports` to map `./register` → `./dist/qa-hooks.js`.
{
  const hooksPkg = JSON.parse(readFileSync(join(hooksDst, 'package.json'), 'utf8'));
  delete hooksPkg.dependencies;
  delete hooksPkg.devDependencies;
  delete hooksPkg.scripts;
  writeFileSync(join(hooksDst, 'package.json'), JSON.stringify(hooksPkg, null, 2) + '\n');
}

// Write a staging-local .vscodeignore that explicitly un-ignores the workspace
// hook dir (vsce's default + --no-dependencies otherwise drop node_modules/).
const stagingIgnore = [
  '**/.DS_Store',
  '**/*.map',
  '**/.git',
  '**/.vscode-test/**',
  'node_modules/**',
  '!node_modules/@qa-debug/**',
  '!node_modules/@qa-debug/mocha-hooks/**',
  'node_modules/@qa-debug/mocha-hooks/src/**',
  'node_modules/@qa-debug/mocha-hooks/node_modules/**',
  'node_modules/@qa-debug/mocha-hooks/tsconfig*',
  'node_modules/@qa-debug/mocha-hooks/esbuild.config.mjs',
  'node_modules/@qa-debug/mocha-hooks/*.tsbuildinfo',
  'node_modules/@qa-debug/mocha-hooks/**/*.map',
  '',
].join('\n');
writeFileSync(join(staging, '.vscodeignore'), stagingIgnore);

console.log(`[prepare-vsix] staged at ${staging}`);
console.log(`  node_modules/@qa-debug/mocha-hooks/dist/ ← ${readdirSync(join(hooksDst, 'dist')).join(', ')}`);
