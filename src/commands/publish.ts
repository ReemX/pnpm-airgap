/**
 * Publish command - publish packages to registry
 */

import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import chalk from 'chalk';
import type { PublishConfig, OperationResult } from '../types.js';
import { Status, Existence } from '../types.js';
import { CONCURRENCY, DEFAULT_CONFIG, BLOCKED_REGISTRIES } from '../constants.js';
import { packageExists } from '../core/registry.js';
import { getPackageInfo } from '../core/tarball.js';
import { publishPackage } from '../core/publisher.js';
import { verifyAuth } from '../utils/http.js';
import { setDebugMode } from '../utils/logger.js';
import { validateDirectory, validateRegistryUrl } from '../utils/validation.js';
import { ProgressTracker, createSpinner, printHeader, printInfo, printSummary, printErrors } from '../ui/progress.js';

/**
 * Check if registry is a public registry that should be blocked
 */
function isBlockedRegistry(registryUrl: string): boolean {
  try {
    const url = new URL(registryUrl);
    return BLOCKED_REGISTRIES.some(
      (blocked) => url.hostname === blocked || url.hostname.endsWith('.' + blocked)
    );
  } catch {
    return false;
  }
}

export interface PublishResult {
  success: boolean;
  total: number;
  published: number;
  skipped: number;
  failed: number;
  errors: OperationResult[];
  dryRun: boolean;
}

interface PackageInfoCache {
  info: { name: string; version: string };
  packageId: string;
}

/**
 * Publish all packages to registry
 */
