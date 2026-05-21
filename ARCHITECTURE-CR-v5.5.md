# ARCHITECTURE v5.5 — Change Request: pre-pause test discovery + selective run via Test Explorer

> Status: **Iteration #1 (file)** drafted 2026-05-21. Closes the structural gap surfaced post-S4/v5.4: `TestController` only lazy-creates `TestItem`s at pause-time, so a QA who opens Test Explorer BEFORE running anything sees an empty tree and cannot pick a specific describe/it to run. v5.5 introduces AST-driven discovery + `resolveHandler` + File→Describe→It hierarchy + `FileSystemWatcher` + selective-run via anchored `--grep`. Also adds **`full_title`** to PausePayload so discovery-time TestItem id matches pause-time TestItem id (without it the two paths produce different ids and the tree forks).
>
> Scope: §2 component list (`test-discovery.ts` new + extended `test-controller.ts`), §3.1 qa-hooks `afterEach` payload (adds `full_title`), §3.6 reporter unchanged, §3.7 (v5.4) status-bar unchanged, §3.8 NEW (Test Explorer discovery model), §4 failure-pause loop unchanged. Wire IPC: `PausePayload` schema gains `full_title: string`. Stored `PausePayload` (pause-store-types) gains `full_title: string`.
>
> **Larger surface than v5.4.** v5.4 was 4 small refinements; v5.5 introduces a new module + extends `test-controller.ts` substantially + touches 4 cross-package types (wire payload, stored payload, qa-hooks, test-controller). Author expects ≥1 iter#3 cycle is possible; cap=3 applies per CR-v5.4 §8 precedent.
>
> **Process discipline (from CR-v5.4 NB11):** All §0 platform-owned URL citations were WebFetch-verified (or installed-source-verified via grep) BEFORE this file was written. No "iter#2 reviewer please verify" TODOs in §0.

## 0. Sources (per ARCHITECTURE v5 §0.1 / §0.2)

### Capability sources — VS Code testing API (§0.1)

All citations against `node_modules/.pnpm/@types+vscode@1.120.0/node_modules/@types/vscode/index.d.ts`:

- **`vscode.tests.createTestController(id, label)`** at :18286 → returns `TestController`. Already used at extension/src/test-controller.ts:48.

- **`TestController.resolveHandler`** at :18509:

  ```ts
  /** A function provided by the extension that the editor may call to request
   *  children of a test item, if the {@link TestItem.canResolveChildren} is
   *  `true`. When called, the item should discover children and call
   *  {@link TestController.createTestItem} as children are discovered.
   *
   *  Generally the extension manages the lifecycle of test items, but under
   *  certain conditions the editor may request the children of a specific
   *  item to be loaded.
   *
   *  The item in the explorer will automatically be marked as "busy" until
   *  the function returns or the returned thenable resolves.
   *
   *  @param item An unresolved test item for which children are being
   *  requested, or `undefined` to resolve the controller's initial
   *  {@link TestController.items items}. */
  resolveHandler?: (item: TestItem | undefined) => Thenable<void> | void;
  ```

  This is the discovery entry point. The `undefined` arg = "populate the root level"; an item arg = "populate that item's children". v5.5 uses both: root-level populates file-level TestItems from a workspace scan; item-arg populates describe→it children from AST parse of that file.

- **`TestController.createRunProfile(label, kind, runHandler, isDefault?, tag?, supportsContinuousRun?)`** at :18489. Already used at extension/src/test-controller.ts:54. The `runHandler` signature is `(request: TestRunRequest, token: CancellationToken) => Thenable<void> | void`.

- **`CancellationToken`** at :1664 (interface). Currently the v5.4-shipped runHandler ignores the token (extension/src/test-controller.ts:57 — `_token` prefix). v5.5 wires it to SessionManager so cancelling the Test Explorer run kills the mocha child via SIGTERM.

- **`TestItem` interface** at :18796. Key fields used by v5.5:
  - `id: string` (readonly, :18802) — must be unique among siblings.
  - `uri: Uri | undefined` (readonly, :18807) — file URI for click-to-jump.
  - `children: TestItemCollection` (readonly, :18814) — nested children.
  - `tags: readonly TestTag[]` (:18827) — v5.5 uses for `.skip` / `.only` visual marks per C3.
  - `canResolveChildren: boolean` (:18838) — v5.5 sets true on file + describe items.
  - `busy: boolean` (:18846) — v5.5 sets during AST parse (resolveHandler auto-toggles too).
  - `label: string` — display name.
  - `description?: string` — sibling text (v5.4 uses for "(marked passed)"; v5.5 uses for ".only" / ".skip" markers).
  - `range?: Range` — cursor-jump target (v5.5 sets to describe/it call-site line).

- **`TestTag` class** at ~:18317. Constructor takes `id: string`. v5.5 defines two: `qa-debug.skip` and `qa-debug.only` for visual filtering.

- **`TestRunRequest`** at :18594. Key fields:
  - `include: readonly TestItem[] | undefined` (:18604) — "If this property is undefined, then the extension should simply run all tests."
  - `exclude: readonly TestItem[] | undefined` (:18614) — exclusions apply after inclusions.
  - `profile: TestRunProfile | undefined` (:18621) — Run vs Debug vs Coverage; v5.5 only uses Run.

- **`workspace.findFiles(include, exclude?, maxResults?, token?)`** at :14100 → returns `Thenable<Uri[]>`. Used at activate to seed file-level TestItems from a single workspace scan [NB2].

- **`workspace.createFileSystemWatcher(globPattern, ignoreCreateEvents?, ignoreChangeEvents?, ignoreDeleteEvents?)`** at :14081 → returns `FileSystemWatcher`. The `FileSystemWatcher` interface at :1810 exposes:
  - `onDidCreate: Event<Uri>` (:1833)
  - `onDidChange: Event<Uri>` (:1838)
  - `onDidDelete: Event<Uri>` (:1843)
  - Extends `Disposable`.

  v5.5 uses `createFileSystemWatcher('**/*.spec.{ts,js}', false, false, false)` so all three event channels fire, then debounces per-file to 300ms (S2).

- **`GlobPattern`** type at :2367 — `string | RelativePattern`. v5.5 supports both (multi-workspace fixture dirs use RelativePattern; single-workspace uses string).

### Capability sources — TypeScript Compiler API (§0.1)

All citations against `node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.d.ts`:

- **`ts.createSourceFile(fileName, sourceText, languageVersionOrOptions, setParentNodes?, scriptKind?)`** at :9192 — parses source string into a `SourceFile` AST. v5.5 calls with `ScriptTarget.Latest` + `setParentNodes: true` (parent pointers help line-range resolution).

- **`ts.forEachChild(node, cbNode, cbNodes?)`** at :9191 — depth-first child walker; returns when callback returns a truthy value. v5.5 uses this rather than the `Node.forEachChild` method for type narrowing.

- **`ts.isCallExpression(node): node is CallExpression`** at :9023 — type guard.
- **`ts.isIdentifier(node): node is Identifier`** at :8972 — type guard. (The traversal uses the type guards directly; the enum value `SyntaxKind.CallExpression = 214` is at :3893 but not referenced by v5.5 code.)

**`ts.createSourceFile` does NOT throw on syntax errors** (verified at :9192 — returns a `SourceFile` with `parseDiagnostics` attached). The parse-error path in §2.1 must check `sourceFile.parseDiagnostics.length > 0` rather than wrap a try/catch [NB11].

TypeScript is already a project dependency (`typescript@5.9.3`, installed); no new dep introduced.

### Capability sources — Mocha (§0.1)

All citations against `node_modules/.pnpm/mocha@10.8.2/node_modules/mocha/lib/`:

- **`Runnable.prototype.fullTitle()`** at `runnable.js:206`:

  ```js
  Runnable.prototype.fullTitle = function () {
    return this.titlePath().join(' ');
  };

  Runnable.prototype.titlePath = function () {
    return this.parent.titlePath().concat([this.title]);
  };
  ```

  i.e., space-joined ancestor titles + own title. **This is the canonical id for matching discovery-time IDs to pause-time IDs.** Mocha's own `--grep` matches against the same fullTitle.

