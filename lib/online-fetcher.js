const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');
const { TIMEOUTS, CONCURRENCY, STATUS, DEFAULTS } = require('./constants');
const { debug, setDebugMode, validateFile, validateRegistryUrl } = require('./shared-utils');

/**
 * Parse package key from lockfile to extract name and version
 * Handles multiple pnpm lockfile formats (v5, v6, v9+)
 *
 * Supported formats:
 * - Regular: package@version, /package@version, /package/version
 * - Scoped: @scope/package@version, /@scope/package@version
 * - With peer deps: package@version(peer@version), @scope/package@version(peer@version)
 * - Aliased: alias@npm:package@version (extracts real package, not alias)
 * - Patched: package@version_patch_hash
 *
 * @param {string} key - Lockfile package key
 * @returns {object|null} {name, version} or null if not parseable
 */
function parsePackageKey(key) {
  if (!key || typeof key !== 'string') {
    return null;
  }

  // Remove leading slash if present
  let cleanKey = key.replace(/^\//, '');

  // Skip non-registry packages (git, file, link, workspace references)
  if (cleanKey.startsWith('file:') ||
      cleanKey.startsWith('link:') ||
      cleanKey.startsWith('git+') ||
      cleanKey.startsWith('git:') ||
      cleanKey.startsWith('github:') ||
      cleanKey.startsWith('bitbucket:') ||
      cleanKey.startsWith('gitlab:') ||
      cleanKey.includes('.git') ||
      cleanKey.startsWith('workspace:')) {
    debug(`Skipping non-registry package: ${key}`);
    return null;
  }

  // Handle aliased packages: alias@npm:real-package@version
  // We want the real package, not the alias
  const aliasMatch = cleanKey.match(/^[^@]*@npm:(.+)$/);
  if (aliasMatch) {
    cleanKey = aliasMatch[1];
    debug(`Resolved alias to: ${cleanKey}`);
  }

  // Remove patch suffix (e.g., package@version_hash=)
  cleanKey = cleanKey.replace(/_[a-f0-9]+=$/, '');

  // Remove peer dependency suffix (e.g., package@version(peer@version))
  // But be careful with scoped packages which have @
  const peerDepIndex = cleanKey.indexOf('(');
  if (peerDepIndex > 0) {
    cleanKey = cleanKey.substring(0, peerDepIndex);
  }

  // Try to parse scoped packages first: @scope/package@version
  const scopedMatch = cleanKey.match(/^(@[^@\/]+\/[^@\/]+)[@\/](.+)$/);
  if (scopedMatch) {
    const [, name, version] = scopedMatch;
    if (isValidVersion(version)) {
      return { name, version };
    }
  }

  // Parse regular packages: package@version or package/version
  const regularMatch = cleanKey.match(/^([^@\/]+)[@\/](.+)$/);
  if (regularMatch) {
    const [, name, version] = regularMatch;
    if (isValidVersion(version) && !name.startsWith('@')) {
      return { name, version };
    }
  }

  debug(`Could not parse package key: ${key}`);
  return null;
}

/**
 * Check if a string looks like a valid semver version
 * @param {string} version - Version string to check
 * @returns {boolean} True if valid
 */
function isValidVersion(version) {
  if (!version || typeof version !== 'string') {
    return false;
  }

  // Basic semver check: starts with number, contains dots
  // Also allow prerelease suffixes like -beta.1, -rc.0
  const semverPattern = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
  return semverPattern.test(version);
}

/**
 * Construct tarball URL for npm registry
 * @param {string} name - Package name
 * @param {string} version - Package version
 * @param {string} registry - Registry base URL
 * @returns {string} Tarball URL
 */
function constructTarballUrl(name, version, registry = DEFAULTS.NPM_REGISTRY_URL) {
  // Remove trailing slash from registry
  registry = registry.replace(/\/$/, '');

  // Handle scoped packages: @scope/package -> @scope%2fpackage for URL path
  if (name.startsWith('@')) {
    const encoded = name.replace('/', '%2f');
    const packagePart = name.split('/')[1];
    return `${registry}/${encoded}/-/${packagePart}-${version}.tgz`;
  }

  return `${registry}/${name}/-/${name}-${version}.tgz`;
}

/**
 * Parse pnpm lockfile and extract package information
 * Supports lockfile versions 5.x, 6.x, and 9.x
 *
 * @param {string} lockfilePath - Path to pnpm-lock.yaml
 * @param {object} options - Parsing options
 * @param {string} options.registryUrl - Registry URL for tarball construction
 * @param {boolean} options.skipOptional - Skip optional dependencies
 * @returns {Promise<Map<string, object>>} Map of packageId -> package info
 */
async function parseLockfile(lockfilePath, options = {}) {
  const { registryUrl = DEFAULTS.NPM_REGISTRY_URL, skipOptional = false } = options;

  const content = await fs.readFile(lockfilePath, 'utf8');
  const lockfile = yaml.load(content);

  const packages = new Map();
  const skipped = { nonRegistry: 0, invalid: 0, duplicate: 0, optional: 0 };

  // Detect lockfile version
  const lockfileVersion = String(lockfile.lockfileVersion || '6.0');
  const majorVersion = parseInt(lockfileVersion.split('.')[0], 10);

  debug(`Parsing lockfile version ${lockfileVersion} (major: ${majorVersion})`);

  // Process packages section (primary source of package info)
  if (lockfile.packages) {
    for (const [key, value] of Object.entries(lockfile.packages)) {
      // Skip optional dependencies if requested
      if (skipOptional && value && value.optional === true) {
        skipped.optional++;
        continue;
      }

      const packageInfo = parsePackageKey(key);

      if (!packageInfo) {
        skipped.nonRegistry++;
        continue;
      }

      const { name, version } = packageInfo;
      const packageId = `${name}@${version}`;

      // Skip if already processed (from different peer dep variants)
      if (packages.has(packageId)) {
        skipped.duplicate++;
        continue;
      }

      // Get tarball URL - check multiple possible locations
      let tarballUrl = null;
      let integrity = null;

      // Check if tarball is directly in the resolution
      if (value && value.resolution && value.resolution.tarball) {
        tarballUrl = value.resolution.tarball;
        integrity = value.resolution.integrity;
      } else if (value && value.resolution && value.resolution.integrity) {
        // Construct tarball URL from package name and version
        tarballUrl = constructTarballUrl(name, version, registryUrl);
        integrity = value.resolution.integrity;
      } else if (value && value.integrity) {
        // Some lockfile versions put integrity at root level
        tarballUrl = constructTarballUrl(name, version, registryUrl);
        integrity = value.integrity;
      } else {
        // Fallback: construct URL anyway (might work)
        tarballUrl = constructTarballUrl(name, version, registryUrl);
      }

      packages.set(packageId, {
        name,
        version,
        tarballUrl,
        integrity,
        dev: value?.dev === true,
        optional: value?.optional === true
      });
    }
  }

  // For v9+, also check snapshots section for any packages not in packages section
  if (majorVersion >= 9 && lockfile.snapshots) {
    for (const [key, value] of Object.entries(lockfile.snapshots)) {
      const packageInfo = parsePackageKey(key);

      if (!packageInfo) {
        continue;
      }

      const { name, version } = packageInfo;
      const packageId = `${name}@${version}`;

      // Skip if already have this package from packages section
      if (packages.has(packageId)) {
        continue;
      }

      const tarballUrl = constructTarballUrl(name, version, registryUrl);

      packages.set(packageId, {
        name,
        version,
        tarballUrl,
        integrity: value?.resolution?.integrity,
        dev: value?.dev === true,
        optional: value?.optional === true,
        fromSnapshots: true
      });
    }
  }

  debug(`Parsed ${packages.size} packages from lockfile`);
  debug(`Skipped: ${skipped.nonRegistry} non-registry, ${skipped.invalid} invalid, ${skipped.duplicate} duplicate, ${skipped.optional} optional`);

  return packages;
}

/**
 * Download a package tarball
 * @param {object} packageInfo - Package info with tarballUrl
 * @param {string} outputDir - Directory to save tarball
 * @returns {Promise<object>} Download result
 */
async function downloadPackage(packageInfo, outputDir) {
  const { name, version, tarballUrl } = packageInfo;
  const packageId = `${name}@${version}`;

  // Generate safe filename (replace / with - for scoped packages)
  const fileName = `${name.replace('/', '-').replace('@', '')}-${version}.tgz`;
  const filePath = path.join(outputDir, fileName);

  // Skip if already downloaded
  if (await fs.pathExists(filePath)) {
    return {
      status: STATUS.SKIPPED,
      package: packageId,
      reason: 'Already downloaded',
      path: filePath
    };
  }

  try {
    const response = await axios({
      method: 'GET',
      url: tarballUrl,
      responseType: 'stream',
      timeout: TIMEOUTS.DOWNLOAD,
      validateStatus: (status) => status === 200
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        resolve({
          status: STATUS.SUCCESS,
          package: packageId,
          path: filePath,
          size: writer.bytesWritten
        });
      });
      writer.on('error', async (error) => {
        // Clean up partial file
        await fs.unlink(filePath).catch(() => {});
        reject(error);
      });
    });
  } catch (error) {
    // Clean up partial file if exists
    await fs.unlink(filePath).catch(() => {});

    const errorMessage = error.response
      ? `HTTP ${error.response.status}: ${error.response.statusText}`
      : error.message;

    return {
      status: STATUS.ERROR,
      package: packageId,
      error: errorMessage,
      url: tarballUrl
    };
  }
}