export async function publishPackages(config: Partial<PublishConfig> = {}): Promise<PublishResult> {
  const finalConfig: PublishConfig = {
    ...DEFAULT_CONFIG.publish,
    ...config,
  };

  const {
    packagesDir,
    registryUrl,
    concurrency,
    skipExisting,
    dryRun,
    debug: debugEnabled,
  } = finalConfig;

  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  validateRegistryUrl(registryUrl);
  await validateDirectory(packagesDir, 'Packages directory');

  // CRITICAL: Block publishing to public registries
  if (isBlockedRegistry(registryUrl)) {
    throw new Error(
      `BLOCKED: Cannot publish to public registry "${registryUrl}"!\n` +
        `This tool is designed for private/local registries only.\n` +
        `Publishing to public registries like npmjs.org could:\n` +
        `  - Expose internal packages publicly\n` +
        `  - Cause naming conflicts with existing packages\n` +
        `  - Violate npm terms of service\n\n` +
        `Use a local registry like Verdaccio instead.`
    );
  }

  printHeader('Publish Packages', dryRun ? chalk.yellow('DRY RUN MODE') : undefined);
  printInfo('Packages', packagesDir);
  printInfo('Registry', registryUrl);

  if (!dryRun) {
    console.log(chalk.yellow(`\n⚠ Make sure you are logged in: npm login --registry ${registryUrl}\n`));
  }

  // Verify authentication
  const authSpinner = createSpinner('Verifying authentication...');
  try {
    const username = await verifyAuth(registryUrl);
    authSpinner.succeed(`Authenticated as ${chalk.bold(username)}`);
  } catch (error) {
    if (dryRun) {
      authSpinner.warn('Could not verify authentication (dry run mode)');
    } else {
      authSpinner.fail('Authentication failed');
      throw error;
    }
  }

  // Find all tarballs
  const files = await fs.readdir(packagesDir);
  const tarballs = files.filter((f) => f.endsWith('.tgz')).map((f) => path.join(packagesDir, f));

  if (tarballs.length === 0) {
    console.log(chalk.yellow('No package tarballs found'));
    return { success: true, total: 0, published: 0, skipped: 0, failed: 0, errors: [], dryRun };
  }

  console.log(chalk.gray(`Found ${tarballs.length} packages to process\n`));

  // Extract package info in parallel
  const infoSpinner = createSpinner('Extracting package information...');
  const packageInfoCache = new Map<string, PackageInfoCache>();
  let infoExtracted = 0;
  let infoErrors = 0;

  const infoLimit = pLimit(CONCURRENCY.PACKAGE_INFO);
  await Promise.all(
    tarballs.map((tarball) =>
      infoLimit(async () => {
        try {
          const info = await getPackageInfo(tarball);
          const packageId = `${info.name}@${info.version}`;
          packageInfoCache.set(tarball, { info: { name: info.name, version: info.version }, packageId });
          infoExtracted++;
        } catch {
          infoErrors++;
        }
        infoSpinner.text = `Extracting package information... (${infoExtracted + infoErrors}/${tarballs.length})`;
      })
    )
  );
  infoSpinner.succeed(`Extracted info from ${infoExtracted} packages${infoErrors > 0 ? chalk.yellow(` (${infoErrors} failed)`) : ''}`);

  // Pre-check existing packages
  const preCheckedPackages = new Map<string, { exists: boolean; certain: boolean }>();
  let preSkippedCount = 0;

  if (skipExisting && !dryRun) {
    const checkSpinner = createSpinner('Pre-checking existing packages...');
    const checkLimit = pLimit(CONCURRENCY.PRE_CHECK);

    await Promise.all(
      tarballs.map((tarball) =>
        checkLimit(async () => {
          const cached = packageInfoCache.get(tarball);
          if (!cached) return;

          const result = await packageExists(cached.info.name, cached.info.version, registryUrl);
          if (result.status === Existence.EXISTS && result.certain) {
            preCheckedPackages.set(cached.packageId, { exists: true, certain: true });
            preSkippedCount++;
          } else if (result.status === Existence.NOT_EXISTS && result.certain) {
            preCheckedPackages.set(cached.packageId, { exists: false, certain: true });
          } else {
            preCheckedPackages.set(cached.packageId, { exists: false, certain: false });
          }
        })
      )
    );

    const toPublish = tarballs.length - preSkippedCount;
    checkSpinner.succeed(`Pre-check: ${preSkippedCount} exist, ${toPublish} to publish`);

    if (preSkippedCount === tarballs.length) {
      console.log(chalk.yellow('\nAll packages already exist - nothing to publish'));
      return { success: true, total: tarballs.length, published: 0, skipped: preSkippedCount, failed: 0, errors: [], dryRun };
    }
  }

  // Publish packages
  const limit = pLimit(concurrency);
  const progress = new ProgressTracker('Publishing', tarballs.length, preSkippedCount);
  const errors: OperationResult[] = [];
  let published = 0;
  let skipped = preSkippedCount;

  await Promise.all(
    tarballs.map((tarball) =>
      limit(async () => {
        const cached = packageInfoCache.get(tarball);
        const packageId = cached?.packageId || path.basename(tarball, '.tgz');

        // Skip pre-checked existing packages
        if (skipExisting && cached) {
          const preCheck = preCheckedPackages.get(packageId);
          if (preCheck?.exists && preCheck?.certain) {
            return; // Already counted
          }
        }

        const result = await publishPackage(tarball, registryUrl, {
          packageInfo: cached?.info,
          dryRun,
        });

        if (result.status === Status.SUCCESS) {
          published++;
          progress.success();
        } else if (result.status === Status.SKIPPED) {
          skipped++;
          progress.skip();
        } else {
          errors.push(result);
          progress.fail();
        }
      })
    )
  );

  progress.complete();

  // Verify failed packages (some 404 errors might be false negatives)
  let realErrors = errors;
  if (errors.length > 0 && !dryRun) {
    const verifySpinner = createSpinner('Verifying failed packages...');
    const verifyLimit = pLimit(CONCURRENCY.VERIFY);
    let falseNegatives = 0;

    const verifiedErrors: OperationResult[] = [];
    await Promise.all(
      errors.map((error) =>
        verifyLimit(async () => {
          if (error.error?.includes('404') && error.name && error.version) {
            const result = await packageExists(error.name, error.version, registryUrl, { useCache: false });
            if (result.status === Existence.EXISTS) {
              falseNegatives++;
              published++;
              return;
            }
          }
          verifiedErrors.push(error);
        })
      )
    );

    realErrors = verifiedErrors;
    if (falseNegatives > 0) {
      verifySpinner.succeed(`Verification: ${falseNegatives} false negatives corrected`);
    } else {
      verifySpinner.succeed('Verification complete');
    }
  }

  // Save publish report
  const report = {
    timestamp: new Date().toISOString(),
    registry: registryUrl,
    dryRun,
    total: tarballs.length,
    published,
    skipped,
    failed: realErrors.length,
    errors: realErrors.map((e) => ({
      package: e.package,
      error: e.error,
    })),
  };
  await fs.writeJson(
    path.join(packagesDir, dryRun ? 'dry-run-report.json' : 'publish-report.json'),
    report,
    { spaces: 2 }
  );

  // Print results
  printSummary({
    total: tarballs.length,
    [dryRun ? 'wouldPublish' : 'published']: published,
    skipped,
    failed: realErrors.length,
  });
  printErrors(realErrors);

  const resultMessage = dryRun
    ? `Dry run complete`
    : realErrors.length === 0
      ? `All packages published successfully!`
      : `Completed with ${realErrors.length} errors`;

  console.log(realErrors.length === 0 ? chalk.green(`\n✓ ${resultMessage}`) : chalk.yellow(`\n⚠ ${resultMessage}`));

  return {
    success: realErrors.length === 0,
    total: tarballs.length,
    published,
    skipped,
    failed: realErrors.length,
    errors: realErrors,
    dryRun,
  };
}
