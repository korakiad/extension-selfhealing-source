/**
 * Prefix-tolerant response-body parsing for the company TestRail gateway,
 * which glues an opaque ASCII status token in front of (potentially every)
 * response body: `USERAUTHENSUCESSFULLY{...}`. Token vocabulary is unknown, so
 * the prefix is treated as opaque text — the HTTP status code stays the only
 * authority on success/failure.
 *
 * Pure module (no vscode, no fetch) — unit-tested by
 * extension/test/testrail-parse.test.mts. The CALLER (client.ts) owns logging:
 * prefix/suffix text and ambiguity warnings go to the output channel only and
 * never reach the model.
 */

export interface ParsedBody {
  data: unknown;
  /** Trimmed gateway text found before the chosen JSON extent, or null. */
  prefix: string | null;
  /** Trimmed text found after the chosen JSON extent, or null. */
  suffix: string | null;
  /**
   * Set when >= 2 disjoint parseable JSON extents were found — the selection
   * picked one (end-of-input preferred, else longest), but the caller should
   * log all extents as an ambiguity warning. Positions are into the trimmed
   * input.
   */
  ambiguousExtents?: Array<{ start: number; end: number }>;
}

export class TestRailParseError extends Error {
  constructor(
    /** First ~200 chars of the body. OUTPUT-CHANNEL ONLY — a gateway/SSO page
     *  embeds internal hostnames; never put the snippet in a model-visible
     *  message. */
    public readonly snippet: string,
    public readonly hint?: string,
  ) {
    super(hint ?? 'unparseable body');
    this.name = 'TestRailParseError';
  }
}

/** Candidate starts are only searched within this prefix window. */
const SCAN_WINDOW = 64 * 1024;
/** Work floor for the body-length-aware cap (see scan loop). */
const WORK_FLOOR = 5_000_000;
const SNIPPET_LEN = 200;

export function parseTestRailBody(raw: string): ParsedBody {
  // trim() strips BOM (U+FEFF is ES whitespace) + leading newlines; everything
  // below operates on the SAME trimmed string that gets parsed.
  const text = raw.trim();
  if (text === '') return { data: null, prefix: null, suffix: null };

  // Fast path: the whole body is JSON (no gateway interference).
  if (text[0] === '{' || text[0] === '[') {
    try {
      return { data: JSON.parse(text), prefix: null, suffix: null };
    } catch {
      // fall through to the scanner (e.g. `{payload}TRAILER`)
    }
  }

  // Quirk path: string-aware bracket-depth scan. Selection bias: prefer the
  // extent ending at end-of-input (matches the OBSERVED prepending gateway and
  // resolves a JSON-shaped envelope PREFIX); else longest, ties → earliest.
  // Known limit (PLAN-testrail D6): a JSON-shaped SUFFIX envelope mis-selects
  // the trailer — pinned by test, revisited only on gateway evidence.
  const workCap = Math.max(2 * text.length, WORK_FLOOR);
  let work = 0;
  const successes: Array<{ start: number; end: number; data: unknown }> = [];
  const windowEnd = Math.min(text.length, SCAN_WINDOW);

  for (let i = 0; i < windowEnd; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    // Skip candidates nested inside an already-parsed extent — only disjoint
    // top-level extents matter for selection/ambiguity.
    const last = successes[successes.length - 1];
    if (last && i <= last.end) continue;

    const end = walkBalancedExtent(text, i, () => {
      if (++work > workCap) {
        throw new TestRailParseError(text.slice(0, SNIPPET_LEN), 'scan work cap exceeded');
      }
    });
    if (end === -1) continue;
    let data: unknown;
    try {
      data = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    if (end === text.length - 1) {
      // At most one extent can end at end-of-input — short-circuit winner.
      return finish(text, { start: i, end, data }, successes);
    }
    successes.push({ start: i, end, data });
  }

  if (successes.length === 0) {
    const snippet = text.slice(0, SNIPPET_LEN);
    throw new TestRailParseError(
      snippet,
      /<html|<!doctype|<head|<body/i.test(snippet)
        ? 'looks like a gateway/SSO login page'
        : undefined,
    );
  }
  // No extent reached end-of-input: take the longest (earliest on ties — the
  // scan order plus strict > comparison gives that for free).
  let best = successes[0];
  for (const s of successes) {
    if (s.end - s.start > best.end - best.start) best = s;
  }
  return finish(text, best, successes);
}

function finish(
  text: string,
  chosen: { start: number; end: number; data: unknown },
  others: Array<{ start: number; end: number }>,
): ParsedBody {
  const disjoint = others.filter((s) => s.start !== chosen.start);
  const prefix = text.slice(0, chosen.start).trim();
  const suffix = text.slice(chosen.end + 1).trim();
  const out: ParsedBody = {
    data: chosen.data,
    prefix: prefix === '' ? null : prefix,
    suffix: suffix === '' ? null : suffix,
  };
  if (disjoint.length > 0) {
    out.ambiguousExtents = [...disjoint, { start: chosen.start, end: chosen.end }].sort(
      (a, b) => a.start - b.start,
    );
  }
  return out;
}

/**
 * Walks a balanced {}/[] extent starting at `start` (which must be `{` or
 * `[`), tracking string literals + escapes so braces inside strings don't
 * count. Returns the index of the closing bracket, or -1 if the input ends
 * unbalanced. Bracket TYPE pairing is left to JSON.parse.
 */
function walkBalancedExtent(text: string, start: number, tick: () => void): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let k = start; k < text.length; k++) {
    tick();
    const c = text[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return k;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

// ---- get_bdd (Gherkin) route ------------------------------------------------

/**
 * High-precision Gherkin openers. The observed gateway glues its token on the
 * SAME line (`USERAUTHENSUCESSFULLYFeature: login`), so we split at the
 * earliest OCCURRENCE, not at line starts. Bare `#`/`@` are deliberately NOT
 * anchors — a mid-file comment or tag would silently discard the real header.
 */
const GHERKIN_OPENERS = ['Feature:', 'Business Need:', 'Ability:', '# language:'];

/**
 * Splits an opaque gateway prefix off a `.feature` body. Returns null when no
 * opener is found anywhere (caller must treat that as PARSE_ERROR — an
 * opener-less short body is exactly what a gateway-token-only response looks
 * like, and raw gateway bytes must never reach the model).
 */
export function splitGherkin(raw: string): { text: string; prefix: string | null } | null {
  const body = raw.trim();
  let at = -1;
  for (const opener of GHERKIN_OPENERS) {
    const i = body.indexOf(opener);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return null;
  const prefix = body.slice(0, at).trim();
  return { text: body.slice(at), prefix: prefix === '' ? null : prefix };
}
