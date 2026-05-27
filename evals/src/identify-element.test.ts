#!/usr/bin/env tsx
/**
 * Mock e2e for the identify-element skill's picker.
 *
 * Loads extension/skills/identify-element/pick-element.js, evaluates it with
 * a hand-rolled mock document, dispatches synthetic mousemove / click / keydown
 * events, and asserts the picker resolves with the expected JSON shape.
 *
 * Run: `pnpm --filter @qa-debug/evals run picker-smoke`
 *
 * This is the "mock" half of e2e — the agent-side flow (Mocha pause → chat →
 * browser_evaluate(picker)) is exercised by manually opening
 * extension/tools/identify-element-playground.html in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pickElementPath = resolve(
  __dirname,
  '../../extension/skills/identify-element/pick-element.js',
);

interface MockAttr { name: string; value: string; }
interface PickResult {
  element?: {
    tag: string; id: string; name: string; type: string;
    classes: string[]; placeholder: string;
    data: Record<string, string>;
    aria: Record<string, string>;
    text: string;
  };
  frames?: unknown[];
  playwrightLocatorHint?: string;
  cancelled?: boolean;
}

class MockElement {
  tagName: string;
  id = '';
  classList: string[] = [];
  attributes: MockAttr[] = [];
  textContent = '';
  style: Record<string, string> & { cssText?: string } = {};
  rect = { left: 0, top: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  getAttribute(name: string): string | null {
    const a = this.attributes.find((x) => x.name === name);
    return a ? a.value : null;
  }
  getBoundingClientRect() { return this.rect; }
  remove(): void { /* no-op; document tracks insertion */ }
}

interface Listener { type: string; fn: (e: unknown) => void; }

class MockDocument {
  created: MockElement[] = [];
  body = {
    appendChild: (el: MockElement) => {
      this.created.push(el);
      // Wire el.remove() so the mock actually drops it from `created` —
      // matches real DOM behaviour (the picker's cleanup() calls h.remove()).
      const owner = this;
      el.remove = function () {
        const idx = owner.created.indexOf(this);
        if (idx >= 0) owner.created.splice(idx, 1);
      };
    },
  };
  listeners: Listener[] = [];
  private nextTarget: MockElement | null = null;
  setTarget(el: MockElement | null) { this.nextTarget = el; }
  getElementById(id: string): MockElement | null {
    return this.created.find((e) => e.id === id) ?? null;
  }
  createElement(tag: string): MockElement { return new MockElement(tag); }
  elementFromPoint(_x: number, _y: number): MockElement | null { return this.nextTarget; }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const idx = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }
  /** Dispatch a synthetic event to all currently-registered handlers of `type`. */
  dispatch(type: string, event: Record<string, unknown>): void {
    // Copy the list — cleanup() removes listeners during dispatch.
    for (const l of [...this.listeners]) {
      if (l.type === type) l.fn(event);
    }
  }
  highlightCount(): number {
    return this.created.filter((e) => e.id === '__qa_debug_picker_highlight__').length;
  }
}

/** Load pick-element.js and bind `document` to the provided mock. */
function loadPicker(doc: MockDocument): () => Promise<PickResult> {
  const src = readFileSync(pickElementPath, 'utf8');
  // Strip leading comments + isolate the bare `async () => { ... }` expression.
  const fnSrc = src
    .replace(/^[\s\S]*?(async\s*\(\)\s*=>)/m, '$1')
    .trim()
    .replace(/;\s*$/, '');
  const factory = new Function('document', `return (${fnSrc});`) as (
    d: MockDocument,
  ) => () => Promise<PickResult>;
  return factory(doc);
}

