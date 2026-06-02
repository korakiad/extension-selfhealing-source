/**
 * Self-update flow.
 *
 * Polls GitHub for the latest *stable* release of the public mirror, notifies
 * when a newer vsix exists, and offers a one-click download +
 * workbench.extensions.installExtension + reload.
 *
 * Stable-only by design: `/releases/latest` excludes prereleases server-side,
 * which matches the channel decision. QAs on a -beta.N build won't be
 * notified about newer betas, only about the eventual stable.
 */

import * as vscode from 'vscode';

import { appendInfo } from './output-channel.js';

const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const VSIX_NAME_RE = /^qa-debug-companion-.*\.vsix$/i;
const STATE_LAST_CHECKED_MS = 'qa-debug.updateCheck.lastCheckedMs';
const STATE_DISMISSED_TAG = 'qa-debug.updateCheck.dismissedTag';
const CONFIG_ENABLED = 'qaDebug.updateCheck.enabled';

export interface UpdateCheckerDeps {
  context: vscode.ExtensionContext;
  channel: vscode.OutputChannel;
  installedVersion: string;
  repoSlug: { owner: string; repo: string } | undefined;
}

export interface UpdateCheckerHandle extends vscode.Disposable {
  runBackgroundCheck(): Promise<void>;
  runManualCheck(): Promise<void>;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface LatestRelease {
  tag_name: string;
  name: string;
  html_url: string;
  body: string;
  assets: ReleaseAsset[];
}

type FetchError =
  | { kind: 'offline'; message: string }
  | { kind: 'notFound' }
  | { kind: 'rateLimited' }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'malformed'; message: string };

