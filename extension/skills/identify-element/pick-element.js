// In-page element picker for the QA Debug Companion.
// Pass this function as the `function` argument to playwright-mcp's
// `browser_evaluate` tool while attached to the held Chrome. The function runs
// in the page context, overlays a hover highlight, and resolves on click.
//
// Returns one of:
//   { element: {...}, frames: [], playwrightLocatorHint: "..." }   on click
//   { cancelled: true }                                              on Escape
//
// Top-frame only — iframe walking deferred to a later beta.

async () => {
  return new Promise((resolve) => {
    const HIGHLIGHT_ID = '__qa_debug_picker_highlight__';

    const existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) existing.remove();

    const highlight = document.createElement('div');
    highlight.id = HIGHLIGHT_ID;
    highlight.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'border:2px solid #ff3333',
      'background:rgba(255,51,51,0.10)',
      'z-index:2147483647',
      'transition:all 0.05s',
      'box-sizing:border-box',
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
      if (!el || el.id === HIGHLIGHT_ID) return null;
      return el;
    };

    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      highlight.style.left = rect.left + 'px';
      highlight.style.top = rect.top + 'px';
      highlight.style.width = rect.width + 'px';
      highlight.style.height = rect.height + 'px';
    };

    const onClick = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();

      const data = {};
      const aria = {};
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-')) data[attr.name.slice(5)] = attr.value;
        else if (attr.name.startsWith('aria-')) aria[attr.name.slice(5)] = attr.value;
      }

      const role = el.getAttribute('role') || '';
      const dataTest = data['test'] || data['testid'] || data['test-id'];
      let locatorHint;
      if (dataTest) locatorHint = `locator('[data-test="${dataTest}"]')`;
      else if (el.id) locatorHint = `locator('#${el.id}')`;
      else if (role) locatorHint = `getByRole('${role}')`;
      else locatorHint = `locator('${el.tagName.toLowerCase()}')`;

      resolve({
        element: {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          classes: [...el.classList],
          placeholder: el.getAttribute('placeholder') || '',
          data,
          aria: { ...aria, role },
          text: (el.textContent || '').trim().substring(0, 200),
        },
        frames: [],
        playwrightLocatorHint: locatorHint,
      });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve({ cancelled: true });
      }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
};
