const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');
const { TIMEOUTS, CONCURRENCY, STATUS, MAX_BUFFER, SIZES } = require('./constants');
const {
  packageExists,
  detectPrereleaseTag,
  calculateTimeout,
  calculateBackoffDelay,
  verifyAuth
} = require('./shared-utils');

const execAsync = promisify(exec);

/**
 * Enhanced package info extraction with better error handling
 */
async function getPackageInfo(tarballPath) {
  try {
    const tar = require('tar');
    let packageJson = null;
    let mainPackageJson = null;

    // tar.t() returns a Promise, not a stream
    await tar.t({
      file: tarballPath,
      onentry: (entry) => {
        // Look for package.json in various possible locations
        if (entry.path === 'package/package.json' ||
            entry.path === 'package.json' ||
            entry.path.endsWith('/package.json')) {
          const chunks = [];
          let chunkSize = 0;
          const maxSize = SIZES.BUFFER_1MB; // 1MB limit for package.json

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
                console.warn(`Package.json too large (${chunkSize} bytes) in ${path.basename(tarballPath)} at ${entry.path}`);
                return;
              }

              const parsed = JSON.parse(Buffer.concat(chunks).toString());

              // Prioritize the main package.json (at root level)
              if (entry.path === 'package/package.json' || entry.path === 'package.json') {
                mainPackageJson = parsed;
              } else if (!mainPackageJson) {
                // Only use nested package.json if we haven't found the main one yet
                packageJson = parsed;
              }
            } catch (parseError) {
              console.warn(`Failed to parse package.json from ${path.basename(tarballPath)} at ${entry.path}: ${parseError.message}`);
            }
          });
          entry.on('error', (error) => {
            console.warn(`Error reading package.json from ${path.basename(tarballPath)} at ${entry.path}: ${error.message}`);
          });
        }
      }
    });

    // Use main package.json if found, otherwise fall back to any package.json
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
 */
async function publishPackage(tarballPath, registryUrl, skipExisting = true, maxRetries = 3, preCheckedPackages = null) {
  let packageInfo = null;
  let packageIdentifier = path.basename(tarballPath, '.tgz');

  try {
    // Get package info with enhanced error handling
    try {
      packageInfo = await getPackageInfo(tarballPath);
      packageIdentifier = `${packageInfo.name}@${packageInfo.version}`;
    } catch (infoError) {
      console.warn(`Warning: Could not extract package info for ${packageIdentifier}: ${infoError.message}`);
      // Continue with filename-based identifier
    }

    // Check if already exists using pre-checked set or direct check
    if (skipExisting && packageInfo) {
      // If we have pre-checked packages, use that (much faster)
      if (preCheckedPackages && preCheckedPackages.has(packageIdentifier)) {
        return {
          status: STATUS.SKIPPED,
          package: packageIdentifier,
          reason: 'Already exists in registry (pre-checked)'
        };
      }
      // Fallback to direct check if not pre-checked
      else if (!preCheckedPackages) {
        const exists = await packageExists(packageInfo.name, packageInfo.version, registryUrl);
        if (exists) {
          return {
            status: STATUS.SKIPPED,
            package: packageIdentifier,
            reason: 'Already exists in registry'
          };
        }
      }
    }

    // Calculate appropriate timeout
    const timeout = packageInfo ?
      calculateTimeout(tarballPath) :
      TIMEOUTS.BASE; // Default if no package info

    // Detect if this is a prerelease version and determine tag
    const prereleaseTag = packageInfo ? detectPrereleaseTag(packageInfo.version) : null;
    const tagOption = prereleaseTag ? `--tag ${prereleaseTag}` : '';

    // Retry logic for publishing
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(
          `npm publish "${tarballPath}" --registry ${registryUrl} ${tagOption} --provenance false`,
          {
            timeout,
            maxBuffer: MAX_BUFFER
          }
        );

        return {
          status: STATUS.SUCCESS,
          package: packageIdentifier,
          name: packageInfo.name,
          version: packageInfo.version,
          attempt,
          size: await getFileSizeString(tarballPath)
        };

      } catch (publishError) {
        lastError = publishError;

        // Check if it's a version conflict (trying to publish older version)
        // In this case, retry with a version-specific tag to force publish
        if (publishError.message.includes('previously published version') &&
            publishError.message.includes('is higher than') &&
            publishError.message.includes('You must specify a tag')) {

          // Retry with version-specific tag to allow older versions to be published
          // NOTE: Tag names cannot be valid semver ranges, so we convert dots to dashes
          try {
            const versionTag = packageInfo ? `legacy-${packageInfo.version.replace(/\./g, '-')}` : 'legacy';
            const { stdout, stderr } = await execAsync(
              `npm publish "${tarballPath}" --registry ${registryUrl} --tag ${versionTag} --provenance false`,
              {
                timeout,
                maxBuffer: MAX_BUFFER
              }
            );

            return {
              status: STATUS.SUCCESS,
              package: packageIdentifier,
              name: packageInfo.name,
              version: packageInfo.version,
              attempt,
              size: await getFileSizeString(tarballPath),
              note: `Published with tag ${versionTag} (older version)`
            };
          } catch (retryError) {
            // If retry also fails, return error
            return {
              status: STATUS.ERROR,
              package: packageIdentifier,
              name: packageInfo.name,
              version: packageInfo.version,
              error: `Version conflict retry failed: ${retryError.message.split('\n')[0]}`
            };
          }
        }

        // Check if it's a prerelease tag requirement error
        if (publishError.message.includes('You must specify a tag using --tag when publishing a prerelease version')) {
          // This shouldn't happen anymore with our tag detection, but just in case
          return {
            status: STATUS.ERROR,
            package: packageIdentifier,
            name: packageInfo.name,
            version: packageInfo.version,
            error: 'Prerelease tag detection failed - manual intervention needed'
          };
        }

        // Check if it's a timeout or network error that we should retry
        const retryableErrors = [
          'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND',
          'ECONNREFUSED', 'socket hang up', 'network timeout'
        ];

        const isRetryable = retryableErrors.some(errorType =>
          publishError.message.toLowerCase().includes(errorType.toLowerCase())
        );

        if (isRetryable && attempt < maxRetries) {
          const backoffTime = calculateBackoffDelay(attempt);
          console.log(`Retry ${attempt}/${maxRetries} for ${packageIdentifier} in ${backoffTime}ms (${publishError.message.split('\n')[0]})`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
          continue;
        }

        // If not retryable or max retries reached, break the loop
        break;
      }
    }

    // If we get here, all retries failed
    return {
      status: STATUS.ERROR,
      package: packageIdentifier,
      name: packageInfo.name,
      version: packageInfo.version,
      error: lastError.message,
      attempts: maxRetries
    };

  } catch (error) {
    return {
      status: STATUS.ERROR,
      package: packageIdentifier,
      name: packageInfo ? packageInfo.name : 'unknown',
      version: packageInfo ? packageInfo.version : 'unknown',
      error: error.message
    };
  }
}