- **`Suite.prototype.fullTitle`** at `suite.js:380–382` — same shape (`titlePath().join(' ')`).

- **`Runnable.prototype.pending`** + **`Runnable.prototype.isPending()`** at `runnable.js:143/152` — `.skip` populates `this.pending = true`, and `isPending()` walks up the parent chain. The Test Explorer rendering must propagate skip from describe → its children visually (C3).

- **`.only` semantics** — Mocha's `--grep` does NOT honor `.only` markers; the runtime `only()` system filters before `--grep` matching. v5.5 discovery marks `.only` as a TestTag for visual reference but DOES NOT alter `--grep` behavior; the Mocha process itself handles `.only` filtering at runtime regardless of what `--grep` matches.

### Capability sources — repo-local (§0.1)

- `extension/src/test-controller.ts:48` — current `createTestController` call site.
- `extension/src/test-controller.ts:54–67` — current `createRunProfile` (Run kind) with token-ignoring handler.
- `extension/src/test-controller.ts:96–109` — current `ensureTestItem` lazy-create-on-pause (THE GAP v5.5 closes).
- `extension/src/test-controller.ts:232–244` — current `collectSpecUris` from request.include (already extracts URIs from TestItems; v5.5 extends to also derive `--grep` patterns from selected items).
- `extension/src/session-manager.ts:188–250` — `runMocha` opts shape (`mochaBin`, `cwd`, `specFiles`, `grep`). v5.5 reuses with the same shape; no SessionManager API change.
- `extension/src/session-manager.ts:264–304` — `pause.publish` handler. v5.5 needs to update the wire→stored transformation to forward `full_title`.
- `mocha-hooks/src/protocol.ts:22–37` — wire `PausePayload` schema. v5.5 adds `full_title: z.string()` to the wire shape (required field — not optional, because discovery needs it everywhere).
- `mocha-hooks/src/qa-hooks.ts:241–250` — wire payload construction. v5.5 adds `full_title: test.fullTitle()` alongside `test: test.title` (keep `test` for the it()-only title used by Output Channel friendliness; `full_title` is the new canonical id field).
- `pause-store-types/src/index.ts:26–41` — stored `PausePayload` interface. v5.5 adds `full_title: string` (required).
- `pause-store-types/src/index.ts:52–66` — `FailureContextView`. **Open Q3 below**: should the view also expose `full_title` to MCP tool callers? Recommend yes (helpful for agent's reasoning about the failure's place in the suite hierarchy).

### Agentic-design sources (§0.2)

v5.5 does NOT make new agentic-design claims; all surfaces it adds (Test Explorer hierarchy, file watcher, selective run) are human-facing UI gestures. The relevant agentic-design rule it inherits from prior CRs is:

- **`anthropic.com/engineering/writing-tools-for-agents`** (cited in ARCH v5 §0.2 and CR-v5.4 §0): *"Too many tools or overlapping tools can also distract agents from pursuing efficient strategies. Make sure each tool you build has a clear, distinct purpose."* v5.5 reaffirms this by NOT adding any MCP tool — discovery is a UI concern, not an agent concern. The 6 qa-debug MCP tools are unchanged.

### Memory cross-references

- [[feedback-chat-not-launcher]] — Test Explorer is the canonical run surface; v5.5 makes it actually work pre-pause (was structurally hollow before v5.5).
- [[feedback-chat-panel-engagement]] — v5.4 resolution direction relies on Test Explorer being usable; v5.5 fulfills the precondition.
- [[feedback-transparent-use]] — discovery must work with **no .mocharc edits** + **no .spec edits**; v5.5 AST-only discovery honors this (parses what the user wrote; modifies nothing).
- [[project-qa-companion]] — v5.5 entry currently marked DRAFTED; this CR transitions to APPROVED upon iter#2.

## 1. The contradiction

Post-S4 + v5.4 implementation, the user-visible Test Explorer rendering has a structural gap:

1. **Before any test runs**: Test Explorer is empty. The user cannot pick "I want to run only this one describe block" because no TestItems exist yet. Only the `qa-debug.runFixture` command runs anything; it always runs the entire fixture suite.
2. **On first pause**: `recordPause` lazily creates a `${fileUri}::${test_title}` TestItem (extension/src/test-controller.ts:96–109). The tree finally has one item — the test that just failed.
3. **For subsequent tests in the same file**: lazy-create accretes one item per pause, but **never the passing tests** (because passing tests don't fire `afterEach` failure paths). The Test Explorer tree under-represents the suite by 100% minus the number of failed tests.

The contradiction with [[feedback-chat-not-launcher]] and CR-v5.4's "Test Explorer = primary surface (project choice)" framing is acute: we declared Test Explorer the canonical run surface but did not actually build the surface. v5.4 surface taxonomy assumed v5.5 would close this.

A secondary contradiction (the unification problem). Even if discovery populates a `${fileUri}::it::<full_title>` TestItem at workspace-scan time, the lazy `recordPause` path at extension/src/test-controller.ts:81–83 builds `${fileUri.toString()}::${title}` using `pause.test_title` — and `pause.test_title` is currently `test.title` (just the it() title — per qa-hooks.ts:242 wire field `test: test.title`). The two ids will not match; the tree will fork. To unify, the pause payload must carry the same canonical full-title string that AST discovery extracts. This is the **C1 prerequisite** from the v5.5 handoff.

## 2. The proposal

Five additive changes, none of which break v5.4 or earlier:

### 2.1 `extension/src/test-discovery.ts` — AST parser + workspace scan

New module. Public surface:

```ts
import * as vscode from 'vscode';
import * as ts from 'typescript';

export interface DiscoveredTest {
  /** Full title joined by spaces: `<describe path> <it title>` — matches Mocha's Runnable.fullTitle(). */
  fullTitle: string;
  /** Just the it() title. */
  title: string;
  /** Path of describe titles, root-to-leaf. */
  describePath: readonly string[];
  /** 1-based line number of the it() call site. */
  line: number;
  /** True if the it call is `.skip` OR any enclosing describe is `.skip`. */
  skip: boolean;
  /** True if the it call is `.only` (does NOT recursively check enclosing describes per Mocha semantics — describe.only has its own filter pass at runtime). */
  only: boolean;
}

export interface DiscoveredDescribe {
  title: string;
  describePath: readonly string[];
  line: number;
  skip: boolean;
  only: boolean;
  children: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>;
}

export interface DiscoveredFile {
  uri: vscode.Uri;
  /** Top-level describes + (rare) top-level its. */
  children: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>;
  /** Set if parse failed; the rest of the file is best-effort. */
  parseError?: string;
}

export function parseSpec(uri: vscode.Uri, sourceText: string): DiscoveredFile;

export function discoveryFullTitle(describePath: readonly string[], title: string): string {
  // Mocha's titlePath().join(' '); same logic as Runnable.fullTitle() (runnable.js:206).
  return [...describePath, title].join(' ');
}
```

**AST traversal.** Use `ts.createSourceFile(uri.fsPath, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true)`. Walk with `ts.forEachChild`. For each node that is `ts.isCallExpression`:

- Identify the callee's leftmost identifier (which may be `describe`, `it`, `describe.only`, `it.skip`, etc.). Use `ts.PropertyAccessExpression` unwrapping.
- Recognize the literal-string first argument. **NON-literal first argument (template / variable / call expression) = "computed title; cannot extract statically"; emit a TestItem with `description: '(computed title)'` and `range` at the call site (per S1 should-include) — Q1.**
- For `describe(...)` calls, recurse into the second arg's body (a function expression / arrow function); if the second arg is not a function literal, emit a describe TestItem with no children and `description: '(opaque suite)'`.
- For `it(...)` calls, terminate recursion.
- Track current `describePath: string[]` as a stack during traversal.
- Track current `skip` flag (true if current call's chain has `.skip` OR any ancestor describe's chain has `.skip`) and `only` flag (own-chain only; describe.only at runtime is handled by Mocha).

**Parse failures.** `ts.createSourceFile` does NOT throw on syntax errors (verified at typescript.d.ts:9192) — it returns a `SourceFile` with `parseDiagnostics: readonly DiagnosticWithLocation[]` attached. The discovery check is `if (sourceFile.parseDiagnostics.length > 0)` → emit `DiscoveredFile` with `parseError: sourceFile.parseDiagnostics[0].messageText.toString()` AND continue the AST walk best-effort (the parser tries to recover for child nodes; partial discovery is better than total empty). The file-level TestItem is still created so the user sees the file in the tree; clicking it focuses the editor on line 1 where the user can fix the syntax [NB11]. Per **C5**: empty workspace → `resolveHandler(undefined)` returns immediately with no items added; Test Explorer shows VS Code's built-in "No tests found" message naturally.

**Stale TestItem cleanup (S4 should-include).** On `onDidDelete` from `FileSystemWatcher`: remove the file's TestItem from `controller.items`. On rename (manifested as Create+Delete in VS Code FileSystemWatcher per :1810 contract): add new, drop old. v5.5 explicit invariant: TestItem ids derive from file URI string + canonical `::describe::` / `::it::` infix; renaming a file invalidates every id under it (new file URI → new id; the old subtree is gone).

### 2.2 `TestController.resolveHandler` registration

Extend `extension/src/test-controller.ts` (the `createTestControllerWrapper` factory):

```ts
import { parseSpec, discoveryFullTitle, type DiscoveredFile } from './test-discovery.js';

// Inside createTestControllerWrapper, after controller created:
controller.resolveHandler = async (item) => {
  if (item === undefined) {
    // Root-level populate. Workspace scan for **/*.spec.{ts,js}.
    await populateRoot();
    return;
  }
  // Item-level expand. If item is a file, parse its source and add describe/it children.
  // If item is a describe, its children were already added when its file was parsed
  // (we do not lazy-load below the file level — the AST walk covers the whole file in
  // one pass per S2 / debounce rationale). Re-parse only on FileSystemWatcher events.
  if (isFileItem(item)) {
    await parseAndPopulate(item);
  }
};
```

`populateRoot()` calls `vscode.workspace.findFiles('**/*.spec.{ts,js}', '**/node_modules/**')`. For each URI, creates a file TestItem with `canResolveChildren: true` and adds to `controller.items`. **Does NOT parse content at root-level** — parsing happens when the user expands the file (per resolveHandler item-level path) OR on first `FileSystemWatcher` event. This keeps activation cheap on large repos.

`parseAndPopulate(fileItem)`:
1. `vscode.workspace.fs.readFile(fileItem.uri)` → `sourceText`.
2. `parseSpec(uri, sourceText)` → `DiscoveredFile`.
3. Walk the discovered tree; for each describe / it, create a TestItem with id per §2.3 below, parent into the file item or its enclosing describe.
4. If `parseError`: set fileItem's TestItem to render an error message via `description: '(parse error: <first 80 chars>)'`. Do NOT block other files.
5. Set `fileItem.busy = false` (resolveHandler auto-toggles per :18839, but explicit clear is defensive against partial-failure paths).

### 2.3 TestItem id formula — discovery + pause unification (C1)

v5.5 binds the id formula across both code paths:

| Item type | Id format |
|---|---|
| File | `fileUri.toString()` |
| Describe | `${fileUri}::describe::${describePath.join('>')}` |
| It (test) | `${fileUri}::it::${fullTitle}` |

`fullTitle` here is the same string Mocha's `Runnable.fullTitle()` produces (runnable.js:206 → `titlePath().join(' ')`). The space-join is significant; if the AST extracts `['Login', 'should accept valid creds']` and the test's actual mocha context has the same describe stack, both produce `"Login should accept valid creds"`.

**This requires the pause-time payload to carry the canonical full title.** See §2.4.

**Separator-injection invariant [NB3].** The id formula uses `::it::` / `::describe::` as path separators. If a test title contains the literal substring `::it::` (or `::describe::`), the id remains self-consistent (discovery + pause-time produce the same string) but `lookupOrCreateTestItem` is no longer injective with respect to potential sibling ids. Phase 1 contract: test titles MUST NOT contain `::it::` or `::describe::` as literal substrings. The AST parser emits a `[test-discovery] title contains reserved separator; rendering with description='(reserved separator)'` log to Output Channel and renders the TestItem with a `description: '(reserved separator)'` warning so the QA notices. Phase 2 may switch to URI-encoded segments (`encodeURIComponent(segment)`) if a real-world collision is reported; today's QA test titles in fixture-tests do not contain the separator and no telemetry justifies preemptive encoding.

`extension/src/test-controller.ts:96–109`'s `ensureTestItem` is REPLACED by a lookup function:

```ts
function lookupOrCreateTestItem(fileUri: vscode.Uri, fullTitle: string, line?: number): vscode.TestItem {
  const id = `${fileUri.toString()}::it::${fullTitle}`;
  const fromDiscovery = items.get(id);   // populated by parseAndPopulate
  if (fromDiscovery) return fromDiscovery;
  // Pause fired before discovery for this file (race: user starts run via runFixture
  // command without ever opening Test Explorer; resolveHandler never fired for the
  // file). Create a minimal placeholder item so the pause renders; future
  // resolveHandler runs may merge it.
  const fileItem = ensureFileItem(fileUri);
  const item = controller.createTestItem(id, fullTitle, fileUri);
  if (line != null && line >= 1) {
    item.range = new vscode.Range(line - 1, 0, line - 1, 0);
  }
  fileItem.children.add(item);
  items.set(id, item);
  return item;
}
```

The fallback-create branch handles the race where pause-publish fires before any resolveHandler walk on that file (e.g., the user invokes `qa-debug.runFixture` from the command palette without ever opening Test Explorer). The placeholder uses `fullTitle` as the label (Test Explorer convention is short label; future Phase 2 may split label = just `it.title` and use `description` for the describe-path crumbs).

### 2.4 PausePayload `full_title` field (the C1 prerequisite)

**Wire schema** (`mocha-hooks/src/protocol.ts:22`):

```ts
export const PausePayload = z.object({
  test: z.string(),               // unchanged — it()-only title; used in Output Channel friendliness
  full_title: z.string(),         // NEW — Mocha's currentTest.fullTitle()
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  error: SerializedError,
  cdp_ws_url: z.string(),
  mode: BrowserOwnershipMode.optional().default('B'),
  started_at: z.number().int(),
  retry_count: z.number().int().nonnegative(),
});
```

`full_title` is required (not optional); pre-v5.5 oracles / hooks would fail Zod validation on `pause.publish`. This is a HARD WIRE BREAK — Phase 1 has no released consumers other than the in-repo qa-hooks + oracle + extension, so the break is acceptable. The corresponding change to qa-hooks-tools/oracle.ts must land in the same commit.

**qa-hooks** (`mocha-hooks/src/qa-hooks.ts:241–250`):

```ts
const payload: PausePayload = {
  test: test.title,
  full_title: test.fullTitle(),    // NEW
  file: test.file ?? null,
  line: fileLineFromStack(test.err?.stack),
  error: serializeError(test.err),
  cdp_ws_url: cdpWsUrl,
  mode,
  started_at: Date.now(),
  retry_count: currentRetryOf(test),
};
```

**Stored shape** (`pause-store-types/src/index.ts:26`):

```ts
export interface PausePayload {
  session_id: string;
  test_title: string;     // unchanged — it()-only (kept for Output-Channel friendliness)
  full_title: string;     // NEW — canonical id field; matches Mocha's Runnable.fullTitle()
  file: string;
  line?: number;
  failing_assertion: string;
  stack_trace: { frames: string[]; more_at?: string };
  cdp_ws_url: string;
  mode?: BrowserOwnershipMode;
  screenshot_path?: string;
  console_logs: { lines: string[]; bytes: number; more_at?: string };
  paused_at_ms: number;
  retry_count: number;
  max_retries_remaining: number;
}
```

**wireToStored** (in `extension/src/session-manager.ts`): pass `full_title: wire.full_title` through.

**FailureContextView gains `full_title` [Q3 resolved].** `pause-store-types/src/index.ts:52–66` `FailureContextView` interface adds `full_title: string` (required). The pure-projection helper `toFailureContextView` at :95–129 passes it through (`full_title: active.full_title`). MCP `qa_get_failure_context` consumers (agents) see the field in their response; cheap to add, helpful for hierarchy-aware reasoning. No behavior change for non-MCP consumers.

**FinalDecisionParams rename [NB8 / Q2 resolved as (a)].** The existing `FinalDecisionParams.test_title` field (mocha-hooks/protocol.ts:81) is already populated with `test.fullTitle()` (qa-hooks.ts:277) — a pre-v5.5 semantic mismatch with the wire `PausePayload`'s `test: test.title`. v5.5 renames `FinalDecisionParams.test_title` → `full_title` for symmetry with the new wire/stored PausePayload field. Downstream consumers updated atomically:

- `mocha-hooks/src/qa-reporter.ts:83` — change `params.test_title` → `params.full_title`. Correlation key unchanged (it was always the full title; just the field name shifts).
- `tools/oracle.ts` — same rename.
- `extension/src/session-manager.ts:333` — already uses the field for retry `--grep ^${escapeRegex(testTitle)}$`; field name shifts, behavior identical.
- `extension/src/test-controller.ts:146` — **DELETE the buggy `decision.test_title.replace(/^.*? > /, '')` strip entirely**. The strip was attempting to remove a `<suite> > ` prefix that Mocha never emits (Mocha joins with single space, not ` > `), so the strip has been a no-op masking a misunderstanding. Replace the fallback lookup with a clean unified-id lookup against `${fileUri}::it::${decision.full_title}` — which now matches the discovery-time id formula (§2.3). This is a free correctness fix bundled with the v5.5 rename.

All four sites land in the same commit as the PausePayload wire-break (§2.4). No external monorepo consumers exist (verified by iter#2 reviewer's `node_modules/` grep).

**MementoPauseStore migration [NB5 / Q4 resolved].** Existing stale-resume pauses in user's globalState pre-dating v5.5 will lack `full_title`. Normalization happens at the store READ sites — `extension/src/pause-store.ts` `MementoPauseStore.peekActivePause()` and `.getActivePause()` (lines 48–53, both currently `globalState.get<PausePayload>(KEY_ACTIVE)`) wrap the read in a `normalizeStoredPause(raw)` call. The helper is a pure function exported from `pause-store-types/src/index.ts` (it CAN live in the type package even though the type package has no reader of its own — it's a pure normalizer, not a read API):

```ts
// pause-store-types/src/index.ts
export function normalizeStoredPause(raw: unknown): PausePayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const test_title = typeof obj.test_title === 'string' ? obj.test_title : '';
  const full_title = typeof obj.full_title === 'string' ? obj.full_title : test_title;
  // ... rest of the field coercion
  return { ...obj, test_title, full_title } as PausePayload;
}
```

Both `peekActivePause` and `getActivePause` in MementoPauseStore call this helper. The chat-participant (extension/src/chat-participant.ts) and decision-router (extension/src/decision-router.ts) both consume `PausePayload` via MementoPauseStore, so all readers see the normalized shape (no risk of a pre-v5.5 untyped blob leaking through). The fallback `full_title: stored.test_title` is best-effort: it may produce a placeholder TestItem instead of unifying under the discovery tree, but does not crash and does not block stale-resume Give Up flow.

**FailureContextView.** Per Q3, recommend adding `full_title: string` to the view so the MCP `qa_get_failure_context` consumer sees the hierarchy crumb. Pure-projection update at pause-store-types/src/index.ts:95.

### 2.5 Run handler — `--grep` regex synthesis + CancellationToken (C2)

`extension/src/test-controller.ts:54–67`'s runHandler currently:

```ts
async (request, _token) => {
  const specs = collectSpecUris(request);
  await startSuiteRun(specs);
}
```

v5.5 extension:

```ts
async (request, token) => {
  const plan = planRun(request);  // groups by file; derives anchored --grep for each
  await startSuiteRun({
    specs: plan.specs,
    grep: plan.grepPattern,            // NEW: anchored regex; undefined = run whole file
    cancellationToken: token,          // NEW: forwarded to SessionManager
  });
}
```

`planRun(request)` walks `request.include` recursively. For each leaf TestItem (id matching `::it::`), accumulate `full_title`s grouped by file. The synthesized `--grep` is `^(escape(t1)|escape(t2)|...)$` with the regex metacharacters in each title escaped per the standard table (`. \ ^ $ * + ? ( ) [ ] { } |`) using the existing `escapeRegex` at `extension/src/session-manager.ts:470–472` (REUSE — do NOT re-define) [NB4]. Anchors are explicit so partial title matches don't fire (e.g., running "Login should accept" must NOT also match "Login should accept and then redirect").

**Mocha grep flag-extraction invariant [NB13].** Mocha's `--grep` handling (`mocha@10.8.2/lib/mocha.js:564–573`) parses the value with `re.match(/^\/(.*)\/([gimy]{0,4})$|.*/)` — if the string is shaped `/pattern/flags`, it strips the outer slashes. The synthesized form `^(t1|t2|...)$` cannot trigger this shortcut because its first char after `^` is `(` (alternation parens are mandatory: even a single-selection produces `^(escaped_t1)$` not `^escaped_t1$`). The implementation MUST enforce alternation parens unconditionally so a single-leaf selection cannot degenerate into a slash-shaped string. Document as a structural invariant in the run-handler test.

Test Explorer's groupings:

| User selects | Run handler behavior |
|---|---|
| Root or no `include` | `request.include === undefined` per :18604 → run all (no `--grep`); SessionManager defaults specs to fixture-tests CWD per v5.2 behavior. |
| A file TestItem | `include` contains the file item; descendants are implicit. Run handler emits one spec URI + no `--grep` (Mocha runs all tests in that file). |
| One or more describe TestItems (concrete leaves) | Walk children, collect all it-IDs, derive `--grep` from their `full_title`s using the PRIMARY alternation form (Q6 RESOLVED). Equivalent to selecting all child its directly. |
| One or more describe TestItems (partial leaves) | When a selected describe contains computed-title its OR un-parsed children (parse error in subtree), drop to the FALLBACK prefix form: `^${escape(describePath.join(' '))} .*$` — anchored describe-path prefix + ` ` separator + any-it-title (Q6 RESOLVED). The prefix form risks over-matching nested sibling describes whose path shares the prefix; the `\s` after the prefix bounds the match to the immediate describe. |
| One or more individual it TestItems | Derive `--grep` from the selected `full_title`s; if from different files, emit multiple spec args but a single combined `--grep` (Mocha respects `--grep` per child process; since v5.5 still spawns ONE mocha child per Phase 1 single-session invariant, the combined `--grep` covers all selected files). |
| Mixed file + describe + it | Walk each include item; for items whose subtree is entirely selected, treat as the parent (emit at the file/describe level — no `--grep` adjustment); for items with partial subtree, derive item-by-item `--grep`. Per S3 should-include. |
| `request.exclude` present | Subtract excluded leaves from the include set before deriving `--grep`. Mocha has no native exclude; v5.5 implements via the include-set minus exclude-set. |

**Phase 1 invariant: single mocha session at a time.** Per S3 should-include — v5.5 does NOT spawn parallel children. If the user clicks Run on multiple files, all selected files become spec args to ONE child + a combined `--grep`. SessionManager's `runMocha` opts shape (session-manager.ts:188–250) already accepts `specFiles: string[]` and `grep?: string`; no API change to SessionManager.

**CancellationToken wiring (C2).** SessionManager already owns the child process; v5.5 needs to wire `token.onCancellationRequested → child.kill('SIGTERM')`. The wiring lives in SessionManager (not test-controller) because the child reference is there. Add to `extension/src/session-manager.ts` `runMocha()`:

```ts
opts.cancellationToken?.onCancellationRequested(() => {
  appendInfo(this.deps.channel, `[session-manager] cancellation requested; SIGTERM mocha pid=${child.pid}`);
  try { child.kill('SIGTERM'); } catch { /* already dead */ }
});
```

If a pause is active when cancellation fires, the heartbeat-abandon path in qa-hooks (`onAbandoned: 'give_up'`) resolves the IPC decision; the child exits cleanly. The Test Explorer surfaces the run as cancelled.

### 2.6 `.skip` / `.only` semantics (C3)

`.skip` and `.only` are discovered by the AST parser and surfaced visually:

| Marker | Discovery output | Test Explorer rendering | Run-time |
|---|---|---|---|
| `it.skip(...)` or enclosing `describe.skip(...)` | `DiscoveredTest.skip = true` | TestItem.tags includes `new TestTag('qa-debug.skip')`; `description: '(skip)'` | Mocha won't execute (Mocha's own `.skip` handling at runtime, runnable.js:143); v5.5 emits no `--grep` adjustment. |
| `it.only(...)` (own chain) | `DiscoveredTest.only = true` | `tags` includes `new TestTag('qa-debug.only')`; `description: '(only)'` | Mocha auto-restricts at runtime (its own `.only` system); v5.5's `--grep` does NOT need to exclude non-only tests. |
| `describe.only(...)` (own chain) | `DiscoveredDescribe.only = true`; all children inherit `only_filter_will_skip: true` flag if outside the describe.only subtree | describe TestItem has `(only)` description + only TestTag; child TestItems outside the describe.only subtree get a sibling `only_filter_will_skip` flag (NOT a visible tag; used by the warning logic only) | Mocha's `filterOnly()` (`suite.js:466–489`, runs in `prepare` per `runner.js:1064` BEFORE the per-test grep loop at `:743`) keeps only the describe.only subtree; ALL other tests are dropped regardless of `--grep` match [NB6]. |

