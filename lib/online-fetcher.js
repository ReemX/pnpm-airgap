const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const tar = require('tar');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');

/**
 * Parse pnpm lockfile and extract package information
 */
async function parseLockfile(lockfilePath) {
  const content = await fs.readFile(lockfilePath, 'utf8');
  const lockfile = yaml.load(content);

  const packages = new Map();

  // Handle different lockfile versions
  const lockfileVersion = lockfile.lockfileVersion || '6.0';
  const isV9 = lockfileVersion.startsWith('9');

  // Process packages section
  if (lockfile.packages) {
    for (const [key, value] of Object.entries(lockfile.packages)) {
      // Extract package name and version from the key
      let packageInfo = parsePackageKey(key);

      if (packageInfo) {
        const { name, version } = packageInfo;
        const packageId = `${name}@${version}`;

        // Get tarball URL - check multiple possible locations
        let tarballUrl = null;

        // Check if tarball is directly in the resolution
        if (value.resolution?.tarball) {
          tarballUrl = value.resolution.tarball;
        } else if (value.resolution?.integrity) {
          // Construct tarball URL from package name and version
          tarballUrl = constructTarballUrl(name, version);
        }

        if (tarballUrl) {
          packages.set(packageId, {
            name,
            version,
            tarballUrl,
            integrity: value.resolution?.integrity || value.integrity
          });
        }
      }
    }
  }

  // In v9, also check snapshots section if present
  if (isV9 && lockfile.snapshots) {
    for (const [key, value] of Object.entries(lockfile.snapshots)) {
      const packageInfo = parsePackageKey(key);
      if (packageInfo && !packages.has(`${packageInfo.name}@${packageInfo.version}`)) {
        const { name, version } = packageInfo;
        const tarballUrl = constructTarballUrl(name, version);
        packages.set(`${name}@${version}`, {
          name,
          version,
          tarballUrl,
          integrity: value.resolution?.integrity
        });
      }
    }
  }

  return packages;
}

/**
 * Parse package key from lockfile to extract name and version
 */
function parsePackageKey(key) {
  // Remove leading slash if present
  key = key.replace(/^\//, '');

  // Handle scoped packages
  const scopedMatch = key.match(/^(@[^/]+\/[^@/]+)[@/]([^(/]+)/);
  if (scopedMatch) {
    return { name: scopedMatch[1], version: scopedMatch[2] };
  }

  // Handle regular packages
  const regularMatch = key.match(/^([^@/]+)[@/]([^(/]+)/);
  if (regularMatch) {
    return { name: regularMatch[1], version: regularMatch[2] };
  }

  return null;
}

/**
 * Construct tarball URL for npm registry
 */
function constructTarballUrl(name, version, registry = 'https://registry.npmjs.org') {
  // Handle scoped packages
  if (name.startsWith('@')) {
    const encoded = name.replace('/', '%2f');
    return `${registry}/${encoded}/-/${name.split('/')[1]}-${version}.tgz`;
  }

  return `${registry}/${name}/-/${name}-${version}.tgz`;
}

/**
 * Download a package tarball
 */
async function downloadPackage(packageInfo, outputDir) {
  const { name, version, tarballUrl } = packageInfo;
  const fileName = `${name.replace('/', '-')}-${version}.tgz`;
  const filePath = path.join(outputDir, fileName);

  // Skip if already downloaded
  if (await fs.pathExists(filePath)) {
    return { status: 'skipped', package: `${name}@${version}` };
  }

  try {
    const response = await axios({
      method: 'GET',
      url: tarballUrl,
      responseType: 'stream',
      timeout: 30000
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        resolve({ status: 'success', package: `${name}@${version}` });
      });
      writer.on('error', (error) => {
        fs.unlink(filePath).catch(() => {});
        reject(error);
      });
    });
  } catch (error) {
    return {
      status: 'error',
      package: `${name}@${version}`,
      error: error.message
    };
  }
}

/**
 * Main function to fetch all dependencies
 */
async function fetchDependencies(config) {
  const { lockfilePath, outputDir, concurrency = 5 } = config;

  // Ensure output directory exists
  await fs.ensureDir(outputDir);

  // Parse lockfile
  const spinner = ora('Parsing lockfile...').start();
  const packages = await parseLockfile(lockfilePath);
  spinner.succeed(`Found ${packages.size} packages`);

  if (packages.size === 0) {
    console.log(chalk.yellow('No packages found in lockfile'));
    return;
  }

  // Create metadata file
  const metadata = {
    timestamp: new Date().toISOString(),
    packageCount: packages.size,
    packages: Array.from(packages.values()).map(p => ({
      name: p.name,
      version: p.version
    }))
  };
  await fs.writeJson(path.join(outputDir, 'metadata.json'), metadata, { spaces: 2 });

  // Download packages with concurrency limit
  const limit = pLimit(concurrency);
  const downloadSpinner = ora('Downloading packages...').start();

  let completed = 0;
  let errors = [];

  const downloadPromises = Array.from(packages.values()).map(packageInfo =>
    limit(async () => {
      const result = await downloadPackage(packageInfo, outputDir);
      completed++;
      downloadSpinner.text = `Downloading packages... (${completed}/${packages.size})`;

      if (result.status === 'error') {
        errors.push(result);
      }

      return result;
    })
  );

  await Promise.all(downloadPromises);
  downloadSpinner.succeed(`Downloaded ${completed} packages`);

  // Report errors if any
  if (errors.length > 0) {
    console.log(chalk.yellow(`\n⚠️  ${errors.length} packages failed to download:`));
    errors.forEach(err => {
      console.log(chalk.red(`  - ${err.package}: ${err.error}`));
    });
  }

  // Create transfer bundle info
  const bundleInfo = {
    created: new Date().toISOString(),
    totalPackages: packages.size,
    successfulDownloads: completed - errors.length,
    failedDownloads: errors.length,
    errors: errors
  };

  await fs.writeJson(path.join(outputDir, 'bundle-info.json'), bundleInfo, { spaces: 2 });
}

module.exports = {
  fetchDependencies,
  parseLockfile
};
