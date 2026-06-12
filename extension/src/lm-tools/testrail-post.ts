import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import {
  classifyVerb,
  firstSegment,
  isContained,
  isUnsupportedPost,
  validateEndpointSyntax,
} from '../testrail/endpoint.js';

const TOOL_NAME = 'qa-debug_qa_testrail_post';

interface Input {
  endpoint: string;
  body?: Record<string, unknown>;
  attachment_path?: string;
}

/**
 * Write tool over the company TestRail API v2 (PLAN-testrail D1/D2/D4).
 * prepareInvocation IS the write-confirmation mechanism — package.json
 * languageModelTools carries no annotations, so readOnlyHint never reaches
 * this host; the dialog below is what stands between the model and a
 * delete_project. The title names the verb class so destructive calls don't
 * visually blend into add_result noise.
 */
export class TestRailPostTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
  ): vscode.PreparedToolInvocation {
    const { endpoint, body, attachment_path } = options.input;
    const seg = firstSegment(endpoint ?? '');
    const title = seg.startsWith('delete_')
      ? `Delete in TestRail: ${endpoint?.slice(0, 80) ?? ''}`
      : `Write to TestRail: ${endpoint?.slice(0, 80) ?? ''}`;
    const parts: string[] = [];
    if (attachment_path) parts.push(`upload file: ${attachment_path}`);
    else if (body && Object.keys(body).length > 0) parts.push(`fields: ${summarizeBody(body)}`);
    else parts.push('no body');
    if (seg.startsWith('delete_')) {
      parts.push('Deletes are PERMANENT and cascade to child entities.');
    }
    return {
      invocationMessage: `Writing to TestRail: ${endpoint?.slice(0, 120) ?? ''}`,
      confirmationMessages: { title, message: new vscode.MarkdownString(parts.join('\n\n')) },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, undefined);
    try {
      const { endpoint, body, attachment_path } = options.input;
      validateEndpointSyntax(endpoint);
      const verb = classifyVerb(endpoint);
      if (verb === 'read') {
        throw new QaToolError('WRONG_TOOL_FOR_READ', `${firstSegment(endpoint)} is a read endpoint — use qa_testrail_get`);
      }
      if (verb === 'unknown') {
        throw new QaToolError('UNKNOWN_ENDPOINT_VERB', `${firstSegment(endpoint)} matches no documented TestRail verb — check the testrail skill catalog`);
      }
      if (isUnsupportedPost(endpoint)) {
        throw new QaToolError('UNSUPPORTED_ENDPOINT', 'add_bdd is not supported in v1 (raw .feature request body) — see the testrail skill catalog');
      }

      const client = await this.deps.testrail.getClient();
      if (attachment_path) {
        const real = await containInWorkspace(attachment_path);
        return jsonResult(await client.postAttachment(endpoint, real));
      }
      return jsonResult(await client.postJson(endpoint, body));
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}

function summarizeBody(body: Record<string, unknown>): string {
  return Object.entries(body)
    .slice(0, 12)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? `"${v.slice(0, 40)}${v.length > 40 ? '…' : ''}"` : Array.isArray(v) ? `[${v.length} items]` : typeof v === 'object' && v !== null ? '{…}' : String(v);
      return `${k}=${val}`;
    })
    .join(', ');
}

/**
 * Outbound containment (PLAN-testrail D4): realpath BOTH the candidate and
 * each workspace root, then the relative/isAbsolute predicate (symlink escape,
 * prefix-boundary, and Windows cross-drive holes all covered). Returns the
 * candidate's real path for the upload read.
 */
async function containInWorkspace(candidate: string): Promise<string> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (folders.length === 0) {
    throw new QaToolError('NO_WORKSPACE', 'open a workspace folder first — attachment uploads must come from inside the workspace');
  }
  const abs = path.isAbsolute(candidate) ? candidate : path.join(folders[0].uri.fsPath, candidate);
  let realCandidate: string;
  try {
    realCandidate = await fs.promises.realpath(abs);
  } catch {
    throw new QaToolError('ATTACHMENT_OUTSIDE_WORKSPACE', `file not found: ${candidate}`);
  }
  for (const f of folders) {
    try {
      const realRoot = await fs.promises.realpath(f.uri.fsPath);
      if (isContained(realRoot, realCandidate)) return realCandidate;
    } catch {
      // unreadable root — try the next one
    }
  }
  throw new QaToolError(
    'ATTACHMENT_OUTSIDE_WORKSPACE',
    'attachment_path resolves outside every workspace folder (symlinks are resolved before the check)',
  );
}
