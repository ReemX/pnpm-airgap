const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');
const {
  TIMEOUTS,
  CONCURRENCY,
  STATUS,
  EXISTENCE,
  MAX_BUFFER,
  SIZES,
  RETRY,
  VERSION_TAG_PREFIX
} = require('./constants');
const {
  packageExists,
  detectPrereleaseTag,
  calculateTimeout,
  calculateBackoffDelay,
  verifyAuth,
  validateRegistryUrl,
  validateDirectory,
  generateVersionTag,
  getFileSizeString,
  setDebugMode,
  debug,
  sleep,
  batchProcess
} = require('./shared-utils');

const execAsync = promisify(exec);

/**
 * Enhanced package info extraction with better error handling
 * @param {string} tarballPath - Path to tarball
 * @returns {Promise<object>} Package.json contents
 */
async function getPackageInfo(tarballPath) {
  try {
    const tar = require('tar');
    let packageJson = null;
    let mainPackageJson = null;

    await tar.t({
      file: tarballPath,
      onentry: (entry) => {
        // Look for package.json in various possible locations
        if (entry.path === 'package/package.json' ||
            entry.path === 'package.json' ||
            entry.path.endsWith('/package.json')) {
          const chunks = [];
          let chunkSize = 0;
          const maxSize = SIZES.BUFFER_1MB;

          entry.on('data', chunk => {
            chunkSize += chunk.length;
            if (chunkSize > maxSize) {
              entry.destroy();
              return;
            }
            chunks.push(chunk);
          });

          entry.on('end', () => {
            try {
              if (chunkSize > maxSize) {
                debug(`Package.json too large in ${path.basename(tarballPath)}`);
                return;
              }

              const parsed = JSON.parse(Buffer.concat(chunks).toString());

              // Prioritize the main package.json (at root level)
              if (entry.path === 'package/package.json' || entry.path === 'package.json') {
                mainPackageJson = parsed;
              } else if (!mainPackageJson) {
                packageJson = parsed;
              }
            } catch (parseError) {
              debug(`Failed to parse package.json from ${path.basename(tarballPath)}: ${parseError.message}`);
            }
          });

          entry.on('error', (error) => {
            debug(`Error reading package.json from ${path.basename(tarballPath)}: ${error.message}`);
          });
        }
      }
    });

    const finalPackageJson = mainPackageJson || packageJson;

    if (!finalPackageJson || !finalPackageJson.name || !finalPackageJson.version) {
      throw new Error('Invalid package.json - missing name or version');
    }

    return finalPackageJson;
  } catch (error) {
    throw new Error(`Failed to extract package.json from ${path.basename(tarballPath)}: ${error.message}`);
  }
}

/**
 * Enhanced publish function with retry logic and better error handling
 * @param {string} tarballPath - Path to tarball
 * @param {string} registryUrl - Registry URL
 * @param {object} options - Publish options
 * @returns {Promise<object>} Publish result
 */
