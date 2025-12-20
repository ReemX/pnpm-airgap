/**
 * Centralized configuration constants
 */

// Timeouts (milliseconds)
export const TIMEOUTS = {
  BASE: 120_000, // 2 minutes - base timeout for publishing
  MAX: 600_000, // 10 minutes - maximum timeout cap
  PER_MB: 30_000, // 30 seconds per MB for large files
  HTTP_REQUEST: 10_000, // 10 seconds for HTTP requests
  HTTP_REQUEST_RETRY: 15_000, // 15 seconds for retry attempts
  NPM_CONFIG: 2_000, // 2 seconds for npm config commands
  DOWNLOAD: 30_000, // 30 seconds for package downloads
  PACKAGE_INFO: 2_000, // 2 seconds for extracting package info
} as const;

// Concurrency limits
export const CONCURRENCY = {
  PUBLISH: 5,
  PUBLISH_LOW: 3,
  PRE_CHECK: 10,
  FETCH: 5,
  VERIFY: 10,
  PACKAGE_INFO: 15,
} as const;

// Cache configuration
export const CACHE = {
  MAX_SIZE: 10_000,
  EVICTION_COUNT: 1_000,
} as const;

// Retry configuration
export const RETRY = {
  MAX_ATTEMPTS: 3,
  PRE_CHECK_ATTEMPTS: 2,
  INITIAL_BACKOFF: 1_000,
  MAX_BACKOFF: 10_000,
  BACKOFF_MULTIPLIER: 2,
  JITTER_MAX: 500,
} as const;

// Size constants (bytes)
export const SIZES = {
  KB: 1024,
  MB: 1024 * 1024,
  BUFFER_1MB: 1024 * 1024,
  BUFFER_10MB: 10 * 1024 * 1024,
} as const;

// Default values
export const DEFAULTS = {
  REGISTRY_URL: 'http://localhost:4873',
  NPM_REGISTRY_URL: 'https://registry.npmjs.org',
  LOCKFILE_PATH: './pnpm-lock.yaml',
  PACKAGES_DIR: './airgap-packages',
} as const;

// Prerelease patterns for version detection
export const PRERELEASE_PATTERNS = [
  { pattern: '-beta', tag: 'beta' },
  { pattern: '-alpha', tag: 'alpha' },
  { pattern: '-rc', tag: 'rc' },
  { pattern: '-next', tag: 'next' },
  { pattern: '-canary', tag: 'canary' },
  { pattern: '-dev', tag: 'dev' },
  { pattern: '-pre', tag: 'pre' },
  { pattern: '-nightly', tag: 'nightly' },
  { pattern: '-snapshot', tag: 'snapshot' },
  { pattern: '-experimental', tag: 'experimental' },
] as const;

// Public registries that should be blocked from full sync
export const BLOCKED_REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'npm.pkg.github.com',
] as const;

// Version tag prefix for legacy versions
export const VERSION_TAG_PREFIX = 'legacy';

// Default configuration for all commands
export const DEFAULT_CONFIG = {
  fetch: {
    lockfilePath: './pnpm-lock.yaml',
    outputDir: './airgap-packages',
    concurrency: 5,
    registryUrl: 'https://registry.npmjs.org',
    registryStatePath: null,
    skipOptional: false,
    debug: false,
  },
  publish: {
    packagesDir: './airgap-packages',
    registryUrl: 'http://localhost:4873',
    concurrency: 3,
    skipExisting: true,
    dryRun: false,
    debug: false,
  },
  sync: {
    sourceRegistry: '',
    destRegistry: 'http://localhost:4873',
    outputDir: './sync-packages',
    scope: null,
    packageList: null,
    maxVersions: null,
    sinceDate: null,
    concurrency: 5,
    skipExisting: true,
    downloadOnly: false,
    publishOnly: false,
    dryRun: false,
    debug: false,
  },
  registryState: {
    registryUrl: 'http://localhost:4873',
    outputPath: './registry-state.json',
    scope: null,
    concurrency: 10,
    debug: false,
  },
} as const;
