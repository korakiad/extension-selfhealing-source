import * as vscode from 'vscode';

import { QaToolError } from '@qa-debug/tool-contracts/errors';

import { auditLog, jsonResult, toErrorResult, type LmToolDeps } from './base.js';
import { classifyVerb, firstSegment, validateEndpointSyntax } from '../testrail/endpoint.js';

const TOOL_NAME = 'qa-debug_qa_testrail_get';

interface Input {
  endpoint: string;
  paginate?: boolean;
}

/**
 * Read tool over the company TestRail API v2 (PLAN-testrail D1/D2). Routes by
 * endpoint name: get_attachment/* → binary save, get_bdd/* → Gherkin text,
 * everything else → prefix-tolerant JSON. The verb gate keeps writes out of
 * this frictionless (no-confirmation) tool.
 */
export class TestRailGetTool implements vscode.LanguageModelTool<Input> {
  constructor(private readonly deps: LmToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
  ): vscode.PreparedToolInvocation {
    return { invocationMessage: `Reading TestRail: ${options.input.endpoint?.slice(0, 120) ?? ''}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Input>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    auditLog(this.deps.auditChannel, TOOL_NAME, undefined);
    try {
      const { endpoint, paginate } = options.input;
      validateEndpointSyntax(endpoint);
      const verb = classifyVerb(endpoint);
      if (verb === 'write') {
        throw new QaToolError('WRONG_TOOL_FOR_WRITE', `${firstSegment(endpoint)} is a write endpoint — use qa_testrail_post`);
      }
      if (verb === 'unknown') {
        throw new QaToolError('UNKNOWN_ENDPOINT_VERB', `${firstSegment(endpoint)} matches no documented TestRail verb — check the testrail skill catalog`);
      }

      const client = await this.deps.testrail.getClient();
      const seg = firstSegment(endpoint);
      if (seg === 'get_attachment') {
        return jsonResult(await client.getBinary(endpoint));
      }
      if (seg === 'get_bdd') {
        return jsonResult(await client.getText(endpoint));
      }
      return jsonResult(await client.getJson(endpoint, { paginate }));
    } catch (err) {
      if (err instanceof QaToolError) {
        return toErrorResult(new Error(`${err.code}: ${err.message}`));
      }
      return toErrorResult(err);
    }
  }
}
