/**
 * TestRail API v2 client (PLAN-testrail D7). No vscode import — constructor
 * injection only, so the whole client is unit-testable against a local HTTP
 * stub (extension/test/testrail-client.test.mts).
 *
 * Leak rules this file enforces (the PLAN invariant):
 *  - The instance URL is a SECRET. Log lines carry method + endpoint + status
 *    + duration only; NETWORK_ERROR surfaces a category to the model and the
 *    raw cause goes to the log sink.
 *  - Gateway prefix/suffix TEXT stays here: it is logged, then converted to
 *    hadPrefix/hadSuffix booleans before anything reaches the tool layer
 *    (whose jsonResult serializes the entire payload to the model).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import {
  sanitizeAttachmentId,
  stripPagingParams,
  validateEndpointSyntax,
} from './endpoint.js';
import { parseTestRailBody, splitGherkin, TestRailParseError } from './parse.js';

export interface TestRailClientConfig {
  /** Normalized instance URL, no trailing slash, no index.php. SECRET. */
  baseUrl: string;
  username: string;
  apiKey: string;
}

export interface TestRailClientDeps {
  /** Output-channel sink. Receives endpoint/status lines + gateway bytes. */
  log: (line: string) => void;
  /** Resolves the attachments dir (creating it); throws NO_WORKSPACE when no
   *  folder is open. Injected because workspace lookup is a vscode facility. */
  attachmentsDir: () => string;
  /** Test seam for the 429 wait. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TestRailResponse {
  data: unknown;
  status: number;
  hadPrefix: boolean;
  hadSuffix: boolean;
  nonJson?: boolean;
  paginated?: { pages: number; truncated: boolean; truncatedBy?: 'cap' | 'rate_limit' };
}

export interface SavedAttachment {
  saved_to: string;
  bytes: number;
  content_type: string;
  display_name: string | null;
  possiblePrefix?: boolean;
}

const JSON_TIMEOUT_MS = 30_000;
/** 256MB-class transfers on a corporate VPN don't fit 30s. */
const BINARY_TIMEOUT_MS = 180_000;
const RETRY_AFTER_DEFAULT_S = 5;
const RETRY_AFTER_CAP_S = 30;
const PAGINATE_MAX_PAGES = 8;
const PAGINATE_MAX_RECORDS = 2000;
const PAGE_LIMIT = 250;
const TEXT_SIZE_CAP = 256 * 1024;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json',
  'video/mp4': '.mp4',
};

const BINARY_CONTENT_TYPE = /^(image|audio|video)\/|^application\/(octet-stream|pdf|zip|gzip|x-tar)/i;

export class TestRailClient {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: TestRailClientConfig,
    private readonly deps: TestRailClientDeps,
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getJson(endpoint: string, opts?: { paginate?: boolean }): Promise<TestRailResponse> {
    validateEndpointSyntax(endpoint);
    if (!opts?.paginate) {
      const res = await this.fetchRaw('GET', endpoint, { kind: 'json' });
      return this.parseJsonResponse('GET', endpoint, res);
    }
    return this.getPaginated(endpoint);
  }

  async postJson(endpoint: string, body?: Record<string, unknown>): Promise<TestRailResponse> {
    validateEndpointSyntax(endpoint);
    const res = await this.fetchRaw('POST', endpoint, { kind: 'json', body });
    return this.parseJsonResponse('POST', endpoint, res);
  }

  /** get_bdd route — Gherkin text; the JSON scanner is deliberately skipped
   *  (a .feature with a JSON docstring would be mis-extracted). */
  async getText(endpoint: string): Promise<TestRailResponse> {
    validateEndpointSyntax(endpoint);
    const res = await this.fetchRaw('GET', endpoint, { kind: 'json' });
    await this.throwOnHttpError('GET', endpoint, res);
    const raw = await res.text();
    const split = splitGherkin(raw);
    if (!split) {
      this.deps.log(`[testrail] get_bdd body had no Gherkin opener; body: ${raw.slice(0, 400)}`);
      throw new QaToolError(
        'PARSE_ERROR',
        'response was not recognizable Gherkin — detail in the QA Debug output channel',
      );
    }
    if (split.prefix) this.logGatewayBytes(endpoint, split.prefix, null);
    if (split.text.length > TEXT_SIZE_CAP) {
      const saved = this.saveToAttachments('bdd', '.feature', Buffer.from(split.text, 'utf-8'), 'text/plain', null);
      return { data: saved, status: res.status, hadPrefix: split.prefix != null, hadSuffix: false, nonJson: true };
    }
    return {
      data: split.text,
      status: res.status,
      hadPrefix: split.prefix != null,
      hadSuffix: false,
      nonJson: true,
    };
  }

