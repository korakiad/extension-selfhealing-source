/**
 * Stdio MCP probe helper — parity with extension/src/lm-tools/probe-ports.ts.
 * The two are kept independent because the extension's LM-tool path and the
 * stdio CLI path live in separate workspace packages with separate ts compiles.
 * They MUST stay structurally identical so `qa_discover_chromes` returns the
 * same `AvailableChrome` shape regardless of whether the agent invokes via
 * LM tool or stdio MCP.
 */

import type { AvailableChrome } from '@qa-debug/pause-store-types';

const PROBE_TIMEOUT_MS = 500;

function normalizeCdpWsUrl(raw: string): string {
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

// PLAN-runtime-tab-orient — best-effort runtime classification from the
// /json/version User-Agent. MUST stay identical to the copies in
// mocha-hooks/src/qa-hooks.ts and extension/src/lm-tools/probe-ports.ts.
export function classifyRuntime(
  userAgent: string | undefined,
): 'chrome' | 'electron' | 'openfin' | 'unknown' {
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
      // /json/list best-effort.
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