/**
 * Helper function to get human-readable file size
 */
async function getFileSizeString(filePath) {
  try {
    const stats = await fs.stat(filePath);
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
 * Main function to publish all packages
 */
async function publishPackages(config) {
  const { packagesDir, registryUrl, concurrency = CONCURRENCY.PUBLISH_LOW, skipExisting = true } = config;

  // Check if packages directory exists
  if (!await fs.pathExists(packagesDir)) {
    throw new Error(`Packages directory not found: ${packagesDir}`);
  }

  // Verify authentication
  const authSpinner = ora('Verifying authentication...').start();
  try {
    const username = await verifyAuth(registryUrl);
    authSpinner.succeed(`Authenticated as: ${username}`);
  } catch (error) {
    authSpinner.fail('Authentication failed');
    throw error;
  }

  // Find all .tgz files
  const files = await fs.readdir(packagesDir);
  let tarballs = files
    .filter(f => f.endsWith('.tgz'))
    .map(f => path.join(packagesDir, f));

  if (tarballs.length === 0) {
    console.log(chalk.yellow('No package tarballs found'));
    return;
  }

  console.log(chalk.blue(`Found ${tarballs.length} packages to publish`));

  // Group tarballs by package name to handle multiple versions
  const packageGroups = new Map();
  for (const tarball of tarballs) {
    try {
      const info = await getPackageInfo(tarball);
      const { name } = info;
      if (!packageGroups.has(name)) {
        packageGroups.set(name, []);
      }
      packageGroups.get(name).push(tarball);
    } catch (error) {
      console.log(chalk.yellow(`Warning: Could not read ${path.basename(tarball)}`));
    }
  }

  console.log(chalk.gray(`Publishing ${packageGroups.size} unique packages with ${tarballs.length} total versions`));

  // Pre-check existing packages in bulk if skipExisting is enabled
  const preCheckedPackages = new Set();
  const packageInfoCache = new Map(); // Cache package info to avoid re-extraction
  if (skipExisting) {
    const preCheckSpinner = ora('Pre-checking existing packages...').start();
    const preCheckLimit = pLimit(Math.min(CONCURRENCY.PRE_CHECK, concurrency * 3));
    let preCheckedCount = 0;

    const preCheckPromises = tarballs.map(tarball =>
      preCheckLimit(async () => {
        try {
          const info = await getPackageInfo(tarball);
          const packageId = `${info.name}@${info.version}`;
          packageInfoCache.set(tarball, { info, packageId }); // Store for later use

          const exists = await packageExists(info.name, info.version, registryUrl);
          preCheckedCount++;
          preCheckSpinner.text = `Pre-checking existing packages... (${preCheckedCount}/${tarballs.length})`;

          if (exists) {
            preCheckedPackages.add(packageId);
          }
        } catch (error) {
          // If we can't check, we'll try to publish anyway
          preCheckedCount++;
        }
      })
    );

    await Promise.all(preCheckPromises);
    preCheckSpinner.succeed(`Pre-check complete: ${preCheckedPackages.size} packages already exist, ${tarballs.length - preCheckedPackages.size} to publish`);

    // Early exit if no packages need publishing
    const packagesToPublish = tarballs.length - preCheckedPackages.size;
    if (packagesToPublish === 0) {
      console.log(chalk.yellow('All packages already exist in registry - nothing to publish'));
      return;
    }

    console.log(chalk.gray(`Publishing ${packagesToPublish} packages (${preCheckedPackages.size} already skipped)`));
  }

  // Publish packages with concurrency limit
  const limit = pLimit(concurrency);
  const publishSpinner = ora('Publishing packages...').start();

  let completed = skipExisting ? preCheckedPackages.size : 0; // Start from pre-skipped count
  let successful = 0;
  let skipped = skipExisting ? preCheckedPackages.size : 0; // Already counted from pre-check
  let errors = [];
  const totalPackages = tarballs.length;

  const publishPromises = tarballs.map(tarball =>
    limit(async () => {
      // Use cached package info if available, otherwise extract
      let info, packageId;
      if (packageInfoCache.has(tarball)) {
        const cached = packageInfoCache.get(tarball);
        info = cached.info;
        packageId = cached.packageId;
      } else {
        info = await getPackageInfo(tarball);
        packageId = `${info.name}@${info.version}`;
      }

      if (preCheckedPackages.has(packageId)) {
        // Skip this package - it already exists (already counted in initial completed/skipped)
        return { status: STATUS.SKIPPED, package: packageId, reason: 'Pre-checked' };
      }

      // Publish the package (don't pass preCheckedPackages since we already filtered)
      const result = await publishPackage(tarball, registryUrl, false, 3, null);
      completed++;

      if (result.status === STATUS.SUCCESS) {
        successful++;
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${totalPackages})`;
      } else if (result.status === STATUS.SKIPPED) {
        skipped++;
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${totalPackages})`;
      } else {
        errors.push(result);
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${totalPackages})`;
      }

      return result;
    })
  );

  const results = await Promise.all(publishPromises);

  // Verify 404 errors - they might be false negatives (now parallelized)
  let realFailures = [];
  if (errors.length > 0) {
    const verifySpinner = ora('Verifying failed packages...').start();

    // Create verification limit for parallel checking
    const verifyLimit = pLimit(Math.min(CONCURRENCY.VERIFY, concurrency * 3)); // Use higher concurrency for verification
    let verifiedCount = 0;
    let falseNegatives = 0;

    const verifyPromises = errors.map(error =>
      verifyLimit(async () => {
        if (error.error && error.error.includes('404')) {
          try {
            // Use the name and version from the error object directly
            const { name, version } = error;
            
            if (!name || !version || name === 'unknown' || version === 'unknown') {
              return { isFalseNegative: false, error };
            }

            // Check if package actually exists now
            const exists = await packageExists(name, version, registryUrl);
            verifiedCount++;
            verifySpinner.text = `Verifying failed packages... (${verifiedCount}/${errors.length})`;

            if (!exists) {
              return { isFalseNegative: false, error }; // Actually failed
            } else {
              // Package exists - the 404 was a false negative
              falseNegatives++;
              return { isFalseNegative: true, error };
            }
          } catch (verifyError) {
            // If verification fails, assume it's a real failure
            return { isFalseNegative: false, error };
          }
        } else {
          // Non-404 errors are real failures
          verifiedCount++;
          return { isFalseNegative: false, error };
        }
      })
    );

    const verificationResults = await Promise.all(verifyPromises);

    // Separate false negatives from real failures
    verificationResults.forEach(result => {
      if (result.isFalseNegative) {
        successful++; // Count as successful
      } else {
        realFailures.push(result.error);
      }
    });

    verifySpinner.succeed(`Verification complete: ${falseNegatives} false negatives corrected`);
  } else {
    realFailures = errors;
  }

  publishSpinner.succeed(`Publishing complete: ✅ ${successful} published, ⏭️  ${skipped} skipped, ❌ ${realFailures.length} failed`);

  // Report detailed results
  if (successful > 0) {
    console.log(chalk.green(`\n✅ Successfully published ${successful} packages`));
  }

  if (skipped > 0) {
    console.log(chalk.gray(`\n⏭️  Skipped ${skipped} packages (already exist)`));
  }

  if (realFailures.length > 0) {
    console.log(chalk.red(`\n❌ Failed to publish ${realFailures.length} packages:`));
    realFailures.forEach(err => {
      console.log(chalk.red(`  - ${err.package}: ${err.error}`));
    });
  }

  // Save publish report with corrected counts
  const report = {
    timestamp: new Date().toISOString(),
    registry: registryUrl,
    total: tarballs.length,
    successful,
    skipped,
    failed: realFailures.length,
    falseNegatives: errors.length - realFailures.length,
    results
  };

  await fs.writeJson(
    path.join(packagesDir, 'publish-report.json'),
    report,
    { spaces: 2 }
  );

  console.log(chalk.gray(`\n📊 Report saved to: ${path.join(packagesDir, 'publish-report.json')}`));
}

module.exports = {
  publishPackages,
  verifyAuth
};
