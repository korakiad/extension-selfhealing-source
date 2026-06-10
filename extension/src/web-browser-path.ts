/**
 * Best-effort discovery of a Chromium-family browser for the Live Inspect
 * Session's `type:"web"` launches, so the QA usually doesn't need to set
 * `qaDebug.webBrowserBinary`. Chrome's install locations are stable per OS; we
 * probe the well-known paths (Chrome → Chromium → Edge) and return the first
 * that exists. A miss is non-fatal — the caller falls back to a clear "set the
 * setting" error.
 *
 * Injectable (platform/env/exists) so it's unit-testable without the real FS,
 * matching the codebase's process-group-kill.ts / child-env.ts style.
 */

import { existsSync } from 'node:fs';

export interface BrowserLookupDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
}

const defaultDeps: BrowserLookupDeps = {
  platform: process.platform,
  env: process.env,
  exists: (p) => existsSync(p),
};

/** Well-known Chromium-family executable paths for `platform`, in preference
 *  order (Chrome stable first, then Chromium, then Edge). */
export function knownBrowserPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pfx86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA;
    const candidates = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    return candidates.filter((c): c is string => c !== undefined);
  }
  // linux + others
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

/** First existing well-known browser executable, or undefined when none found. */
export function detectWebBrowserBinary(deps: BrowserLookupDeps = defaultDeps): string | undefined {
  for (const p of knownBrowserPaths(deps.platform, deps.env)) {
    if (deps.exists(p)) return p;
  }
  return undefined;
}
