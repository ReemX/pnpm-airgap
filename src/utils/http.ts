/**
 * HTTP utilities for registry communication
 */

import http from 'http';
import https from 'https';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { TIMEOUTS, RETRY } from '../constants.js';
import { debug } from './logger.js';

const execAsync = promisify(exec);

// Auth token cache
const authTokenCache = new Map<string, string | null>();

export interface HttpResponse {
  statusCode: number;
  data: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Make HTTP/HTTPS request with redirect support
 */
export function httpRequest(
  url: string,
  options: { timeout?: number; headers?: Record<string, string> } = {},
  maxRedirects = 5
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      timeout: options.timeout || TIMEOUTS.HTTP_REQUEST,
      headers: options.headers || {},
    };

    debug(`HTTP GET ${url}`);

    const req = httpModule.get(url, requestOptions, (res) => {
      // Handle redirects
      if (
        (res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308) &&
        res.headers.location
      ) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }

        const redirectUrl = new URL(res.headers.location, url).toString();
        debug(`Following redirect to ${redirectUrl}`);

        httpRequest(redirectUrl, options, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          data,
          headers: res.headers,
        });
      });
    });

    req.on('error', (error) => {
      debug(`HTTP request error: ${error.message}`);
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Get authentication token for a registry.
 *
 * Resolves the token so that read-only checks (existence pre-check, manifest
 * read-back) authenticate identically to `npm publish`. The previous
 * implementation only scanned the default `userconfig` file, so a token in a
 * project-level `.npmrc` was invisible — on an auth-gated registry every probe
 * then 401'd and was treated as "uncertain", silently disabling skip-existing
 * (so re-runs re-published everything and re-triggered the same-package race).
 *
 * Tokens MUST be read from the raw `.npmrc` files: modern npm (9+) *protects*
 * auth keys, so `npm config get "//host/:_authToken"` errors instead of
 * returning the value. We therefore scan candidate `.npmrc` files directly, in
 * npm precedence order (project first), and fall back to env vars:
 *   1. `./.npmrc` (project — where devs keep the registry token)
 *   2. `$npm_config_userconfig`, then `npm config get userconfig` (~/.npmrc)
 *   3. `npm config get globalconfig`, then `~/.npmrc`
 *   4. `NPM_TOKEN` / `NODE_AUTH_TOKEN` (CI-style)
 *
 * `npm config get userconfig|globalconfig` is safe to call — those return file
 * paths, not protected secrets.
 */
export async function getAuthToken(registryUrl: string): Promise<string | null> {
  if (authTokenCache.has(registryUrl)) {
    return authTokenCache.get(registryUrl) || null;
  }

  const isUsable = (v: string | undefined | null): v is string =>
    !!v && v.trim() !== '' && v.trim() !== 'undefined' && v.trim() !== 'null';

  const resolveToken = async (): Promise<string | null> => {
    const url = new URL(registryUrl);
    const registryHost = `//${url.host}${url.pathname}`.replace(/\/$/, '');
    // Both key forms seen in the wild: `//host/path/:_authToken` and `//host/path:_authToken`.
    const keys = [`${registryHost}/:_authToken`, `${registryHost}:_authToken`];

    // Candidate .npmrc files, highest precedence first.
    const candidates: string[] = [path.join(process.cwd(), '.npmrc')];
    if (isUsable(process.env.npm_config_userconfig)) {
      candidates.push(process.env.npm_config_userconfig);
    }
    for (const cfg of ['userconfig', 'globalconfig']) {
      try {
        const { stdout } = await execAsync(`npm config get ${cfg}`, { timeout: TIMEOUTS.NPM_CONFIG });
        const p = stdout.trim();
        if (isUsable(p)) candidates.push(p);
      } catch {
        // ignore — not all environments resolve these
      }
    }
    candidates.push(path.join(os.homedir(), '.npmrc'));

    const seen = new Set<string>();
    for (const file of candidates) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!fs.existsSync(file)) continue;

      let content: string;
      try {
        content = await fsPromises.readFile(file, 'utf8');
      } catch {
        continue;
      }

      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        for (const key of keys) {
          if (line.startsWith(`${key}=`)) {
            let token = line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
            // Resolve a `${NPM_TOKEN}`-style env reference if present.
            const envRef = token.match(/^\$\{?([A-Z0-9_]+)\}?$/);
            if (envRef) token = process.env[envRef[1]] ?? '';
            if (isUsable(token)) {
              debug(`Found auth token for ${registryUrl} in ${file}`);
              return token;
            }
          }
        }
      }
    }

    const envToken = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN;
    if (isUsable(envToken)) {
      debug(`Found auth token for ${registryUrl} (env)`);
      return envToken;
    }

    return null;
  };

  try {
    const token = await resolveToken();
    authTokenCache.set(registryUrl, token);
    if (!token) debug(`No auth token found for ${registryUrl}`);
    return token;
  } catch (error) {
    debug(`Error getting auth token: ${(error as Error).message}`);
    authTokenCache.set(registryUrl, null);
    return null;
  }
}

/**
 * Verify authentication to registry
 */
export async function verifyAuth(registryUrl: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`npm whoami --registry "${registryUrl}"`, {
      timeout: TIMEOUTS.HTTP_REQUEST,
    });
    return stdout.trim();
  } catch {
    throw new Error(
      `Not authenticated to registry ${registryUrl}.\n` +
        `Please run: npm login --registry ${registryUrl}`
    );
  }
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  initialDelay = RETRY.INITIAL_BACKOFF,
  maxDelay = RETRY.MAX_BACKOFF,
  multiplier = RETRY.BACKOFF_MULTIPLIER
): number {
  const baseDelay = Math.min(initialDelay * Math.pow(multiplier, attempt - 1), maxDelay);
  const jitter = Math.floor(Math.random() * RETRY.JITTER_MAX);
  return baseDelay + jitter;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clear auth token cache
 */
export function clearAuthCache(): void {
  authTokenCache.clear();
}
