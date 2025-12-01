/**
 * Registry State - Export and compare registry states for incremental syncing
 *
 * Enables exporting a snapshot of all packages/versions from a registry,
 * then using that state to fetch only missing packages from lockfiles.
 */

const fs = require('fs-extra');
const path = require('path');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');
const { CONCURRENCY } = require('./constants');
const { listAllPackages, getPackageMetadata } = require('./registry-sync');
const { getAuthToken, setDebugMode, debug, isValidUrl } = require('./shared-utils');

// Current format version for registry state files
const REGISTRY_STATE_VERSION = 1;

/**
 * Validate registry state file format
 * @param {object} state - Parsed registry state object
 * @throws {Error} If format is invalid
 */
function validateRegistryState(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid registry state: expected an object');
  }

  if (state.version !== REGISTRY_STATE_VERSION) {
    throw new Error(`Unsupported registry state version: ${state.version} (expected ${REGISTRY_STATE_VERSION})`);
  }

  if (!state.packages || typeof state.packages !== 'object') {
    throw new Error('Invalid registry state: missing packages object');
  }

  // Validate that packages values are arrays
  for (const [name, versions] of Object.entries(state.packages)) {
    if (!Array.isArray(versions)) {
      throw new Error(`Invalid registry state: package "${name}" versions should be an array`);
    }
  }
}

/**
 * Load and parse registry state from file
 * @param {string} filePath - Path to registry-state.json
 * @returns {Promise<object>} Parsed registry state
 */
