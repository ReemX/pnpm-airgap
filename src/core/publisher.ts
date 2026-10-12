/**
 * Publisher - handles publishing packages to npm registries
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { OperationResult, PackageInfo } from '../types.js';
import { Status, Existence } from '../types.js';
import { RETRY, TIMEOUTS, PRERELEASE_PATTERNS, VERSION_TAG_PREFIX } from '../constants.js';
import { calculateBackoffDelay, getAuthHeader, request, sleep } from '../utils/http.js';
import { debug } from '../utils/logger.js';
import { readTarball, type TarballContents } from './tarball.js';
import { encodePackageName, getPackument, notePublished, packageExists } from './registry.js';

/**
 * Detect prerelease tag from version string
 */
export function detectPrereleaseTag(version: string): string | null {
  // First, try to extract the full prerelease identifier from semver format
  // e.g., "1.0.0-preview.1" -> "preview", "2.0.0-beta" -> "beta"
  const semverMatch = version.match(/^\d+\.\d+\.\d+-([a-zA-Z]+)/);
  if (semverMatch) {
    const identifier = semverMatch[1].toLowerCase();

    // Check if it matches any known prerelease pattern
    for (const { pattern, tag } of PRERELEASE_PATTERNS) {
      const patternName = pattern.replace('-', '');
      if (identifier === patternName) {
        return tag;
      }
    }

    // Return the full identifier for unknown tags
    return identifier;
  }

  // Handle numeric-only prerelease (e.g., "1.0.0-0", "1.0.0-123")
  const numericPrerelease = /^\d+\.\d+\.\d+-\d+$/;
  if (numericPrerelease.test(version)) {
    return 'prerelease';
  }

  // Fallback: check for pattern anywhere in version string
  for (const { pattern, tag } of PRERELEASE_PATTERNS) {
    if (version.includes(pattern)) {
      return tag;
    }
  }

  return null;
}

/**
 * Generate version tag for legacy/older versions
 */
export function generateVersionTag(version: string): string {
  return `${VERSION_TAG_PREFIX}-${version.replace(/\./g, '-')}`;
}

/**
 * Compare two semver versions by precedence (-1, 0, 1). Build metadata is
 * ignored; a prerelease sorts below its release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return parseInt(p, 10) < parseInt(q, 10) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Normalize a package.json into the version document a registry stores, the
 * way `npm publish` does before upload.
 */
