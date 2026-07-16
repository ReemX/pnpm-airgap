/**
 * Prune - remove registry versions that no consumer lockfile references.
 *
 * The keep-set is the union of all supplied lockfile closures (name@version,
 * including transitive + optional deps, which pnpm lockfiles fully resolve).
 * Anything in the registry NOT in that set is dead weight on a no-uplink
 * airgap registry and is safe to remove.
 *
 * SAFETY: prune operates at VERSION granularity, never package granularity.
 * For a package the lockfiles reference, stale versions are removed. A package
 * the lockfiles do NOT mention at all is left completely untouched (it was
 * published deliberately - e.g. pm2/verdaccio for the update path). Whole-
 * package removal is opt-in via --prune-orphans with an explicit --keep list.
 *
 * Default is DRY-RUN: prints the plan and removes nothing unless dryRun=false.
 */

import pLimit from 'p-limit';
import chalk from 'chalk';
import type { OperationResult, OperationStats } from '../types.js';
import { Status } from '../types.js';
import { CONCURRENCY } from '../constants.js';
import { listAllPackages, getPackageMetadata } from '../core/registry.js';
import { parseLockfile } from '../core/lockfile.js';
import { unpublishVersion } from '../core/unpublisher.js';
import { getAuthHeader } from '../utils/http.js';
import { setDebugMode, debug } from '../utils/logger.js';
import { isValidUrl, validateFile } from '../utils/validation.js';
import { createSpinner, printHeader, printInfo } from '../ui/progress.js';

export interface PruneConfig {
  /** One or more pnpm-lock.yaml paths; their union is the keep-set. */
  lockfiles: string[];
  registryUrl: string;
  concurrency: number;
  /** Also remove whole packages absent from every lockfile (default false). */
  pruneOrphans: boolean;
  /** Package names protected from orphan removal (exact match). */
  keep: string[];
  /** Print the plan but remove nothing (default true - safe). */
  dryRun: boolean;
  debug: boolean;
}

export interface PruneResult {
  success: boolean;
  stats: OperationStats;
  planned: number;
  orphanPackages: string[];
}

const DEFAULTS: PruneConfig = {
  lockfiles: ['pnpm-lock.yaml'],
  registryUrl: 'http://localhost:4873',
  concurrency: CONCURRENCY.PUBLISH,
  pruneOrphans: false,
  keep: [],
  dryRun: true,
  debug: false,
};

/** Build the keep-set (name -> Set<version>) from the union of all lockfiles. */
async function buildKeepSet(lockfiles: string[]): Promise<Map<string, Set<string>>> {
  const keep = new Map<string, Set<string>>();
  for (const lf of lockfiles) {
    await validateFile(lf);
    // skipOptional:false on purpose - optional deps may be installed, so keep them.
    const { packages } = await parseLockfile(lf, { skipOptional: false });
    for (const [, pkg] of packages) {
      if (!keep.has(pkg.name)) keep.set(pkg.name, new Set());
      keep.get(pkg.name)!.add(pkg.version);
    }
  }
  return keep;
}

/** Fetch current registry contents (name -> versions[]). */
async function fetchRegistryVersions(
  registryUrl: string,
  authHeader: string | null,
  concurrency: number
): Promise<Map<string, string[]>> {
  const packageList = await listAllPackages(registryUrl, { authHeader });
  const result = new Map<string, string[]>();
  const limit = pLimit(concurrency);

  await Promise.all(
    Array.from(packageList.keys()).map((name) =>
      limit(async () => {
        const metadata = await getPackageMetadata(name, registryUrl, { authHeader });
        result.set(name, metadata?.versions ? Object.keys(metadata.versions) : []);
      })
    )
  );

  return result;
}