async function loadRegistryState(filePath) {
  if (!await fs.pathExists(filePath)) {
    throw new Error(`Registry state file not found: ${filePath}`);
  }

  const content = await fs.readFile(filePath, 'utf8');
  let state;

  try {
    state = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse registry state file: ${e.message}`);
  }

  validateRegistryState(state);

  return state;
}

/**
 * Convert registry state to efficient lookup structure
 * @param {object} registryState - Parsed registry state
 * @returns {Map<string, Set<string>>} Map of packageName -> Set of versions
 */
function buildVersionLookup(registryState) {
  const lookup = new Map();

  for (const [name, versions] of Object.entries(registryState.packages)) {
    lookup.set(name, new Set(versions));
  }

  return lookup;
}

/**
 * Filter lockfile packages to only those missing from registry
 * @param {Map<string, object>} lockfilePackages - From parseLockfile()
 * @param {Map<string, Set<string>>} versionLookup - From buildVersionLookup()
 * @returns {{missing: Map, existing: Map, stats: object}}
 */
function filterMissingPackages(lockfilePackages, versionLookup) {
  const missing = new Map();
  const existing = new Map();

  for (const [packageId, info] of lockfilePackages) {
    const versions = versionLookup.get(info.name);
    if (versions && versions.has(info.version)) {
      existing.set(packageId, info);
    } else {
      missing.set(packageId, info);
    }
  }

  return {
    missing,
    existing,
    stats: {
      total: lockfilePackages.size,
      missing: missing.size,
      existing: existing.size
    }
  };
}

/**
 * Export complete registry state (all packages with all versions)
 * @param {object} options - Export options
 * @param {string} options.registryUrl - Registry URL to export from
 * @param {string} options.outputPath - Output file path
 * @param {string} [options.scope] - Optional scope filter
 * @param {number} [options.concurrency] - Concurrent operations
 * @param {boolean} [options.debug] - Enable debug output
 * @returns {Promise<{success: boolean, stats: object}>}
 */
async function exportRegistryState(options) {
  const {
    registryUrl,
    outputPath,
    scope = null,
    concurrency = CONCURRENCY.PRE_CHECK,
    debug: debugEnabled = false
  } = options;

  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate registry URL
  if (!isValidUrl(registryUrl)) {
    throw new Error(`Invalid registry URL: ${registryUrl}`);
  }

  console.log(chalk.blue('\n📦 Registry State Export'));
  console.log(chalk.gray(`Registry: ${registryUrl}`));
  console.log(chalk.gray(`Output: ${outputPath}`));
  if (scope) {
    console.log(chalk.gray(`Scope: ${scope}`));
  }
  console.log();

  // Get auth token if available
  const authToken = await getAuthToken(registryUrl);
  if (authToken) {
    debug('Found auth token for registry');
  }

  // Step 1: Get list of all packages
  const listSpinner = ora('Fetching package list from registry...').start();
  let packageList;

  try {
    packageList = await listAllPackages(registryUrl, { scope, authToken });
    listSpinner.succeed(`Found ${packageList.size} packages in registry`);
  } catch (error) {
    listSpinner.fail('Failed to list packages from registry');
    throw error;
  }

  if (packageList.size === 0) {
    console.log(chalk.yellow('No packages found in registry'));

    const emptyState = {
      version: REGISTRY_STATE_VERSION,
      exportedAt: new Date().toISOString(),
      registry: registryUrl,
      stats: {
        totalPackages: 0,
        totalVersions: 0
      },
      packages: {}
    };

    await fs.writeJson(outputPath, emptyState, { spaces: 2 });

    return {
      success: true,
      stats: emptyState.stats
    };
  }

  // Step 2: Fetch detailed metadata for each package to get ALL versions
  const metaSpinner = ora('Fetching version metadata...').start();
  const packages = {};
  let totalVersions = 0;
  let processed = 0;
  const errors = [];

  const limit = pLimit(concurrency);
  const packageNames = Array.from(packageList.keys());

  const metaPromises = packageNames.map(name =>
    limit(async () => {
      try {
        const metadata = await getPackageMetadata(name, registryUrl, { authToken });

        if (metadata && metadata.versions) {
          const versions = Object.keys(metadata.versions);
          packages[name] = versions;
          totalVersions += versions.length;
          debug(`${name}: ${versions.length} versions`);
        } else if (packageList.get(name).versions) {
          // Fallback to versions from listAllPackages if getPackageMetadata fails
          const versions = Object.keys(packageList.get(name).versions);
          packages[name] = versions;
          totalVersions += versions.length;
        } else {
          debug(`No version info available for ${name}`);
          packages[name] = [];
        }
      } catch (error) {
        debug(`Error fetching metadata for ${name}: ${error.message}`);
        errors.push({ package: name, error: error.message });
        packages[name] = []; // Include package with empty versions
      }

      processed++;
      metaSpinner.text = `Fetching version metadata... (${processed}/${packageNames.length}) - ${totalVersions} versions found`;
    })
  );

  await Promise.all(metaPromises);

  if (errors.length > 0) {
    metaSpinner.warn(`Fetched metadata with ${errors.length} errors - ${totalVersions} versions from ${packageNames.length} packages`);
    debug(`Errors: ${JSON.stringify(errors.slice(0, 5))}`);
  } else {
    metaSpinner.succeed(`Fetched ${totalVersions} versions from ${packageNames.length} packages`);
  }

  // Step 3: Build and write registry state file
  const registryState = {
    version: REGISTRY_STATE_VERSION,
    exportedAt: new Date().toISOString(),
    registry: registryUrl,
    stats: {
      totalPackages: Object.keys(packages).length,
      totalVersions
    },
    packages
  };

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, registryState, { spaces: 2 });

  console.log(chalk.green(`\n✅ Registry state exported to: ${outputPath}`));
  console.log(chalk.gray(`   ${registryState.stats.totalPackages} packages, ${registryState.stats.totalVersions} versions`));

  return {
    success: errors.length === 0,
    stats: registryState.stats,
    errors: errors.length > 0 ? errors : undefined
  };
}

module.exports = {
  exportRegistryState,
  loadRegistryState,
  buildVersionLookup,
  filterMissingPackages,
  validateRegistryState,
  REGISTRY_STATE_VERSION
};
