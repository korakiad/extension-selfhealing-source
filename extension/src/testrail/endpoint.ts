/**
 * Endpoint-string validation + verb gate for the qa_testrail_* tools
 * (PLAN-testrail D2). Pure module — unit-tested without vscode.
 *
 * An endpoint is the exact path after `/api/v2/`, e.g.
 * `get_cases/14&suite_id=8&limit=50`. The whole TestRail API path lives in one
 * query string, so params append with `&`; the client prepends
 * `{baseUrl}/index.php?/api/v2/`.
 */

import * as nodePath from 'node:path';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

/** Complete documented GET surface: get_* + the two report runners. */
const GET_VERB = /^(get_\w+|run_report|run_cross_project_report)$/;
/** Complete documented write surface (124-endpoint index verified). */
const WRITE_VERB = /^(add|update|delete|close|move|copy)_\w+$/;
/** Write endpoints the post tool refuses (PLAN-testrail D3): add_bdd's request
 *  body is raw .feature text with an UNCLEAR mechanism in the official docs —
 *  a JSON body may store mangled Gherkin rather than fail safe. */
const UNSUPPORTED_POST = new Set(['add_bdd']);

export type VerbClass = 'read' | 'write' | 'unknown';

/** First path segment of the endpoint: `get_cases/14&x=1` → `get_cases`. */
export function firstSegment(endpoint: string): string {
  return endpoint.split('&', 1)[0].split('/', 1)[0];
}

export function classifyVerb(endpoint: string): VerbClass {
  const seg = firstSegment(endpoint);
  if (GET_VERB.test(seg)) return 'read';
  if (WRITE_VERB.test(seg)) return 'write';
  return 'unknown';
}

export function isUnsupportedPost(endpoint: string): boolean {
  return UNSUPPORTED_POST.has(firstSegment(endpoint));
}

/**
 * Injection guard. Throws INVALID_ENDPOINT on: scheme smuggling, leading `/`,
 * whitespace/control chars (values with spaces must be percent-encoded),
 * `#` (fetch fragment-truncates every following param), any `?` (the base URL
 * already carries the one query `?`), and `..` in the path part (the segment
 * before the first `&` — free-text filter VALUES like `&filter=1..5` are
 * legitimate).
 */
export function validateEndpointSyntax(endpoint: string): void {
  const fail = (why: string): never => {
    throw new QaToolError('INVALID_ENDPOINT', `${why} (endpoint: ${endpoint.slice(0, 80)})`);
  };
  if (endpoint.length === 0) fail('endpoint is empty');
  if (endpoint.includes('://')) fail('endpoint must not contain a URL scheme');
  if (endpoint.startsWith('/')) fail('endpoint must not start with /');
  if (/[\s\u0000-\u001f]/.test(endpoint)) {
    fail('endpoint must not contain whitespace/control chars — percent-encode values');
  }
  if (endpoint.includes('#')) fail("endpoint must not contain '#'");
  if (endpoint.includes('?')) fail("endpoint must not contain '?' — append params with &");
  const pathPart = endpoint.split('&', 1)[0];
  if (pathPart.includes('..')) fail("endpoint path must not contain '..'");
}

/**
 * Removes caller-supplied offset/limit params — under paginate:true the client
 * owns paging (duplicate-param behavior must not depend on PHP's
 * last-occurrence accident).
 */
export function stripPagingParams(endpoint: string): string {
  const [path, ...params] = endpoint.split('&');
  const kept = params.filter((p) => !/^(offset|limit)=/.test(p));
  return [path, ...kept].join('&');
}

/**
 * Strip-semantics sanitizer for the get_attachment id used as the saved
 * filename key. Allowed set includes `-`: TestRail 7.1+ Cloud attachment ids
 * are UUID strings. Empty after strip → 'attachment'.
 */
export function sanitizeAttachmentId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9-]/g, '');
  return cleaned === '' ? 'attachment' : cleaned;
}

/**
 * Containment predicate for attachment paths (PLAN-testrail D4). Both paths
 * must already be realpath'd by the caller. `path.relative` alone is not
 * enough: on Windows a cross-drive/UNC pair makes it return the ABSOLUTE
 * target, which does not start with '..' — hence the isAbsolute check.
 * `pathMod` is parameterized so tests can exercise the win32 branch on any OS.
 */
export function isContained(
  realRoot: string,
  realCandidate: string,
  pathMod: Pick<typeof nodePath, 'relative' | 'isAbsolute'> = nodePath,
): boolean {
  const rel = pathMod.relative(realRoot, realCandidate);
  if (rel === '') return false; // the root itself is not an uploadable file
  return !rel.startsWith('..') && !pathMod.isAbsolute(rel);
}
