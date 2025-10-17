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
const { TIMEOUTS, CONCURRENCY, STATUS, SIZES, DEFAULTS } = require('./constants');
const {
  packageExists,
  detectPrereleaseTag,
  calculateTimeout,
  verifyAuth
} = require('./shared-utils');

/**
 * Simple package info extraction using only Node.js built-ins
 * No external dependencies - uses system tar command
 */
async function getPackageInfoSimple(tarballPath) {
  try {
    // Extract package.json directly with single command (faster)
    // Try multiple patterns to handle different tarball structures
    // Note: Windows bsdtar doesn't support --wildcards, using exact paths and patterns
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

const execAsync = promisify(exec);



/**
 * Simple console logging with colors (no dependencies)
 */
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  gray: (msg) => console.log(`\x1b[90m${msg}\x1b[0m`)
};

/**
 * Publish a single package
 */
async function publishPackage(tarballPath, registryUrl, skipExisting = true, preCheckedPackages = null) {
  let packageInfo = null;
  let packageId = path.basename(tarballPath, '.tgz');

  try {
    packageInfo = await getPackageInfoSimple(tarballPath);
    packageId = `${packageInfo.name}@${packageInfo.version}`;
  } catch (error) {
    log.warn(`Could not extract package info for ${packageId}, continuing with filename`);
  }

  // Check if exists using pre-checked set or direct check
  if (skipExisting && packageInfo) {
    // If we have pre-checked packages, use that (much faster)
    if (preCheckedPackages && preCheckedPackages.has(packageId)) {
      return {
        status: 'skipped',
        package: packageId,
        reason: 'Already exists (pre-checked)'
      };
    }
    // Fallback to direct check if not pre-checked
    else if (!preCheckedPackages) {
      try {
        const exists = await packageExists(packageInfo.name, packageInfo.version, registryUrl);
        if (exists) {
          return {
            status: 'skipped',
            package: packageId,
            reason: 'Already exists'
          };
        }
      } catch (error) {
        // Continue if check fails
      }
    }
  }
  
  // Detect if this is a prerelease version and determine tag
  const prereleaseTag = packageInfo ? detectPrereleaseTag(packageInfo.version) : null;
  const tagOption = prereleaseTag ? `--tag ${prereleaseTag}` : '';

  // Calculate timeout based on file size
  const timeout = calculateTimeout(tarballPath);

  // Publish
  try {
    const { stdout, stderr } = await execAsync(
      `npm publish "${tarballPath}" --registry "${registryUrl}" ${tagOption} --provenance false`,
      { timeout }
    );

    return {
      status: STATUS.SUCCESS,
      package: packageId
    };

  } catch (error) {
    // Check if it's a version conflict (trying to publish older version)
    // In this case, retry with a version-specific tag to force publish
    if (error.message.includes('previously published version') &&
        error.message.includes('is higher than') &&
        error.message.includes('You must specify a tag')) {

      // Retry with version-specific tag to allow older versions to be published
      try {
        const versionTag = packageInfo ? `v${packageInfo.version}` : 'legacy';
        const { stdout, stderr } = await execAsync(
          `npm publish "${tarballPath}" --registry "${registryUrl}" --tag ${versionTag} --provenance false`,
          { timeout }
        );

        return {
          status: STATUS.SUCCESS,
          package: packageId,
          note: `Published with tag ${versionTag} (older version)`
        };
      } catch (retryError) {
        // If retry also fails, return error
        return {
          status: STATUS.ERROR,
          package: packageId,
          error: `Version conflict retry failed: ${retryError.message.split('\n')[0]}`
        };
      }
    }

    // Check if it's a prerelease tag requirement error
    if (error.message.includes('You must specify a tag using --tag when publishing a prerelease version')) {
      return {
        status: STATUS.ERROR,
        package: packageId,
        error: 'Prerelease tag detection failed - manual intervention needed'
      };
    }

    // Check if it's a conflict (already exists)
    if (error.message.includes('409') ||
        error.message.includes('conflict') ||
        error.message.includes('cannot publish over')) {
      return {
        status: STATUS.SKIPPED,
        package: packageId,
        reason: 'Already exists (conflict)'
      };
    }

    return {
      status: STATUS.ERROR,
      package: packageId,
      error: error.message.split('\n')[0] // First line only
    };
  }
}

/**
 * Main bootstrap publisher function
 */
async function bootstrapPublish(packagesDir, registryUrl = DEFAULTS.REGISTRY_URL) {
  log.info('🚀 Bootstrap Publisher - Dependency-free publishing');
  log.gray(`Packages: ${packagesDir}`);
  log.gray(`Registry: ${registryUrl}`);
  
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
    throw error;
  }
  
  // Find tarballs
  const files = fs.readdirSync(packagesDir);
  const tarballs = files
    .filter(f => f.endsWith('.tgz'))
    .map(f => path.join(packagesDir, f));
  
  if (tarballs.length === 0) {
    log.warn('No .tgz files found');
    return;
  }
  
  log.info(`Found ${tarballs.length} packages to publish`);

  // Pre-check existing packages in bulk
  log.info('Pre-checking existing packages...');
  const preCheckedPackages = new Set();
  const packageInfoMap = new Map(); // Store package info to avoid re-extraction

  let preCheckCompleted = 0;
  for (let i = 0; i < tarballs.length; i += CONCURRENCY.PRE_CHECK) {
    const batch = tarballs.slice(i, i + CONCURRENCY.PRE_CHECK);
    const batchPromises = batch.map(async (tarball) => {
      try {
        const info = await getPackageInfoSimple(tarball);
        const packageId = `${info.name}@${info.version}`;
        packageInfoMap.set(tarball, { info, packageId }); // Store for later use
        
        const exists = await packageExists(info.name, info.version, registryUrl);
        preCheckCompleted++;
        process.stdout.write(`\rPre-checking... [${preCheckCompleted}/${tarballs.length}]`);

        if (exists) {
          preCheckedPackages.add(packageId);
        }
      } catch (error) {
        // If we can't check, we'll try to publish anyway
        preCheckCompleted++;
        process.stdout.write(`\rPre-checking... [${preCheckCompleted}/${tarballs.length}]`);
      }
    });

    await Promise.all(batchPromises);
  }

  console.log(); // New line after progress
  log.success(`Pre-check complete: ${preCheckedPackages.size} exist, ${tarballs.length - preCheckedPackages.size} to publish`);

  // Early exit if no packages need publishing
  const packagesToPublish = tarballs.length - preCheckedPackages.size;
  if (packagesToPublish === 0) {
    log.info('All packages already exist in registry - nothing to publish');
    return {
      total: tarballs.length,
      successful: 0,
      skipped: preCheckedPackages.size,
      failed: 0,
      errors: [],
      actuallyProcessed: 0
    };
  }

  log.info(`Publishing ${packagesToPublish} packages (${preCheckedPackages.size} already skipped)`);

  // Process packages concurrently with limited concurrency
  let successful = 0;
  let skipped = preCheckedPackages.size; // Already counted from pre-check
  let errors = [];
  let completed = preCheckedPackages.size; // Start from pre-skipped count
  const totalPackages = tarballs.length;

  const processPackage = async (tarball, index) => {
    const filename = path.basename(tarball);

    try {
      // Use cached package info if available, otherwise extract
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
        // Skip this package - it already exists (already counted in initial completed/skipped)
        return { status: 'pre-skipped', package: packageId, reason: 'Pre-checked' };
      }

      // This package needs to be published
      const result = await publishPackage(tarball, registryUrl, false, null);
      completed++;

      process.stdout.write(`\r[${completed}/${totalPackages}] `);

      if (result.status === STATUS.SUCCESS) {
        successful++;
        console.log(`✅ ${filename}`);
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
    const batchPromises = batch.map((tarball, batchIndex) => 
      processPackage(tarball, i + batchIndex)
    );
    
    await Promise.all(batchPromises);
  }
  
  // Summary
  console.log();
  log.success(`✅ Published: ${successful}`);
  log.info(`⏭️  Skipped: ${skipped}`);
  if (errors.length > 0) {
    log.error(`❌ Failed: ${errors.length}`);
  }
  
  if (errors.length > 0) {
    log.info('\nFailed packages:');
    errors.forEach(err => {
      log.error(`  - ${err.package}: ${err.error}`);
    });
  }
  
  return {
    total: tarballs.length,
    successful,
    skipped,
    failed: errors.length,
    errors,
    actuallyProcessed: tarballs.length - preCheckedPackages.size
  };
}

// CLI usage when run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Bootstrap Publisher - Dependency-free package publisher

Usage:
  node bootstrap-publisher.js <packages-dir> [registry-url]

Examples:
  node bootstrap-publisher.js ./airgap-packages
  node bootstrap-publisher.js ./airgap-packages http://localhost:4873

Note: Make sure you are logged in to the registry first:
  npm login --registry http://localhost:4873
`);
    process.exit(1);
  }
  
  const packagesDir = args[0];
  const registryUrl = args[1] || 'http://localhost:4873';
  
  bootstrapPublish(packagesDir, registryUrl)
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