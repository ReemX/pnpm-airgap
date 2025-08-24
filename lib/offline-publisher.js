const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');

const execAsync = promisify(exec);

/**
 * Enhanced package info extraction with better error handling
 */
async function getPackageInfo(tarballPath) {
  try {
    const tar = require('tar');
    let packageJson = null;

    await new Promise((resolve, reject) => {
      const stream = tar.t({
        file: tarballPath,
        onentry: (entry) => {
          // Look for package.json in various possible locations
          if (entry.path === 'package/package.json' ||
              entry.path === 'package.json' ||
              entry.path.endsWith('/package.json')) {
            const chunks = [];
            entry.on('data', chunk => chunks.push(chunk));
            entry.on('end', () => {
              try {
                packageJson = JSON.parse(Buffer.concat(chunks).toString());
                resolve();
              } catch (parseError) {
                reject(new Error(`Failed to parse package.json: ${parseError.message}`));
              }
            });
            entry.on('error', reject);
          }
        }
      });

      stream.on('end', () => {
        if (!packageJson) {
          reject(new Error('package.json not found in tarball'));
        } else {
          resolve();
        }
      });

      stream.on('error', reject);
    });

    if (!packageJson || !packageJson.name || !packageJson.version) {
      throw new Error('Invalid package.json - missing name or version');
    }

    return packageJson;
  } catch (error) {
    // Enhanced fallback: parse filename more robustly
    const basename = path.basename(tarballPath, '.tgz');

    // Handle @types packages
    if (basename.startsWith('@types-')) {
      const withoutPrefix = basename.substring(7);
      const lastDashIndex = withoutPrefix.lastIndexOf('-');
      if (lastDashIndex > 0) {
        const packageName = withoutPrefix.substring(0, lastDashIndex);
        const version = withoutPrefix.substring(lastDashIndex + 1);
        // Convert dashes back to slashes for nested @types packages
        const name = `@types/${packageName.replace(/--/g, '/')}`;
        return { name, version };
      }
    }

    // Handle other scoped packages (e.g., @scope-package-name-version)
    if (basename.startsWith('@')) {
      const withoutAt = basename.substring(1);
      const parts = withoutAt.split('-');
      if (parts.length >= 3) {
        // Find where version starts (first part that looks like a version)
        let versionStartIndex = -1;
        for (let i = 1; i < parts.length; i++) {
          if (/^\d+\.\d+\.\d+/.test(parts[i])) {
            versionStartIndex = i;
            break;
          }
        }

        if (versionStartIndex > 0) {
          const scope = parts[0];
          const packageName = parts.slice(1, versionStartIndex).join('-');
          const version = parts.slice(versionStartIndex).join('-');
          return {
            name: `@${scope}/${packageName}`,
            version
          };
        }
      }
    }

    // Handle regular packages
    const match = basename.match(/^(.+)-(\d+\.\d+\.\d+.*)$/);
    if (match) {
      return {
        name: match[1],
        version: match[2]
      };
    }

    throw new Error(`Could not parse package info from ${basename}: ${error.message}`);
  }
}

/**
 * Check if package version already exists in registry
 */
async function packageExists(name, version, registryUrl) {
  try {
    const { stdout } = await execAsync(
      `npm view ${name}@${version} version --registry ${registryUrl}`,
      { timeout: 10000 }
    );
    return stdout.trim() === version;
  } catch (error) {
    // Package doesn't exist or error accessing registry
    return false;
  }
}

/**
 * Enhanced publish function with retry logic and better error handling
 */
