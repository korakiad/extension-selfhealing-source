/**
 * Curated subset of @playwright/mcp (v0.0.75) tool definitions for use in the engagement evals.
 * Source: github.com/microsoft/playwright-mcp/blob/main/README.md (per context7 query 2026-05-20).
 *
 * Why a curated subset (~14) rather than the full ~25:
 *   1. The eval measures tool-selection accuracy among credible alternatives. The tools below
 *      are the ones the agent might plausibly reach for FIRST when investigating a paused failure
 *      (browser_snapshot, browser_evaluate, browser_console_messages, browser_network_requests).
 *   2. The full surface adds tools (browser_pdf_save, browser_tabs, browser_drag, etc.) that don't
 *      compete with qa_get_failure_context for "first-call after pause", so excluding them keeps
 *      the eval signal sharp without changing the answer.
 *   3. Token budget for evals/budget.ts is computed against this curated set; tool-budget.md
 *      records the delta vs. the full ~25 surface and the rationale.
 *
 * Descriptions are paraphrased from the public README to stay third-person + concise. They are
 * NOT identical to the live @playwright/mcp wire descriptions — the eval is testing whether the
 * qa-debug Skill description discriminates against credible alternatives, not exact playwright-mcp
 * fidelity. See evals/tool-budget.md for the divergence note.
 */

import type Anthropic from '@anthropic-ai/sdk';

const obj = (
  props: Record<string, { type: string; description?: string; enum?: string[] }>,
  required: string[] = [],
): Anthropic.Tool['input_schema'] => ({
  type: 'object',
  properties: props,
  required,
});

export const PLAYWRIGHT_MCP_TOOLS: Anthropic.Tool[] = [
  {
    name: 'browser_snapshot',
    description:
      'Captures a structured accessibility snapshot of the current page in the held browser. Returns a textual representation of the DOM tree with element references that can be passed to other browser_* tools. Use this to ground subsequent interactions in the live page state rather than a screenshot.',
    input_schema: obj({}),
  },
  {
    name: 'browser_navigate',
    description: 'Navigates the held browser to the given URL.',
    input_schema: obj({ url: { type: 'string', description: 'The URL to navigate to.' } }, ['url']),
  },
  {
    name: 'browser_click',
    description:
      'Clicks an element in the held browser. Requires an element reference obtained from browser_snapshot.',
    input_schema: obj(
      {
        element: {
          type: 'string',
          description: 'Human-readable element description used for permission and audit.',
        },
        ref: {
          type: 'string',
          description: 'Exact element reference returned by browser_snapshot.',
        },
      },
      ['element', 'ref'],
    ),
  },
  {
    name: 'browser_type',
    description:
      'Types text into an editable element in the held browser. Requires an element reference from browser_snapshot.',
    input_schema: obj(
      {
        element: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
      },
      ['element', 'ref', 'text'],
    ),
  },
  {
    name: 'browser_evaluate',
    description:
      'Evaluates a JavaScript expression in the held browser and returns the result. Use to read live DOM state, computed values, or test asserted-against expressions against the actual page.',
    input_schema: obj(
      {
        function: {
          type: 'string',
          description:
            "JavaScript function body, e.g. '() => document.querySelector(\".price\").textContent'.",
        },
      },
      ['function'],
    ),
  },
  {
    name: 'browser_console_messages',
    description:
      'Returns console messages logged in the held browser since the page loaded. Includes log level, source, and message text.',
    input_schema: obj({
      level: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'debug'],
        description: "Defaults to 'info'. Each level includes more severe levels.",
      },
    }),
  },
  {
    name: 'browser_network_requests',
    description:
      'Lists network requests made by the held browser since the page loaded. Returns a numbered list usable with browser_network_request for full details.',
    input_schema: obj({
      static: {
        type: 'boolean',
        description: 'Include static assets (images, fonts, scripts). Defaults to false.',
      },
      filter: { type: 'string', description: 'Regex to filter request URLs.' },
    }),
  },
  {
    name: 'browser_press_key',
    description:
      "Presses a key on the keyboard in the held browser (e.g. 'ArrowLeft', 'Enter', or a character like 'a').",
    input_schema: obj({ key: { type: 'string' } }, ['key']),
  },
  {
    name: 'browser_wait_for',
    description:
      'Waits for a text string to appear (or disappear) in the held browser, or for a fixed time. Use to handle async content.',
    input_schema: obj({
      text: { type: 'string', description: 'Text to wait to appear.' },
      textGone: { type: 'string', description: 'Text to wait to disappear.' },
      time: { type: 'number', description: 'Seconds to wait.' },
    }),
  },
  {
    name: 'browser_take_screenshot',
    description:
      'Captures a screenshot of the current page in the held browser. Visual only — cannot be used as a basis for performing actions. Use browser_snapshot for action-grounding.',
    input_schema: obj({
      element: { type: 'string' },
    }),
  },
  {
    name: 'browser_close',
    description:
      "Closes the agent's Playwright session against the held browser. Does NOT tear down the underlying held-on-failure Chrome process — that is owned by the test framework (Mode C) and disposed by the framework's teardown.",
    input_schema: obj({}),
  },
  {
    name: 'browser_select_option',
    description:
      'Selects one or more options in a <select> element in the held browser. Requires an element reference from browser_snapshot.',
    input_schema: obj(
      {
        element: { type: 'string' },
        ref: { type: 'string' },
        values: {
          type: 'string',
          description: 'Comma-separated values to select.',
        },
      },
      ['element', 'ref', 'values'],
    ),
  },
  {
    name: 'browser_hover',
    description:
      'Hovers over an element in the held browser. Requires an element reference from browser_snapshot.',
    input_schema: obj(
      {
        element: { type: 'string' },
        ref: { type: 'string' },
      },
      ['element', 'ref'],
    ),
  },
  {
    name: 'browser_resize',
    description: 'Resizes the held browser viewport.',
    input_schema: obj(
      {
        width: { type: 'number' },
        height: { type: 'number' },
      },
      ['width', 'height'],
    ),
  },
];