type FetchResult = { ok: true; release: LatestRelease } | { ok: false; err: FetchError };

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateCheckerHandle {
  const { context, channel, installedVersion, repoSlug } = deps;
  let inflight: Promise<void> | undefined;

  const userAgent = `qa-debug-companion/${installedVersion}`;

  async function check(opts: { manual: boolean }): Promise<void> {
    if (!opts.manual) {
      const enabled = vscode.workspace.getConfiguration().get<boolean>(CONFIG_ENABLED, true);
      if (!enabled) return;
      const last = context.globalState.get<number>(STATE_LAST_CHECKED_MS, 0);
      if (Date.now() - last < BACKGROUND_INTERVAL_MS) return;
    }

    if (!repoSlug) {
      appendInfo(channel, '[update-check] no repo slug (packageJSON.repository.url unparseable)');
      if (opts.manual) {
        void vscode.window.showWarningMessage(
          'QA Debug: cannot check for updates — extension manifest is missing a parseable repository URL.',
        );
      }
      return;
    }

    if (!opts.manual) {
      await context.globalState.update(STATE_LAST_CHECKED_MS, Date.now());
    }

    const result = await fetchLatestRelease(repoSlug, userAgent);
    if (!result.ok) {
      handleFetchError(result.err, channel, opts.manual);
      return;
    }
    const release = result.release;

    const cmp = compareSemver(release.tag_name, installedVersion);
    if (cmp <= 0) {
      appendInfo(
        channel,
        `[update-check] up to date (installed=${installedVersion} latest_stable=${release.tag_name})`,
      );
      if (opts.manual) {
        void vscode.window.showInformationMessage(
          `QA Debug: you're on the latest stable (${normalizeTag(release.tag_name)}).`,
        );
      }
      return;
    }

    if (!opts.manual) {
      const dismissed = context.globalState.get<string>(STATE_DISMISSED_TAG);
      if (dismissed === release.tag_name) {
        appendInfo(channel, `[update-check] skipped — user dismissed ${release.tag_name}`);
        return;
      }
    }

    const asset = release.assets.find((a) => VSIX_NAME_RE.test(a.name));
    if (!asset) {
      appendInfo(
        channel,
        `[update-check] release ${release.tag_name} has no qa-debug-companion-*.vsix asset`,
      );
      if (opts.manual) {
        void vscode.window.showErrorMessage(
          `QA Debug: release ${release.tag_name} is missing a vsix asset. Open the release page to investigate.`,
          'Open Release Page',
        ).then((pick) => {
          if (pick) void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
        });
      }
      return;
    }

    appendInfo(
      channel,
      `[update-check] newer release available: ${release.tag_name} (installed=${installedVersion})`,
    );
    await offerInstall(release, asset, deps);
  }

  return {
    async runBackgroundCheck() {
      if (inflight) return inflight;
      inflight = check({ manual: false }).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    async runManualCheck() {
      if (inflight) return inflight;
      inflight = check({ manual: true }).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    dispose() {},
  };
}

async function offerInstall(
  release: LatestRelease,
  asset: ReleaseAsset,
  deps: UpdateCheckerDeps,
): Promise<void> {
  const installedShort = deps.installedVersion;
  const latestShort = normalizeTag(release.tag_name);
  const pick = await vscode.window.showInformationMessage(
    `QA Debug Companion ${latestShort} is available (you're on ${installedShort}).`,
    'Install & Reload',
    'View Release Notes',
    'Skip this Version',
  );

  if (pick === 'View Release Notes') {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    return;
  }
  if (pick === 'Skip this Version') {
    await deps.context.globalState.update(STATE_DISMISSED_TAG, release.tag_name);
    appendInfo(deps.channel, `[update-check] user dismissed ${release.tag_name}`);
    return;
  }
  if (pick !== 'Install & Reload') return;

  await downloadAndInstall(release, asset, deps);
}

async function downloadAndInstall(
  release: LatestRelease,
  asset: ReleaseAsset,
  deps: UpdateCheckerDeps,
): Promise<void> {
  const { context, channel } = deps;
  let vsixUri: vscode.Uri;
  try {
    vsixUri = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading QA Debug Companion ${normalizeTag(release.tag_name)}`,
        cancellable: false,
      },
      async () => downloadVsix(asset, context.globalStorageUri, `qa-debug-companion/${deps.installedVersion}`),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(channel, `[update-check] download failed: ${msg}`);
    await showInstallFailure(`Download failed: ${msg}`, release);
    return;
  }

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vsixUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendInfo(channel, `[update-check] installExtension failed: ${msg}`);
    await showInstallFailure(`Install failed: ${msg}`, release);
    return;
  }

  appendInfo(channel, `[update-check] installed ${release.tag_name} from ${asset.browser_download_url}`);
  const reload = await vscode.window.showInformationMessage(
    `QA Debug Companion ${normalizeTag(release.tag_name)} installed. Reload to finish updating.`,
    'Reload Window',
  );
  if (reload === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function showInstallFailure(message: string, release: LatestRelease): Promise<void> {
  const pick = await vscode.window.showErrorMessage(
    `QA Debug: ${message}`,
    'Open Release Page',
  );
  if (pick === 'Open Release Page') {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  }
}

async function downloadVsix(
  asset: ReleaseAsset,
  storageRoot: vscode.Uri,
  userAgent: string,
): Promise<vscode.Uri> {
  const updatesDir = vscode.Uri.joinPath(storageRoot, 'updates');
  await vscode.workspace.fs.createDirectory(updatesDir);
  const target = vscode.Uri.joinPath(updatesDir, asset.name);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(asset.browser_download_url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength !== asset.size) {
      throw new Error(`size mismatch (expected ${asset.size}, got ${buf.byteLength})`);
    }
    await vscode.workspace.fs.writeFile(target, buf);
    return target;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestRelease(
  slug: { owner: string; repo: string },
  userAgent: string,
): Promise<FetchResult> {
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return { ok: false, err: { kind: 'notFound' } };
    if (res.status === 403 || res.status === 429) {
      return { ok: false, err: { kind: 'rateLimited' } };
    }
    if (!res.ok) {
      return {
        ok: false,
        err: { kind: 'http', status: res.status, message: res.statusText },
      };
    }
    const json = (await res.json()) as Partial<LatestRelease>;
    if (
      typeof json.tag_name !== 'string' ||
      typeof json.html_url !== 'string' ||
      !Array.isArray(json.assets)
    ) {
      return { ok: false, err: { kind: 'malformed', message: 'missing tag_name/html_url/assets' } };
    }
    return {
      ok: true,
      release: {
        tag_name: json.tag_name,
        name: typeof json.name === 'string' ? json.name : json.tag_name,
        html_url: json.html_url,
        body: typeof json.body === 'string' ? json.body : '',
        assets: json.assets
          .filter((a): a is ReleaseAsset =>
            typeof a?.name === 'string' &&
            typeof a?.browser_download_url === 'string' &&
            typeof a?.size === 'number',
          ),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, err: { kind: 'offline', message } };
  } finally {
    clearTimeout(timer);
  }
}

function handleFetchError(
  err: FetchError,
  channel: vscode.OutputChannel,
  manual: boolean,
): void {
  switch (err.kind) {
    case 'notFound':
      appendInfo(channel, '[update-check] no stable release published yet (404)');
      if (manual) {
        void vscode.window.showInformationMessage('QA Debug: no stable release has been published yet.');
      }
      return;
    case 'rateLimited':
      appendInfo(channel, '[update-check] GitHub rate-limited the request');
      if (manual) {
        void vscode.window.showWarningMessage(
          "QA Debug: GitHub rate-limited the update check. Try again in an hour.",
        );
      }
      return;
    case 'http':
      appendInfo(channel, `[update-check] GitHub returned ${err.status} ${err.message}`);
      if (manual) {
        void vscode.window.showWarningMessage(
          `QA Debug: GitHub returned ${err.status}. Try again later.`,
        );
      }
      return;
    case 'malformed':
      appendInfo(channel, `[update-check] malformed release payload: ${err.message}`);
      if (manual) {
        void vscode.window.showWarningMessage('QA Debug: GitHub returned an unexpected payload shape.');
      }
      return;
    case 'offline':
    default:
      appendInfo(channel, `[update-check] network error: ${err.message}`);
      if (manual) {
        void vscode.window.showWarningMessage(
          `QA Debug: couldn't reach GitHub (${err.message}).`,
        );
      }
      return;
  }
}

