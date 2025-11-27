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
const fsPromises = require('fs').promises;
const path = require('path');
const {
  TIMEOUTS,
  PRERELEASE_PATTERNS,
  CACHE,
  SIZES,
  RETRY,
  EXISTENCE,
  LOG_LEVELS,
  VERSION_TAG_PREFIX
} = require('./constants');

const execAsync = promisify(exec);

// Global debug flag and log level
let debugMode = false;
let logLevel = LOG_LEVELS.INFO;

/**
 * Set debug mode for verbose logging
 * @param {boolean} enabled - Enable or disable debug mode
 */
function setDebugMode(enabled) {
  debugMode = enabled;
  if (enabled) {
    logLevel = LOG_LEVELS.DEBUG;
  }
}

/**
 * Set log level
 * @param {number} level - Log level from LOG_LEVELS
 */
function setLogLevel(level) {
  logLevel = level;
}

/**
 * Debug logger - only logs when debug mode is enabled
 * @param {string} message - Message to log
 * @param {any} data - Optional data to log
 */
function debug(message, data = null) {
  if (logLevel >= LOG_LEVELS.DEBUG) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    if (data !== null) {
      console.log(`\x1b[90m[${timestamp}] [DEBUG] ${message}\x1b[0m`, data);
    } else {
      console.log(`\x1b[90m[${timestamp}] [DEBUG] ${message}\x1b[0m`);
    }
  }
}

/**
 * LRU Cache implementation for better memory management
 */
class LRUCache {
  constructor(maxSize, evictionCount = 100) {
    this.maxSize = maxSize;
    this.evictionCount = evictionCount;
    this.cache = new Map();
    this.accessOrder = [];
  }

  get(key) {
    if (this.cache.has(key)) {
      // Move to end of access order (most recently used)
      this._updateAccessOrder(key);
      return this.cache.get(key);
    }
    return undefined;
  }

  has(key) {
    return this.cache.has(key);
  }

  set(key, value) {
    // Evict if at capacity
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      this._evict();
    }

    this.cache.set(key, value);
    this._updateAccessOrder(key);
  }

  _updateAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  _evict() {
    // Remove oldest entries (LRU)
    const toRemove = this.accessOrder.splice(0, this.evictionCount);
    for (const key of toRemove) {
      this.cache.delete(key);
    }
    debug(`LRU Cache evicted ${toRemove.length} entries, size now: ${this.cache.size}`);
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size() {
    return this.cache.size;
  }

  entries() {
    return this.cache.entries();
  }
}

// Caches with LRU eviction
const existenceCache = new LRUCache(CACHE.MAX_SIZE, CACHE.EVICTION_COUNT);
const authTokenCache = new Map();

/**
 * Calculate exponential backoff delay with jitter
 * @param {number} attempt - Current attempt number (1-based)
 * @param {number} initialDelay - Initial delay in milliseconds
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @param {number} multiplier - Backoff multiplier
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt, initialDelay = RETRY.INITIAL_BACKOFF, maxDelay = RETRY.MAX_BACKOFF, multiplier = RETRY.BACKOFF_MULTIPLIER) {
  const baseDelay = Math.min(initialDelay * Math.pow(multiplier, attempt - 1), maxDelay);
  // Add jitter to prevent thundering herd
  const jitter = Math.floor(Math.random() * RETRY.JITTER_MAX);
  return baseDelay + jitter;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
      const npmrcContent = await fsPromises.readFile(npmrcPath, 'utf8');
      const lines = npmrcContent.split('\n');

      // Find the auth token line for this registry
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

    // No token found
    debug(`No auth token found for ${registryUrl}`);
    authTokenCache.set(registryUrl, null);
    return null;
  } catch (error) {
    debug(`Error getting auth token: ${error.message}`);
    authTokenCache.set(registryUrl, null);
    return null;
  }
}

/**
 * Make HTTP/HTTPS request with redirect support
 * @param {string} url - URL to request
 * @param {object} options - Request options
 * @param {number} maxRedirects - Maximum number of redirects to follow
 * @returns {Promise<{statusCode: number, data: string, headers: object}>}
 */
