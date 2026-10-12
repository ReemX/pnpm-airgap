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
const authHeaderCache = new Map<string, string | null>();

export interface HttpResponse {
  statusCode: number;
  data: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Shared keep-alive agents. Every registry call (existence probes, publishes,
 * downloads) reuses pooled sockets instead of paying a TCP (and TLS) handshake
 * per request, which dominates on a slow or high-latency registry.
 */
export const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 10_000 });
export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 10_000 });

export function agentFor(url: string | URL): http.Agent {
  return new URL(url).protocol === 'https:' ? httpsAgent : httpAgent;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /**
   * Socket inactivity timeout in ms: the request fails only when no bytes move
   * for this long. A large upload or a slow server that is still working is
   * never cut off by a wall-clock budget. 0 disables it.
   */
  idleTimeout?: number;
}

/**
 * Send one HTTP request with a pooled keep-alive socket and collect the body.
 * Never rejects on an HTTP status; callers inspect `statusCode`.
 */
export function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, idleTimeout = TIMEOUTS.HTTP_REQUEST } = options;

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;
    const finalHeaders: Record<string, string | number> = { ...headers };
    if (body !== undefined) finalHeaders['Content-Length'] = Buffer.byteLength(body);

    debug(`HTTP ${method} ${url}`);

    const req = httpModule.request(
      parsedUrl,
      { method, headers: finalHeaders, agent: agentFor(parsedUrl) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode || 0,
            data: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          })
        );
        res.on('error', reject);
      }
    );

    if (idleTimeout > 0) {
      req.setTimeout(idleTimeout, () => {
        req.destroy(new Error(`Request timed out (no activity for ${Math.round(idleTimeout / 1000)}s)`));
      });
    }

    req.on('error', (error) => {
      debug(`HTTP ${method} error: ${error.message}`);
      reject(error);
    });

    if (body !== undefined) req.end(body);
    else req.end();
  });
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
      agent: agentFor(parsedUrl),
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

        res.resume();
        httpRequest(redirectUrl, options, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          data: Buffer.concat(chunks).toString('utf8'),
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
 *   2. `$npm_config_userconfig`, then `~/.npmrc`
 *   3. `$npm_config_globalconfig`, else npm's default `<prefix>/etc/npmrc`
 *   4. `npm_config_*` env vars (`npm_config__auth`, ...)
 *   5. `NPM_TOKEN` / `NODE_AUTH_TOKEN` (CI-style)
 *
 * Returns the bearer token only. Registries configured with *basic* auth
 * (`username` + `_password`, or `_auth`) have no bearer token — use
 * {@link getAuthHeader}, which covers every scheme npm supports.
 */
export async function getAuthToken(registryUrl: string): Promise<string | null> {
  if (authTokenCache.has(registryUrl)) {
    return authTokenCache.get(registryUrl) || null;
  }

  try {
    const keys = await readRegistryNpmrcKeys(registryUrl);
    const token =
      keys.get('_authToken') ?? pickUsable(process.env.NPM_TOKEN, process.env.NODE_AUTH_TOKEN);
    authTokenCache.set(registryUrl, token);
    if (!token) debug(`No auth token found for ${registryUrl}`);
    return token;
  } catch (error) {
    debug(`Error getting auth token: ${(error as Error).message}`);
    authTokenCache.set(registryUrl, null);
    return null;
  }
}

const isUsable = (v: string | undefined | null): v is string =>
  !!v && v.trim() !== '' && v.trim() !== 'undefined' && v.trim() !== 'null';

const pickUsable = (...values: Array<string | undefined | null>): string | null =>
  values.find(isUsable) ?? null;


/**
 * Read the auth-related npm config keys scoped to `registryUrl`'s host from the
 * raw `.npmrc` files.
 *
 * npm precedence applies: the first file that defines a key wins, so a
 * project-level `.npmrc` overrides `~/.npmrc`. Values may be a `${NPM_TOKEN}`
 * env reference, which is resolved here.
 *
 * See {@link getAuthToken} for why these are read from disk rather than via
 * `npm config get`.
 */
async function readRegistryNpmrcKeys(registryUrl: string): Promise<Map<string, string>> {
  const url = new URL(registryUrl);
  const registryHost = `//${url.host}${url.pathname}`.replace(/\/$/, '');
  const authKeys = ['_authToken', '_auth', 'username', '_password'];

  // Candidate .npmrc files, highest precedence first. The user/global paths
  // are resolved the way npm resolves them instead of spawning
  // `npm config get` twice (a cold npm start costs ~0.5-2s each, more on
  // Windows).
  const candidates: string[] = [path.join(process.cwd(), '.npmrc')];
  const userconfig = npmEnv('userconfig');
  if (isUsable(userconfig)) candidates.push(userconfig);
  candidates.push(path.join(os.homedir(), '.npmrc'));
  candidates.push(npmEnv('globalconfig') ?? path.join(npmPrefix(), 'etc', 'npmrc'));

  const found = new Map<string, string>();
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
      for (const authKey of authKeys) {
        if (found.has(authKey)) continue; // first file wins
        // Both key forms seen in the wild: `//host/path/:key` and `//host/path:key`.
        for (const key of [`${registryHost}/:${authKey}`, `${registryHost}:${authKey}`]) {
          if (!line.startsWith(`${key}=`)) continue;
          let value = line
            .slice(key.length + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
          // Resolve a `${NPM_TOKEN}`-style env reference if present.
          const envRef = value.match(/^\$\{?([A-Z0-9_]+)\}?$/);
          if (envRef) value = process.env[envRef[1]] ?? '';
          if (isUsable(value)) {
            debug(`Found ${authKey} for ${registryUrl} in ${file}`);
            found.set(authKey, value);
          }
        }
      }
    }
  }

  // npm also takes config from `npm_config_*` env vars (what CI and wrapper
  // scripts use, e.g. `npm_config__auth`). Fill in whatever the files lacked.
  for (const authKey of authKeys) {
    if (found.has(authKey)) continue;
    const value = npmEnv(`${registryHost}/:${authKey}`) ?? npmEnv(`${registryHost}:${authKey}`) ?? npmEnv(authKey);
    if (isUsable(value)) {
      debug(`Found ${authKey} for ${registryUrl} in environment`);
      found.set(authKey, value);
    }
  }

  return found;
}

