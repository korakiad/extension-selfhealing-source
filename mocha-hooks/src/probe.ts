/**
 * Shared CDP port probe — the SINGLE source for all three call sites:
 *   - the Mocha hook (qa-hooks.ts, imports `./probe`)
 *   - the extension LM tools (extension/src/lm-tools/probe-ports.ts re-exports this)
 *   - the stdio MCP server (qa-debug-mcp/src/probe-ports.ts re-exports this)
 *
 * Replaces the three previously byte-identical copies that each carried a
 * "MUST stay identical" comment and had already begun to drift.
 *
 * Probes /json/version (browser-level CDP endpoint) + /json/list (page
 * titles/count) per port; returns an AvailableChrome on success, null on failure.
 * Returns the protocol `AvailableChrome` shape — structurally identical to the
 * pause-store-types interface, so host-side consumers assign it freely.
 */

import type { AvailableChrome, ChromeRuntime } from './protocol.js';

const PROBE_TIMEOUT_MS = 500;

/** Rewrite a 0.0.0.0-bound CDP URL to loopback so clients (playwright-mcp) can dial it. */
export function normalizeCdpWsUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname === '0.0.0.0') {
      u.hostname = '127.0.0.1';
      return u.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Best-effort runtime label from the /json/version User-Agent. openfin > electron > chrome. */
export function classifyRuntime(userAgent: string | undefined): ChromeRuntime {
  if (!userAgent) return 'unknown';
  if (/openfin/i.test(userAgent)) return 'openfin';
  if (/electron/i.test(userAgent)) return 'electron';
  return 'chrome';
}

export async function probeChromePort(port: number): Promise<AvailableChrome | null> {
  try {
    const versionRes = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!versionRes.ok) return null;
    const versionJson = (await versionRes.json()) as {
      webSocketDebuggerUrl?: string;
      'User-Agent'?: string;
    };
    const wsRaw = versionJson.webSocketDebuggerUrl;
    if (!wsRaw || typeof wsRaw !== 'string') return null;
    const wsUrl = normalizeCdpWsUrl(wsRaw);
    const runtime = classifyRuntime(versionJson['User-Agent']);
    // /json/list → tab_count (orient trigger) + page_titles (display, capped 5).
    // Best-effort: on failure keep tab_count=1 (we know ≥1 since /json/version probed).
    let pageTitles: string[] = [];
    let tabCount = 1;
    try {
      const listRes = await fetch(`http://localhost:${port}/json/list`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (listRes.ok) {
        const listJson = (await listRes.json()) as Array<{ title?: string; type?: string }>;
        const pages = listJson.filter((p) => p.type === 'page');
        tabCount = pages.length;
        pageTitles = pages
          .filter((p) => typeof p.title === 'string')
          .map((p) => p.title as string)
          .slice(0, 5);
      }
    } catch {
      // /json/list is best-effort; absence of page titles/count is not fatal.
    }
    return { port, ws_url: wsUrl, page_titles: pageTitles, tab_count: tabCount, runtime };
  } catch {
    return null;
  }
}

export async function probePorts(ports: readonly number[]): Promise<AvailableChrome[]> {
  const results = await Promise.all(ports.map((p) => probeChromePort(p)));
  return results.filter((r): r is AvailableChrome => r !== null);
}
