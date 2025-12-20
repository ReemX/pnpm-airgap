/**
 * HTTP utilities for registry communication
 */

import http from 'http';
import https from 'https';
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
 * Get authentication token for registry from .npmrc
 */
export async function getAuthToken(registryUrl: string): Promise<string | null> {
  if (authTokenCache.has(registryUrl)) {
    return authTokenCache.get(registryUrl) || null;
  }

  try {
    const url = new URL(registryUrl);
    const registryHost = `//${url.host}${url.pathname}`.replace(/\/$/, '');
    const registryKey = `${registryHost}/:_authToken`;

    const { stdout: userConfigPath } = await execAsync('npm config get userconfig', {
      timeout: TIMEOUTS.NPM_CONFIG,
    });
    const npmrcPath = userConfigPath.trim();

    if (fs.existsSync(npmrcPath)) {
      const npmrcContent = await fsPromises.readFile(npmrcPath, 'utf8');
      const lines = npmrcContent.split('\n');

      for (const line of lines) {
        if (line.startsWith(registryKey)) {
          const token = line.split('=')[1]?.trim();
          if (token) {
            authTokenCache.set(registryUrl, token);
            debug(`Found auth token for ${registryUrl}`);
            return token;
          }
        }
      }
    }

    debug(`No auth token found for ${registryUrl}`);
    authTokenCache.set(registryUrl, null);
    return null;
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
