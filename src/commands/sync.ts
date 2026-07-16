/**
 * Sync command - mirror packages between registries
 */

import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import chalk from 'chalk';
import type { SyncConfig, OperationResult } from '../types.js';
import { Status, Existence } from '../types.js';
import { CONCURRENCY, DEFAULT_CONFIG } from '../constants.js';
import { listAllPackages, getPackageMetadata, packageExists, isPublicRegistry } from '../core/registry.js';
import { downloadTarball, getPackageInfo } from '../core/tarball.js';
import { publishPackage } from '../core/publisher.js';
import { getAuthHeader, verifyAuth } from '../utils/http.js';
import { setDebugMode, debug } from '../utils/logger.js';
import { validateRegistryUrl } from '../utils/validation.js';
import { generateFilename } from '../utils/files.js';
import { ProgressTracker, createSpinner, printHeader, printInfo, printSummary, printErrors } from '../ui/progress.js';

export interface SyncResult {
  success: boolean;
  packages: number;
  versions: number;
  downloaded: number;
  published: number;
  skipped: number;
  failed: number;
}

interface TarballInfo {
  path: string;
  name: string;
  version: string;
  dryRun?: boolean;
}

/**
 * Sync packages from source registry to destination
 */
export async function syncRegistries(config: Partial<SyncConfig> = {}): Promise<SyncResult> {
  const finalConfig: SyncConfig = {
    ...DEFAULT_CONFIG.sync,
    ...config,
  };

  const {
    sourceRegistry,
    destRegistry,
    outputDir,
    scope,
    packageList,
    maxVersions,
    sinceDate,
    concurrency,
    skipExisting,
    downloadOnly,
    publishOnly,
    dryRun,
    debug: debugEnabled,
  } = finalConfig;

  if (debugEnabled) {
    setDebugMode(true);
  }

  // Validate inputs
  validateRegistryUrl(sourceRegistry);
  if (!downloadOnly) {
    validateRegistryUrl(destRegistry);
  }

  // Safety check for public registries
  if (isPublicRegistry(sourceRegistry) && !scope && !packageList) {
    console.log(chalk.red('\n🚫 BLOCKED: Syncing from public npm registry without filters'));
    console.log(chalk.yellow('\nThe public npm registry contains millions of packages.'));
    console.log(chalk.white('\nUse one of these options:'));
    console.log(chalk.gray('  --scope @mycompany        Only sync packages in a scope'));
    console.log(chalk.gray('  --package-list file.txt   Sync packages listed in a file'));
    throw new Error('Full sync from public npm registry is blocked for safety');
  }

  printHeader('Registry Sync', dryRun ? chalk.yellow('DRY RUN MODE') : undefined);
  printInfo('Source', sourceRegistry);
  if (!downloadOnly) {
    printInfo('Destination', destRegistry);
  }
  printInfo('Output', outputDir);
  if (scope) printInfo('Scope', scope);
  if (maxVersions) printInfo('Max versions', maxVersions.toString());
  if (sinceDate) printInfo('Since', sinceDate);

  await fs.ensureDir(outputDir);

  const sourceAuthHeader = await getAuthHeader(sourceRegistry);
  if (sourceAuthHeader) debug('Found credentials for source registry');

  // Get list of packages to sync
  const packagesToSync = new Map<string, { name: string; tarballs?: TarballInfo[] }>();

  if (publishOnly) {
    const spinner = createSpinner('Scanning for existing tarballs...');
    const files = await fs.readdir(outputDir);
    const tarballs = files.filter((f) => f.endsWith('.tgz'));

    for (const tarball of tarballs) {
      try {
        const tarballPath = path.join(outputDir, tarball);
        const info = await getPackageInfo(tarballPath);
        if (!packagesToSync.has(info.name)) {
          packagesToSync.set(info.name, { name: info.name, tarballs: [] });
        }
        packagesToSync.get(info.name)!.tarballs!.push({
          version: info.version,
          path: tarballPath,
          name: info.name,
        });
      } catch (e) {
        debug(`Could not read ${tarball}: ${(e as Error).message}`);
      }
    }

    spinner.succeed(`Found ${tarballs.length} tarballs for ${packagesToSync.size} packages`);
  } else if (packageList) {
    const spinner = createSpinner('Reading package list...');
    let packageNames: string[] = [];

    if (await fs.pathExists(packageList)) {
      const content = await fs.readFile(packageList, 'utf8');
      packageNames = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    } else {
      packageNames = packageList.split(',').map((p) => p.trim());
    }

    for (const name of packageNames) {
      packagesToSync.set(name, { name });
    }

    spinner.succeed(`Loaded ${packagesToSync.size} packages from list`);
  } else {
    const spinner = createSpinner('Fetching package list from source...');

    try {
      const list = await listAllPackages(sourceRegistry, { scope, authHeader: sourceAuthHeader });
      for (const [name] of list) {
        packagesToSync.set(name, { name });
      }
      spinner.succeed(`Found ${packagesToSync.size} packages`);
    } catch (error) {
      spinner.fail('Failed to list packages');
      throw error;
    }
  }

  if (packagesToSync.size === 0) {
    console.log(chalk.yellow('No packages to sync'));
    return { success: true, packages: 0, versions: 0, downloaded: 0, published: 0, skipped: 0, failed: 0 };
  }

  // Download packages
  const downloadResults = { downloaded: 0, skipped: 0, failed: 0, errors: [] as OperationResult[] };
  const tarballs: TarballInfo[] = [];

  if (!publishOnly) {
    const metaSpinner = createSpinner('Fetching metadata and downloading...');
    const limit = pLimit(concurrency);
    let processed = 0;

    await Promise.all(
      Array.from(packagesToSync.entries()).map(([name]) =>
        limit(async () => {
          try {
            const metadata = await getPackageMetadata(name, sourceRegistry, { authHeader: sourceAuthHeader });

            if (!metadata?.versions) {
              processed++;
              return;
            }

            let versions = Object.keys(metadata.versions);

            // Filter by date
            if (sinceDate && metadata.time) {
              const sinceTime = new Date(sinceDate).getTime();
              versions = versions.filter((v) => {
                const vTime = metadata.time?.[v];
                return vTime && new Date(vTime).getTime() >= sinceTime;
              });
            }

            // Limit versions
            if (maxVersions && versions.length > maxVersions) {
              if (metadata.time) {
                versions.sort((a, b) => {
                  const timeA = new Date(metadata.time?.[a] || 0).getTime();
                  const timeB = new Date(metadata.time?.[b] || 0).getTime();
                  return timeB - timeA;
                });
              }
              versions = versions.slice(0, maxVersions);
            }

            // Download each version
            for (const version of versions) {
              const versionData = metadata.versions[version];
              if (!versionData?.dist?.tarball) continue;

              const filename = generateFilename(name, version);
              const outputPath = path.join(outputDir, filename);

              if (dryRun) {
                tarballs.push({ path: outputPath, name, version, dryRun: true });
                downloadResults.downloaded++;
                continue;
              }

              const result = await downloadTarball(versionData.dist.tarball, outputPath, { authHeader: sourceAuthHeader });

              if (result.status === Status.SUCCESS) {
                downloadResults.downloaded++;
                tarballs.push({ path: outputPath, name, version });
              } else if (result.status === Status.SKIPPED) {
                downloadResults.skipped++;
                tarballs.push({ path: outputPath, name, version });
              } else {
                downloadResults.failed++;
                downloadResults.errors.push({ ...result, name, version });
              }
            }

            processed++;
            metaSpinner.text = `Processing... (${processed}/${packagesToSync.size}) - Downloaded: ${downloadResults.downloaded}`;
          } catch (error) {
            debug(`Error processing ${name}: ${(error as Error).message}`);
            processed++;
          }
        })
      )
    );

    metaSpinner.succeed(`Download: ✓ ${downloadResults.downloaded} | ⊘ ${downloadResults.skipped} | ✗ ${downloadResults.failed}`);
  } else {
    // Use tarballs from publish-only scan
    for (const [, pkg] of packagesToSync) {
      if (pkg.tarballs) {
        tarballs.push(...pkg.tarballs);
      }
    }
  }

  // Save manifest
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
    tarballs: tarballs.map((t) => ({ name: t.name, version: t.version, file: path.basename(t.path) })),
  };
  await fs.writeJson(path.join(outputDir, 'sync-manifest.json'), manifest, { spaces: 2 });

  // Publish to destination
  const publishResults = { published: 0, skipped: 0, failed: 0, errors: [] as OperationResult[] };

  if (!downloadOnly && tarballs.length > 0 && !dryRun) {
    const authSpinner = createSpinner('Verifying destination auth...');
    try {
      const username = await verifyAuth(destRegistry);
      authSpinner.succeed(`Authenticated as ${chalk.bold(username)}`);
    } catch (error) {
      authSpinner.fail('Authentication failed');
      throw error;
    }

    // Pre-check existing packages
    const existsInDest = new Set<string>();
    if (skipExisting) {
      const checkLimit = pLimit(CONCURRENCY.PRE_CHECK);
      await Promise.all(
        tarballs.map((t) =>
          checkLimit(async () => {
            const result = await packageExists(t.name, t.version, destRegistry);
            if (result.status === Existence.EXISTS && result.certain) {
              existsInDest.add(`${t.name}@${t.version}`);
            }
          })
        )
      );
      publishResults.skipped = existsInDest.size;
    }

    const progress = new ProgressTracker('Publishing', tarballs.length, existsInDest.size);
    const publishLimit = pLimit(Math.min(concurrency, CONCURRENCY.PUBLISH));

    await Promise.all(
      tarballs.map((t) =>
        publishLimit(async () => {
          const packageId = `${t.name}@${t.version}`;

          if (skipExisting && existsInDest.has(packageId)) {
            return;
          }

          try {
            const result = await publishPackage(t.path, destRegistry, { maxRetries: 2 });

            if (result.status === Status.SUCCESS) {
              publishResults.published++;
              progress.success();
            } else if (result.status === Status.SKIPPED) {
              publishResults.skipped++;
              progress.skip();
            } else {
              publishResults.failed++;
              publishResults.errors.push({ ...result, name: t.name, version: t.version });
              progress.fail();
            }
          } catch (error) {
            publishResults.failed++;
            publishResults.errors.push({
              status: Status.ERROR,
              package: packageId,
              name: t.name,
              version: t.version,
              error: (error as Error).message,
            });
            progress.fail();
          }
        })
      )
    );

    progress.complete();
  } else if (dryRun) {
    console.log(chalk.yellow(`\nDry run: Would publish ${tarballs.length} versions to ${destRegistry}`));
    publishResults.published = tarballs.length;
  }

  // Save report
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
  };
  await fs.writeJson(
    path.join(outputDir, dryRun ? 'sync-dry-run-report.json' : 'sync-report.json'),
    report,
    { spaces: 2 }
  );

  // Print results
  printSummary({
    packages: packagesToSync.size,
    versions: tarballs.length,
    downloaded: downloadResults.downloaded,
    published: publishResults.published,
    skipped: downloadResults.skipped + publishResults.skipped,
    failed: downloadResults.failed + publishResults.failed,
  });

  const allErrors = [...downloadResults.errors, ...publishResults.errors];
  printErrors(allErrors);

  const success = downloadResults.failed === 0 && publishResults.failed === 0;
  console.log(success ? chalk.green('\n✓ Sync completed successfully') : chalk.yellow(`\n⚠ Sync completed with errors`));

  return {
    success,
    packages: packagesToSync.size,
    versions: tarballs.length,
    downloaded: downloadResults.downloaded,
    published: publishResults.published,
    skipped: downloadResults.skipped + publishResults.skipped,
    failed: downloadResults.failed + publishResults.failed,
  };
}
