/**
 * pnpm-airgap - Transfer pnpm dependencies between online and offline environments
 *
 * @module pnpm-airgap
 */

const { fetchDependencies, parseLockfile, parsePackageKey } = require('./lib/online-fetcher');
const { publishPackages, publishPackage, getPackageInfo } = require('./lib/offline-publisher');
const { bootstrapPublish } = require('./lib/bootstrap-publisher');
const { syncRegistries, listAllPackages, getPackageMetadata } = require('./lib/registry-sync');
const {
  packageExists,
  detectPrereleaseTag,
  verifyAuth,
  setDebugMode,
  clearCaches,
  getCacheStats
} = require('./lib/shared-utils');
const constants = require('./lib/constants');

module.exports = {
  // Main functions
  fetchDependencies,
  publishPackages,
  bootstrapPublish,
  syncRegistries,

  // Utility functions
  parseLockfile,
  parsePackageKey,
  publishPackage,
  getPackageInfo,
  packageExists,
  detectPrereleaseTag,
  verifyAuth,
  listAllPackages,
  getPackageMetadata,

  // Configuration
  setDebugMode,
  clearCaches,
  getCacheStats,

  // Constants
  constants,
  STATUS: constants.STATUS,
  EXISTENCE: constants.EXISTENCE
};
