/**
 * Registry Sync - Mirror packages from one registry to another
 *
 * Supports syncing all packages from a source npm registry (Verdaccio, Nexus, etc.)
 * to a destination registry.
 *
 * WARNING: This tool has safeguards against syncing from the public npm registry
 * which contains millions of packages and would be terabytes of data.
 */

const fs = require('fs-extra');
const path = require('path');
const pLimit = require('p-limit');
const ora = require('ora');
const chalk = require('chalk');
const axios = require('axios');
const readline = require('readline');
const {
  TIMEOUTS,
  CONCURRENCY,
  STATUS,
  EXISTENCE,
  DEFAULTS
} = require('./constants');
const {
  packageExists,
  verifyAuth,
  validateRegistryUrl,
  getAuthToken,
  httpRequest,
  setDebugMode,
  debug,
  getFileSizeString
} = require('./shared-utils');
const { publishPackage, getPackageInfo } = require('./offline-publisher');

// Public registries that should be blocked from full sync
const BLOCKED_REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'npm.pkg.github.com'
];

/**
 * Check if a registry URL is a public npm registry that shouldn't be fully synced
 * @param {string} registryUrl - Registry URL to check
 * @returns {boolean} True if it's a blocked public registry
 */
function isPublicRegistry(registryUrl) {
  try {
    const url = new URL(registryUrl);
    return BLOCKED_REGISTRIES.some(blocked =>
      url.hostname === blocked || url.hostname.endsWith('.' + blocked)
    );
  } catch {
    return false;
  }
}

/**
 * Prompt user for confirmation
 * @param {string} message - Message to display
 * @returns {Promise<boolean>} True if user confirmed
 */
