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

const execAsync = promisify(exec);

/**
 * Simple package info extraction using only built-ins
 */
async function getPackageInfoSimple(tarballPath) {
  try {
    // Extract package.json directly with single command (faster)
    const { stdout: packageContent } = await execAsync(
      `tar -xzf "${tarballPath}" --wildcards -O "*/package.json" | head -c 10000`,
      { timeout: Math.floor(2000) }
    );
    
    if (packageContent.trim()) {
      const packageJson = JSON.parse(packageContent);
      if (packageJson.name && packageJson.version) {
        return packageJson;
      }
    }
    
    throw new Error('Could not extract package.json');
  } catch (error) {
    // Fallback: parse filename
    const basename = path.basename(tarballPath, '.tgz');
    
    // Handle scoped packages
    if (basename.startsWith('@')) {
      const withoutAt = basename.substring(1);
      const parts = withoutAt.split('-');
      if (parts.length >= 3) {
        // Find version start
        let versionStart = -1;
        for (let i = 1; i < parts.length; i++) {
          if (/^\d+\.\d+\.\d+/.test(parts[i])) {
            versionStart = i;
            break;
          }
        }
        
        if (versionStart > 0) {
          const scope = parts[0];
          const packageName = parts.slice(1, versionStart).join('-');
          const version = parts.slice(versionStart).join('-');
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
    
    throw new Error(`Could not parse package info from ${basename}`);
  }
}

/**
 * Check if package exists in registry
 */
async function packageExists(name, version, registryUrl) {
  try {
    const { stdout } = await execAsync(
      `npm view "${name}@${version}" version --registry "${registryUrl}"`,
      { timeout: Math.floor(3000) }
    );
    return stdout.trim() === version;
  } catch (error) {
    return false;
  }
}

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
async function publishPackage(tarballPath, registryUrl, skipExisting = true) {
  let packageInfo = null;
  let packageId = path.basename(tarballPath, '.tgz');
  
  try {
    packageInfo = await getPackageInfoSimple(tarballPath);
    packageId = `${packageInfo.name}@${packageInfo.version}`;
  } catch (error) {
    log.warn(`Could not extract package info for ${packageId}, continuing with filename`);
  }
  
  // Check if exists
  if (skipExisting && packageInfo) {
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
  
  // Publish
  try {
    const { stdout, stderr } = await execAsync(
      `npm publish "${tarballPath}" --registry "${registryUrl}" --provenance false`,
      { timeout: Math.floor(120000) } // 2 minutes timeout
    );
    
    return {
      status: 'success',
      package: packageId
    };
    
  } catch (error) {
    // Check if it's a conflict (already exists)
    if (error.message.includes('409') || 
        error.message.includes('conflict') ||
        error.message.includes('cannot publish over')) {
      return {
        status: 'skipped',
        package: packageId,
        reason: 'Already exists (conflict)'
      };
    }
    
    return {
      status: 'error',
      package: packageId,
      error: error.message.split('\n')[0] // First line only
    };
  }
}

/**
 * Verify authentication
 */
async function verifyAuth(registryUrl) {
  try {
    const { stdout } = await execAsync(
      `npm whoami --registry "${registryUrl}"`,
      { timeout: Math.floor(2000) }
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
 * Main bootstrap publisher function
 */
async function bootstrapPublish(packagesDir, registryUrl = 'http://localhost:4873') {
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
  
  // Process packages concurrently with limited concurrency
  const CONCURRENT_LIMIT = 5; // Limit to avoid overwhelming registry
  let successful = 0;
  let skipped = 0;
  let errors = [];
  let completed = 0;

  const processPackage = async (tarball, index) => {
    const filename = path.basename(tarball);
    
    try {
      const result = await publishPackage(tarball, registryUrl, true);
      completed++;
      
      process.stdout.write(`\r[${completed}/${tarballs.length}] `);
      
      if (result.status === 'success') {
        successful++;
        console.log(`✅ ${filename}`);
      } else if (result.status === 'skipped') {
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
        status: 'error',
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
  for (let i = 0; i < tarballs.length; i += CONCURRENT_LIMIT) {
    const batch = tarballs.slice(i, i + CONCURRENT_LIMIT);
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
    errors
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