/** Read an `npm_config_<key>` env var the way npm does (case-insensitive). */
function npmEnv(key: string): string | undefined {
  const wanted = `npm_config_${key}`.toLowerCase();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === wanted && isUsable(value)) return value;
  }
  return undefined;
}

/** npm's default prefix: next to node.exe on Windows, one level up elsewhere. */
function npmPrefix(): string {
  const fromEnv = npmEnv('prefix');
  if (fromEnv) return fromEnv;
  const nodeDir = path.dirname(process.execPath);
  return process.platform === 'win32' ? nodeDir : path.dirname(nodeDir);
}

/**
 * Resolve the full `Authorization` header value for a registry, covering every
 * auth scheme npm supports — not just bearer tokens.
 *
 * This exists because read-only probes MUST authenticate identically to
 * `npm publish`. A basic-auth registry (Verdaccio's default `htpasswd` setup
 * uses `username` + `_password`) has no `_authToken` at all, so a bearer-only
 * resolver sends no header, every probe 401s, and the existence pre-check
 * degrades to "uncertain" — silently disabling skip-existing and re-publishing
 * the whole closure on every run.
 *
 * Precedence matches npm: `_authToken` (bearer), then `_auth`, then
 * `username` + `_password` (both basic), then the unscoped `NPM_TOKEN` /
 * `NODE_AUTH_TOKEN` env vars.
 *
 * @returns e.g. `Bearer abc123` or `Basic dXNlcjpwYXNz`, or null if the
 *   registry has no configured credentials.
 */
export async function getAuthHeader(registryUrl: string): Promise<string | null> {
  if (authHeaderCache.has(registryUrl)) {
    return authHeaderCache.get(registryUrl) || null;
  }

  const resolve = async (): Promise<string | null> => {
    const keys = await readRegistryNpmrcKeys(registryUrl);

    const token = keys.get('_authToken');
    if (isUsable(token)) return `Bearer ${token}`;

    // `_auth` is already base64("user:pass").
    const auth = keys.get('_auth');
    if (isUsable(auth)) return `Basic ${auth}`;

    // `username` + `_password`, where `_password` is base64-encoded.
    const username = keys.get('username');
    const password = keys.get('_password');
    if (isUsable(username) && isUsable(password)) {
      const decoded = Buffer.from(password, 'base64').toString('utf8');
      return `Basic ${Buffer.from(`${username}:${decoded}`, 'utf8').toString('base64')}`;
    }

    // Generic CI tokens last: they are not scoped to this registry (setup-node
    // exports a placeholder NODE_AUTH_TOKEN), so explicit credentials win.
    const envToken = pickUsable(process.env.NPM_TOKEN, process.env.NODE_AUTH_TOKEN);
    if (envToken) return `Bearer ${envToken}`;

    return null;
  };

  try {
    const header = await resolve();
    authHeaderCache.set(registryUrl, header);
    if (!header) debug(`No credentials found for ${registryUrl}`);
    else debug(`Resolved ${header.split(' ')[0]} auth for ${registryUrl}`);
    return header;
  } catch (error) {
    debug(`Error resolving auth header: ${(error as Error).message}`);
    authHeaderCache.set(registryUrl, null);
    return null;
  }
}

/**
 * Verify authentication to registry.
 *
 * Asks the registry directly (`GET /-/whoami`) with the same credentials the
 * publishes will use, instead of spawning `npm whoami`. Falls back to the npm
 * CLI only if the registry has no whoami endpoint.
 */
export async function verifyAuth(registryUrl: string): Promise<string> {
  const authHeader = await getAuthHeader(registryUrl);
  if (authHeader) {
    try {
      const res = await request(`${registryUrl.replace(/\/$/, '')}/-/whoami`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (res.statusCode === 200) {
        const username = (JSON.parse(res.data) as { username?: string }).username;
        if (username) return username;
      }
      debug(`whoami returned HTTP ${res.statusCode}`);
    } catch (error) {
      debug(`whoami request failed: ${(error as Error).message}`);
    }
  }

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
  authHeaderCache.clear();
}
