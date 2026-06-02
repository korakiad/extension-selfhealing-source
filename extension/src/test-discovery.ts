/**
 * Test-file AST discovery for Test Explorer pre-population.
 *
 * Parses `*.spec.{ts,js}` files via the TypeScript
 * Compiler API and emits a File → Describe → It hierarchy. Does NOT execute
 * the file — pure static analysis.
 *
 * Identification rules:
 *   - Callee `describe` / `it` (or `.skip` / `.only`) via Identifier or
 *     PropertyAccessExpression. Anything else (custom test helpers,
 *     `context()`, `specify()`) is ignored — Phase 1 sticks to canonical Mocha
 *     BDD names.
 *   - First arg is a string literal (or no-substitution template) → title.
 *     Anything else (variable, template with interpolation, call expr) =
 *     computed title; rendered as `(computed title)` placeholder.
 *   - For `describe`, walk the body of the second arg when it is a function /
 *     arrow expression; otherwise emit no children (opaque suite).
 *
 * Parse errors: `ts.createSourceFile` does NOT throw (returns SourceFile with
 * `parseDiagnostics` attached per NB11). Detect via
 * `sourceFile.parseDiagnostics.length > 0` and return `parseError` on the
 * DiscoveredFile; partial children are still emitted (recovery parse).
 *
 * `.only` filter annotation (NB6): post-walk pass marks each leaf with
 * `only_filter_will_skip` true iff the file contains any `.only` marker AND
 * the leaf is outside every `.only` subtree (matches Mocha's filterOnly() at
 * suite.js:466–489).
 */

import * as ts from 'typescript';
import type * as vscode from 'vscode';

export const COMPUTED_TITLE_PLACEHOLDER = '(computed title)';

export interface DiscoveredTest {
  readonly kind: 'it';
  readonly fullTitle: string;
  readonly title: string;
  readonly describePath: readonly string[];
  readonly line: number;
  /** Includes inherited skip from any ancestor describe.skip. */
  readonly skip: boolean;
  /** Own-chain `.only` (does NOT include ancestor describe.only). */
  readonly only: boolean;
  readonly computedTitle: boolean;
  /** True if title contains `::it::` or `::describe::` literal substrings (NB3). */
  readonly reservedSeparator: boolean;
  /**
   * NB6: true iff file has any `.only` marker AND this leaf is outside every
   * `.only` subtree. Mocha's filterOnly() drops these BEFORE per-test grep.
   */
  only_filter_will_skip: boolean;
}

export interface DiscoveredDescribe {
  readonly kind: 'describe';
  readonly title: string;
  readonly describePath: readonly string[];
  readonly line: number;
  readonly skip: boolean;
  readonly only: boolean;
  readonly computedTitle: boolean;
  readonly reservedSeparator: boolean;
  readonly children: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>;
}

export interface DiscoveredFile {
  readonly uri: vscode.Uri;
  readonly children: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>;
  /** Set if `ts.createSourceFile` produced parseDiagnostics. Children still populated best-effort. */
  readonly parseError?: string;
}

/** Mocha's titlePath().join(' ') — runnable.js:206. The canonical id key. */
export function discoveryFullTitle(describePath: readonly string[], title: string): string {
  return [...describePath, title].join(' ');
}

interface CalleeInfo {
  base: 'describe' | 'it';
  modifier?: 'skip' | 'only';
}

function classifyCallee(expr: ts.Expression): CalleeInfo | undefined {
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'describe' || expr.text === 'it') return { base: expr.text };
    return undefined;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    ts.isIdentifier(expr.name)
  ) {
    const base = expr.expression.text;
    if (base !== 'describe' && base !== 'it') return undefined;
    const mod = expr.name.text;
    if (mod === 'skip' || mod === 'only') return { base, modifier: mod };
    return undefined;
  }
  return undefined;
}