export function parseRepoSlugFromPackageJson(
  repoUrl: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repoUrl) return undefined;
  // Strip optional npm prefix "git+", trailing ".git", and trailing slash.
  let url = repoUrl.trim();
  if (url.startsWith('git+')) url = url.slice(4);
  url = url.replace(/\.git$/i, '').replace(/\/+$/, '');
  // SSH form: git@github.com:owner/repo
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // HTTPS form: https://github.com/owner/repo
  const https = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) return { owner: https[1], repo: https[2] };
  return undefined;
}

/**
 * Semver compare per https://semver.org §11. Returns -1, 0, 1 for a vs b.
 * Strips a leading "v". Treats malformed inputs as 0.0.0 with no prerelease.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] > pb.core[i]) return 1;
    if (pa.core[i] < pb.core[i]) return -1;
  }
  // Cores equal: a version without prerelease > one with prerelease.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    const an = typeof ai === 'number';
    const bn = typeof bi === 'number';
    if (an && bn) {
      if ((ai as number) > (bi as number)) return 1;
      if ((ai as number) < (bi as number)) return -1;
    } else if (an && !bn) {
      return -1;
    } else if (!an && bn) {
      return 1;
    } else {
      const as = ai as string;
      const bs = bi as string;
      if (as > bs) return 1;
      if (as < bs) return -1;
    }
  }
  if (pa.prerelease.length > pb.prerelease.length) return 1;
  if (pa.prerelease.length < pb.prerelease.length) return -1;
  return 0;
}

function parseSemver(raw: string): { core: [number, number, number]; prerelease: Array<string | number> } {
  const stripped = normalizeTag(raw);
  const [coreStr, preStr = ''] = stripped.split('-', 2);
  const coreParts = coreStr.split('.').map((s) => Number(s));
  const core: [number, number, number] = [
    Number.isFinite(coreParts[0]) ? coreParts[0] : 0,
    Number.isFinite(coreParts[1]) ? coreParts[1] : 0,
    Number.isFinite(coreParts[2]) ? coreParts[2] : 0,
  ];
  const prerelease = preStr
    ? preStr.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];
  return { core, prerelease };
}

function normalizeTag(tag: string): string {
  return tag.startsWith('v') || tag.startsWith('V') ? tag.slice(1) : tag;
}