  /** get_attachment route — saves bytes (any content-type; attachments can
   *  legitimately be .txt/.log) under .qa-debug/attachments/<id>.<ext>. */
  async getBinary(endpoint: string): Promise<SavedAttachment & { status: number }> {
    validateEndpointSyntax(endpoint);
    const res = await this.fetchRaw('GET', endpoint, { kind: 'binary' });
    await this.throwOnHttpError('GET', endpoint, res);
    const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    const bytes = Buffer.from(await res.arrayBuffer());
    // id = path segment after get_attachment/, re-sanitized independently of
    // the endpoint guard (strip semantics; UUID ids keep their hyphens).
    const rawId = endpoint.split('&', 1)[0].split('/').slice(1).join('-');
    const id = sanitizeAttachmentId(rawId);
    const ext = EXT_BY_CONTENT_TYPE[contentType] ?? '.bin';
    const dispName = parseContentDispositionName(res.headers.get('content-disposition'));
    const saved = this.saveToAttachments(id, ext, bytes, contentType, dispName);
    // Prefix-corruption detection: binary content-type but the body opens with
    // a printable-ASCII run before any magic bytes → flag, never strip.
    if (BINARY_CONTENT_TYPE.test(contentType) && looksTextPrefixed(bytes)) {
      saved.possiblePrefix = true;
      this.deps.log(`[testrail] WARN ${endpoint}: binary body opens with printable ASCII — gateway prefix suspected; file saved unmodified`);
    }
    return { ...saved, status: res.status };
  }

  async postAttachment(endpoint: string, filePath: string): Promise<TestRailResponse> {
    validateEndpointSyntax(endpoint);
    const form = new FormData();
    const fileBuf = await fs.promises.readFile(filePath);
    // Official field name per the API docs' curl example: -F "attachment=@…"
    form.append('attachment', new Blob([fileBuf]), path.basename(filePath));
    const res = await this.fetchRaw('POST', endpoint, { kind: 'multipart', form });
    return this.parseJsonResponse('POST', endpoint, res);
  }

  // ---- internals ------------------------------------------------------------