function httpRequest(url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      timeout: options.timeout || TIMEOUTS.HTTP_REQUEST,
      headers: options.headers || {}
    };

    debug(`HTTP ${options.method || 'GET'} ${url}`);

    const req = httpModule.get(url, requestOptions, (res) => {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data,
          headers: res.headers
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
 * Check if package exists in registry with retry logic and tri-state return
 * Uses direct HTTP API calls for better performance than npm CLI
 *
 * @param {string} name - Package name
 * @param {string} version - Package version
 * @param {string} registryUrl - Registry URL
 * @param {object} options - Options
 * @param {boolean} options.useCache - Whether to use cache (default: true)
 * @param {number} options.maxRetries - Maximum retry attempts (default: RETRY.PRE_CHECK_ATTEMPTS)
 * @returns {Promise<{status: string, certain: boolean, error?: string}>}
 *   status: 'exists' | 'not_exists' | 'uncertain'
 *   certain: true if we're confident in the result
 *   error: error message if uncertain
 */
async function packageExists(name, version, registryUrl, options = {}) {
  const { useCache = true, maxRetries = RETRY.PRE_CHECK_ATTEMPTS } = options;
  const cacheKey = `${registryUrl}::${name}@${version}`;

  // Check cache first
  if (useCache && existenceCache.has(cacheKey)) {
    const cached = existenceCache.get(cacheKey);
    debug(`Cache hit for ${name}@${version}: ${cached.status}`);
    return cached;
  }

  // Construct registry URL - handle scoped packages correctly
  const encodedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  const packageUrl = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  // Get authentication token if available
  const authToken = await getAuthToken(registryUrl);
  const headers = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeout = attempt === 1 ? TIMEOUTS.HTTP_REQUEST : TIMEOUTS.HTTP_REQUEST_RETRY;

      const response = await httpRequest(packageUrl, { headers, timeout });

      if (response.statusCode === 200) {
        try {
          const packageData = JSON.parse(response.data);
          const versionExists = packageData.versions && packageData.versions[version] !== undefined;

          const result = {
            status: versionExists ? EXISTENCE.EXISTS : EXISTENCE.NOT_EXISTS,
            certain: true
          };

          // Cache successful results
          existenceCache.set(cacheKey, result);
          debug(`Package ${name}@${version} ${versionExists ? 'exists' : 'does not exist'} (certain)`);
          return result;

        } catch (parseError) {
          debug(`JSON parse error for ${name}: ${parseError.message}`);
          lastError = `Failed to parse registry response: ${parseError.message}`;
          // Don't retry on parse errors - likely a real issue
          break;
        }
      } else if (response.statusCode === 404) {
        // Package definitely doesn't exist
        const result = {
          status: EXISTENCE.NOT_EXISTS,
          certain: true
        };
        existenceCache.set(cacheKey, result);
        debug(`Package ${name}@${version} not found (404)`);
        return result;
      } else if (response.statusCode === 401 || response.statusCode === 403) {
        // Auth error - don't retry, it won't help
        debug(`Auth error for ${name}: ${response.statusCode}`);
        return {
          status: EXISTENCE.UNCERTAIN,
          certain: false,
          error: `Authentication error (${response.statusCode})`
        };
      } else {
        // Other HTTP errors - might be transient
        lastError = `HTTP ${response.statusCode}`;
        debug(`HTTP ${response.statusCode} for ${name}@${version}, attempt ${attempt}/${maxRetries}`);
      }

    } catch (error) {
      lastError = error.message;
      debug(`Request error for ${name}@${version}: ${error.message}, attempt ${attempt}/${maxRetries}`);
    }

    // Wait before retry
    if (attempt < maxRetries) {
      const delay = calculateBackoffDelay(attempt);
      debug(`Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  // All retries exhausted - return uncertain
  debug(`Package ${name}@${version} check uncertain after ${maxRetries} attempts: ${lastError}`);
  return {
    status: EXISTENCE.UNCERTAIN,
    certain: false,
    error: lastError
  };
}

/**
 * Legacy wrapper for packageExists that returns boolean
 * For backward compatibility - prefer using packageExists directly
 * @deprecated Use packageExists() with tri-state return instead
 */
async function packageExistsSimple(name, version, registryUrl, useCache = true) {
  const result = await packageExists(name, version, registryUrl, { useCache });
  // For uncertain results, assume doesn't exist (will try to publish)
  return result.status === EXISTENCE.EXISTS;
}

/**
 * Detect if a version is a prerelease and determine the appropriate tag
 * @param {string} version - Package version string
 * @returns {string|null} Prerelease tag or null if not a prerelease
 */
function detectPrereleaseTag(version) {
  // Also check for semver prerelease format (e.g., 1.0.0-0, 1.0.0-1.2.3)
  const semverPrerelease = /^\d+\.\d+\.\d+-(\d+|[a-zA-Z])/;

  for (const { pattern, tag } of PRERELEASE_PATTERNS) {
    if (version.includes(pattern)) {
      return tag;
    }
  }

  // Check for generic prerelease without known pattern
  if (semverPrerelease.test(version)) {
    // Extract the prerelease identifier
    const match = version.match(/-([a-zA-Z]+)/);
    if (match) {
      return match[1].toLowerCase();
    }
    return 'prerelease';
  }

  return null;
}

/**
 * Calculate dynamic timeout based on file size
 * Publishing is I/O intensive and registry processing takes time
 * @param {string} tarballPath - Path to the tarball file
 * @returns {Promise<number>} Timeout in milliseconds
 */
async function calculateTimeout(tarballPath) {
  try {
    const stats = await fsPromises.stat(tarballPath);
    const fileSizeMB = stats.size / SIZES.BYTES_PER_MB;

    // Base timeout + time based on file size
    let timeout = TIMEOUTS.BASE + Math.floor(fileSizeMB * TIMEOUTS.PER_MB);

    // Cap at maximum timeout
    return Math.min(timeout, TIMEOUTS.MAX);
  } catch (error) {
    debug(`Could not stat file ${tarballPath}: ${error.message}`);
    // If we can't read file stats, use default
    return TIMEOUTS.BASE;
  }
}

/**
 * Synchronous version of calculateTimeout for cases where async isn't practical
 * @param {string} tarballPath - Path to the tarball file
 * @returns {number} Timeout in milliseconds
 */
function calculateTimeoutSync(tarballPath) {
  try {
    const stats = fs.statSync(tarballPath);
    const fileSizeMB = stats.size / SIZES.BYTES_PER_MB;
    let timeout = TIMEOUTS.BASE + Math.floor(fileSizeMB * TIMEOUTS.PER_MB);
    return Math.min(timeout, TIMEOUTS.MAX);
  } catch (error) {
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
 * Validate a URL string
 * @param {string} urlString - URL to validate
 * @returns {boolean} True if valid URL
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate registry URL and provide helpful error message
 * @param {string} registryUrl - Registry URL to validate
 * @throws {Error} If URL is invalid
 */
function validateRegistryUrl(registryUrl) {
  if (!registryUrl) {
    throw new Error('Registry URL is required');
  }

  if (!isValidUrl(registryUrl)) {
    throw new Error(
      `Invalid registry URL: "${registryUrl}"\n` +
      `URL must start with http:// or https://\n` +
      `Example: http://localhost:4873 or https://registry.npmjs.org`
    );
  }
}

/**
 * Validate that a path exists and is a directory
 * @param {string} dirPath - Directory path to validate
 * @param {string} description - Description for error message
 * @throws {Error} If path doesn't exist or isn't a directory
 */
async function validateDirectory(dirPath, description = 'Directory') {
  try {
    const stats = await fsPromises.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${description} path exists but is not a directory: ${dirPath}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${description} not found: ${dirPath}`);
    }
    throw error;
  }
}

/**
 * Validate that a file exists
 * @param {string} filePath - File path to validate
 * @param {string} description - Description for error message
 * @throws {Error} If file doesn't exist
 */
async function validateFile(filePath, description = 'File') {
  try {
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${description} path exists but is not a file: ${filePath}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${description} not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Generate a consistent version tag for legacy/older versions
 * @param {string} version - Package version
 * @returns {string} Tag name
 */
function generateVersionTag(version) {
  // Tag names cannot be valid semver ranges, so we convert dots to dashes
  return `${VERSION_TAG_PREFIX}-${version.replace(/\./g, '-')}`;
}

/**
 * Clear all caches
 * Useful for testing or when you want to force fresh checks
 */
function clearCaches() {
  existenceCache.clear();
  authTokenCache.clear();
  debug('All caches cleared');
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

/**
 * Get file size in human-readable format
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} Human-readable size string
 */
async function getFileSizeString(filePath) {
  try {
    const stats = await fsPromises.stat(filePath);
    const bytes = stats.size;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(SIZES.BYTES_PER_KB));
    return `${(bytes / Math.pow(SIZES.BYTES_PER_KB, i)).toFixed(1)} ${sizes[i]}`;
  } catch {
    return 'unknown size';
  }
}

/**
 * Batch process items with concurrency control
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {number} concurrency - Max concurrent operations
 * @param {Function} onProgress - Optional progress callback (completed, total)
 * @returns {Promise<Array>} Results
 */
async function batchProcess(items, processor, concurrency, onProgress = null) {
  const results = new Array(items.length);
  let completed = 0;
  let currentIndex = 0;

  async function processNext() {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];

      try {
        results[index] = await processor(item, index);
      } catch (error) {
        results[index] = { error: error.message, item };
      }

      completed++;
      if (onProgress) {
        onProgress(completed, items.length);
      }
    }
  }

  // Start concurrent workers
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(processNext());
  }

  await Promise.all(workers);
  return results;
}

module.exports = {
  // Auth
  getAuthToken,
  verifyAuth,

  // Package existence checking
  packageExists,
  packageExistsSimple,  // Deprecated, for backward compatibility

  // Prerelease detection
  detectPrereleaseTag,

  // Timeout calculation
  calculateTimeout,
  calculateTimeoutSync,
  calculateBackoffDelay,

  // Validation utilities
  isValidUrl,
  validateRegistryUrl,
  validateDirectory,
  validateFile,

  // Version tag generation
  generateVersionTag,

  // File utilities
  getFileSizeString,

  // Batch processing
  batchProcess,

  // Cache management
  clearCaches,
  getCacheStats,

  // Debug utilities
  setDebugMode,
  setLogLevel,
  debug,
  sleep,

  // HTTP utilities
  httpRequest,

  // Export caches and LRUCache for advanced usage
  existenceCache,
  authTokenCache,
  LRUCache
};
