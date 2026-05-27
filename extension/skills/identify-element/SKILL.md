---
name: identify-element
description: Use during an active Mocha test pause when the agent or QA needs to visually identify a specific element in the held browser. Engages when investigating a selector-related failure (test-bug / code-bug), when the QA says "pick this element" / "show me which element you mean" / "let me identify it" / "the right element is the one labelled X", or when the agent is uncertain which DOM node a failing assertion refers to. Injects an in-page picker overlay via the playwright-mcp `browser_evaluate` tool — QA clicks an element in the held browser, returns structured DOM attributes for the agent to build a project-matched locator. Does NOT engage when no Mocha test is paused — qa-debug companion must be active, chrome selection committed, playwright-mcp registered against the held Chrome.
---

# /identify-element — Visual element picker during a Mocha pause

A Mocha test is paused and a browser is held alive at a CDP endpoint (qa-debug companion is engaged). When the failing assertion mentions a selector — or you genuinely don't know which DOM node the QA means — invoke this skill to have the QA click the target in the held browser. The picker overlays the page, highlights elements on hover, and returns structured attributes on click. **Always confirm the picked element with the QA in plain language before building a selector.**

## Prerequisites

- An active Mocha pause (qa-debug companion engaged); `qa-debug.paused` context is true.
- Chrome selection committed (qa-debug SKILL Step 1b ran; `cdp_ws_url` is non-null).
- playwright-mcp registered and attached to the held Chrome via `browser_connect`.

If any prerequisite is missing, do NOT call the picker — fall back to the qa-debug Step 1 / Step 1b flow first.

## When to use

- The failure says *"selector resolved to 0 elements"*, *"expected 1 element matching X but found N"*, or similar selector-anchored shape AND the right element isn't obvious from `browser_snapshot` alone.
- The QA explicitly asks: *"pick this element"*, *"let me show you which one"*, *"the right element is the one labelled X"*, *"identify the button I'm clicking"*.
- During qa-debug Arm 1 / Arm 2 closing turn, before proposing a selector edit, when you'd otherwise be guessing.

## When NOT to use

- No Mocha pause is active (the skill description gates this; do not bypass).
- The failure has nothing to do with an element (value mismatch, network 503, runtime exception, missing fixture data, etc.).
- The right selector is already obvious from `browser_snapshot` AND matches the project's existing selector pattern — don't interrupt the QA for a free move you've already made.
- The QA is in autopilot and has explicitly delegated selector decisions to you for this session.

## How to invoke

### Step 1 — Tell the QA what's about to happen

One short message in chat:

> *"I'm entering pick mode in the held browser. Hover to highlight elements; click the one you want me to use. Press Escape if you want to cancel."*

This sets expectations and prevents the QA from being surprised when their browser starts highlighting.

### Step 2 — Inject the picker via `browser_evaluate`

Call the `browser_evaluate` tool (resolve from your registry by the `browser_evaluate` suffix — see qa-debug SKILL Step 2 for prefix handling across hosts). Pass the picker function below as the `function` argument. The full canonical copy is shipped alongside this SKILL as `pick-element.js`; the same function is inlined below for easy copy-paste:

```js
async () => {
  return new Promise((resolve) => {
    const HIGHLIGHT_ID = '__qa_debug_picker_highlight__';
    const existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) existing.remove();

    const highlight = document.createElement('div');
    highlight.id = HIGHLIGHT_ID;
    highlight.style.cssText = [
      'position:fixed', 'pointer-events:none',
      'border:2px solid #ff3333', 'background:rgba(255,51,51,0.10)',
      'z-index:2147483647', 'transition:all 0.05s', 'box-sizing:border-box',
    ].join(';');
    document.body.appendChild(highlight);

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      const h = document.getElementById(HIGHLIGHT_ID);
      if (h) h.remove();
    };
    const elementAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return (!el || el.id === HIGHLIGHT_ID) ? null : el;
    };
    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
    };
    const onClick = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      e.preventDefault(); e.stopPropagation(); cleanup();
      const data = {}, aria = {};
      for (const a of el.attributes) {
        if (a.name.startsWith('data-')) data[a.name.slice(5)] = a.value;
        else if (a.name.startsWith('aria-')) aria[a.name.slice(5)] = a.value;
      }
      const role = el.getAttribute('role') || '';
      const dt = data['test'] || data['testid'] || data['test-id'];
      let hint;
      if (dt) hint = `locator('[data-test="${dt}"]')`;
      else if (el.id) hint = `locator('#${el.id}')`;
      else if (role) hint = `getByRole('${role}')`;
      else hint = `locator('${el.tagName.toLowerCase()}')`;
      resolve({
        element: {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          classes: [...el.classList],
          placeholder: el.getAttribute('placeholder') || '',
          data, aria: { ...aria, role },
          text: (el.textContent || '').trim().substring(0, 200),
        },
        frames: [],
        playwrightLocatorHint: hint,
      });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve({ cancelled: true }); }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}
```