async function publishPackage(tarballPath, registryUrl, skipExisting = true, maxRetries = 3) {
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

    // Check if already exists (only if we have valid package info)
    if (skipExisting && packageInfo) {
      const exists = await packageExists(packageInfo.name, packageInfo.version, registryUrl);
      if (exists) {
        return {
          status: 'skipped',
          package: packageIdentifier,
          reason: 'Already exists in registry'
        };
      }
    }

    // Calculate appropriate timeout
    const timeout = packageInfo ?
      await calculateTimeout(tarballPath, packageInfo.name) :
      60000; // Default 1 minute if no package info

    // Retry logic for publishing
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(
          `npm publish "${tarballPath}" --registry ${registryUrl} --provenance false`,
          {
            timeout,
            // Increase maxBuffer for large packages
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
          }
        );

        return {
          status: 'success',
          package: packageIdentifier,
          attempt,
          size: await getFileSizeString(tarballPath)
        };

      } catch (publishError) {
        lastError = publishError;

        // Check if it's a conflict error (package already exists)
        if (publishError.message.includes('409') ||
            publishError.message.includes('conflict') ||
            publishError.message.includes('cannot publish over')) {
          return {
            status: 'skipped',
            package: packageIdentifier,
            reason: 'Already exists (409 Conflict)'
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
          const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
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
      status: 'error',
      package: packageIdentifier,
      error: lastError.message,
      attempts: maxRetries
    };

  } catch (error) {
    return {
      status: 'error',
      package: packageIdentifier,
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
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  } catch {
    return 'unknown size';
  }
}

/**
 * Calculate dynamic timeout based on file size and package characteristics
 */
async function calculateTimeout(tarballPath, packageName) {
  try {
    const stats = await fs.stat(tarballPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    // Base timeout: 30 seconds
    let timeout = 30000;

    // Add time based on file size (15 seconds per MB, minimum 30s)
    timeout = Math.max(timeout, fileSizeMB * 15000);

    // Special cases for known problematic packages
    const largePackages = [
      'next', '@next/core', 'webpack', 'typescript', 'react-scripts',
      '@angular/cli', 'electron', 'puppeteer', 'playwright'
    ];

    if (largePackages.some(pkg => packageName.includes(pkg))) {
      timeout = Math.max(timeout, 120000); // minimum 2 minutes
    }

    // Cap at 5 minutes to prevent hanging
    timeout = Math.min(timeout, 300000);

    return timeout;
  } catch (error) {
    // If we can't read file stats, use conservative timeout
    return 60000; // 1 minute
  }
}

/**
 * Verify authentication to registry
 */
async function verifyAuth(registryUrl) {
  try {
    const { stdout } = await execAsync(
      `npm whoami --registry ${registryUrl}`,
      { timeout: 5000 }
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
 * Main function to publish all packages
 */
async function publishPackages(config) {
  const { packagesDir, registryUrl, concurrency = 3, skipExisting = true } = config;

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
  const tarballs = files
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

  // Publish packages with concurrency limit
  const limit = pLimit(concurrency);
  const publishSpinner = ora('Publishing packages...').start();

  let completed = 0;
  let successful = 0;
  let skipped = 0;
  let errors = [];

  const publishPromises = tarballs.map(tarball =>
    limit(async () => {
      const result = await publishPackage(tarball, registryUrl, skipExisting);
      completed++;

      if (result.status === 'success') {
        successful++;
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${tarballs.length})`;
      } else if (result.status === 'skipped') {
        skipped++;
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${tarballs.length})`;
      } else {
        errors.push(result);
        publishSpinner.text = `Publishing... ✅ ${successful} | ⏭️  ${skipped} | ❌ ${errors.length} (${completed}/${tarballs.length})`;
      }

      return result;
    })
  );

  const results = await Promise.all(publishPromises);
  publishSpinner.succeed(`Publishing complete: ✅ ${successful} published, ⏭️  ${skipped} skipped, ❌ ${errors.length} failed`);

  // Report detailed results
  if (successful > 0) {
    console.log(chalk.green(`\n✅ Successfully published ${successful} packages`));
  }

  if (skipped > 0) {
    console.log(chalk.gray(`\n⏭️  Skipped ${skipped} packages (already exist)`));
  }

  if (errors.length > 0) {
    console.log(chalk.red(`\n❌ Failed to publish ${errors.length} packages:`));
    errors.forEach(err => {
      console.log(chalk.red(`  - ${err.package}: ${err.error}`));
    });
  }

  // Save publish report
  const report = {
    timestamp: new Date().toISOString(),
    registry: registryUrl,
    total: tarballs.length,
    successful,
    skipped,
    failed: errors.length,
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