  private buildUrl(endpoint: string): string {
    return `${this.cfg.baseUrl}/index.php?/api/v2/${endpoint}`;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.cfg.username}:${this.cfg.apiKey}`).toString('base64');
  }

  /** One fetch + the single Retry-After retry on 429. Network failures are
   *  scrubbed to a category here — raw cause only to the log sink. */
  private async fetchRaw(
    method: 'GET' | 'POST',
    endpoint: string,
    payload: { kind: 'json' | 'binary'; body?: Record<string, unknown> } | { kind: 'multipart'; form: FormData },
  ): Promise<Response> {
    const url = this.buildUrl(endpoint);
    const timeout = payload.kind === 'json' ? JSON_TIMEOUT_MS : BINARY_TIMEOUT_MS;
    const attempt = async (): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const headers: Record<string, string> = { Authorization: this.authHeader() };
        let body: string | FormData | undefined;
        if (payload.kind === 'multipart') {
          body = payload.form; // fetch sets the multipart boundary header itself
        } else {
          // Required header per the official docs — on GETs too.
          headers['Content-Type'] = 'application/json';
          if (method === 'POST') body = JSON.stringify(payload.body ?? {});
        }
        const started = Date.now();
        const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
        this.deps.log(`[testrail] ${method} ${endpoint} -> ${res.status} (${Date.now() - started}ms)`);
        return res;
      } catch (err) {
        throw this.toNetworkError(err);
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await attempt();
    if (res.status === 429) {
      const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      const waitS = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, RETRY_AFTER_CAP_S) : RETRY_AFTER_DEFAULT_S;
      this.deps.log(`[testrail] 429 on ${endpoint}; retrying once in ${waitS}s`);
      await this.sleep(waitS * 1000);
      res = await attempt();
      if (res.status === 429) {
        throw new QaToolError('RATE_LIMITED', `TestRail rate limit persisted after one retry (${endpoint})`);
      }
    }
    return res;
  }

  private toNetworkError(err: unknown): QaToolError {
    if (err instanceof QaToolError) return err;
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const name = (err as { name?: string })?.name;
    const code = cause?.code ?? '';
    let category: string;
    if (name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') category = 'timeout';
    else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') category = 'dns';
    else if (/CERT|TLS|SSL|UNABLE_TO_VERIFY/i.test(code) || /certificate/i.test(cause?.message ?? '')) category = 'tls';
    else if (code === 'ECONNREFUSED') category = 'refused';
    else category = 'other';
    // Raw cause (can embed the secret hostname/IP) → log sink only.
    const raw = err instanceof Error ? `${err.message} ${cause?.code ?? ''} ${cause?.message ?? ''}` : String(err);
    this.deps.log(`[testrail] NETWORK_ERROR(${category}): ${raw}`);
    return new QaToolError('NETWORK_ERROR', `${category} — detail in the QA Debug output channel`);
  }

  private async throwOnHttpError(method: 'GET' | 'POST', endpoint: string, res: Response): Promise<void> {
    if (res.ok) return;
    // Error bodies ride the same gateway → prefix-parse them for {"error": …}.
    let trMessage = '';
    try {
      const parsed = parseTestRailBody(await res.text());
      const e = (parsed.data as { error?: unknown } | null)?.error;
      if (typeof e === 'string') trMessage = ` — ${e}`;
    } catch {
      // unparseable error body: status alone is enough
    }
    const detail = `${method} ${endpoint} -> ${res.status}${trMessage}`;
    switch (res.status) {
      case 400:
        throw new QaToolError('BAD_REQUEST', detail);
      case 401:
        throw new QaToolError('AUTH_FAILED', `${detail} — credentials rejected; re-run "QA Debug: Configure TestRail"`);
      case 403:
        throw new QaToolError('FORBIDDEN', detail);
      case 404:
        throw new QaToolError('ENDPOINT_NOT_FOUND', detail);
      case 409:
        throw new QaToolError('MAINTENANCE', `${detail} — TestRail Cloud daily maintenance; retry later`);
      default:
        throw new QaToolError('SERVER_ERROR', detail);
    }
  }

  private async parseJsonResponse(
    method: 'GET' | 'POST',
    endpoint: string,
    res: Response,
  ): Promise<TestRailResponse> {
    await this.throwOnHttpError(method, endpoint, res);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (BINARY_CONTENT_TYPE.test(contentType)) {
      throw new QaToolError(
        'UNEXPECTED_BINARY',
        `${method} ${endpoint} returned ${contentType} on a JSON route — use the get_attachment form if this is a file`,
      );
    }
    const raw = await res.text();
    try {
      const parsed = parseTestRailBody(raw);
      if (parsed.prefix || parsed.suffix) this.logGatewayBytes(endpoint, parsed.prefix, parsed.suffix);
      if (parsed.ambiguousExtents) {
        this.deps.log(
          `[testrail] WARN ${endpoint}: ${parsed.ambiguousExtents.length} disjoint JSON extents found ` +
            `(${parsed.ambiguousExtents.map((e) => `${e.start}..${e.end}`).join(', ')}) — selection may be wrong; see PLAN-testrail D6`,
        );
      }
      return {
        data: parsed.data,
        status: res.status,
        hadPrefix: parsed.prefix != null,
        hadSuffix: parsed.suffix != null,
      };
    } catch (err) {
      if (!(err instanceof TestRailParseError)) throw err;
      this.deps.log(`[testrail] PARSE_ERROR on ${method} ${endpoint}: ${err.hint ?? 'no hint'}; snippet: ${err.snippet}`);
      const writeCaveat =
        method === 'POST'
          ? ' HTTP status was 2xx — the write may have been applied; verify with a get_* call before retrying.'
          : '';
      throw new QaToolError(
        'PARSE_ERROR',
        `${err.hint ?? 'unparseable response body'} — detail in the QA Debug output channel.${writeCaveat}`,
      );
    }
  }

  private async getPaginated(endpoint: string): Promise<TestRailResponse> {
    const base = stripPagingParams(endpoint);
    let offset = 0;
    let pages = 0;
    let arrayKey: string | null = null;
    let merged: unknown[] = [];
    let first: TestRailResponse | null = null;
    let truncatedBy: 'cap' | 'rate_limit' | undefined;

    for (;;) {
      const pageEndpoint = pages === 0 ? base : `${base}&offset=${offset}&limit=${PAGE_LIMIT}`;
      let page: TestRailResponse;
      try {
        const res = await this.fetchRaw('GET', pageEndpoint, { kind: 'json' });
        page = await this.parseJsonResponse('GET', pageEndpoint, res);
      } catch (err) {
        if (err instanceof QaToolError && err.code === 'RATE_LIMITED' && pages > 0) {
          truncatedBy = 'rate_limit'; // keep what we have — partial beats discarded
          break;
        }
        throw err;
      }
      pages++;
      if (first === null) first = page;

      const wrapper = page.data as Record<string, unknown> | null;
      const isWrapper =
        wrapper != null && typeof wrapper === 'object' && !Array.isArray(wrapper) && '_links' in wrapper;
      const found = isWrapper
        ? Object.entries(wrapper as Record<string, unknown>).find(
            ([k, v]) => k !== '_links' && Array.isArray(v),
          )
        : undefined;
      if (!isWrapper || !found) {
        if (pages === 1) {
          // Bare array / wrapper-less endpoint → single page, as-is.
          return { ...page, paginated: { pages: 1, truncated: false } };
        }
        break; // later-page anomaly: keep what we merged so far
      }
      const w = wrapper as Record<string, unknown>;
      arrayKey = found[0];
      const records = found[1] as unknown[];
      merged = merged.concat(records);
      const links = w._links as { next?: unknown } | null | undefined;
      const limit = typeof w.limit === 'number' ? w.limit : PAGE_LIMIT;
      const pageOffset = typeof w.offset === 'number' ? w.offset : offset;
      offset = pageOffset + limit;

      const hasNext = links != null && typeof links === 'object' && (links as { next?: unknown }).next != null;
      if (!hasNext) break;
      if (pages >= PAGINATE_MAX_PAGES || merged.length >= PAGINATE_MAX_RECORDS) {
        truncatedBy = 'cap';
        break;
      }
    }

    const data: Record<string, unknown> = {
      offset: 0,
      limit: merged.length,
      size: merged.length,
      _links: { next: null, prev: null },
      [arrayKey ?? 'items']: merged,
    };
    return {
      data,
      status: first?.status ?? 200,
      hadPrefix: first?.hadPrefix ?? false,
      hadSuffix: first?.hadSuffix ?? false,
      paginated: { pages, truncated: truncatedBy != null, truncatedBy },
    };
  }

  private logGatewayBytes(endpoint: string, prefix: string | null, suffix: string | null): void {
    if (prefix) this.deps.log(`[testrail] gateway prefix on ${endpoint} (${prefix.length} chars): ${prefix.slice(0, 200)}`);
    if (suffix) this.deps.log(`[testrail] gateway suffix on ${endpoint} (${suffix.length} chars): ${suffix.slice(0, 200)}`);
  }

  private saveToAttachments(
    id: string,
    ext: string,
    bytes: Buffer,
    contentType: string,
    displayName: string | null,
  ): SavedAttachment {
    const dir = this.deps.attachmentsDir();
    const target = path.join(dir, `${id}${ext}`);
    // Re-verify the composed path sits inside the attachments dir (defense in
    // depth — id is already strip-sanitized).
    const rel = path.relative(dir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new QaToolError('INVALID_ENDPOINT', 'attachment id resolved outside the attachments dir');
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, bytes);
    return { saved_to: target, bytes: bytes.length, content_type: contentType, display_name: displayName };
  }
}

/** RFC 6266-lite: filename= / filename*= value, reduced to a display string.
 *  NEVER used in the saved path — returned to the caller as metadata only. */
function parseContentDispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 120);
  } catch {
    return raw.slice(0, 120);
  }
}

/** True when the first bytes are a printable-ASCII run (letters/digits) rather
 *  than a recognizable binary magic — the gateway-prefixed-binary smell. */
function looksTextPrefixed(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const head = bytes.subarray(0, 16);
  let printable = 0;
  for (const b of head) {
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)) printable++;
    else break;
  }
  return printable >= 8;
}
