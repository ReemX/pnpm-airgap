/**
 * pnpm-airgap - Transfer pnpm dependencies between online and offline environments
 *
 * @module pnpm-airgap
 */

// Main commands
export { fetchDependencies, type FetchResult } from './commands/fetch.js';
export { publishPackages, type PublishResult } from './commands/publish.js';
export { syncRegistries, type SyncResult } from './commands/sync.js';
export { prunePackages, type PruneConfig, type PruneResult } from './commands/prune.js';
export {
  exportRegistryState,
  registryStateFromLockfile,
  loadRegistryState,
  buildVersionLookup,
  filterMissingPackages,
  type ExportResult,
  type FromLockfileConfig,
  type FromLockfileResult,
} from './commands/registry-state.js';

// Core utilities
export {
  parseLockfile,
  parsePackageKey,
  constructTarballUrl,
  type ParseLockfileOptions,
  type ParseLockfileResult,
} from './core/lockfile.js';

export {
  packageExists,
  getPackageMetadata,
  listAllPackages,
  isPublicRegistry,
  clearExistenceCache,
  getCacheStats,
  type PackageExistsOptions,
  type PackageMetadata,
} from './core/registry.js';

export {
  getPackageInfo,
  getPackageInfoSimple,
  downloadTarball,
  downloadPackage,
  type DownloadOptions,
} from './core/tarball.js';

export {
  publishPackage,
  detectPrereleaseTag,
  generateVersionTag,
  type PublishOptions,
} from './core/publisher.js';

export { unpublishVersion, type UnpublishOptions } from './core/unpublisher.js';

// Utilities
export { setDebugMode, debug } from './utils/logger.js';
export { LRUCache } from './utils/cache.js';
export { verifyAuth, getAuthToken, httpRequest, clearAuthCache } from './utils/http.js';
export { isValidUrl, validateRegistryUrl, validateDirectory, validateFile, isValidVersion } from './utils/validation.js';
export { getFileSizeString, calculateTimeout, generateFilename } from './utils/files.js';

// Types
export * from './types.js';

// Constants
export {
  TIMEOUTS,
  CONCURRENCY,
  CACHE,
  RETRY,
  SIZES,
  DEFAULTS,
  PRERELEASE_PATTERNS,
  BLOCKED_REGISTRIES,
  VERSION_TAG_PREFIX,
  DEFAULT_CONFIG,
} from './constants.js';