async function publishPackage(tarballPath, registryUrl, options = {}) {
  const {
    packageInfo = null,
    maxRetries = RETRY.MAX_ATTEMPTS,
    dryRun = false
  } = options;

  let pkgInfo = packageInfo;
  let packageIdentifier = path.basename(tarballPath, '.tgz');

  try {
    // Get package info if not provided
    if (!pkgInfo) {
      try {
        pkgInfo = await getPackageInfo(tarballPath);
      } catch (infoError) {
        debug(`Warning: Could not extract package info for ${packageIdentifier}: ${infoError.message}`);
      }
    }

    if (pkgInfo) {
      packageIdentifier = `${pkgInfo.name}@${pkgInfo.version}`;
    }

    // Calculate appropriate timeout
    const timeout = await calculateTimeout(tarballPath);

    // Detect if this is a prerelease version and determine tag
    // Always explicitly specify --tag to override publishConfig.tag in package.json
    const prereleaseTag = pkgInfo ? detectPrereleaseTag(pkgInfo.version) : null;
    const tagOption = `--tag ${prereleaseTag || 'latest'}`;

    // Dry run mode - just report what would happen
    if (dryRun) {
      return {
        status: STATUS.SUCCESS,
        package: packageIdentifier,
        name: pkgInfo?.name,
        version: pkgInfo?.version,
        dryRun: true,
        wouldPublish: true,
        tag: prereleaseTag || 'latest'
      };
    }

    // Retry logic for publishing
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await execAsync(
          `npm publish "${tarballPath}" --registry ${registryUrl} ${tagOption} --provenance false`,
          { timeout, maxBuffer: MAX_BUFFER }
        );

        return {
          status: STATUS.SUCCESS,
          package: packageIdentifier,
          name: pkgInfo?.name,
          version: pkgInfo?.version,
          attempt,
          size: await getFileSizeString(tarballPath),
          tag: prereleaseTag || 'latest'
        };

      } catch (publishError) {
        lastError = publishError;
        const errorMessage = publishError.message || '';

        // Check if it's a version conflict (trying to publish older version)
        if (errorMessage.includes('previously published version') &&
            errorMessage.includes('is higher than') &&
            errorMessage.includes('You must specify a tag')) {

          try {
            const versionTag = pkgInfo ? generateVersionTag(pkgInfo.version) : VERSION_TAG_PREFIX;
            await execAsync(
              `npm publish "${tarballPath}" --registry ${registryUrl} --tag ${versionTag} --provenance false`,
              { timeout, maxBuffer: MAX_BUFFER }
            );

            return {
              status: STATUS.SUCCESS,
              package: packageIdentifier,
              name: pkgInfo?.name,
              version: pkgInfo?.version,
              attempt,
              size: await getFileSizeString(tarballPath),
              note: `Published with tag ${versionTag} (older version)`,
              tag: versionTag
            };
          } catch (retryError) {
            return {
              status: STATUS.ERROR,
              package: packageIdentifier,
              name: pkgInfo?.name,
              version: pkgInfo?.version,
              error: `Version conflict retry failed: ${retryError.message.split('\n')[0]}`
            };
          }
        }

        // Check if it's a prerelease tag requirement error
        if (errorMessage.includes('You must specify a tag using --tag when publishing a prerelease version')) {
          return {
            status: STATUS.ERROR,
            package: packageIdentifier,
            name: pkgInfo?.name,
            version: pkgInfo?.version,
            error: 'Prerelease tag detection failed - manual intervention needed'
          };
        }

        // Check for conflict (already exists)
        if (errorMessage.includes('409') ||
            errorMessage.includes('conflict') ||
            errorMessage.includes('cannot publish over')) {
          return {
            status: STATUS.SKIPPED,
            package: packageIdentifier,
            name: pkgInfo?.name,
            version: pkgInfo?.version,
            reason: 'Already exists (conflict)'
          };
        }

        // Check if it's a retryable error
        const retryableErrors = [
          'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND',
          'ECONNREFUSED', 'socket hang up', 'network timeout'
        ];

        const isRetryable = retryableErrors.some(errorType =>
          errorMessage.toLowerCase().includes(errorType.toLowerCase())
        );

        if (isRetryable && attempt < maxRetries) {
          const backoffTime = calculateBackoffDelay(attempt);
          debug(`Retry ${attempt}/${maxRetries} for ${packageIdentifier} in ${backoffTime}ms`);
          await sleep(backoffTime);
          continue;
        }

        break;
      }
    }

    // All retries failed
    return {
      status: STATUS.ERROR,
      package: packageIdentifier,
      name: pkgInfo?.name,
      version: pkgInfo?.version,
      error: lastError?.message?.split('\n')[0] || 'Unknown error',
      attempts: maxRetries
    };

  } catch (error) {
    return {
      status: STATUS.ERROR,
      package: packageIdentifier,
      name: pkgInfo?.name,
      version: pkgInfo?.version,
      error: error.message
    };
  }
}

/**
 * Main function to publish all packages
 * @param {object} config - Publish configuration
 */
