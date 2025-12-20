/**
 * Registry operations - checking existence, fetching metadata
 */

import axios from 'axios';
import { Existence, type ExistenceResult } from '../types.js';
import { TIMEOUTS, RETRY, CACHE, BLOCKED_REGISTRIES } from '../constants.js';
import { LRUCache } from '../utils/cache.js';
import { httpRequest, getAuthToken, calculateBackoffDelay, sleep } from '../utils/http.js';
import { debug } from '../utils/logger.js';

// Package existence cache
const existenceCache = new LRUCache<string, ExistenceResult>(CACHE.MAX_SIZE, CACHE.EVICTION_COUNT);

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
  const cacheKey = `${registryUrl}::${name}@${version}`;

  if (useCache && existenceCache.has(cacheKey)) {
    const cached = existenceCache.get(cacheKey)!;
    debug(`Cache hit for ${name}@${version}: ${cached.status}`);
    return cached;
  }

  const encodedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  const packageUrl = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  const authToken = await getAuthToken(registryUrl);
  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeout = attempt === 1 ? TIMEOUTS.HTTP_REQUEST : TIMEOUTS.HTTP_REQUEST_RETRY;
      const response = await httpRequest(packageUrl, { headers, timeout });

      if (response.statusCode === 200) {
        try {
          const packageData = JSON.parse(response.data);
          const versionExists = packageData.versions && packageData.versions[version] !== undefined;

          const result: ExistenceResult = {
            status: versionExists ? Existence.EXISTS : Existence.NOT_EXISTS,
            certain: true,
          };

          existenceCache.set(cacheKey, result);
          debug(`Package ${name}@${version} ${versionExists ? 'exists' : 'does not exist'} (certain)`);
          return result;
        } catch (parseError) {
          debug(`JSON parse error for ${name}: ${(parseError as Error).message}`);
          lastError = `Failed to parse registry response: ${(parseError as Error).message}`;
          break;
        }
      } else if (response.statusCode === 404) {
        const result: ExistenceResult = {
          status: Existence.NOT_EXISTS,
          certain: true,
        };
        existenceCache.set(cacheKey, result);
        debug(`Package ${name}@${version} not found (404)`);
        return result;
      } else if (response.statusCode === 401 || response.statusCode === 403) {
        debug(`Auth error for ${name}: ${response.statusCode}`);
        return {
          status: Existence.UNCERTAIN,
          certain: false,
          error: `Authentication error (${response.statusCode})`,
        };
      } else {
        lastError = `HTTP ${response.statusCode}`;
        debug(`HTTP ${response.statusCode} for ${name}@${version}, attempt ${attempt}/${maxRetries}`);
      }
    } catch (error) {
      lastError = (error as Error).message;
      debug(`Request error for ${name}@${version}: ${lastError}, attempt ${attempt}/${maxRetries}`);
    }

    if (attempt < maxRetries) {
      const delay = calculateBackoffDelay(attempt);
      debug(`Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  debug(`Package ${name}@${version} check uncertain after ${maxRetries} attempts: ${lastError}`);
  return {
    status: Existence.UNCERTAIN,
    certain: false,
    error: lastError || 'Unknown error',
  };
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
  options: { authToken?: string | null } = {}
): Promise<PackageMetadata | null> {
  const { authToken = null } = options;

  const encodedName = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);

  const url = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const response = await axios.get(url, {
      headers,
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
  options: { scope?: string | null; authToken?: string | null } = {}
): Promise<Map<string, PackageMetadata>> {
  const { scope = null, authToken = null } = options;

  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
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
  existenceCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    existenceCache: {
      size: existenceCache.size,
      maxSize: CACHE.MAX_SIZE,
    },
  };
}