function syntheticClick(x = 50, y = 50): Record<string, unknown> {
  return {
    clientX: x,
    clientY: y,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

async function caseDataTestPreferred(): Promise<void> {
  const doc = new MockDocument();
  const btn = new MockElement('button');
  btn.id = 'submit';
  btn.classList = ['btn', 'btn-primary'];
  btn.textContent = 'Sign In';
  btn.attributes = [
    { name: 'id', value: 'submit' },
    { name: 'name', value: 'submit' },
    { name: 'type', value: 'submit' },
    { name: 'data-test', value: 'login-submit' },
    { name: 'aria-label', value: 'Sign in' },
  ];
  doc.setTarget(btn);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  doc.dispatch('mousemove', { clientX: 50, clientY: 50 });
  doc.dispatch('click', syntheticClick());
  const result = await pending;

  assert.equal(result.element?.tag, 'button', 'tag is lowercased button');
  assert.equal(result.element?.id, 'submit');
  assert.equal(result.element?.name, 'submit');
  assert.equal(result.element?.type, 'submit');
  assert.deepEqual(result.element?.classes, ['btn', 'btn-primary']);
  assert.deepEqual(result.element?.data, { test: 'login-submit' });
  assert.equal(result.element?.aria.label, 'Sign in');
  assert.equal(result.element?.text, 'Sign In');
  assert.deepEqual(result.frames, []);
  assert.equal(
    result.playwrightLocatorHint,
    `locator('[data-test="login-submit"]')`,
    'data-test wins the hint preference order',
  );
  console.log('  OK case 1 — data-test preferred');
}

async function caseIdPreferred(): Promise<void> {
  const doc = new MockDocument();
  const input = new MockElement('input');
  input.id = 'user-name';
  input.attributes = [
    { name: 'id', value: 'user-name' },
    { name: 'name', value: 'user-name' },
    { name: 'type', value: 'text' },
    { name: 'placeholder', value: 'Username' },
  ];
  doc.setTarget(input);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  doc.dispatch('click', syntheticClick());
  const result = await pending;

  assert.equal(result.element?.id, 'user-name');
  assert.equal(result.element?.placeholder, 'Username');
  assert.deepEqual(result.element?.data, {}, 'no data-* attrs → empty object');
  assert.equal(
    result.playwrightLocatorHint,
    `locator('#user-name')`,
    'id wins when no data-test',
  );
  console.log('  OK case 2 — id preferred');
}

async function caseRolePreferred(): Promise<void> {
  const doc = new MockDocument();
  const link = new MockElement('a');
  link.textContent = 'Search';
  link.attributes = [
    { name: 'href', value: '#nav-search' },
    { name: 'role', value: 'search' },
  ];
  doc.setTarget(link);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  doc.dispatch('click', syntheticClick());
  const result = await pending;

  assert.equal(result.element?.id, '', 'no id');
  assert.equal(result.element?.aria.role, 'search');
  assert.equal(
    result.playwrightLocatorHint,
    `getByRole('search')`,
    'role wins when no data-test / id',
  );
  console.log('  OK case 3 — role preferred');
}

async function caseTagFallback(): Promise<void> {
  const doc = new MockDocument();
  const div = new MockElement('div');
  div.textContent = 'A card.';
  doc.setTarget(div);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  doc.dispatch('click', syntheticClick());
  const result = await pending;

  assert.equal(
    result.playwrightLocatorHint,
    `locator('div')`,
    'tag fallback when no data-test / id / role',
  );
  console.log('  OK case 4 — tag fallback');
}

async function caseEscapeCancels(): Promise<void> {
  const doc = new MockDocument();
  const btn = new MockElement('button');
  doc.setTarget(btn);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  doc.dispatch('keydown', { key: 'Escape' });
  const result = await pending;

  assert.equal(result.cancelled, true, 'Escape resolves with cancelled:true');
  assert.equal(result.element, undefined, 'no element on cancel');
  assert.equal(
    doc.listeners.length,
    0,
    'all listeners cleaned up after cancel',
  );
  assert.equal(
    doc.created.find((e) => e.id === '__qa_debug_picker_highlight__'),
    undefined,
    'highlight removed after cancel (getElementById would not find it)',
  );
  console.log('  OK case 5 — Escape cancels');
}

async function caseCleanupOnClick(): Promise<void> {
  const doc = new MockDocument();
  const btn = new MockElement('button');
  btn.attributes = [{ name: 'data-test', value: 'x' }];
  doc.setTarget(btn);

  const pickerFn = loadPicker(doc);
  const pending = pickerFn();
  assert.equal(doc.listeners.length, 3, 'picker installs 3 listeners');
  assert.equal(doc.highlightCount(), 1, 'picker appends 1 highlight');
  doc.dispatch('click', syntheticClick());
  await pending;
  assert.equal(doc.listeners.length, 0, 'listeners cleaned up after click');
  // The picker removes the highlight by calling .remove() on it; our MockElement.remove
  // is a no-op (we don't try to splice from `created`), but cleanup also runs
  // document.getElementById(HIGHLIGHT_ID).remove() — which exercises the same path.
  // So we only assert the listener side here.
  console.log('  OK case 6 — cleanup after click');
}

async function caseSkipsHighlightInElementAt(): Promise<void> {
  // If elementFromPoint returns the picker's own highlight overlay, the picker
  // must ignore it (returns null from elementAt). Synthesised by setting the
  // target to the highlight element after it's been created.
  const doc = new MockDocument();
  const btn = new MockElement('button');
  btn.attributes = [{ name: 'data-test', value: 'real' }];

  const pickerFn = loadPicker(doc);
  doc.setTarget(null); // first mousemove will see null and skip
  const pending = pickerFn();
  // Find the highlight element the picker just appended
  const highlight = doc.created.find((e) => e.id === '__qa_debug_picker_highlight__');
  assert.ok(highlight, 'highlight was created');
  doc.setTarget(highlight); // elementFromPoint returns highlight itself
  doc.dispatch('mousemove', { clientX: 0, clientY: 0 });
  // No crash, no spurious resolution. Now point at the real button and click.
  doc.setTarget(btn);
  doc.dispatch('click', syntheticClick());
  const result = await pending;
  assert.equal(
    result.playwrightLocatorHint,
    `locator('[data-test="real"]')`,
    'highlight is skipped, real target is picked',
  );
  console.log('  OK case 7 — highlight skipped by elementAt');
}

async function main(): Promise<void> {
  console.log('identify-element picker — mock e2e');
  await caseDataTestPreferred();
  await caseIdPreferred();
  await caseRolePreferred();
  await caseTagFallback();
  await caseEscapeCancels();
  await caseCleanupOnClick();
  await caseSkipsHighlightInElementAt();
  console.log('OK: identify-element picker passed all assertions');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