`browser_evaluate` blocks while the QA hovers and clicks. When they click, the Promise resolves and `browser_evaluate` returns:

```json
{
  "element": {
    "tag": "button",
    "id": "submit",
    "name": "submit",
    "type": "submit",
    "classes": ["btn", "btn-primary"],
    "placeholder": "",
    "data": { "test": "login-submit" },
    "aria": { "label": "Sign in", "role": "button" },
    "text": "Sign In"
  },
  "frames": [],
  "playwrightLocatorHint": "locator('[data-test=\"login-submit\"]')"
}
```

If the QA pressed Escape: `{ "cancelled": true }` — fall back to your prior plan (don't loop; ask the QA what they want next).

### Step 3 — Confirm with the QA in plain language

Show the QA what got picked, NOT raw JSON:

> *"You picked a `<button>` with id `submit`, data-test `login-submit`, text 'Sign In'. Is this the right element?"*

Wait for confirmation. If QA confirms → Step 4. If QA says no → loop back to Step 1 with a fresh picker invocation.

### Step 4 — Build a project-matched selector

Before writing the diff, read 2–3 of the project's existing test / page-object files to learn the project's selector pattern (`data-test`, plain `css`, `aria` / `getByRole`, a custom wrapper like `Ws.instance.client.$()`, etc.). Build the locator using ONLY the attributes from Step 2's JSON output, in the project's pattern.

- DO NOT use `playwrightLocatorHint` directly as the final selector — it's a *hint* showing preference order (data-test → id → role → tag), not a project-matched expression.
- DO NOT build a selector from training data — the JSON attributes are the only source of truth.
- DO match whatever pattern the project already uses; if the project uses `data-test`, use it; if `getByRole`, use it.

## Anti-patterns

| Anti-pattern | Reason |
|---|---|
| Picking before attaching to the held browser via `browser_connect`. | The picker runs in the page context; if playwright-mcp isn't connected to the held browser, `browser_evaluate` returns no active page or attaches to a fresh blank target. Attach via the qa-debug Step 1b flow first. |
| Skipping Step 3 (QA confirmation in plain language). | The picker reports *what* QA clicked, but they may have mis-clicked (sticky headers, overlays, hidden disabled buttons). Always confirm in plain English before building the selector. |
| Building the final selector from `playwrightLocatorHint` directly. | It's a hint, not a project-matched expression. The QA's project may use `data-test`, `getByRole`, a wrapper like `Ws.instance.client.$()`, or a custom CSS scheme. Read the project's tests first. |
| Calling the picker on an element inside a nested iframe (v1 limitation). | This first version captures only top-frame elements. If `document.elementFromPoint` returns the iframe shell, fall back to: read the iframe's `src`, ask the QA to confirm which iframe, then use Playwright's frame-locator path. iframe-aware picking will land in a later beta. |
| Calling `browser_evaluate` a second time before the first picker call returns. | `browser_evaluate` blocks awaiting the picker's Promise. Two concurrent picker calls leak listeners and confuse the highlight. Wait for the first to return (or for the QA to press Escape). |
| Using the picker when the right selector is already obvious from `browser_snapshot`. | Free reads of the DOM tree don't need QA interaction; reserve the picker for cases where the snapshot alone doesn't disambiguate. |

## Limitations (current beta)

- **Top-frame only.** Nested iframes are not walked in this version. If the failing element is inside an iframe, ask the QA which iframe it lives in; use `browser_snapshot` of the iframe to find the element manually until iframe-aware picking ships.
- **ESC-to-cancel is best-effort.** Relies on the in-page keydown listener; some apps that swallow keydown events at capture phase may prevent cancellation. Worst case: QA can click a neutral background element to dismiss.
- **Highlight visibility.** Position-fixed elements above the highlight (modals, toasts) may obscure the outline. The picker still captures the correct DOM element on click.

## Reference

- `pick-element.js` (same folder) — full canonical copy of the picker function. Identical to the inline copy in Step 2; ship-friendly as a standalone file.
- `extension/skills/qa-debug/SKILL.md` — the qa-debug investigation flow this skill plugs into (Step 1b for attach, Arms 1 & 2 for selector-fix proposals).
