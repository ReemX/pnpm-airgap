const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');

const execAsync = promisify(exec);

/**
 * Extract package.json from tarball to get package info
 */
async function getPackageInfo(tarballPath) {
  try {
    const tar = require('tar');
    let packageJson = null;

    await tar.t({
      file: tarballPath,
      onentry: (entry) => {
        if (entry.path === 'package/package.json') {
          const chunks = [];
          entry.on('data', chunk => chunks.push(chunk));
          entry.on('end', () => {
            packageJson = JSON.parse(Buffer.concat(chunks).toString());
          });
        }
      }
    });

    return packageJson;
  } catch (error) {
    // Fallback: try to extract from filename
    const basename = path.basename(tarballPath, '.tgz');
    const match = basename.match(/^(.+)-(\d+\.\d+\.\d+.*)$/);
    if (match) {
      return {
        name: match[1].replace('-', '/'),
        version: match[2]
      };
    }
    throw error;
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
 * Publish a single package to the registry
 */
async function publishPackage(tarballPath, registryUrl, skipExisting = true) {
  try {
    // Get package info
    const packageInfo = await getPackageInfo(tarballPath);
    const { name, version } = packageInfo;

    // Check if already exists
    if (skipExisting) {
      const exists = await packageExists(name, version, registryUrl);
      if (exists) {
        return {
          status: 'skipped',
          package: `${name}@${version}`,
          reason: 'Already exists in registry'
        };
      }
    }

    // Publish the package
    const { stdout, stderr } = await execAsync(
      `npm publish ${tarballPath} --registry ${registryUrl}`,
      { timeout: 30000 }
    );

    return {
      status: 'success',
      package: `${name}@${version}`
    };
  } catch (error) {
    // Extract package name from error or tarball path
    let packageName = path.basename(tarballPath, '.tgz');
    try {
      const info = await getPackageInfo(tarballPath);
      packageName = `${info.name}@${info.version}`;
    } catch {}

    // Check if it's a conflict error (package already exists)
    if (error.message.includes('409') || error.message.includes('conflict')) {
      return {
        status: 'skipped',
        package: packageName,
        reason: 'Already exists (409 Conflict)'
      };
    }

    return {
      status: 'error',
      package: packageName,
      error: error.message
    };
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