**The .only-aware skip-warning logic [NB6 corrected].** v5.5 emits an Output Channel warning when ANY of these conditions hold for a `request.include` selection:
1. **it.only present in scope file**: any test in the include set is outside the it.only subtree of its file AND the file has at least one `it.only`.
2. **describe.only present in scope file** [NB6]: any test in the include set is outside any describe.only subtree of its file AND the file has at least one `describe.only`.

The predicate is therefore `file_has_any_only_marker (it-only OR describe-only) && selected_test_is_outside_only_subtree`. Discovery output is extended with a per-test `only_filter_will_skip: boolean` flag computed at parse time (cheap: walk the tree once, marking each leaf with `would-be-kept-by-filterOnly()`). The Output Channel log: `[test-controller] selection contains <N> test(s) Mocha will skip due to .only filter in <file>`. The warning is informational; the run still proceeds.

TestTags are declared once at controller setup:

```ts
const TAG_SKIP = new vscode.TestTag('qa-debug.skip');
const TAG_ONLY = new vscode.TestTag('qa-debug.only');
```

Per vscode.d.ts:18317 docs, TestTags with the same id are considered identical, so reuse is safe across re-discovery passes.

### 2.7 FileSystemWatcher + debounce (S2)

`workspace.createFileSystemWatcher('**/*.spec.{ts,js}', false, false, false)` (per :14081) at extension activation:

```ts
const watcher = vscode.workspace.createFileSystemWatcher('**/*.spec.{ts,js}', false, false, false);
context.subscriptions.push(watcher);

const debounceMs = 300;   // S2 should-include; rationale below
const pendingReparse = new Map<string, NodeJS.Timeout>();

function scheduleReparse(uri: vscode.Uri): void {
  const key = uri.toString();
  const existing = pendingReparse.get(key);
  if (existing) clearTimeout(existing);
  pendingReparse.set(key, setTimeout(() => {
    pendingReparse.delete(key);
    void reparseFile(uri);
  }, debounceMs));
}

watcher.onDidCreate((uri) => {
  // Add file TestItem + (lazy) parse on first expand
  void addFileItem(uri);
});
watcher.onDidChange(scheduleReparse);
watcher.onDidDelete((uri) => {
  // Remove file TestItem + all its descendants
  const id = uri.toString();
  controller.items.delete(id);
  items.delete(id);
  for (const childId of Array.from(items.keys())) {
    if (childId.startsWith(`${id}::`)) items.delete(childId);
  }
});
```

**Debounce rationale [NB7].** 300ms is implementation-time-tunable; the initial value is chosen to (a) absorb typical editor save-on-keystroke bursts (multi-buffer flushes produce 5–10 `onDidChange` events in <100ms — informal observation, formal measurement deferred to Task #21 F5 smoke), (b) stay well under the 1000ms `files.autoSave` VS Code default so the user perceives the reparse as responsive, (c) not so short that a sustained save-stream (e.g., from `git checkout` flipping many files) over-fires reparse against partially-written files. Task #21 measures the actual onDidChange event flood profile in the F5 smoke and adjusts; the §4.5 test #6 PASS criterion does NOT lock the 300ms exactly, only that re-saving with no body change produces no duplicate items.

**Reparse semantics — id-based replace [NB10].** `reparseFile(uri)` does NOT delete-then-re-add (that would flicker UI state — collapsed/expanded indicators reset; the user's expanded view collapses). The semantics are id-based:

1. Read the new file content, parse to a new `DiscoveredFile`.
2. For each new it/describe id, call `controller.items` (or descendant `TestItemCollection.add`) — per vscode.d.ts:18749 docs, `add` with an existing id replaces in place (preserving expand/collapse state).
3. For each id present in the v5.5-internal `items: Map` but NOT in the new parse, call `parent.children.delete(id)` and `items.delete(id)`.
4. Update the file TestItem's `description` to either `undefined` (clean parse) or `(parse error: …)` per NB11.

The diff-and-merge is on id keys only; label / range / tags are unconditionally re-applied to the kept items (which is idempotent — same value re-assigned).

Debounce protects against editor save-on-keystroke + multi-buffer flushes that produce 5–10 onDidChange events in <300ms for the same file (S2 rationale).

**`items: Map` and `controller.items` sync invariant [Q7 resolved].** Per vscode.d.ts:18749, `TestItemCollection.add(item)` with an existing id replaces. v5.5's internal `items: Map<string, TestItem>` mirrors the controller's tree; the invariant is "every TestItem visible in `controller.items` (or under any of their descendants) is also keyed in `items` by its id, and vice versa." `populateRoot()` re-entry (resolveHandler(undefined) called twice) is therefore idempotent at both layers — same id → replace at controller, same id → set at the Map. Acceptance test §4.5 #10 is added to verify (see §4.5).

### 2.8 Status-bar / decision UX consistency (S5 + S6)

No change required to v5.4's status-bar entry — it remains the ambient pause indicator independent of discovery state. v5.4 §3.7 already specified `click → workbench.view.testing.focus`, which after v5.5 lands on a populated Test Explorer rather than an empty one — the click action becomes meaningfully useful.

S6 decision UX consistency: the existing decision buttons (qa-debug.retry / qa-debug.markPassed / qa-debug.giveUp) are wired both in Test Explorer (via testing/message/content menus from S4_DESIGN) AND in the v5.3 chat-participant (via `stream.button({ command: ... })`). v5.5 changes neither; the same commands fire from both surfaces, producing identical pause-store transitions.

## 3. ARCHITECTURE.md edits

### §2 Component list

Append to the diagram description:

> *"v5.5 adds `extension/src/test-discovery.ts` — a TypeScript Compiler API-based AST parser that walks `*.spec.{ts,js}` files for describe / it / .skip / .only and emits a File→Describe→It hierarchy. `TestController.resolveHandler` is registered and populates the tree on first Test Explorer expand + on FileSystemWatcher events. TestItem ids are bound across discovery + pause-time per §3.8."*

### §3.1 qa-hooks afterEach

Update the §3.1 wire payload spec:

> *"v5.5 augment: the wire `pause.publish` payload gains a required `full_title: string` field set to `this.currentTest.fullTitle()` (Mocha Runnable.fullTitle, runnable.js:206 → titlePath().join(' ')). Both `test` (it()-only title, kept for Output Channel friendliness) and `full_title` (canonical id key) ship side-by-side. Pre-v5.5 oracles / hooks would fail Zod validation on `pause.publish` due to the required field; the in-repo qa-hooks + oracle + extension all land the change in the same commit."*

### §3.6 qa-reporter

No change — reporter consumes `final_decision` which already carries `test_title: test.fullTitle()` (qa-hooks.ts:277). v5.5 leaves the reporter wire unchanged.

### §3.8 (NEW) Test Explorer discovery model

> **§3.8 Test Explorer discovery model (v5.5).**
>
> Test Explorer hierarchy is built by `extension/src/test-discovery.ts` from AST parses of `**/*.spec.{ts,js}` files. `TestController.resolveHandler` (vscode.d.ts:18509) populates the tree lazily:
>
> - **Root populate** (`resolveHandler(undefined)`): workspace scan via `vscode.workspace.findFiles('**/*.spec.{ts,js}', '**/node_modules/**')`. Each file becomes a top-level TestItem with `canResolveChildren = true`. No content parse happens at this stage — the tree shows file leaves with collapsed children indicators.
> - **File expand** (`resolveHandler(fileItem)`): reads the file, parses via `ts.createSourceFile` (typescript@5.9.3), walks describe/it call expressions, builds File → Describe → It TestItems. `.skip` and `.only` are surfaced as `TestTag('qa-debug.skip')` / `TestTag('qa-debug.only')` plus `description` text.
> - **FileSystemWatcher** (created at activate, `**/*.spec.{ts,js}`) keeps the tree in sync: onCreate adds a new file leaf (lazy parse), onChange triggers debounced re-parse (300ms), onDelete removes the file subtree.
>
> TestItem id formula:
>
> | Item type | Id format |
> |---|---|
> | File | `fileUri.toString()` |
> | Describe | `${fileUri}::describe::${describePath.join('>')}` |
> | It (test) | `${fileUri}::it::${fullTitle}` |
>
> `fullTitle` matches Mocha's `Runnable.fullTitle()` so discovery-time and pause-time ids unify (the C1 prerequisite — see §3.1 + §3.8.1 below).
>
> **§3.8.1 Pause→TestItem unification.** When `pause.publish` fires (§4 step 4), the SessionManager looks up the discovery TestItem via `items.get(${fileUri}::it::${pause.full_title})`. If present (the common case once root-populate has run), the existing TestItem is annotated with the failure TestMessage. If absent (race: pause fires before any Test Explorer expand), a placeholder TestItem is created with the same id formula; a subsequent resolveHandler may merge it. The unified id formula prevents the tree from forking into a discovery half and a pause half.
>
> **§3.8.2 Run handler.** The Run profile's `runHandler` walks `request.include`, groups leaves by file, derives an anchored `--grep` pattern from the selected leaves' `full_title`s, and forwards to SessionManager. The `CancellationToken` is wired in SessionManager → `child.kill('SIGTERM')`. See §3.8.3 for `.skip` / `.only` interaction.
>
> **§3.8.3 `.skip` / `.only` semantics.** v5.5 discovers both markers but DOES NOT alter `--grep`; Mocha's runtime handles them (runnable.js:143 for `.skip` propagation; Mocha's own `.only` filter system). When the user's Run-handler selection conflicts with file-level `.only`, v5.5 logs to Output Channel `[test-controller] selection contains tests Mocha will skip due to .only in <file>` so the silent skip is visible.
>
> **§3.8.4 Phase 1 invariant.** Single mocha child session at a time (S3 should-include). Multi-file run = ONE child + combined `--grep`, never multiple parallel children. `--parallel` Mocha mode remains Phase-1-excluded per v5 §2 baseline.
>
> **§3.8.5 Stale-TestItem cleanup.** FileSystemWatcher onDidDelete removes the file's TestItem and all `${fileUri}::*` descendants from `controller.items` (S4 should-include). Rename surfaces as onDidCreate + onDidDelete per FileSystemWatcher contract (:1810); v5.5 treats them as independent operations (drop old subtree, add new subtree).
>
> **§3.8.6 Phase 1 exclusions (binding).** No code lens above describe blocks; no `TestRunProfile.Debug` variant; no `supportsContinuousRun`; no coverage. These are explicit Phase 2 follow-ups in SLICE_PLAN.

### §4 Failure-pause loop sequence

Update step 4 (pause-publish):

> *"4. **mocha-hook publishes pause** via `pause.publish` IPC method. Payload now includes `full_title: currentTest.fullTitle()` (v5.5 addition). The SessionManager transforms wire→stored, calling `pauseStore.setActivePause(stored)`; the stored shape carries `full_title` for TestController.recordPause to look up the discovery TestItem by id."*

### §6 Status

Append:

> *"v5.5 APPROVED YYYY-MM-DD by Ralph-loop reviewer #N. Scope: pre-pause test discovery via TypeScript Compiler API AST parse, `TestController.resolveHandler` populating File→Describe→It hierarchy, `FileSystemWatcher` with 300ms debounce, anchored `--grep` selective-run synthesis, `CancellationToken` wired to SessionManager SIGTERM (C2), `.skip` / `.only` discovery via TestTag + description (C3), required `full_title` field on wire + stored PausePayload (C1), discovery empty + parse-error states (C5), stale TestItem cleanup on file delete. No new MCP tools; no chat-participant changes; v5.4 status-bar unchanged."*

## 4. SLICE_PLAN.md edits

- Promote "Test Explorer pre-population" from "future enhancement" status to a Phase 1 must-have, completed in v5.5.
- Append to **§4 "Out of phase 1 (binding)"** [NB12]:
  - *"Code lens above describe/it call sites (Phase 2)."*
  - *"`TestRunProfile.Debug` variant (Phase 2)."*
  - *"`supportsContinuousRun: true` (Phase 2)."*
  - *"Coverage profile (Phase 2)."*
  - *"Tooling-discovered titles for computed describes/its (Phase 2)."*
  - *"Multi-workspace fixture-dirs (Phase 2)."*

  Per CR-v5.4 NB12 convention, exclusions live in the binding section so a future reviewer can trace what's NOT in Phase 1 in one place.
- Append to Phase 2 follow-ups (forward-looking detail; complements the binding list above):
  - *"Code lens above describe / it call sites for 'Run', 'Debug', 'Continue running' affordances."*
  - *"`TestRunProfile.Debug` variant — launches mocha child under `--inspect-brk` and registers a `vscode.debug.startDebugging` config."*
  - *"`supportsContinuousRun: true` for the Run profile — incremental re-run on file save; requires careful invalidate-on-pause semantics."*
  - *"Coverage profile via mocha + c8/nyc + vscode.tests.TestRun.addCoverage."*
  - *"Tooling-discovered titles for computed describes / its — currently rendered with `description: '(computed title)'` and run only via full-file or full-describe selection; Phase 2 may add a one-shot runtime probe (`mocha --dry-run --reporter=qa-debug-discovery`) that enumerates the actual titles."*
  - *"Multi-workspace fixture-dirs: RelativePattern + per-folder discovery (Phase 1 single-workspace assumption per v5 baseline; multi-workspace is explicit Phase 2)."*

## 4.5 Phase 1 acceptance tests

1. **Workspace scan populates Test Explorer** (BLOCKER). F5 Extension Host on the fixture-tests workspace → open Test Explorer → file leaves for every `*.spec.{ts,js}` under `fixture-tests/` and `fixture-tests-wdio/` appear within 1s of activation; no content parse fires yet (verify via absence of `[test-discovery] parsed` log lines until expand). **Pass criterion:** visual + Output Channel logs.

2. **File expand parses and shows hierarchy** (BLOCKER). Click expand on a fixture file → File → Describe → It TestItems appear; each it() with `.skip` shows `(skip)` description + skip TestTag; each `.only` shows `(only)` description + only TestTag. Range on each TestItem matches the call-site line (verify via Cmd+Click → cursor jumps to it()). **Pass criterion:** visual + range-jump correctness.

3. **PausePayload `full_title` flows end-to-end** (BLOCKER — C1) [NB9 strengthened]. Run a fixture suite that fails at a known test → on pause, the Test Explorer TestItem with id `${fileUri}::it::${fullTitle}` is annotated with the failure (NOT a duplicate item created at lazy-pause time). **Pass criterion (two parts, both required):** (a) grep Output Channel for `[test-controller] paused on id=...::it::...` showing the discovery-formula id (NOT a `${fileUri}::<short title>` legacy id). (b) At end of run, programmatically inspect: the file's TestItem has exactly N children (= count of `it`s discovered for that file by the AST parse), and EXACTLY ONE of those children has the failure TestMessage attached at the failing test's id. No duplicate-id orphan exists at any other position in the tree.

4. **Selective run via Test Explorer** (BLOCKER). Select one describe in Test Explorer → click Run → mocha child spawns with `--grep '^(escaped fullTitle 1|escaped fullTitle 2|...)$'` covering exactly that describe's tests. Verify in Output Channel `[session-manager] spawn mocha cwd=... args=[..., "--grep", "..."]` — the printed pattern matches the selection. Tests outside the selection do NOT run. **Pass criterion:** spawn args inspection + Mocha tally.

5. **Run cancellation kills child** (BLOCKER — C2) [NB14 structural rewording]. Start a fixture run; while paused on a failure, click the Test Explorer Cancel button on the run → child receives SIGTERM AND exits BEFORE the next heartbeat fires (so the abandon path doesn't race the SIGTERM-driven exit). **Pass criterion (structural, not clock-based):** Output Channel shows `[session-manager] cancellation requested; SIGTERM mocha pid=...` AND `[session-manager] mocha exited code=null signal=SIGTERM` AND the exit log line appears chronologically BEFORE any `[session-manager] heartbeat sent ...` line that would have fired AFTER the cancellation timestamp. Verifies cancellation is faster than the heartbeat-abandon round-trip (per qa-hooks heartbeat policy) without baking in an absolute clock budget that may flake in CI.

6. **FileSystemWatcher updates the tree** (BLOCKER). With Test Explorer open + file expanded, edit a fixture spec file (add a new `it('new test', ...)`) → wait 300ms → the new it TestItem appears under the file. Save the file (no body change); verify NO duplicate items appear (the debounce + diff-and-merge holds). Delete a fixture spec → the file's subtree disappears from the tree. **Pass criterion:** visual + Output Channel `[test-discovery] reparse file=... children=N` logs.

7. **Parse error renders as file-level description** (BLOCKER — C5). Introduce a syntax error in a fixture spec (e.g., unclosed `describe(`) → expand the file → file TestItem shows `description: '(parse error: ...)'` AND other expanded files retain their hierarchy (no cascading failure). **Pass criterion:** visual.

8. **Empty workspace shows VS Code's "No tests" state** (NON-BLOCKER — C5). Open a workspace folder with no `*.spec.{ts,js}` files → Test Explorer shows the built-in "No tests found" state; no qa-debug TestItems appear. **Pass criterion:** visual; non-blocker because this is mostly VS Code default behavior.

9. **Stale-resume + discovery interplay** (BLOCKER) [NB16 strengthened]. Run fixture → pause → kill Extension Host → re-F5 → stale-resume notification fires AND status-bar shows AND the stale pause's TestItem appears under the discovery tree at the unified id (NOT as a sibling-of-file orphan). **Pass criterion (regardless of activation ordering):** EXACTLY ONE TestItem exists at the unified id `${stale.fileUri}::it::${stale.full_title}` under the parent file TestItem, with the failure TestMessage attached. Output Channel shows BOTH `[session-manager] stale-resume detected session=...` AND `[test-controller] paused on id=...` for the same id; whichever code path created the item first (discovery resolveHandler OR resumeStalePauseIfAny's placeholder-create), the other path MUST merge into the same id (logged as `[test-controller] merged stale pause into discovery item id=...` or `[test-controller] discovery resolved to existing stale pause item id=...`). NO duplicate items, NO orphan items at any tree position.

10. **resolveHandler(undefined) re-entry idempotency** (BLOCKER) [Q7 resolved + NB10 verification]. With Test Explorer open and root populated, programmatically trigger `resolveHandler(undefined)` a second time (e.g., via the refresh button at TestController.refreshHandler if implemented, OR by collapsing+expanding root in VS Code). **Pass criterion:** file TestItems are unchanged in count and id; expanded items remain expanded; no flicker visible. Output Channel logs `[test-discovery] root populate (re-entry) — N file items unchanged` showing the same N as the first populate.

Failures in 1–7, 9, 10 are blockers. #8 is non-blocking (VS Code default UX; unlikely to fail).

## 5. Risk

- **Wire-schema break: required `full_title` field on `pause.publish` (medium).** Pre-v5.5 oracles / hooks would fail Zod validation. **Mitigation:** Phase 1 has no released consumers other than the in-repo qa-hooks + oracle + extension; landing the change atomically in one commit eliminates the risk. The fixture-tests / fixture-tests-wdio + tools/oracle.ts are in the same monorepo and are updated together. If an external consumer ever appears (Phase 2 packaging), the migration story is a one-line `full_title: data.test_title ?? '<no-fullTitle>'` shim in the wire reader.

- **AST parse cost on large workspaces (low).** A 500-file workspace parses each file lazily (on expand) — total parse cost is O(files * avg-file-size). For typical QA suites (≤200 files, ≤10KB each), total parse <500ms wall clock. The root populate scans via `findFiles` which is O(files) but does NO content read; expand cost is paid only on user interaction. **Mitigation:** debounce + lazy parse keep the hot path off activation. Phase 2 may add an LRU cache if profiling shows reparse churn.

- **Mocha `.only` silent skip surprises users (medium).** A user who selects a TestItem outside the `.only` file scope clicks Run; Mocha silently skips it. **Mitigation:** §2.6 logs to Output Channel — the v5.5 implementation must emit `[test-controller] selection contains tests Mocha will skip due to .only in <file>` when the include set is non-empty AND any file with `.only` is in scope AND the include contains non-only items in that file. Phase 2 may surface as a TestRun.appendOutput warning row.

- **Computed describe / it titles not discoverable (low for Phase 1, high for templated suites in Phase 2).** A test author writing `it(`should ${verb} the ${noun}`, ...)` cannot be statically resolved. **Mitigation:** §2.1 emits a TestItem with `description: '(computed title)'` and `range` at the call site so the user sees the placeholder + can run the whole file. Phase 2 follow-up tracked: `mocha --dry-run --reporter=qa-debug-discovery` probe to enumerate actual titles.

- **TestItem id collision via space-joined fullTitle (low).** If two tests have describe paths that produce the same space-joined string (e.g., `describe('Login') > describe('basic')` vs `describe('Login basic')`), the ids collide. **Mitigation:** Mocha itself has this collision (Mocha's `--grep` cannot disambiguate either; the test authors avoid this in practice). v5.5 inherits Mocha's convention. Phase 2 may switch to a structured id (`${fileUri}::${describePath.join('|')}|${itTitle}`) if user reports collision in practice.

- **`request.exclude` not yet wired (medium for partial Phase 1).** §2.5 specs that exclude is the include set minus the exclude set; implementation must actually handle this. **Mitigation:** §4.5 test #4 should include a sub-case where the user picks a describe THEN unticks one of its tests; verify the unticked test is not in the `--grep`.

- **TypeScript Compiler API as a runtime dep in the extension bundle (low).** `typescript@5.9.3` is ~10MB minified. The extension bundle currently does not include it; v5.5 adds it. **Mitigation:** esbuild externalizes `typescript` and bundles only the API surface used (createSourceFile + forEachChild + a few type guards); bundle size impact ~150–300KB minified. Acceptable for a non-language-server use case.

- **FileSystemWatcher event flood on `git checkout` (low).** A branch switch may flip 50 files at once → 50 onDidChange in <100ms. **Mitigation:** the 300ms debounce per-URI absorbs duplicates per file; cross-file flood is naturally limited to the number of distinct .spec files in the switch.

## 6. Open questions — resolved at iter#2

All Q1–Q8 below were resolved by iter#2 reviewer per their verdict. The resolutions are folded inline into §2 / §3 / §4.5 as cited; this section now records the answers for traceability.

1. **Computed titles — placeholder vs omit.** RESOLVED: render placeholder per §2.1. Visual cue beats silent absence; risk row 4 commits to it.

2. **`FinalDecisionParams.test_title` rename.** RESOLVED as **option (a)**: rename to `full_title`. Folded into §2.4 + the buggy `test-controller.ts:146` `.replace(/^.*? > /, '')` strip is removed as a bundled correctness fix. See §2.4 "FinalDecisionParams rename" paragraph.

3. **`FailureContextView.full_title` expose to MCP consumers.** RESOLVED: yes, add. `toFailureContextView` at `pause-store-types/src/index.ts:95–129` gains the field; the projection is pure (no behavior change for non-MCP consumers). Agents reasoning about suite hierarchy benefit.

4. **MementoPauseStore migration normalization site.** RESOLVED: option (a) — normalize at MementoPauseStore READ sites via a `normalizeStoredPause(raw)` helper exported from `pause-store-types`. See §2.4 "MementoPauseStore migration" paragraph for the helper signature.

5. **`.only` warning rendering.** RESOLVED: Output Channel for Phase 1 default + `TestRun.appendOutput` as secondary surface (near-free; the Output Channel is easy to miss). Per NB6, the warning predicate covers BOTH `it.only` AND `describe.only`. Decoration / modal dialog deferred to Phase 2 with telemetry.

6. **Describe-level grep form.** RESOLVED: dual form. PRIMARY = alternation `^(escape(t1)|escape(t2)|...)$` when leaves are concrete (all describe children's `full_title`s are known). FALLBACK = prefix-anchored `^<escaped describePath joined with space> .*$` when leaves are partial (computed titles in subtree OR per-file parse error that didn't enumerate children). §2.5 table extended with a "Selected describe (partial leaves)" row. The §4.5 test #4 splits into two sub-cases.

7. **resolveHandler(undefined) re-entry idempotency.** RESOLVED: confirmed via vscode.d.ts:18749 — `TestItemCollection.add(item)` with existing id replaces in place. §2.7 documents the `items: Map` ↔ `controller.items` sync invariant. §4.5 acceptance test #10 (added) verifies.

8. **`tsconfig` `lib` / `@types/node`.** RESOLVED: implementation-time concern, not CR-level. The extension package already includes `@types/node` (visible from session-manager.ts using `NodeJS.ProcessEnv`). Task #21 verifies at F5 build; no CR change required.

## 7. Recommendation

Apply v5.5 as drafted. Cap=3 per CR-v5.4 precedent. The CR introduces the largest single-CR surface change in the project so far (new module + extended controller + wire schema + stored schema + 4 cross-package edits); iter#2 may surface meaningful blockers. Implementation (Task #21) follows iter#2 APPROVE.

Sequence: v5.4 Task #20 (chat-flow refinement implementation) should land BEFORE v5.5 Task #21 [NB15 corrected]. v5.4's Task #20 touches `session-manager.ts` `pause.publish` handler (notification revert + status-bar wiring) while v5.5 Task #21 also touches the same handler (wire→stored transformation gains `full_title` forwarding); landing them in order avoids rebase conflicts in one commit instead of two. (The prior draft also claimed §3.8.5 stale-TestItem cleanup depends on v5.4 status-bar lifecycle — that claim was wrong; the two react to independent event surfaces, FileSystemWatcher events vs pause.publish/decision-commit events, with no shared state.)

## 8. Status

- **Iteration #1 (this file)** — 2026-05-21 file write. No in-conversation iter#0 prior to this file (unlike v5.4); the design was drafted in conversation but not formally Ralph-reviewed before file write. All §0 platform-owned URL citations were installed-source-verified before this draft (CR-v5.4 NB11 process discipline applied). Q1–Q8 open for iter#2.
- **Iteration #2** — 2026-05-21. Ralph-loop reviewer #8 (general-purpose subagent) returned **APPROVE-with-polish** — 0 blockers, 16 non-blockers (NB1–NB16), Q1–Q7 inline-resolved + Q8 deferred to implementation. Prediction: iter#3 expected for convergence. NBs applied inline in this iter#2 polish pass:
  - **NB1** dropped wrong SyntaxKind.CallExpression citation (:5120 → actual :3893); the enum value is unused (traversal uses `ts.isCallExpression` type guard at :9023).
  - **NB2** added §0 citation for `workspace.findFiles` at vscode.d.ts:14100.
  - **NB3** documented separator-injection invariant in §2.3 — Phase 1 contract: test titles MUST NOT contain `::it::` / `::describe::` substrings; AST parser emits warning if so.
  - **NB4** §2.5 grep escaping now explicitly reuses existing `escapeRegex` at session-manager.ts:470–472 (no re-define).
  - **NB5 / Q4** MementoPauseStore normalization site corrected — `normalizeStoredPause` helper lives in pause-store-types but called at MementoPauseStore read sites (`peekActivePause` + `getActivePause`); chat-participant + decision-router both consume normalized shape.
  - **NB6** `.only` warning predicate corrected — covers BOTH it.only AND describe.only (Mocha's `filterOnly()` at suite.js:466–489 keeps only the describe.only subtree).
  - **NB7** debounce rationale added — 300ms is initial value, implementation-time-tunable; §4.5 test #6 doesn't lock the exact ms.
  - **NB8 / Q2** `FinalDecisionParams.test_title` → `full_title` rename adopted (option (a)); test-controller.ts:146 buggy `.replace(/^.*? > /, '')` strip deleted as bundled correctness fix (Mocha joins with space, never `> `).
  - **NB9** §4.5 test #3 strengthened — two-part pass criterion (Output Channel log + programmatic single-TestItem-per-id verification).
  - **NB10** §2.7 reparse semantics now explicit — id-based replace (no flicker; preserves expand/collapse state); `items: Map` ↔ `controller.items` sync invariant documented.
  - **NB11** §2.1 + §0 corrected — `ts.createSourceFile` does NOT throw; check `sourceFile.parseDiagnostics.length > 0` instead of try/catch.
  - **NB12** §3.8.6 exclusions also append to SLICE_PLAN §4 "Out of phase 1 (binding)" per CR-v5.4 convention (not only Phase-2 follow-ups).
  - **NB13** §2.5 Mocha grep flag-extraction invariant documented — alternation parens are mandatory so a single-leaf selection cannot degenerate into `/pattern/flags` shape (mocha.js:564–573).
  - **NB14** §4.5 test #5 cancellation criterion restructured — structural (exits before next heartbeat) rather than clock-based ("5s").
  - **NB15** §7 sequencing rationale corrected — drop the wrong "§3.8.5 depends on v5.4 status-bar" claim; keep (b) session-manager.ts:264–304 overlap as sufficient justification.
  - **NB16** §4.5 test #9 stale-resume + discovery interplay strengthened — single-TestItem-per-id criterion regardless of activation ordering, with both code paths' merge logs verifiable.
  - **§4.5 acceptance test #10** ADDED — resolveHandler(undefined) re-entry idempotency per Q7.
  - **§2.4 FailureContextView** gains `full_title` per Q3.
- **Iteration #3** — 2026-05-21. Ralph-loop reviewer #9 (general-purpose subagent) audited all 16 iter#2 NBs as applied; returned **APPROVE-with-polish** convergence verdict — 0 new blockers; 5 polish-on-polish citation nits (NB17–NB21) classified as author-discretion at implementation time per cap=3 precedent. Three trivial citation fixes applied inline in this iter#3 pass:
  - **NB17** Mocha `Suite.prototype.fullTitle` citation corrected `suite.js:41–43` → `suite.js:380–382` (cosmetic; same `titlePath().join(' ')` body).
  - **NB19** Mocha `filterOnly()` prepare-call line corrected `runner.js:1063` → `runner.js:1064`.
  - **NB21** §4.5 #5 magic "5s × 3 = 15s" aside dropped; structural criterion alone is the pass gate.
  - **NB18** vscode TestItem field anchors with ±1 drift — DEFERRED to Task #21 (all anchors still land inside the correct interface body; cosmetic).
  - **NB20** normalizeStoredPause type-assertion vs Zod-schema validation — DEFERRED to Task #21 (implementation-time concern; the stored shape is untrusted-globalState by design; defensive coercion is the right pattern).
- **ARCHITECTURE-CR-v5.5 APPROVED 2026-05-21** (Ralph-loop reviewer #9 APPROVE-with-polish at iter#3 convergence; 16 iter#2 NBs applied inline in iter#2 polish pass; 3 iter#3 NBs applied inline + 2 deferred; cap=3 closure per CR-v5.1 / CR-v5.2 / CR-v5.3 / CR-v5.4 precedent). Task #21 (implementation) may begin after Task #20 (v5.4 implementation) lands per §7 sequencing.