async function publishPackages(config) {
  const {
    packagesDir,
    registryUrl,
    concurrency = CONCURRENCY.PUBLISH_LOW,
    skipExisting = true,
    dryRun = false,
    debug: debugEnabled = false
  } = config;

  // Enable debug mode if requested
  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  validateRegistryUrl(registryUrl);
  await validateDirectory(packagesDir, 'Packages directory');

  if (dryRun) {
    console.log(chalk.yellow('🔍 DRY RUN MODE - No packages will actually be published\n'));
  }

  // Verify authentication (skip in dry run if we can't connect)
  const authSpinner = ora('Verifying authentication...').start();
  try {
    const username = await verifyAuth(registryUrl);
    authSpinner.succeed(`Authenticated as: ${username}`);
  } catch (error) {
    if (dryRun) {
      authSpinner.warn('Could not verify authentication (dry run mode)');
    } else {
      authSpinner.fail('Authentication failed');
      throw error;
    }
  }

  // Find all .tgz files
  const files = await fs.readdir(packagesDir);
  let tarballs = files
    .filter(f => f.endsWith('.tgz'))
    .map(f => path.join(packagesDir, f));

  if (tarballs.length === 0) {
    console.log(chalk.yellow('No package tarballs found'));
    return { success: true, total: 0, successful: 0, skipped: 0, failed: 0 };
  }

  console.log(chalk.blue(`Found ${tarballs.length} packages to process`));

  // Extract package info in parallel (much faster than sequential)
  const infoSpinner = ora('Extracting package information...').start();
  const packageInfoCache = new Map();
  let infoExtracted = 0;
  let infoErrors = 0;

  const infoLimit = pLimit(CONCURRENCY.PACKAGE_INFO);
  const infoPromises = tarballs.map(tarball =>
    infoLimit(async () => {
      try {
        const info = await getPackageInfo(tarball);
        const packageId = `${info.name}@${info.version}`;
        packageInfoCache.set(tarball, { info, packageId });
        infoExtracted++;
      } catch (error) {
        infoErrors++;
        debug(`Could not extract info from ${path.basename(tarball)}: ${error.message}`);
      }
      infoSpinner.text = `Extracting package information... (${infoExtracted + infoErrors}/${tarballs.length})`;
    })
  );

  await Promise.all(infoPromises);
  infoSpinner.succeed(`Extracted info from ${infoExtracted} packages${infoErrors > 0 ? ` (${infoErrors} failed)` : ''}`);

  // Pre-check existing packages with improved tri-state logic
  const preCheckedPackages = new Map(); // packageId -> { exists, certain }
  let uncertainCount = 0;

  if (skipExisting && !dryRun) {
    const preCheckSpinner = ora('Pre-checking existing packages...').start();
    const preCheckLimit = pLimit(CONCURRENCY.PRE_CHECK);
    let preCheckedCount = 0;
    let existsCount = 0;

    const preCheckPromises = tarballs.map(tarball =>
      preCheckLimit(async () => {
        const cached = packageInfoCache.get(tarball);
        if (!cached) {
          preCheckedCount++;
          return;
        }

        const { info, packageId } = cached;

        try {
          const result = await packageExists(info.name, info.version, registryUrl);

          if (result.status === EXISTENCE.EXISTS && result.certain) {
            preCheckedPackages.set(packageId, { exists: true, certain: true });
            existsCount++;
          } else if (result.status === EXISTENCE.NOT_EXISTS && result.certain) {
            preCheckedPackages.set(packageId, { exists: false, certain: true });
          } else {
            // Uncertain - we'll try to publish and handle errors
            preCheckedPackages.set(packageId, { exists: false, certain: false, error: result.error });
            uncertainCount++;
          }
        } catch (error) {
          preCheckedPackages.set(packageId, { exists: false, certain: false, error: error.message });
          uncertainCount++;
        }

        preCheckedCount++;
        preCheckSpinner.text = `Pre-checking existing packages... (${preCheckedCount}/${tarballs.length})`;
      })
    );

    await Promise.all(preCheckPromises);

    const toPublish = tarballs.length - existsCount;
    preCheckSpinner.succeed(
      `Pre-check complete: ${existsCount} exist, ${toPublish} to publish` +
      (uncertainCount > 0 ? chalk.yellow(` (${uncertainCount} uncertain)`) : '')
    );

    // Early exit if all packages exist (and all are certain)
    if (existsCount === tarballs.length && uncertainCount === 0) {
      console.log(chalk.yellow('All packages already exist in registry - nothing to publish'));
      return {
        success: true,
        total: tarballs.length,
        successful: 0,
        skipped: existsCount,
        failed: 0
      };
    }

    console.log(chalk.gray(`Publishing ${toPublish} packages (${existsCount} already skipped)`));
  }

  // Publish packages
  const limit = pLimit(concurrency);
  const publishSpinner = ora('Publishing packages...').start();

  let completed = 0;
  let successful = 0;
  let skipped = skipExisting ? Array.from(preCheckedPackages.values()).filter(p => p.exists && p.certain).length : 0;
  let errors = [];
  const totalPackages = tarballs.length;

  const publishPromises = tarballs.map(tarball =>
    limit(async () => {
      const cached = packageInfoCache.get(tarball);
      const packageId = cached?.packageId || path.basename(tarball, '.tgz');

      // Check if we should skip based on pre-check
      if (skipExisting && cached) {
        const preCheck = preCheckedPackages.get(packageId);
        if (preCheck?.exists && preCheck?.certain) {
          // Already counted in skipped, just return
          return {
            status: STATUS.SKIPPED,
            package: packageId,
            reason: 'Pre-checked (exists)'
          };
        }
      }

      // Publish the package
      const result = await publishPackage(tarball, registryUrl, {
        packageInfo: cached?.info,
        dryRun
      });

      completed++;

      if (result.status === STATUS.SUCCESS) {
        successful++;
      } else if (result.status === STATUS.SKIPPED) {
        skipped++;
      } else {
        errors.push(result);
      }

      publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed + (skipExisting ? skipped - completed : 0)}/${totalPackages})`;

      return result;
    })
  );

  const results = await Promise.all(publishPromises);

  // Verify 404 errors - they might be false negatives
  let realFailures = [];
  if (errors.length > 0 && !dryRun) {
    const verifySpinner = ora('Verifying failed packages...').start();
    const verifyLimit = pLimit(CONCURRENCY.VERIFY);
    let verifiedCount = 0;
    let falseNegatives = 0;

    const verifyPromises = errors.map(error =>
      verifyLimit(async () => {
        if (error.error && error.error.includes('404')) {
          const { name, version } = error;

          if (!name || !version || name === 'unknown' || version === 'unknown') {
            return { isFalseNegative: false, error };
          }

          try {
            const result = await packageExists(name, version, registryUrl, { useCache: false });

            if (result.status === EXISTENCE.EXISTS) {
              falseNegatives++;
              return { isFalseNegative: true, error };
            }
          } catch (e) {
            // Verification failed, assume real error
          }
        }

        verifiedCount++;
        verifySpinner.text = `Verifying failed packages... (${verifiedCount}/${errors.length})`;
        return { isFalseNegative: false, error };
      })
    );

    const verificationResults = await Promise.all(verifyPromises);

    verificationResults.forEach(result => {
      if (result.isFalseNegative) {
        successful++;
      } else {
        realFailures.push(result.error);
      }
    });

    if (falseNegatives > 0) {
      verifySpinner.succeed(`Verification complete: ${falseNegatives} false negatives corrected`);
    } else {
      verifySpinner.succeed('Verification complete');
    }
  } else {
    realFailures = errors;
  }

  // Final status
  const statusMessage = dryRun
    ? `Dry run complete: ✅ ${successful} would publish, ⏭️  ${skipped} would skip, ❌ ${realFailures.length} would fail`
    : `Publishing complete: ✅ ${successful} published, ⏭️  ${skipped} skipped, ❌ ${realFailures.length} failed`;

  publishSpinner.succeed(statusMessage);

  // Report detailed results
  if (successful > 0) {
    console.log(chalk.green(`\n✅ ${dryRun ? 'Would publish' : 'Successfully published'} ${successful} packages`));
  }

  if (skipped > 0) {
    console.log(chalk.gray(`\n⏭️  Skipped ${skipped} packages (already exist)`));
  }

  if (realFailures.length > 0) {
    console.log(chalk.red(`\n❌ Failed to publish ${realFailures.length} packages:`));
    realFailures.slice(0, 10).forEach(err => {
      console.log(chalk.red(`  - ${err.package}: ${err.error}`));
    });
    if (realFailures.length > 10) {
      console.log(chalk.gray(`  ... and ${realFailures.length - 10} more`));
    }
  }

  if (uncertainCount > 0 && !dryRun) {
    console.log(chalk.yellow(`\n⚠️  ${uncertainCount} packages had uncertain pre-check status (attempted to publish anyway)`));
  }

  // Save publish report
  const report = {
    timestamp: new Date().toISOString(),
    registry: registryUrl,
    dryRun,
    total: tarballs.length,
    successful,
    skipped,
    failed: realFailures.length,
    uncertainPreChecks: uncertainCount,
    falseNegatives: errors.length - realFailures.length,
    results: results.map(r => ({
      package: r.package,
      status: r.status,
      ...(r.tag && { tag: r.tag }),
      ...(r.error && { error: r.error }),
      ...(r.reason && { reason: r.reason }),
      ...(r.note && { note: r.note }),
      ...(r.dryRun && { dryRun: r.dryRun })
    })),
    errors: realFailures.map(e => ({
      package: e.package,
      error: e.error
    }))
  };

  const reportPath = path.join(packagesDir, dryRun ? 'dry-run-report.json' : 'publish-report.json');
  await fs.writeJson(reportPath, report, { spaces: 2 });

  console.log(chalk.gray(`\n📊 Report saved to: ${reportPath}`));

  return {
    success: realFailures.length === 0,
    total: tarballs.length,
    successful,
    skipped,
    failed: realFailures.length,
    uncertainPreChecks: uncertainCount,
    dryRun
  };
}

module.exports = {
  publishPackages,
  publishPackage,
  getPackageInfo,
  verifyAuth
};
