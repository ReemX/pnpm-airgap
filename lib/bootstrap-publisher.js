#!/usr/bin/env node

/**
 * Bootstrap Publisher - Dependency-free package publisher for initial Verdaccio setup
 *
 * This script uses only Node.js built-in modules to publish packages to Verdaccio
 * when the registry is empty and you need to bootstrap the pnpm-airgap tool itself.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const {
  TIMEOUTS,
  CONCURRENCY,
  STATUS,
  EXISTENCE,
  SIZES,
  DEFAULTS,
  VERSION_TAG_PREFIX
} = require('./constants');
const {
  packageExists,
  detectPrereleaseTag,
  calculateTimeoutSync,
  verifyAuth,
  generateVersionTag,
  setDebugMode
} = require('./shared-utils');

const execAsync = promisify(exec);

/**
 * Simple console logging with colors (no dependencies)
 */
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  gray: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`),
  debug: (msg) => process.env.DEBUG && console.log(`\x1b[90m[DEBUG]\x1b[0m ${msg}`)
};

/**
 * Simple package info extraction using only Node.js built-ins
 * No external dependencies - uses system tar command
 */
async function getPackageInfoSimple(tarballPath) {
  try {
    // Extract package.json directly with single command (faster)
    // Try multiple patterns to handle different tarball structures
    const commands = [
      `tar -xzf "${tarballPath}" -O package/package.json`,
      `tar -xzf "${tarballPath}" -O "*/package.json"`,
      `tar -xzf "${tarballPath}" -O package.json`
    ];

    for (const command of commands) {
      try {
        const { stdout: packageContent } = await execAsync(command, {
          timeout: TIMEOUTS.PACKAGE_INFO,
          maxBuffer: SIZES.BUFFER_1MB
        });

        if (packageContent.trim()) {
          const packageJson = JSON.parse(packageContent);
          if (packageJson.name && packageJson.version) {
            return packageJson;
          }
        }
      } catch (cmdError) {
        // Try next command
        continue;
      }
    }

    throw new Error('Could not extract package.json with any tar command');
  } catch (error) {
    throw new Error(`Failed to extract package.json from ${path.basename(tarballPath)}: ${error.message}`);
  }
}

/**
 * Publish a single package
 */
async function publishPackage(tarballPath, registryUrl, options = {}) {
  const { dryRun = false } = options;
  let packageInfo = null;
  let packageId = path.basename(tarballPath, '.tgz');

  try {
    packageInfo = await getPackageInfoSimple(tarballPath);
    packageId = `${packageInfo.name}@${packageInfo.version}`;
  } catch (error) {
    log.warn(`Could not extract package info for ${packageId}, continuing with filename`);
  }

  // Detect if this is a prerelease version and determine tag
  const prereleaseTag = packageInfo ? detectPrereleaseTag(packageInfo.version) : null;
  const tagOption = prereleaseTag ? `--tag ${prereleaseTag}` : '';

  // Calculate timeout based on file size
  const timeout = calculateTimeoutSync(tarballPath);

  // Dry run mode
  if (dryRun) {
    return {
      status: STATUS.SUCCESS,
      package: packageId,
      dryRun: true,
      tag: prereleaseTag || 'latest'
    };
  }

  // Publish
  try {
    await execAsync(
      `npm publish "${tarballPath}" --registry "${registryUrl}" ${tagOption} --provenance false`,
      { timeout }
    );

    return {
      status: STATUS.SUCCESS,
      package: packageId,
      tag: prereleaseTag || 'latest'
    };

  } catch (error) {
    const errorMessage = error.message || '';

    // Check if it's a version conflict (trying to publish older version)
    if (errorMessage.includes('previously published version') &&
        errorMessage.includes('is higher than') &&
        errorMessage.includes('You must specify a tag')) {

      try {
        const versionTag = packageInfo ? generateVersionTag(packageInfo.version) : VERSION_TAG_PREFIX;
        await execAsync(
          `npm publish "${tarballPath}" --registry "${registryUrl}" --tag ${versionTag} --provenance false`,
          { timeout }
        );

        return {
          status: STATUS.SUCCESS,
          package: packageId,
          note: `Published with tag ${versionTag} (older version)`,
          tag: versionTag
        };
      } catch (retryError) {
        return {
          status: STATUS.ERROR,
          package: packageId,
          error: `Version conflict retry failed: ${retryError.message.split('\n')[0]}`
        };
      }
    }

    // Check if it's a prerelease tag requirement error
    if (errorMessage.includes('You must specify a tag using --tag when publishing a prerelease version')) {
      return {
        status: STATUS.ERROR,
        package: packageId,
        error: 'Prerelease tag detection failed - manual intervention needed'
      };
    }

    // Check if it's a conflict (already exists)
    if (errorMessage.includes('409') ||
        errorMessage.includes('conflict') ||
        errorMessage.includes('cannot publish over')) {
      return {
        status: STATUS.SKIPPED,
        package: packageId,
        reason: 'Already exists (conflict)'
      };
    }

    return {
      status: STATUS.ERROR,
      package: packageId,
      error: errorMessage.split('\n')[0]
    };
  }
}

/**
 * Main bootstrap publisher function
 */
async function bootstrapPublish(packagesDir, registryUrl = DEFAULTS.REGISTRY_URL, options = {}) {
  const { dryRun = false, debug: debugEnabled = false } = options;

  if (debugEnabled) {
    setDebugMode(true);
  }

  log.info('Bootstrap Publisher - Dependency-free publishing');
  log.gray(`Packages: ${packagesDir}`);
  log.gray(`Registry: ${registryUrl}`);

  if (dryRun) {
    log.warn('DRY RUN MODE - No packages will actually be published\n');
  }

  // Check packages directory
  if (!fs.existsSync(packagesDir)) {
    throw new Error(`Packages directory not found: ${packagesDir}`);
  }

  // Verify authentication
  log.info('Verifying authentication...');
  try {
    const username = await verifyAuth(registryUrl);
    log.success(`Authenticated as: ${username}`);
  } catch (error) {
    if (dryRun) {
      log.warn('Could not verify authentication (dry run mode)');
    } else {
      throw error;
    }
  }

  // Find tarballs
  const files = fs.readdirSync(packagesDir);
  const tarballs = files
    .filter(f => f.endsWith('.tgz'))
    .map(f => path.join(packagesDir, f));

  if (tarballs.length === 0) {
    log.warn('No .tgz files found');
    return { success: true, total: 0, successful: 0, skipped: 0, failed: 0 };
  }

  log.info(`Found ${tarballs.length} packages to publish`);

  // Pre-check existing packages in bulk
  log.info('Pre-checking existing packages...');
  const preCheckedPackages = new Set();
  const packageInfoMap = new Map();
  let uncertainCount = 0;

  let preCheckCompleted = 0;
  for (let i = 0; i < tarballs.length; i += CONCURRENCY.PRE_CHECK) {
    const batch = tarballs.slice(i, i + CONCURRENCY.PRE_CHECK);
    const batchPromises = batch.map(async (tarball) => {
      try {
        const info = await getPackageInfoSimple(tarball);
        const packageId = `${info.name}@${info.version}`;
        packageInfoMap.set(tarball, { info, packageId });

        if (!dryRun) {
          const result = await packageExists(info.name, info.version, registryUrl);

          if (result.status === EXISTENCE.EXISTS && result.certain) {
            preCheckedPackages.add(packageId);
          } else if (result.status === EXISTENCE.UNCERTAIN) {
            uncertainCount++;
          }
        }

        preCheckCompleted++;
        process.stdout.write(`\rPre-checking... [${preCheckCompleted}/${tarballs.length}]`);
      } catch (error) {
        preCheckCompleted++;
        process.stdout.write(`\rPre-checking... [${preCheckCompleted}/${tarballs.length}]`);
      }
    });

    await Promise.all(batchPromises);
  }

  console.log(); // New line after progress
  log.success(`Pre-check complete: ${preCheckedPackages.size} exist, ${tarballs.length - preCheckedPackages.size} to publish` +
    (uncertainCount > 0 ? ` (${uncertainCount} uncertain)` : ''));

  // Early exit if no packages need publishing
  const packagesToPublish = tarballs.length - preCheckedPackages.size;
  if (packagesToPublish === 0 && uncertainCount === 0) {
    log.info('All packages already exist in registry - nothing to publish');
    return {
      success: true,
      total: tarballs.length,
      successful: 0,
      skipped: preCheckedPackages.size,
      failed: 0
    };
  }

  log.info(`Publishing ${packagesToPublish} packages (${preCheckedPackages.size} already skipped)`);

  // Process packages concurrently with limited concurrency
  let successful = 0;
  let skipped = preCheckedPackages.size;
  let errors = [];
  let completed = preCheckedPackages.size;
  const totalPackages = tarballs.length;

  const processPackage = async (tarball) => {
    const filename = path.basename(tarball);

    try {
      let info, packageId;
      if (packageInfoMap.has(tarball)) {
        const cached = packageInfoMap.get(tarball);
        info = cached.info;
        packageId = cached.packageId;
      } else {
        info = await getPackageInfoSimple(tarball);
        packageId = `${info.name}@${info.version}`;
      }

      if (preCheckedPackages.has(packageId)) {
        return { status: STATUS.SKIPPED, package: packageId, reason: 'Pre-checked' };
      }

      const result = await publishPackage(tarball, registryUrl, { dryRun });
      completed++;

      process.stdout.write(`\r[${completed}/${totalPackages}] `);

      if (result.status === STATUS.SUCCESS) {
        successful++;
        console.log(`✅ ${filename}${result.dryRun ? ' (dry run)' : ''}`);
      } else if (result.status === STATUS.SKIPPED) {
        skipped++;
        console.log(`⏭️  ${filename} (skipped)`);
      } else {
        errors.push(result);
        console.log(`❌ ${filename}`);
        log.error(`  ${result.package}: ${result.error}`);
      }

      return result;
    } catch (error) {
      completed++;
      const errorResult = {
        status: STATUS.ERROR,
        package: filename,
        error: error.message
      };
      errors.push(errorResult);
      console.log(`❌ ${filename}`);
      log.error(`  ${filename}: ${error.message}`);
      return errorResult;
    }
  };

  // Process in batches with concurrency limit
  for (let i = 0; i < tarballs.length; i += CONCURRENCY.PUBLISH) {
    const batch = tarballs.slice(i, i + CONCURRENCY.PUBLISH);
    const batchPromises = batch.map(tarball => processPackage(tarball));
    await Promise.all(batchPromises);
  }

  // Summary
  console.log();
  log.success(`✅ ${dryRun ? 'Would publish' : 'Published'}: ${successful}`);
  log.info(`⏭️  Skipped: ${skipped}`);
  if (errors.length > 0) {
    log.error(`❌ Failed: ${errors.length}`);
  }
  if (uncertainCount > 0) {
    log.warn(`⚠️  Uncertain pre-checks: ${uncertainCount}`);
  }

  if (errors.length > 0) {
    log.info('\nFailed packages:');
    errors.slice(0, 10).forEach(err => {
      log.error(`  - ${err.package}: ${err.error}`);
    });
    if (errors.length > 10) {
      log.gray(`  ... and ${errors.length - 10} more`);
    }
  }

  return {
    success: errors.length === 0,
    total: tarballs.length,
    successful,
    skipped,
    failed: errors.length,
    uncertainPreChecks: uncertainCount,
    dryRun
  };
}

// CLI usage when run directly
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse arguments
  const dryRun = args.includes('--dry-run');
  const debug = args.includes('--debug');
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  if (filteredArgs.length === 0) {
    console.log(`
Bootstrap Publisher - Dependency-free package publisher

Usage:
  node bootstrap-publisher.js <packages-dir> [registry-url] [options]

Options:
  --dry-run    Show what would be published without actually publishing
  --debug      Enable debug output

Examples:
  node bootstrap-publisher.js ./airgap-packages
  node bootstrap-publisher.js ./airgap-packages http://localhost:4873
  node bootstrap-publisher.js ./airgap-packages --dry-run

Note: Make sure you are logged in to the registry first:
  npm login --registry http://localhost:4873
`);
    process.exit(1);
  }

  const packagesDir = filteredArgs[0];
  const registryUrl = filteredArgs[1] || DEFAULTS.REGISTRY_URL;

  bootstrapPublish(packagesDir, registryUrl, { dryRun, debug })
    .then(result => {
      if (result.failed > 0) {
        process.exit(1);
      }
    })
    .catch(error => {
      log.error(error.message);
      process.exit(1);
    });
}

module.exports = { bootstrapPublish };
