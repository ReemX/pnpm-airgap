/**
 * Shared Constants for pnpm-airgap
 * Centralized configuration values to avoid magic numbers and duplication
 */

module.exports = {
  // Timeouts (in milliseconds)
  TIMEOUTS: {
    BASE: 120000,           // 2 minutes - base timeout for publishing
    MAX: 600000,            // 10 minutes - maximum timeout cap
    PER_MB: 30000,          // 30 seconds per MB for file size calculation
    HTTP_REQUEST: 10000,    // 10 seconds for HTTP requests (increased from 5s)
    HTTP_REQUEST_RETRY: 15000, // 15 seconds for retry attempts
    NPM_CONFIG: 2000,       // 2 seconds for npm config commands
    DOWNLOAD: 30000,        // 30 seconds for package downloads
    PACKAGE_INFO: 2000      // 2 seconds for extracting package info
  },

  // Concurrency limits
  CONCURRENCY: {
    PUBLISH: 5,             // Concurrent publish operations
    PUBLISH_LOW: 3,         // Lower concurrency for publish
    PRE_CHECK: 10,          // Concurrent pre-checks
    FETCH: 5,               // Concurrent fetch operations
    VERIFY: 10,             // Concurrent verification operations
    PACKAGE_INFO: 15        // Concurrent package info extraction
  },

  // Cache configuration
  CACHE: {
    MAX_SIZE: 10000,        // Maximum cache entries before eviction
    EVICTION_COUNT: 1000    // Number of entries to evict when at capacity (LRU)
  },

  // Result statuses
  STATUS: {
    SUCCESS: 'success',
    ERROR: 'error',
    SKIPPED: 'skipped',
    UNCERTAIN: 'uncertain'  // For pre-check when we can't determine status
  },

  // Existence check results (tri-state)
  EXISTENCE: {
    EXISTS: 'exists',
    NOT_EXISTS: 'not_exists',
    UNCERTAIN: 'uncertain'  // Network error, timeout, etc.
  },

  // Prerelease patterns (ordered by specificity)
  PRERELEASE_PATTERNS: [
    { pattern: '-beta', tag: 'beta' },
    { pattern: '-alpha', tag: 'alpha' },
    { pattern: '-rc', tag: 'rc' },
    { pattern: '-next', tag: 'next' },
    { pattern: '-canary', tag: 'canary' },
    { pattern: '-dev', tag: 'dev' },
    { pattern: '-pre', tag: 'pre' },
    { pattern: '-nightly', tag: 'nightly' },
    { pattern: '-snapshot', tag: 'snapshot' },
    { pattern: '-experimental', tag: 'experimental' }
  ],

  // File and data size constants (bytes)
  SIZES: {
    BYTES_PER_KB: 1024,
    BYTES_PER_MB: 1024 * 1024,
    BUFFER_1MB: 1024 * 1024,
    BUFFER_10MB: 1024 * 1024 * 10
  },

  // Retry and backoff configuration
  RETRY: {
    MAX_ATTEMPTS: 3,
    PRE_CHECK_ATTEMPTS: 2,      // Fewer retries for pre-check (speed vs accuracy)
    INITIAL_BACKOFF: 1000,      // 1 second
    MAX_BACKOFF: 10000,         // 10 seconds
    BACKOFF_MULTIPLIER: 2,      // Exponential backoff
    JITTER_MAX: 500             // Max random jitter to add (prevents thundering herd)
  },

  // Default URLs and paths
  DEFAULTS: {
    REGISTRY_URL: 'http://localhost:4873',
    NPM_REGISTRY_URL: 'https://registry.npmjs.org',
    LOCKFILE_PATH: './pnpm-lock.yaml',
    PACKAGES_DIR: './airgap-packages'
  },

  // Default configuration
  DEFAULT_CONFIG: {
    fetch: {
      lockfilePath: './pnpm-lock.yaml',
      outputDir: './airgap-packages',
      concurrency: 5,
      registryUrl: 'https://registry.npmjs.org',
      skipOptional: false
    },
    publish: {
      packagesDir: './airgap-packages',
      registryUrl: 'http://localhost:4873',
      concurrency: 3,
      skipExisting: true,
      dryRun: false,
      debug: false
    },
    sync: {
      sourceRegistry: null,       // Required - source registry URL
      destRegistry: 'http://localhost:4873',
      outputDir: './sync-packages',
      scope: null,                // e.g., '@mycompany'
      packageList: null,          // File path or comma-separated list
      maxVersions: null,          // null = all versions
      sinceDate: null,            // ISO date string
      concurrency: 5,
      skipExisting: true,
      downloadOnly: false,
      publishOnly: false,
      dryRun: false,
      debug: false
    }
  },

  // Buffer size for large packages
  MAX_BUFFER: 1024 * 1024 * 10,  // 10MB buffer

  // Version tag prefix for legacy/older versions
  VERSION_TAG_PREFIX: 'legacy',

  // Log levels
  LOG_LEVELS: {
    SILENT: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4
  }
};
