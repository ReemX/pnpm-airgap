/**
 * Shared Utilities for pnpm-airgap
 * Common functions used across bootstrap-publisher and offline-publisher
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const { TIMEOUTS, PRERELEASE_PATTERNS, CACHE, SIZES, RETRY } = require('./constants');

const execAsync = promisify(exec);

/**
 * Calculate exponential backoff delay
 * @param {number} attempt - Current attempt number (1-based)
 * @param {number} initialDelay - Initial delay in milliseconds
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @param {number} multiplier - Backoff multiplier
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt, initialDelay = RETRY.INITIAL_BACKOFF, maxDelay = RETRY.MAX_BACKOFF, multiplier = RETRY.BACKOFF_MULTIPLIER) {
  return Math.min(initialDelay * Math.pow(multiplier, attempt - 1), maxDelay);
}

// Caches
const existenceCache = new Map();
const authTokenCache = new Map();

/**
 * Get authentication token for registry from .npmrc file
 * @param {string} registryUrl - The registry URL
 * @returns {Promise<string|null>} The auth token or null if not found
 */
async function getAuthToken(registryUrl) {
  // Check cache first
  if (authTokenCache.has(registryUrl)) {
    return authTokenCache.get(registryUrl);
  }

  try {
    // Parse registry URL to get the host and path
    const url = new URL(registryUrl);
    const registryHost = `//${url.host}${url.pathname}`.replace(/\/$/, '');
    const registryKey = `${registryHost}/:_authToken`;

    // Get npmrc file paths
    const { stdout: userConfigPath } = await execAsync('npm config get userconfig', {
      timeout: TIMEOUTS.NPM_CONFIG
    });
    const npmrcPath = userConfigPath.trim();

    // Read .npmrc file directly (tokens are protected from npm config get)
    if (fs.existsSync(npmrcPath)) {
      const npmrcContent = fs.readFileSync(npmrcPath, 'utf8');
      const lines = npmrcContent.split('\n');

      // Find the auth token line for this registry
      for (const line of lines) {
        if (line.startsWith(registryKey)) {
          const token = line.split('=')[1]?.trim();
          if (token) {
            authTokenCache.set(registryUrl, token);
            return token;
          }
        }
      }
    }

    // No token found
    authTokenCache.set(registryUrl, null);
    return null;
  } catch (error) {
    authTokenCache.set(registryUrl, null);
    return null;
  }
}

/**
 * Check if package exists in registry with caching
 * Uses direct HTTP API calls for 10x faster performance than npm CLI
 * Uses only Node.js built-in modules (http/https) for dependency-free operation
 * @param {string} name - Package name
 * @param {string} version - Package version
 * @param {string} registryUrl - Registry URL
 * @param {boolean} useCache - Whether to use cache (default: true)
 * @returns {Promise<boolean>} True if package exists
 */
async function packageExists(name, version, registryUrl, useCache = true) {
  const cacheKey = `${registryUrl}::${name}@${version}`;

  // Check cache first
  if (useCache && existenceCache.has(cacheKey)) {
    return existenceCache.get(cacheKey);
  }

  // Implement cache size management
  if (existenceCache.size > CACHE.MAX_SIZE) {
    existenceCache.clear();
  }

  try {
    // Construct registry URL - handle scoped packages correctly
    const encodedName = encodeURIComponent(name).replace('%2F', '%2f');
    const packageUrl = `${registryUrl}/${encodedName}`;

    // Get authentication token if available
    const authToken = await getAuthToken(registryUrl);

    // Use HTTP GET request instead of npm CLI for 10x performance improvement
    const exists = await new Promise((resolve) => {
      const parsedUrl = new URL(packageUrl);
      const httpModule = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        timeout: TIMEOUTS.HTTP_REQUEST,
        headers: {}
      };

      // Add authentication header if token is available
      if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
      }

      const req = httpModule.get(packageUrl, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const packageData = JSON.parse(data);
              const versionExists = packageData.versions && packageData.versions[version] !== undefined;
              resolve(versionExists);
            } catch (parseError) {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    // Cache the result
    existenceCache.set(cacheKey, exists);
    return exists;
  } catch (error) {
    // Package doesn't exist or error accessing registry
    existenceCache.set(cacheKey, false);
    return false;
  }
}

/**
 * Detect if a version is a prerelease and determine the appropriate tag
 * @param {string} version - Package version string
 * @returns {string|null} Prerelease tag or null if not a prerelease
 */
function detectPrereleaseTag(version) {
  for (const { pattern, tag } of PRERELEASE_PATTERNS) {
    if (version.includes(pattern)) {
      return tag;
    }
  }
  return null;
}

/**
 * Calculate dynamic timeout based on file size
 * Publishing is I/O intensive and registry processing takes time
 * @param {string} tarballPath - Path to the tarball file
 * @returns {number} Timeout in milliseconds
 */
function calculateTimeout(tarballPath) {
  try {
    const stats = fs.statSync(tarballPath);
    const fileSizeMB = stats.size / SIZES.BYTES_PER_MB;

    // Base timeout + time based on file size
    let timeout = TIMEOUTS.BASE + Math.floor(fileSizeMB * TIMEOUTS.PER_MB);

    // Cap at maximum timeout
    return Math.min(timeout, TIMEOUTS.MAX);
  } catch (error) {
    // If we can't read file stats, use default
    return TIMEOUTS.BASE;
  }
}

/**
 * Verify authentication to registry
 * @param {string} registryUrl - Registry URL
 * @returns {Promise<string>} Username if authenticated
 * @throws {Error} If not authenticated
 */
async function verifyAuth(registryUrl) {
  try {
    const { stdout } = await execAsync(
      `npm whoami --registry "${registryUrl}"`,
      { timeout: TIMEOUTS.HTTP_REQUEST }
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Not authenticated to registry ${registryUrl}.\n` +
      `Please run: npm login --registry ${registryUrl}`
    );
  }
}

/**
 * Clear all caches
 * Useful for testing or when you want to force fresh checks
 */
function clearCaches() {
  existenceCache.clear();
  authTokenCache.clear();
}

/**
 * Get cache statistics
 * @returns {object} Cache statistics
 */
function getCacheStats() {
  return {
    existenceCache: {
      size: existenceCache.size,
      maxSize: CACHE.MAX_SIZE
    },
    authTokenCache: {
      size: authTokenCache.size
    }
  };
}

module.exports = {
  getAuthToken,
  packageExists,
  detectPrereleaseTag,
  calculateTimeout,
  calculateBackoffDelay,
  verifyAuth,
  clearCaches,
  getCacheStats,
  // Export caches for advanced usage (e.g., testing)
  existenceCache,
  authTokenCache
};