async function confirmPrompt(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(message + ' (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Fetch all packages list from a registry
 * Supports different registry implementations (npm, Verdaccio, Nexus, etc.)
 *
 * @param {string} registryUrl - Source registry URL
 * @param {object} options - Options
 * @returns {Promise<Map<string, object>>} Map of package name -> metadata
 */
async function listAllPackages(registryUrl, options = {}) {
  const { scope = null, authToken = null } = options;

  const headers = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const packages = new Map();

  // Try different endpoints that registries might support
  const endpoints = [
    '/-/all',           // npm/Verdaccio style
    '/-/v1/search?text=*&size=5000',  // npm search API
    '/_all_docs',       // CouchDB style (some registries)
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${registryUrl.replace(/\/$/, '')}${endpoint}`;
      debug(`Trying endpoint: ${url}`);

      const response = await axios.get(url, {
        headers,
        timeout: TIMEOUTS.MAX, // Allow long timeout for full package list
        maxContentLength: 500 * 1024 * 1024, // 500MB max
        validateStatus: (status) => status === 200
      });

      const data = response.data;

      // Handle /-/all response (object with package names as keys)
      if (typeof data === 'object' && !Array.isArray(data)) {
        // Check if it's the _updated format (Verdaccio/npm)
        if (data._updated) {
          delete data._updated;
        }

        for (const [name, meta] of Object.entries(data)) {
          // Skip if filtering by scope
          if (scope && !name.startsWith(`${scope}/`)) {
            continue;
          }

          packages.set(name, {
            name,
            versions: meta.versions || meta['dist-tags'] || {},
            distTags: meta['dist-tags'] || {},
            time: meta.time || {}
          });
        }

        debug(`Found ${packages.size} packages from /-/all endpoint`);
        return packages;
      }

      // Handle search API response
      if (data.objects && Array.isArray(data.objects)) {
        for (const obj of data.objects) {
          const name = obj.package?.name;
          if (!name) continue;

          if (scope && !name.startsWith(`${scope}/`)) {
            continue;
          }

          packages.set(name, {
            name,
            versions: {},
            distTags: {},
            searchResult: true
          });
        }

        debug(`Found ${packages.size} packages from search API`);
        return packages;
      }

    } catch (error) {
      debug(`Endpoint ${endpoint} failed: ${error.message}`);
      continue;
    }
  }

  // If standard endpoints fail, try to manually discover packages
  // by listing known scopes or using a custom package list
  if (packages.size === 0) {
    throw new Error(
      `Could not list packages from registry ${registryUrl}\n` +
      `The registry may not support package listing, or authentication may be required.\n` +
      `You can try:\n` +
      `  1. Providing an auth token with --auth-token\n` +
      `  2. Using a package list file with --package-list\n` +
      `  3. Specifying scopes to sync with --scope`
    );
  }

  return packages;
}

/**
 * Get detailed package information including all versions
 *
 * @param {string} packageName - Package name
 * @param {string} registryUrl - Registry URL
 * @param {object} options - Options
 * @returns {Promise<object>} Full package metadata
 */
async function getPackageMetadata(packageName, registryUrl, options = {}) {
  const { authToken = null } = options;

  const encodedName = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);

  const url = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  const headers = {
    'Accept': 'application/json'
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const response = await axios.get(url, {
      headers,
      timeout: TIMEOUTS.HTTP_REQUEST * 2,
      validateStatus: (status) => status === 200
    });

    return response.data;
  } catch (error) {
    debug(`Failed to get metadata for ${packageName}: ${error.message}`);
    return null;
  }
}

/**
 * Download a specific package version tarball
 *
 * @param {string} tarballUrl - Tarball URL
 * @param {string} outputPath - Output file path
 * @param {object} options - Options
 * @returns {Promise<object>} Download result
 */
async function downloadTarball(tarballUrl, outputPath, options = {}) {
  const { authToken = null } = options;

  // Skip if already exists
  if (await fs.pathExists(outputPath)) {
    return { status: STATUS.SKIPPED, reason: 'Already downloaded' };
  }

  try {
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await axios({
      method: 'GET',
      url: tarballUrl,
      headers,
      responseType: 'stream',
      timeout: TIMEOUTS.DOWNLOAD * 2,
      validateStatus: (status) => status === 200
    });

    await fs.ensureDir(path.dirname(outputPath));
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        resolve({ status: STATUS.SUCCESS, size: writer.bytesWritten });
      });
      writer.on('error', async (error) => {
        await fs.unlink(outputPath).catch(() => {});
        reject(error);
      });
    });
  } catch (error) {
    await fs.unlink(outputPath).catch(() => {});
    return {
      status: STATUS.ERROR,
      error: error.response ? `HTTP ${error.response.status}` : error.message
    };
  }
}

/**
 * Sync packages from source registry to destination
 *
 * @param {object} config - Sync configuration
 */
async function syncRegistries(config) {
  const {
    sourceRegistry,
    destRegistry,
    outputDir = './sync-packages',
    scope = null,
    packageList = null,
    concurrency = CONCURRENCY.FETCH,
    skipExisting = true,
    downloadOnly = false,
    publishOnly = false,
    maxVersions = null,  // null = all versions, number = latest N versions
    sinceDate = null,    // Only sync versions published after this date
    dryRun = false,
    debug: debugEnabled = false
  } = config;

  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  validateRegistryUrl(sourceRegistry);
  if (!downloadOnly) {
    validateRegistryUrl(destRegistry);
  }

  // SAFETY CHECK: Block syncing from public npm registries without filters
  if (isPublicRegistry(sourceRegistry) && !scope && !packageList) {
    console.log(chalk.red('\n🚫 BLOCKED: Syncing from public npm registry without filters'));
    console.log(chalk.red(''));
    console.log(chalk.yellow('The public npm registry contains:'));
    console.log(chalk.yellow('  - Over 2 million packages'));
    console.log(chalk.yellow('  - Hundreds of terabytes of data'));
    console.log(chalk.yellow(''));
    console.log(chalk.white('To sync specific packages, use one of these options:'));
    console.log(chalk.gray('  --scope @mycompany        Only sync packages in a scope'));
    console.log(chalk.gray('  --package-list file.txt   Sync packages listed in a file'));
    console.log(chalk.gray('  --package-list pkg1,pkg2  Sync specific packages'));
    console.log(chalk.yellow(''));
    console.log(chalk.white('For your airgapped network registries, use their URLs directly.'));
    console.log(chalk.gray('Example: pnpm-airgap sync -s http://internal-registry:4873 -d http://my-verdaccio:4873'));

    throw new Error('Full sync from public npm registry is blocked for safety');
  }

  // Warning for large operations
  if (!scope && !packageList && !publishOnly) {
    console.log(chalk.yellow('\n⚠️  WARNING: You are about to sync ALL packages from the source registry.'));
    console.log(chalk.yellow('   This could be a large amount of data depending on the registry size.'));
    console.log(chalk.gray('   Use --scope or --package-list to filter packages if needed.\n'));
  }

  console.log(chalk.blue('\n📦 Registry Sync'));
  console.log(chalk.gray(`Source: ${sourceRegistry}`));
  if (!downloadOnly) {
    console.log(chalk.gray(`Destination: ${destRegistry}`));
  }
  console.log(chalk.gray(`Output: ${outputDir}`));
  if (scope) {
    console.log(chalk.gray(`Scope: ${scope}`));
  }
  if (maxVersions) {
    console.log(chalk.gray(`Max versions per package: ${maxVersions}`));
  }
  if (sinceDate) {
    console.log(chalk.gray(`Since: ${sinceDate}`));
  }
  if (dryRun) {
    console.log(chalk.yellow('\n🔍 DRY RUN MODE\n'));
  }
  console.log();

  await fs.ensureDir(outputDir);

  // Get source auth token
  const sourceAuthToken = await getAuthToken(sourceRegistry);
  if (sourceAuthToken) {
    debug('Found auth token for source registry');
  }

  // Step 1: Get list of packages
  let packagesToSync = new Map();

  if (publishOnly) {
    // Scan output directory for existing tarballs
    const spinner = ora('Scanning for existing tarballs...').start();
    const files = await fs.readdir(outputDir);
    const tarballs = files.filter(f => f.endsWith('.tgz'));

    // Group by package name
    for (const tarball of tarballs) {
      try {
        const tarballPath = path.join(outputDir, tarball);
        const info = await getPackageInfo(tarballPath);
        if (!packagesToSync.has(info.name)) {
          packagesToSync.set(info.name, { name: info.name, tarballs: [] });
        }
        packagesToSync.get(info.name).tarballs.push({
          version: info.version,
          path: tarballPath
        });
      } catch (e) {
        debug(`Could not read ${tarball}: ${e.message}`);
      }
    }

    spinner.succeed(`Found ${tarballs.length} tarballs for ${packagesToSync.size} packages`);
  } else if (packageList) {
    // Use provided package list
    const spinner = ora('Reading package list...').start();
    let packageNames = [];

    if (await fs.pathExists(packageList)) {
      const content = await fs.readFile(packageList, 'utf8');
      packageNames = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    } else {
      // Treat as comma-separated list
      packageNames = packageList.split(',').map(p => p.trim());
    }

    for (const name of packageNames) {
      packagesToSync.set(name, { name });
    }

    spinner.succeed(`Loaded ${packagesToSync.size} packages from list`);
  } else {
    // List all packages from source registry
    const spinner = ora('Fetching package list from source registry...').start();

    try {
      packagesToSync = await listAllPackages(sourceRegistry, {
        scope,
        authToken: sourceAuthToken
      });
      spinner.succeed(`Found ${packagesToSync.size} packages in source registry`);
    } catch (error) {
      spinner.fail('Failed to list packages');
      throw error;
    }
  }

  if (packagesToSync.size === 0) {
    console.log(chalk.yellow('No packages to sync'));
    return { success: true, total: 0, downloaded: 0, published: 0, skipped: 0, failed: 0 };
  }

  // Step 2: Get detailed metadata and download tarballs
  const downloadResults = { downloaded: 0, skipped: 0, failed: 0, errors: [] };
  const tarballs = [];

  if (!publishOnly) {
    const metaSpinner = ora('Fetching package metadata and downloading...').start();
    const limit = pLimit(concurrency);
    let processed = 0;
    const total = packagesToSync.size;

    const metaPromises = Array.from(packagesToSync.entries()).map(([name, pkg]) =>
      limit(async () => {
        try {
          // Get full metadata
          const metadata = await getPackageMetadata(name, sourceRegistry, {
            authToken: sourceAuthToken
          });

          if (!metadata || !metadata.versions) {
            debug(`No metadata for ${name}`);
            processed++;
            return;
          }

          // Get versions to sync
          let versions = Object.keys(metadata.versions);

          // Filter by date if specified
          if (sinceDate && metadata.time) {
            const sinceTime = new Date(sinceDate).getTime();
            versions = versions.filter(v => {
              const versionTime = metadata.time[v];
              return versionTime && new Date(versionTime).getTime() >= sinceTime;
            });
          }

          // Limit number of versions
          if (maxVersions && versions.length > maxVersions) {
            // Sort by publish time (newest first) and take top N
            if (metadata.time) {
              versions.sort((a, b) => {
                const timeA = new Date(metadata.time[a] || 0).getTime();
                const timeB = new Date(metadata.time[b] || 0).getTime();
                return timeB - timeA;
              });
            }
            versions = versions.slice(0, maxVersions);
          }

          // Download each version
          for (const version of versions) {
            const versionData = metadata.versions[version];
            if (!versionData || !versionData.dist || !versionData.dist.tarball) {
              continue;
            }

            const tarballUrl = versionData.dist.tarball;
            const safeName = name.replace('/', '-').replace('@', '');
            const filename = `${safeName}-${version}.tgz`;
            const outputPath = path.join(outputDir, filename);

            if (dryRun) {
              tarballs.push({ path: outputPath, name, version, dryRun: true });
              downloadResults.downloaded++;
              continue;
            }

            const result = await downloadTarball(tarballUrl, outputPath, {
              authToken: sourceAuthToken
            });

            if (result.status === STATUS.SUCCESS) {
              downloadResults.downloaded++;
              tarballs.push({ path: outputPath, name, version });
            } else if (result.status === STATUS.SKIPPED) {
              downloadResults.skipped++;
              tarballs.push({ path: outputPath, name, version });
            } else {
              downloadResults.failed++;
              downloadResults.errors.push({ package: `${name}@${version}`, error: result.error });
            }
          }

          processed++;
          metaSpinner.text = `Processing packages... (${processed}/${total}) - Downloaded: ${downloadResults.downloaded}`;

        } catch (error) {
          debug(`Error processing ${name}: ${error.message}`);
          processed++;
        }
      })
    );

    await Promise.all(metaPromises);
    metaSpinner.succeed(
      `Download complete: ✅ ${downloadResults.downloaded} downloaded, ⏭️  ${downloadResults.skipped} skipped, ❌ ${downloadResults.failed} failed`
    );
  } else {
    // Use tarballs from the packagesToSync map (publish-only mode)
    for (const [name, pkg] of packagesToSync) {
      if (pkg.tarballs) {
        for (const t of pkg.tarballs) {
          tarballs.push({ path: t.path, name, version: t.version });
        }
      }
    }
  }

  // Save download manifest
  const manifest = {
    timestamp: new Date().toISOString(),
    source: sourceRegistry,
    destination: destRegistry,
    scope,
    totalPackages: packagesToSync.size,
    totalVersions: tarballs.length,
    downloaded: downloadResults.downloaded,
    skipped: downloadResults.skipped,
    failed: downloadResults.failed,
    tarballs: tarballs.map(t => ({
      name: t.name,
      version: t.version,
      file: path.basename(t.path)
    }))
  };
  await fs.writeJson(path.join(outputDir, 'sync-manifest.json'), manifest, { spaces: 2 });

  // Step 3: Publish to destination
  const publishResults = { published: 0, skipped: 0, failed: 0, errors: [] };

  if (!downloadOnly && tarballs.length > 0 && !dryRun) {
    // Verify auth to destination
    const authSpinner = ora('Verifying authentication to destination...').start();
    try {
      const username = await verifyAuth(destRegistry);
      authSpinner.succeed(`Authenticated as: ${username}`);
    } catch (error) {
      authSpinner.fail('Authentication failed');
      throw error;
    }

    const publishSpinner = ora('Publishing packages to destination...').start();
    const publishLimit = pLimit(Math.min(concurrency, CONCURRENCY.PUBLISH));
    let published = 0;

    // Pre-check which packages already exist in destination
    const existsInDest = new Set();
    if (skipExisting) {
      const checkLimit = pLimit(CONCURRENCY.PRE_CHECK);
      const checkPromises = tarballs.map(t =>
        checkLimit(async () => {
          const result = await packageExists(t.name, t.version, destRegistry);
          if (result.status === EXISTENCE.EXISTS && result.certain) {
            existsInDest.add(`${t.name}@${t.version}`);
          }
        })
      );
      await Promise.all(checkPromises);
      publishResults.skipped = existsInDest.size;
      debug(`${existsInDest.size} packages already exist in destination`);
    }

    const publishPromises = tarballs.map(t =>
      publishLimit(async () => {
        const packageId = `${t.name}@${t.version}`;

        if (skipExisting && existsInDest.has(packageId)) {
          return;
        }

        try {
          const result = await publishPackage(t.path, destRegistry, {
            maxRetries: 2
          });

          if (result.status === STATUS.SUCCESS) {
            publishResults.published++;
          } else if (result.status === STATUS.SKIPPED) {
            publishResults.skipped++;
          } else {
            publishResults.failed++;
            publishResults.errors.push({ package: packageId, error: result.error });
          }
        } catch (error) {
          publishResults.failed++;
          publishResults.errors.push({ package: packageId, error: error.message });
        }

        published++;
        publishSpinner.text = `Publishing... ✅ ${publishResults.published} | ⏭️  ${publishResults.skipped} | ❌ ${publishResults.failed} (${published}/${tarballs.length})`;
      })
    );

    await Promise.all(publishPromises);
    publishSpinner.succeed(
      `Publish complete: ✅ ${publishResults.published} published, ⏭️  ${publishResults.skipped} skipped, ❌ ${publishResults.failed} failed`
    );
  } else if (dryRun) {
    console.log(chalk.yellow(`\nDry run: Would publish ${tarballs.length} package versions to ${destRegistry}`));
    publishResults.published = tarballs.length;
  }

  // Final summary
  console.log(chalk.blue('\n📊 Sync Summary'));
  console.log(chalk.white(`Packages: ${packagesToSync.size}`));
  console.log(chalk.white(`Versions: ${tarballs.length}`));
  if (!publishOnly) {
    console.log(chalk.green(`Downloaded: ${downloadResults.downloaded}`));
    if (downloadResults.skipped > 0) {
      console.log(chalk.gray(`Download skipped: ${downloadResults.skipped}`));
    }
    if (downloadResults.failed > 0) {
      console.log(chalk.red(`Download failed: ${downloadResults.failed}`));
    }
  }
  if (!downloadOnly) {
    console.log(chalk.green(`Published: ${publishResults.published}`));
    if (publishResults.skipped > 0) {
      console.log(chalk.gray(`Publish skipped: ${publishResults.skipped}`));
    }
    if (publishResults.failed > 0) {
      console.log(chalk.red(`Publish failed: ${publishResults.failed}`));
    }
  }

  // Report errors
  const allErrors = [...downloadResults.errors, ...publishResults.errors];
  if (allErrors.length > 0) {
    console.log(chalk.red(`\n❌ Errors (${allErrors.length}):`));
    allErrors.slice(0, 10).forEach(e => {
      console.log(chalk.red(`  - ${e.package}: ${e.error}`));
    });
    if (allErrors.length > 10) {
      console.log(chalk.gray(`  ... and ${allErrors.length - 10} more`));
    }
  }

  // Save sync report
  const report = {
    timestamp: new Date().toISOString(),
    source: sourceRegistry,
    destination: destRegistry,
    dryRun,
    scope,
    packages: packagesToSync.size,
    versions: tarballs.length,
    download: downloadResults,
    publish: publishResults,
    errors: allErrors
  };
  await fs.writeJson(
    path.join(outputDir, dryRun ? 'sync-dry-run-report.json' : 'sync-report.json'),
    report,
    { spaces: 2 }
  );

  console.log(chalk.gray(`\n📄 Report saved to: ${path.join(outputDir, 'sync-report.json')}`));

  return {
    success: downloadResults.failed === 0 && publishResults.failed === 0,
    packages: packagesToSync.size,
    versions: tarballs.length,
    downloaded: downloadResults.downloaded,
    published: publishResults.published,
    skipped: downloadResults.skipped + publishResults.skipped,
    failed: downloadResults.failed + publishResults.failed
  };
}

module.exports = {
  syncRegistries,
  listAllPackages,
  getPackageMetadata,
  downloadTarball
};