function extractTitle(arg: ts.Expression | undefined): { title: string; computed: boolean } {
  if (!arg) return { title: COMPUTED_TITLE_PLACEHOLDER, computed: true };
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { title: arg.text, computed: false };
  }
  return { title: COMPUTED_TITLE_PLACEHOLDER, computed: true };
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  // 1-based to match Mocha + the editor's line numbering.
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function hasReservedSeparator(title: string): boolean {
  return title.includes('::it::') || title.includes('::describe::');
}

export function parseSpec(uri: vscode.Uri, sourceText: string): DiscoveredFile {
  const source = ts.createSourceFile(
    uri.fsPath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  // `parseDiagnostics` is a stable runtime field on SourceFile (since TS 3.x)
  // but is not exposed by the public `interface SourceFile`. Spinning up a
  // Program just for parse-error detection is overkill; cast through.
  const diags =
    (source as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics ?? [];
  let parseError: string | undefined;
  if (diags.length > 0) {
    const first = diags[0];
    parseError =
      typeof first.messageText === 'string'
        ? first.messageText
        : first.messageText.messageText;
  }

  function walk(
    container: ts.Node,
    currentPath: readonly string[],
    inheritedSkip: boolean,
  ): Array<DiscoveredDescribe | DiscoveredTest> {
    const out: Array<DiscoveredDescribe | DiscoveredTest> = [];
    ts.forEachChild(container, (node) => {
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return;
      const call = node.expression;
      const callee = classifyCallee(call.expression);
      if (!callee) return;

      const { title, computed } = extractTitle(call.arguments[0]);
      const ownSkip = callee.modifier === 'skip';
      const ownOnly = callee.modifier === 'only';
      const totalSkip = inheritedSkip || ownSkip;
      const line = lineOf(call, source);
      const reservedSeparator = hasReservedSeparator(title);

      if (callee.base === 'describe') {
        const fnArg = call.arguments[1];
        let children: Array<DiscoveredDescribe | DiscoveredTest> = [];
        if (fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
          const body = fnArg.body;
          // Arrow-with-expression-body (e.g., `() => describe(...)`) isn't a
          // Block — only walk when body has statements.
          if (ts.isBlock(body)) {
            children = walk(body, [...currentPath, title], totalSkip);
          }
        }
        out.push({
          kind: 'describe',
          title,
          describePath: currentPath,
          line,
          skip: totalSkip,
          only: ownOnly,
          computedTitle: computed,
          reservedSeparator,
          children,
        });
        return;
      }

      // it
      out.push({
        kind: 'it',
        title,
        fullTitle: discoveryFullTitle(currentPath, title),
        describePath: currentPath,
        line,
        skip: totalSkip,
        only: ownOnly,
        computedTitle: computed,
        reservedSeparator,
        only_filter_will_skip: false, // annotated post-walk
      });
    });
    return out;
  }

  const children = walk(source, [], false);

  // NB6 post-pass: mark leaves Mocha's filterOnly() would drop.
  annotateOnlyFilter(children);

  return { uri, children, parseError };
}

function annotateOnlyFilter(
  children: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>,
): void {
  const hasAnyOnly = treeContainsOnly(children);
  if (!hasAnyOnly) return; // every leaf stays at default false
  annotate(children, /* ancestorOnly */ false);
}

function treeContainsOnly(
  items: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>,
): boolean {
  for (const item of items) {
    if (item.only) return true;
    if (item.kind === 'describe' && treeContainsOnly(item.children)) return true;
  }
  return false;
}

function annotate(
  items: ReadonlyArray<DiscoveredDescribe | DiscoveredTest>,
  ancestorOnly: boolean,
): void {
  for (const item of items) {
    const inOnlySubtree = ancestorOnly || item.only;
    if (item.kind === 'it') {
      item.only_filter_will_skip = !inOnlySubtree;
    } else {
      annotate(item.children, inOnlySubtree);
    }
  }
}