/**
 * Main function to fetch all dependencies
 * @param {object} config - Fetch configuration
 * @param {string} config.lockfilePath - Path to pnpm-lock.yaml
 * @param {string} config.outputDir - Output directory for packages
 * @param {number} config.concurrency - Concurrent downloads
 * @param {string} config.registryUrl - Registry URL
 * @param {string} config.registryStatePath - Path to registry-state.json for diff-based fetching
 * @param {boolean} config.skipOptional - Skip optional dependencies
 * @param {boolean} config.debug - Enable debug logging
 */
async function fetchDependencies(config) {
  const {
    lockfilePath = DEFAULTS.LOCKFILE_PATH,
    outputDir = DEFAULTS.PACKAGES_DIR,
    concurrency = CONCURRENCY.FETCH,
    registryUrl = DEFAULTS.NPM_REGISTRY_URL,
    registryStatePath = null,
    skipOptional = false,
    debug: debugEnabled = false
  } = config;

  // Enable debug mode if requested
  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  await validateFile(lockfilePath, 'Lockfile');
  if (registryUrl !== DEFAULTS.NPM_REGISTRY_URL) {
    validateRegistryUrl(registryUrl);
  }

  // Ensure output directory exists
  await fs.ensureDir(outputDir);

  // Parse lockfile
  const spinner = ora('Parsing lockfile...').start();
  let packages = await parseLockfile(lockfilePath, { registryUrl, skipOptional });
  spinner.succeed(`Found ${packages.size} packages in lockfile`);

  // Filter packages against registry state if provided
  let diffStats = null;
  if (registryStatePath) {
    const { loadRegistryState, buildVersionLookup, filterMissingPackages } = require('./registry-state');

    const stateSpinner = ora('Loading registry state...').start();
    try {
      const registryState = await loadRegistryState(registryStatePath);
      const versionLookup = buildVersionLookup(registryState);
      const { missing, stats } = filterMissingPackages(packages, versionLookup);

      diffStats = stats;
      packages = missing;

      stateSpinner.succeed(
        `Registry state: ${stats.existing} packages already exist, ${stats.missing} to fetch`
      );
    } catch (error) {
      stateSpinner.fail(`Failed to load registry state: ${error.message}`);
      throw error;
    }
  }

  if (packages.size === 0) {
    if (diffStats) {
      console.log(chalk.green('All packages already exist in the target registry!'));
    } else {
      console.log(chalk.yellow('No packages found in lockfile'));
    }
    return {
      success: true,
      total: diffStats ? diffStats.total : 0,
      downloaded: 0,
      skipped: diffStats ? diffStats.existing : 0,
      failed: 0,
      diffStats
    };
  }

  // Create metadata file
  const metadata = {
    timestamp: new Date().toISOString(),
    lockfilePath: path.resolve(lockfilePath),
    registryUrl,
    packageCount: packages.size,
    packages: Array.from(packages.values()).map(p => ({
      name: p.name,
      version: p.version,
      dev: p.dev,
      optional: p.optional
    }))
  };
  await fs.writeJson(path.join(outputDir, 'metadata.json'), metadata, { spaces: 2 });

  // Download packages with concurrency limit
  const limit = pLimit(concurrency);
  const downloadSpinner = ora('Downloading packages...').start();

  let completed = 0;
  let downloaded = 0;
  let skipped = 0;
  const errors = [];

  const downloadPromises = Array.from(packages.values()).map(packageInfo =>
    limit(async () => {
      const result = await downloadPackage(packageInfo, outputDir);
      completed++;

      if (result.status === STATUS.SUCCESS) {
        downloaded++;
      } else if (result.status === STATUS.SKIPPED) {
        skipped++;
      } else {
        errors.push(result);
      }

      downloadSpinner.text = `Downloading... ✅ ${downloaded} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${packages.size})`;

      return result;
    })
  );

  const results = await Promise.all(downloadPromises);
  downloadSpinner.succeed(`Download complete: ✅ ${downloaded} downloaded, ⏭️  ${skipped} skipped, ❌ ${errors.length} failed`);

  // Report errors if any
  if (errors.length > 0) {
    console.log(chalk.yellow(`\n⚠️  ${errors.length} packages failed to download:`));
    errors.slice(0, 10).forEach(err => {
      console.log(chalk.red(`  - ${err.package}: ${err.error}`));
    });
    if (errors.length > 10) {
      console.log(chalk.gray(`  ... and ${errors.length - 10} more`));
    }
  }

  // Create transfer bundle info
  const bundleInfo = {
    created: new Date().toISOString(),
    lockfilePath: path.resolve(lockfilePath),
    registryUrl,
    totalPackages: packages.size,
    successfulDownloads: downloaded,
    skippedDownloads: skipped,
    failedDownloads: errors.length,
    ...(diffStats && {
      incrementalMode: true,
      registryStatePath: path.resolve(registryStatePath),
      diffStats: {
        totalInLockfile: diffStats.total,
        existingInRegistry: diffStats.existing,
        missingFromRegistry: diffStats.missing
      }
    }),
    errors: errors.map(e => ({
      package: e.package,
      error: e.error,
      url: e.url
    })),
    results: results.map(r => ({
      package: r.package,
      status: r.status,
      ...(r.error && { error: r.error }),
      ...(r.reason && { reason: r.reason })
    }))
  };

  await fs.writeJson(path.join(outputDir, 'bundle-info.json'), bundleInfo, { spaces: 2 });

  return {
    success: errors.length === 0,
    total: diffStats ? diffStats.total : packages.size,
    downloaded,
    skipped: diffStats ? diffStats.existing + skipped : skipped,
    failed: errors.length,
    errors,
    diffStats
  };
}

module.exports = {
  fetchDependencies,
  parseLockfile,
  parsePackageKey,
  constructTarballUrl,
  isValidVersion
};