export function buildVersionManifest(
  contents: TarballContents,
  data: Buffer,
  registryUrl: string
): { manifest: Record<string, unknown>; tarballName: string } {
  const manifest: Record<string, unknown> = { ...contents.manifest };
  const name = String(manifest.name);
  const version = String(manifest.version).trim().replace(/^[=v]+/, '');
  manifest.version = version;

  // bin: "cli.js" -> { name: "cli.js" }, and paths normalized like npm's
  if (typeof manifest.bin === 'string') {
    manifest.bin = { [name.replace(/^@[^/]+\//, '')]: manifest.bin };
  }
  if (manifest.bin && typeof manifest.bin === 'object') {
    const bin: Record<string, string> = {};
    for (const [k, v] of Object.entries(manifest.bin as Record<string, string>)) {
      bin[path.posix.basename(k)] = path.posix.normalize(path.posix.join('/', String(v))).slice(1);
    }
    manifest.bin = bin;
  }
  if (manifest.bundledDependencies !== undefined && manifest.bundleDependencies === undefined) {
    manifest.bundleDependencies = manifest.bundledDependencies;
    delete manifest.bundledDependencies;
  }
  if (contents.readme !== undefined && manifest.readme === undefined) {
    manifest.readme = contents.readme;
    manifest.readmeFilename = contents.readmeFilename;
  }

  const tarballName = `${name}-${version}.tgz`;
  manifest._id = `${name}@${version}`;
  manifest._nodeVersion = process.versions.node;
  manifest.dist = {
    ...(manifest.dist as object | undefined),
    integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`,
    shasum: crypto.createHash('sha1').update(data).digest('hex'),
    tarball: new URL(`${name}/-/${tarballName}`, registryUrl.replace(/\/?$/, '/')).href.replace(/^https:\/\//, 'http://'),
  };

  return { manifest, tarballName };
}

export interface PublishOptions {
  packageInfo?: PackageInfo | null;
  maxRetries?: number;
  dryRun?: boolean;
  /** Socket inactivity timeout in ms (0 = none). */
  timeout?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Pull the human message out of a registry error body. */
function registryError(statusCode: number, body: string): string {
  let detail = body.trim().slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: string; reason?: string; message?: string };
    detail = parsed.error || parsed.reason || parsed.message || detail;
  } catch {
    // not JSON
  }
  return `HTTP ${statusCode}${detail ? `: ${detail}` : ''}`;
}

/**
 * Publish a single package tarball to a registry.
 *
 * Talks to the registry directly with the same PUT document `npm publish`
 * sends, instead of shelling out to npm. npm unpacks every tarball into a temp
 * dir (twice) before uploading, so its cost grows with the file count: a 1.2 MB
 * tarball with 11k icons took minutes on Windows and hit the old kill timer.
 * Here the tarball is read once into memory and nothing touches the disk.
 */
export async function publishPackage(
  tarballPath: string,
  registryUrl: string,
  options: PublishOptions = {}
): Promise<OperationResult> {
  const {
    packageInfo = null,
    maxRetries = RETRY.MAX_ATTEMPTS,
    dryRun = false,
    timeout = TIMEOUTS.PUBLISH_IDLE,
  } = options;

  let packageIdentifier = packageInfo
    ? `${packageInfo.name}@${packageInfo.version}`
    : path.basename(tarballPath, '.tgz');
  let name = packageInfo?.name;
  let version = packageInfo?.version;

  try {
    const data = await fs.readFile(tarballPath);
    const contents = await readTarball(data);
    name = contents.manifest.name;
    version = contents.manifest.version;
    packageIdentifier = `${name}@${version}`;

    if (contents.manifest.private) {
      return {
        status: Status.ERROR,
        package: packageIdentifier,
        name,
        version,
        error: 'Package is marked "private": true',
      };
    }

    // Tag: a prerelease gets its own tag; a stable version older than the
    // registry's current `latest` gets a legacy tag so it never moves `latest`
    // backwards (npm refuses that without an explicit --tag).
    let tag = detectPrereleaseTag(version) || 'latest';
    let note: string | undefined;
    if (tag === 'latest' && !dryRun) {
      const current = await getPackument(name, registryUrl);
      const latest = current.status === 'found' ? current.summary.distTags.latest : undefined;
      if (latest && compareVersions(latest, version) > 0) {
        tag = generateVersionTag(version);
        note = `Published with tag ${tag} (older than latest ${latest})`;
      }
    }

    if (dryRun) {
      return { status: Status.SUCCESS, package: packageIdentifier, name, version, dryRun: true, tag };
    }

    const { manifest, tarballName } = buildVersionManifest(contents, data, registryUrl);
    const body = JSON.stringify({
      _id: name,
      name,
      description: contents.manifest.description,
      'dist-tags': { [tag]: manifest.version },
      versions: { [manifest.version as string]: manifest },
      access: null,
      _attachments: {
        [tarballName]: {
          content_type: 'application/octet-stream',
          data: data.toString('base64'),
          length: data.length,
        },
      },
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'npm-command': 'publish',
    };
    const authHeader = await getAuthHeader(registryUrl);
    if (authHeader) headers['Authorization'] = authHeader;
    const url = `${registryUrl.replace(/\/$/, '')}/${encodePackageName(name)}`;

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let statusCode = 0;
      let responseBody = '';
      try {
        const res = await request(url, { method: 'PUT', headers, body, idleTimeout: timeout });
        statusCode = res.statusCode;
        responseBody = res.data;
      } catch (error) {
        lastError = (error as Error).message;
        if (attempt < maxRetries) {
          const backoff = calculateBackoffDelay(attempt);
          debug(`Retry ${attempt}/${maxRetries} for ${packageIdentifier} in ${backoff}ms: ${lastError}`);
          await sleep(backoff);
          continue;
        }
        break;
      }

      if (statusCode >= 200 && statusCode < 300) {
        notePublished(name, version, tag, registryUrl);
        return {
          status: Status.SUCCESS,
          package: packageIdentifier,
          name,
          version,
          attempt,
          size: data.length,
          tag,
          ...(note && { note }),
        };
      }

      // Conflict (409) — a tarball with this name already exists on the
      // registry's storage. This is normally a benign "already published",
      // BUT Verdaccio can leave an ORPHAN: the tarball is on disk while the
      // version is missing from the package manifest (a raced/partial publish
      // of concurrent same-package versions). A blind SKIPPED here would mask
      // that data loss as success. Read the manifest back to tell them apart.
      if (statusCode === 409) {
        const existence = await packageExists(name, version, registryUrl, { useCache: false });
        if (existence.status === Existence.NOT_EXISTS) {
          // Tarball on disk but version absent from manifest = ORPHAN.
          // Cannot be healed over HTTP (whole-package unpublish leaves the
          // orphan tgz); needs server-side filesystem cleanup. Surface it.
          return {
            status: Status.ERROR,
            package: packageIdentifier,
            name,
            version,
            orphan: true,
            error:
              `ORPHAN: tarball present on registry storage but ${name}@${version} ` +
              `is missing from the manifest (raced/partial publish). Cannot be fixed over HTTP — ` +
              `delete the orphan tarball for this version from the registry host's storage ` +
              `(storage/${name}/), then republish.`,
          };
        }
        if (existence.status === Existence.UNCERTAIN) {
          return {
            status: Status.ERROR,
            package: packageIdentifier,
            name,
            version,
            error: `Conflict (409) but existence is uncertain: ${existence.error || 'unknown'}`,
          };
        }
        // Present in the manifest. On a retry that means our earlier attempt
        // landed before its response was lost — that is a success, not a skip.
        if (attempt > 1) {
          return { status: Status.SUCCESS, package: packageIdentifier, name, version, attempt, size: data.length, tag };
        }
        return { status: Status.SKIPPED, package: packageIdentifier, name, version, reason: 'Already published' };
      }

      lastError = registryError(statusCode, responseBody);
      if (RETRYABLE_STATUS.has(statusCode) && attempt < maxRetries) {
        const backoff = statusCode === 429 ? 30_000 * attempt : calculateBackoffDelay(attempt);
        debug(`Retry ${attempt}/${maxRetries} for ${packageIdentifier} in ${backoff}ms: ${lastError}`);
        await sleep(backoff);
        continue;
      }
      break;
    }

    return {
      status: Status.ERROR,
      package: packageIdentifier,
      name,
      version,
      error: lastError,
      attempt: maxRetries,
    };
  } catch (error) {
    return {
      status: Status.ERROR,
      package: packageIdentifier,
      name,
      version,
      error: (error as Error).message,
    };
  }
}
