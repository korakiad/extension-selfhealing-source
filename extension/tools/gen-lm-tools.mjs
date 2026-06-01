#!/usr/bin/env node
/**
 * Generate extension/package.json `contributes.languageModelTools` from the
 * shared @qa-debug/tool-contracts SSOT.
 *
 * WHY: `vscode.lm.registerTool(name, tool)` carries NO description or schema
 * (vscode.d.ts:20779 — LanguageModelTool has only invoke/prepareInvocation), so
 * the package.json contribution is the ONLY tool spec the model ever sees for
 * the LM-tool host. Keeping it hand-synced with tool-contracts (which evals +
 * the stdio MCP host consume) drifted in both directions; this makes the
 * package.json block a DERIVED artifact instead.
 *
 * Each tool's VS Code presentation fields (tags, toolReferenceName, displayName,
 * userDescription, canBeReferencedInPrompt, icon, when) are PRESERVED from the
 * existing entry; only `modelDescription` (<- tool-contracts `description`) and
 * `inputSchema` (<- `inputSchemaJson`) are overwritten.
 *
 * Usage:
 *   node tools/gen-lm-tools.mjs           # write package.json
 *   node tools/gen-lm-tools.mjs --check   # exit 1 if out of sync (build guard)
 *
 * Reads tool-contracts from its built dist (run after `tool-contracts` build;
 * the root `pnpm -r run build` builds it first in topo order).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { qaTools } = require('@qa-debug/tool-contracts/tools');

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', 'package.json');
const raw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const existing = pkg.contributes?.languageModelTools ?? [];
const byName = new Map(existing.map((e) => [e.name, e]));

const generated = qaTools.map((t) => {
  const name = `qa-debug_${t.name}`;
  const cur = byName.get(name);
  if (!cur) {
    throw new Error(
      `gen-lm-tools: no existing languageModelTools entry for "${name}". ` +
        'Add its VS Code presentation fields (tags/displayName/icon/when/...) to ' +
        'package.json first, then re-run.',
    );
  }
  // Spread cur first so presentation fields + their order are preserved;
  // overwrite only the two derived fields.
  return { ...cur, name, modelDescription: t.description, inputSchema: t.inputSchemaJson };
});

pkg.contributes.languageModelTools = generated;
// 2-space indent + trailing newline to match the repo's existing package.json style.
const out = JSON.stringify(pkg, null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (out !== raw) {
    console.error(
      'gen-lm-tools: extension/package.json languageModelTools is OUT OF SYNC with ' +
        '@qa-debug/tool-contracts.\n' +
        'Run `pnpm --filter ./extension run gen:lm-tools` and commit the result.',
    );
    process.exit(1);
  }
  console.log('gen-lm-tools: package.json languageModelTools in sync with tool-contracts ✓');
} else {
  writeFileSync(pkgPath, out);
  console.log(`gen-lm-tools: wrote ${generated.length} tool definitions to package.json`);
}