export async function prunePackages(config: Partial<PruneConfig> = {}): Promise<PruneResult> {
  const finalConfig: PruneConfig = { ...DEFAULTS, ...config };
  const { lockfiles, registryUrl, concurrency, pruneOrphans, keep, dryRun, debug: debugEnabled } = finalConfig;

  if (debugEnabled) setDebugMode(true);

  if (!isValidUrl(registryUrl)) {
    throw new Error(`Invalid registry URL: ${registryUrl}`);
  }

  printHeader('Registry Prune');
  printInfo('Registry', registryUrl);
  printInfo('Lockfiles', lockfiles.join(', '));
  printInfo('Mode', dryRun ? chalk.yellow('DRY-RUN (no deletions)') : chalk.red('EXECUTE (will unpublish)'));
  if (pruneOrphans) printInfo('Orphans', `remove whole packages not in any lockfile (keep: ${keep.join(', ') || 'none'})`);

  // 1. keep-set from union of lockfiles
  const keepSpinner = createSpinner('Parsing lockfiles...');
  const keepSet = await buildKeepSet(lockfiles);
  const keepVersionTotal = Array.from(keepSet.values()).reduce((s, v) => s + v.size, 0);
  keepSpinner.succeed(`Keep-set: ${keepSet.size} packages, ${keepVersionTotal} versions`);

  // 2. current registry contents
  const regSpinner = createSpinner('Reading registry state...');
  const authHeader = await getAuthHeader(registryUrl);
  const registry = await fetchRegistryVersions(registryUrl, authHeader, concurrency);
  const regVersionTotal = Array.from(registry.values()).reduce((s, v) => s + v.length, 0);
  regSpinner.succeed(`Registry: ${registry.size} packages, ${regVersionTotal} versions`);

  // 3. compute removal plan
  const toRemove: Array<{ name: string; version: string }> = [];
  const orphanPackages: string[] = [];
  const keepOrphan = new Set(keep);

  for (const [name, versions] of registry) {
    const kept = keepSet.get(name);
    if (!kept) {
      // package absent from every lockfile
      if (pruneOrphans && !keepOrphan.has(name)) {
        orphanPackages.push(name);
        for (const v of versions) toRemove.push({ name, version: v });
      }
      continue;
    }
    // package is referenced: remove only versions no lockfile uses
    for (const v of versions) {
      if (!kept.has(v)) toRemove.push({ name, version: v });
    }
  }

  const staleVersionRemovals = toRemove.length - orphanPackages.reduce((s, n) => s + (registry.get(n)?.length || 0), 0);
  console.log();
  console.log(chalk.bold('Prune plan:'));
  console.log(`  Stale versions of kept packages: ${chalk.cyan(staleVersionRemovals)}`);
  if (pruneOrphans) {
    console.log(`  Orphan packages (whole): ${chalk.cyan(orphanPackages.length)}`);
  }
  console.log(`  Total versions to remove: ${chalk.bold(toRemove.length)}`);

  if (debugEnabled && toRemove.length > 0) {
    for (const r of toRemove.slice(0, 50)) debug(`  - ${r.name}@${r.version}`);
    if (toRemove.length > 50) debug(`  ... and ${toRemove.length - 50} more`);
  }

  const stats: OperationStats = { total: toRemove.length, success: 0, skipped: 0, failed: 0, errors: [] };

  if (toRemove.length === 0) {
    console.log(chalk.green('\n✓ Registry already matches the lockfile union - nothing to prune.'));
    return { success: true, stats, planned: 0, orphanPackages };
  }

  if (dryRun) {
    console.log(chalk.yellow(`\nDRY-RUN: ${toRemove.length} versions would be removed. Re-run with --yes to execute.`));
    return { success: true, stats, planned: toRemove.length, orphanPackages };
  }

  // 4. execute removals
  const spinner = createSpinner(`Unpublishing ${toRemove.length} versions...`);
  const limit = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    toRemove.map((r) =>
      limit(async () => {
        const res: OperationResult = await unpublishVersion(r.name, r.version, registryUrl);
        if (res.status === Status.SUCCESS) stats.success++;
        else if (res.status === Status.SKIPPED) stats.skipped++;
        else {
          stats.failed++;
          stats.errors.push(res);
        }
        processed++;
        spinner.text = `Unpublishing... (${processed}/${toRemove.length})  ok:${stats.success} skip:${stats.skipped} fail:${stats.failed}`;
      })
    )
  );

  if (stats.failed > 0) spinner.warn(`Pruned with ${stats.failed} failures`);
  else spinner.succeed(`Pruned ${stats.success} versions (${stats.skipped} already absent)`);

  if (stats.errors.length > 0) {
    console.log(chalk.red('\nFailures:'));
    for (const e of stats.errors.slice(0, 20)) console.log(chalk.red(`  ${e.package}: ${e.error}`));
    if (stats.errors.length > 20) console.log(chalk.gray(`  ... and ${stats.errors.length - 20} more`));
  }

  return { success: stats.failed === 0, stats, planned: toRemove.length, orphanPackages };
}
