/**
 * Fetch command - download packages from lockfile
 */

import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import chalk from 'chalk';
import type { FetchConfig, LockfilePackage, OperationResult } from '../types.js';
import { Status } from '../types.js';
import { DEFAULT_CONFIG } from '../constants.js';
import { parseLockfile } from '../core/lockfile.js';
import { downloadPackage } from '../core/tarball.js';
import { setDebugMode } from '../utils/logger.js';
import { validateFile, validateRegistryUrl } from '../utils/validation.js';
import { generateFilename } from '../utils/files.js';
import { ProgressTracker, createSpinner, printHeader, printInfo, printSummary, printErrors } from '../ui/progress.js';

export interface FetchResult {
  success: boolean;
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  errors: OperationResult[];
}

/**
 * Fetch all dependencies from lockfile
 */
export async function fetchDependencies(config: Partial<FetchConfig> = {}): Promise<FetchResult> {
  const finalConfig: FetchConfig = {
    ...DEFAULT_CONFIG.fetch,
    ...config,
  };

  const {
    lockfilePath,
    outputDir,
    concurrency,
    registryUrl,
    registryStatePath,
    skipOptional,
    debug: debugEnabled,
  } = finalConfig;

  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  await validateFile(lockfilePath, 'Lockfile');
  validateRegistryUrl(registryUrl);
  await fs.ensureDir(outputDir);

  printHeader('Fetch Dependencies');
  printInfo('Lockfile', lockfilePath);
  printInfo('Output', outputDir);
  printInfo('Registry', registryUrl);
  if (skipOptional) {
    printInfo('Options', 'Skipping optional dependencies');
  }

  // Parse lockfile
  const parseSpinner = createSpinner('Parsing lockfile...');
  const { packages } = await parseLockfile(lockfilePath, { registryUrl, skipOptional });
  parseSpinner.succeed(`Found ${chalk.bold(packages.size)} packages in lockfile`);

  // Filter against registry state if provided
  let packagesToFetch = packages;
  let preExistingInRegistry = 0;

  if (registryStatePath) {
    const stateSpinner = createSpinner('Loading registry state...');
    try {
      const { loadRegistryState, buildVersionLookup, filterMissingPackages } = await import('./registry-state.js');
      const registryState = await loadRegistryState(registryStatePath);
      const versionLookup = buildVersionLookup(registryState);
      const { missing, stats } = filterMissingPackages(packages, versionLookup);

      packagesToFetch = missing;
      preExistingInRegistry = stats.existing;
      stateSpinner.succeed(`Registry state: ${stats.existing} exist, ${stats.missing} to fetch`);
    } catch (error) {
      stateSpinner.fail(`Failed to load registry state: ${(error as Error).message}`);
      throw error;
    }
  }

  if (packagesToFetch.size === 0) {
    console.log(chalk.green('\n✓ All packages already exist!'));
    return {
      success: true,
      total: packages.size,
      downloaded: 0,
      skipped: preExistingInRegistry,
      failed: 0,
      errors: [],
    };
  }

  // Pre-check existing files in output directory
  const checkSpinner = createSpinner('Checking existing files...');
  let preExistingFiles = 0;
  const packagesArray = Array.from(packagesToFetch.values());

  for (const pkg of packagesArray) {
    const filename = generateFilename(pkg.name, pkg.version);
    const filePath = path.join(outputDir, filename);
    if (await fs.pathExists(filePath)) {
      preExistingFiles++;
    }
  }

  if (preExistingFiles > 0) {
    checkSpinner.succeed(`Found ${preExistingFiles} packages already downloaded`);
  } else {
    checkSpinner.succeed('No existing packages found');
  }

  // Create metadata file
  const metadata = {
    timestamp: new Date().toISOString(),
    lockfilePath: path.resolve(lockfilePath),
    registryUrl,
    packageCount: packagesToFetch.size,
    packages: Array.from(packagesToFetch.values()).map((p: LockfilePackage) => ({
      name: p.name,
      version: p.version,
      dev: p.dev,
      optional: p.optional,
    })),
  };
  await fs.writeJson(path.join(outputDir, 'metadata.json'), metadata, { spaces: 2 });

  // Download packages
  const limit = pLimit(concurrency);
  const progress = new ProgressTracker('Downloading', packagesArray.length, preExistingFiles);
  const errors: OperationResult[] = [];
  let downloaded = 0;
  let skipped = preExistingFiles;

  const downloadPromises = packagesArray.map((pkg: LockfilePackage) =>
    limit(async () => {
      const result = await downloadPackage(pkg.name, pkg.version, pkg.tarballUrl, outputDir);

      if (result.status === Status.SUCCESS) {
        downloaded++;
        progress.success();
      } else if (result.status === Status.SKIPPED) {
        // Don't double-count pre-existing files
        if (result.reason !== 'Already downloaded') {
          skipped++;
          progress.skip();
        }
      } else {
        errors.push(result);
        progress.fail();
      }

      return result;
    })
  );

  await Promise.all(downloadPromises);
  progress.complete();

  // Save bundle info
  const bundleInfo = {
    created: new Date().toISOString(),
    lockfilePath: path.resolve(lockfilePath),
    registryUrl,
    totalPackages: packagesToFetch.size,
    successfulDownloads: downloaded,
    skippedDownloads: skipped,
    failedDownloads: errors.length,
    errors: errors.map((e) => ({
      package: e.package,
      error: e.error,
    })),
  };
  await fs.writeJson(path.join(outputDir, 'bundle-info.json'), bundleInfo, { spaces: 2 });

  // Print results
  printSummary({
    total: packages.size,
    downloaded,
    skipped: preExistingInRegistry + skipped,
    failed: errors.length,
  });
  printErrors(errors);

  if (errors.length === 0) {
    console.log(chalk.green(`\n✓ All packages downloaded to ${path.resolve(outputDir)}`));
  }

  return {
    success: errors.length === 0,
    total: packages.size,
    downloaded,
    skipped: preExistingInRegistry + skipped,
    failed: errors.length,
    errors,
  };
}
