/**
 * Registry operations - checking existence, fetching metadata
 */

import axios from 'axios';
import { Existence, type ExistenceResult } from '../types.js';
import { TIMEOUTS, RETRY, CACHE, BLOCKED_REGISTRIES } from '../constants.js';
import { LRUCache } from '../utils/cache.js';
import { httpRequest, getAuthHeader, calculateBackoffDelay, sleep, httpAgent, httpsAgent } from '../utils/http.js';
import { debug } from '../utils/logger.js';

/**
 * What the registry holds for one package name. Fetched once per name (not per
 * version) using the abbreviated "corgi" document, which carries only what a
 * publish needs: the version list and the dist-tags.
 */
export interface PackumentSummary {
  versions: Set<string>;
  distTags: Record<string, string>;
}

type PackumentResult =
  | { status: 'found'; summary: PackumentSummary }
  | { status: 'missing' }
  | { status: 'uncertain'; error: string };

const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

// One in-flight/settled lookup per registry+name, so N versions of one package
// cost one request, and concurrent callers share it.
const packumentCache = new LRUCache<string, Promise<PackumentResult>>(CACHE.MAX_SIZE, CACHE.EVICTION_COUNT);

export function encodePackageName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function loadPackument(name: string, registryUrl: string, maxRetries: number): Promise<PackumentResult> {
  const packageUrl = `${registryUrl.replace(/\/$/, '')}/${encodePackageName(name)}`;
  const authHeader = await getAuthHeader(registryUrl);
  const headers: Record<string, string> = { Accept: ABBREVIATED_ACCEPT };
  if (authHeader) headers['Authorization'] = authHeader;

  let lastError = 'Unknown error';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeout = attempt === 1 ? TIMEOUTS.HTTP_REQUEST : TIMEOUTS.HTTP_REQUEST_RETRY;
      const response = await httpRequest(packageUrl, { headers, timeout });

      if (response.statusCode === 200) {
        try {
          const data = JSON.parse(response.data) as {
            versions?: Record<string, unknown>;
            'dist-tags'?: Record<string, string>;
          };
          return {
            status: 'found',
            summary: {
              versions: new Set(Object.keys(data.versions ?? {})),
              distTags: data['dist-tags'] ?? {},
            },
          };
        } catch (parseError) {
          return { status: 'uncertain', error: `Failed to parse registry response: ${(parseError as Error).message}` };
        }
      }
      if (response.statusCode === 404) return { status: 'missing' };
      if (response.statusCode === 401 || response.statusCode === 403) {
        return { status: 'uncertain', error: `Authentication error (${response.statusCode})` };
      }
      lastError = `HTTP ${response.statusCode}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    debug(`Packument ${name}: ${lastError}, attempt ${attempt}/${maxRetries}`);
    if (attempt < maxRetries) await sleep(calculateBackoffDelay(attempt));
  }
  return { status: 'uncertain', error: lastError };
}

/**
 * Get the version list and dist-tags of a package on a registry.
 * `fresh` bypasses the cache (used to read back state after a publish).
 */
export function getPackument(
  name: string,
  registryUrl: string,
  options: { fresh?: boolean; maxRetries?: number } = {}
): Promise<PackumentResult> {
  const { fresh = false, maxRetries = RETRY.PRE_CHECK_ATTEMPTS } = options;
  const key = `${registryUrl}::${name}`;
  const cached = !fresh && packumentCache.get(key);
  if (cached) return cached;
  const pending = loadPackument(name, registryUrl, maxRetries);
  packumentCache.set(key, pending);
  // Don't pin a failure: the next caller retries.
  pending.then((r) => r.status === 'uncertain' && packumentCache.delete(key)).catch(() => packumentCache.delete(key));
  return pending;
}

/** Record a successful publish so later lookups see it without a refetch. */
export function notePublished(name: string, version: string, tag: string, registryUrl: string): void {
  const key = `${registryUrl}::${name}`;
  const cached = packumentCache.get(key);
  const update = (prev: PackumentResult): PackumentResult => {
    const summary: PackumentSummary =
      prev.status === 'found'
        ? { versions: new Set(prev.summary.versions), distTags: { ...prev.summary.distTags } }
        : { versions: new Set(), distTags: {} };
    summary.versions.add(version);
    summary.distTags[tag] = version;
    return { status: 'found', summary };
  };
  packumentCache.set(key, cached ? cached.then(update) : Promise.resolve(update({ status: 'missing' })));
}

export interface PackageExistsOptions {
  useCache?: boolean;
  maxRetries?: number;
}

/**
 * Check if package exists in registry with retry logic and tri-state return
 */
export async function packageExists(
  name: string,
  version: string,
  registryUrl: string,
  options: PackageExistsOptions = {}
): Promise<ExistenceResult> {
  const { useCache = true, maxRetries = RETRY.PRE_CHECK_ATTEMPTS } = options;
  const result = await getPackument(name, registryUrl, { fresh: !useCache, maxRetries });

  if (result.status === 'found') {
    const exists = result.summary.versions.has(version);
    debug(`Package ${name}@${version} ${exists ? 'exists' : 'does not exist'} (certain)`);
    return { status: exists ? Existence.EXISTS : Existence.NOT_EXISTS, certain: true };
  }
  if (result.status === 'missing') {
    return { status: Existence.NOT_EXISTS, certain: true };
  }
  return { status: Existence.UNCERTAIN, certain: false, error: result.error };
}

/**
 * Check if a registry URL is a public npm registry
 */
export function isPublicRegistry(registryUrl: string): boolean {
  try {
    const url = new URL(registryUrl);
    return BLOCKED_REGISTRIES.some(
      (blocked) => url.hostname === blocked || url.hostname.endsWith('.' + blocked)
    );
  } catch {
    return false;
  }
}

export interface PackageMetadata {
  name: string;
  versions: Record<string, { dist?: { tarball?: string } }>;
  'dist-tags'?: Record<string, string>;
  time?: Record<string, string>;
}

/**
 * Get detailed package metadata including all versions
 */
export async function getPackageMetadata(
  packageName: string,
  registryUrl: string,
  options: { authHeader?: string | null; abbreviated?: boolean } = {}
): Promise<PackageMetadata | null> {
  const { authHeader = null, abbreviated = false } = options;

  const encodedName = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);

  const url = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  // The abbreviated document is a fraction of the full one (no readmes, no
  // per-version descriptions); use it whenever only versions/dist-tags matter.
  const headers: Record<string, string> = {
    Accept: abbreviated ? ABBREVIATED_ACCEPT : 'application/json',
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  try {
    const response = await axios.get(url, {
      headers,
      httpAgent,
      httpsAgent,
      timeout: TIMEOUTS.HTTP_REQUEST * 2,
      validateStatus: (status) => status === 200,
    });

    return response.data;
  } catch (error) {
    debug(`Failed to get metadata for ${packageName}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * List all packages from a registry
 */
export async function listAllPackages(
  registryUrl: string,
  options: { scope?: string | null; authHeader?: string | null } = {}
): Promise<Map<string, PackageMetadata>> {
  const { scope = null, authHeader = null } = options;

  const headers: Record<string, string> = {};
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const packages = new Map<string, PackageMetadata>();

  const endpoints = [
    '/-/all',
    '/-/v1/search?text=*&size=5000',
    '/_all_docs',
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${registryUrl.replace(/\/$/, '')}${endpoint}`;
      debug(`Trying endpoint: ${url}`);

      const response = await axios.get(url, {
        headers,
        httpAgent,
        httpsAgent,
        timeout: TIMEOUTS.MAX,
        maxContentLength: 500 * 1024 * 1024,
        validateStatus: (status) => status === 200,
      });

      const data = response.data;

      if (typeof data === 'object' && !Array.isArray(data)) {
        if (data._updated) {
          delete data._updated;
        }

        for (const [name, meta] of Object.entries(data)) {
          if (scope && !name.startsWith(`${scope}/`)) {
            continue;
          }

          const typedMeta = meta as Record<string, unknown>;
          packages.set(name, {
            name,
            versions: (typedMeta.versions || typedMeta['dist-tags'] || {}) as Record<string, { dist?: { tarball?: string } }>,
            'dist-tags': typedMeta['dist-tags'] as Record<string, string>,
            time: typedMeta.time as Record<string, string>,
          });
        }

        debug(`Found ${packages.size} packages from /-/all endpoint`);
        return packages;
      }

      if (data.objects && Array.isArray(data.objects)) {
        for (const obj of data.objects) {
          const name = obj.package?.name;
          if (!name) continue;

          if (scope && !name.startsWith(`${scope}/`)) {
            continue;
          }

          packages.set(name, {
            name,
            versions: {},
            'dist-tags': {},
          });
        }

        debug(`Found ${packages.size} packages from search API`);
        return packages;
      }
    } catch (error) {
      debug(`Endpoint ${endpoint} failed: ${(error as Error).message}`);
      continue;
    }
  }

  if (packages.size === 0) {
    throw new Error(
      `Could not list packages from registry ${registryUrl}\n` +
        `The registry may not support package listing, or authentication may be required.\n` +
        `You can try:\n` +
        `  1. Providing an auth token\n` +
        `  2. Using a package list file with --package-list\n` +
        `  3. Specifying scopes to sync with --scope`
    );
  }

  return packages;
}

/**
 * Clear package existence cache
 */
export function clearExistenceCache(): void {
  packumentCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    existenceCache: {
      size: packumentCache.size,
      maxSize: CACHE.MAX_SIZE,
    },
  };
}
