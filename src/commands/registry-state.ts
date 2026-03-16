/**
 * Registry State - export and manage registry state for incremental syncing
 */

import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import chalk from 'chalk';
import type { RegistryStateConfig, RegistryState, LockfilePackage } from '../types.js';
import { DEFAULT_CONFIG } from '../constants.js';
import { listAllPackages, getPackageMetadata } from '../core/registry.js';
import { parseLockfile } from '../core/lockfile.js';
import { getAuthToken } from '../utils/http.js';
import { setDebugMode, debug } from '../utils/logger.js';
import { isValidUrl, validateFile } from '../utils/validation.js';
import { createSpinner, printHeader, printInfo } from '../ui/progress.js';

export const REGISTRY_STATE_VERSION = 1;

/**
 * Validate registry state file format
 */
export function validateRegistryState(state: unknown): asserts state is RegistryState {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid registry state: expected an object');
  }

  const s = state as Record<string, unknown>;

  if (s.version !== REGISTRY_STATE_VERSION) {
    throw new Error(`Unsupported registry state version: ${s.version} (expected ${REGISTRY_STATE_VERSION})`);
  }

  if (!s.packages || typeof s.packages !== 'object') {
    throw new Error('Invalid registry state: missing packages object');
  }

  for (const [name, versions] of Object.entries(s.packages as Record<string, unknown>)) {
    if (!Array.isArray(versions)) {
      throw new Error(`Invalid registry state: package "${name}" versions should be an array`);
    }
  }
}

/**
 * Load and parse registry state from file
 */
export async function loadRegistryState(filePath: string): Promise<RegistryState> {
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Registry state file not found: ${filePath}`);
  }

  const content = await fs.readFile(filePath, 'utf8');
  let state: unknown;

  try {
    state = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse registry state file: ${(e as Error).message}`);
  }

  validateRegistryState(state);
  return state;
}

/**
 * Build efficient lookup structure from registry state
 */
export function buildVersionLookup(registryState: RegistryState): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();

  for (const [name, versions] of Object.entries(registryState.packages)) {
    lookup.set(name, new Set(versions));
  }

  return lookup;
}

/**
 * Filter lockfile packages to only those missing from registry
 */
export function filterMissingPackages(
  lockfilePackages: Map<string, LockfilePackage>,
  versionLookup: Map<string, Set<string>>
): {
  missing: Map<string, LockfilePackage>;
  existing: Map<string, LockfilePackage>;
  stats: { total: number; missing: number; existing: number };
} {
  const missing = new Map<string, LockfilePackage>();
  const existing = new Map<string, LockfilePackage>();

  for (const [packageId, info] of lockfilePackages) {
    const versions = versionLookup.get(info.name);
    if (versions && versions.has(info.version)) {
      existing.set(packageId, info);
    } else {
      missing.set(packageId, info);
    }
  }

  return {
    missing,
    existing,
    stats: {
      total: lockfilePackages.size,
      missing: missing.size,
      existing: existing.size,
    },
  };
}

export interface ExportResult {
  success: boolean;
  stats: { totalPackages: number; totalVersions: number };
  errors?: Array<{ package: string; error: string }>;
}

/**
 * Export complete registry state
 */
export async function exportRegistryState(config: Partial<RegistryStateConfig> = {}): Promise<ExportResult> {
  const finalConfig: RegistryStateConfig = {
    ...DEFAULT_CONFIG.registryState,
    ...config,
  };

  const {
    registryUrl,
    outputPath,
    scope,
    concurrency,
    debug: debugEnabled,
  } = finalConfig;

  if (debugEnabled) {
    setDebugMode(true);
  }

  if (!isValidUrl(registryUrl)) {
    throw new Error(`Invalid registry URL: ${registryUrl}`);
  }

  printHeader('Registry State Export');
  printInfo('Registry', registryUrl);
  printInfo('Output', outputPath);
  if (scope) {
    printInfo('Scope', scope);
  }

  const authToken = await getAuthToken(registryUrl);
  if (authToken) {
    debug('Found auth token for registry');
  }

  // Get list of all packages
  const listSpinner = createSpinner('Fetching package list...');
  let packageList: Map<string, { name: string; versions: Record<string, unknown> }>;

  try {
    packageList = await listAllPackages(registryUrl, { scope, authToken });
    listSpinner.succeed(`Found ${packageList.size} packages`);
  } catch (error) {
    listSpinner.fail('Failed to list packages');
    throw error;
  }

  if (packageList.size === 0) {
    console.log(chalk.yellow('No packages found'));

    const emptyState: RegistryState = {
      version: REGISTRY_STATE_VERSION,
      exportedAt: new Date().toISOString(),
      registry: registryUrl,
      stats: { totalPackages: 0, totalVersions: 0 },
      packages: {},
    };

    await fs.writeJson(outputPath, emptyState, { spaces: 2 });
    return { success: true, stats: emptyState.stats };
  }

  // Fetch metadata for each package
  const metaSpinner = createSpinner('Fetching version metadata...');
  const packages: Record<string, string[]> = {};
  let totalVersions = 0;
  let processed = 0;
  const errors: Array<{ package: string; error: string }> = [];

  const limit = pLimit(concurrency);
  const packageNames = Array.from(packageList.keys());

  await Promise.all(
    packageNames.map((name) =>
      limit(async () => {
        try {
          const metadata = await getPackageMetadata(name, registryUrl, { authToken });

          if (metadata?.versions) {
            const versions = Object.keys(metadata.versions);
            packages[name] = versions;
            totalVersions += versions.length;
            debug(`${name}: ${versions.length} versions`);
          } else {
            packages[name] = [];
          }
        } catch (error) {
          debug(`Error fetching metadata for ${name}: ${(error as Error).message}`);
          errors.push({ package: name, error: (error as Error).message });
          packages[name] = [];
        }

        processed++;
        metaSpinner.text = `Fetching version metadata... (${processed}/${packageNames.length}) - ${totalVersions} versions`;
      })
    )
  );

  if (errors.length > 0) {
    metaSpinner.warn(`Fetched with ${errors.length} errors - ${totalVersions} versions`);
  } else {
    metaSpinner.succeed(`Fetched ${totalVersions} versions from ${packageNames.length} packages`);
  }

  // Write registry state file
  const registryState: RegistryState = {
    version: REGISTRY_STATE_VERSION,
    exportedAt: new Date().toISOString(),
    registry: registryUrl,
    stats: {
      totalPackages: Object.keys(packages).length,
      totalVersions,
    },
    packages,
  };

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, registryState, { spaces: 2 });

  console.log(chalk.green(`\n✓ Registry state exported to: ${outputPath}`));
  console.log(chalk.gray(`  ${registryState.stats.totalPackages} packages, ${registryState.stats.totalVersions} versions`));

  return {
    success: errors.length === 0,
    stats: registryState.stats,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// =============================================================================
// From Lockfile
// =============================================================================

export interface FromLockfileConfig {
  lockfilePath: string;
  outputPath: string;
  /** Existing registry-state to merge with (preserves old versions not in lockfile) */
  mergeWith?: string | null;
  /** Registry URL label for the output (default: 'from-lockfile') */
  registry?: string;
  skipOptional?: boolean;
  debug?: boolean;
}

export interface FromLockfileResult {
  success: boolean;
  stats: { totalPackages: number; totalVersions: number };
  merged: boolean;
}

/**
 * Build a registry-state from a pnpm lockfile.
 *
 * Parses the lockfile to extract all package names and versions,
 * then outputs a registry-state.json. Optionally merges with an
 * existing registry-state to preserve versions not in the lockfile.
 *
 * Use case: on the internet (authority) side after exporting a bundle
 * with packages, to predict the airgap registry state without needing
 * access to a live Verdaccio instance.
 */
export async function registryStateFromLockfile(config: Partial<FromLockfileConfig> = {}): Promise<FromLockfileResult> {
  const {
    lockfilePath = 'pnpm-lock.yaml',
    outputPath = 'registry-state.json',
    mergeWith,
    registry = 'from-lockfile',
    skipOptional = false,
    debug: debugEnabled = false,
  } = config;

  if (debugEnabled) {
    setDebugMode(true);
  }

  printHeader('Registry State from Lockfile');
  printInfo('Lockfile', lockfilePath);
  printInfo('Output', outputPath);
  if (mergeWith) {
    printInfo('Merge with', mergeWith);
  }

  // Parse lockfile
  const spinner = createSpinner('Parsing lockfile...');

  await validateFile(lockfilePath);
  const lockfileResult = await parseLockfile(lockfilePath, { skipOptional });
  spinner.succeed(`Parsed ${lockfileResult.packages.size} packages from lockfile (v${lockfileResult.lockfileVersion})`);

  // Build packages map from lockfile
  const packages: Record<string, string[]> = {};

  for (const [, pkg] of lockfileResult.packages) {
    if (!packages[pkg.name]) {
      packages[pkg.name] = [];
    }
    if (!packages[pkg.name].includes(pkg.version)) {
      packages[pkg.name].push(pkg.version);
    }
  }

  // Merge with existing registry-state if provided
  let merged = false;
  if (mergeWith && await fs.pathExists(mergeWith)) {
    const mergeSpinner = createSpinner('Merging with existing registry state...');
    try {
      const existingState = await loadRegistryState(mergeWith);

      for (const [name, versions] of Object.entries(existingState.packages)) {
        if (!packages[name]) {
          packages[name] = [...versions];
        } else {
          for (const version of versions) {
            if (!packages[name].includes(version)) {
              packages[name].push(version);
            }
          }
        }
      }

      merged = true;
      mergeSpinner.succeed('Merged with existing registry state');
    } catch (error) {
      mergeSpinner.warn(`Could not merge: ${(error as Error).message}`);
    }
  }

  // Sort versions within each package
  for (const name of Object.keys(packages)) {
    packages[name].sort();
  }

  // Calculate stats
  const totalPackages = Object.keys(packages).length;
  const totalVersions = Object.values(packages).reduce((sum, v) => sum + v.length, 0);

  // Write registry state
  const registryState: RegistryState = {
    version: REGISTRY_STATE_VERSION,
    exportedAt: new Date().toISOString(),
    registry,
    stats: { totalPackages, totalVersions },
    packages,
  };

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, registryState, { spaces: 2 });

  console.log(chalk.green(`\n✓ Registry state created from lockfile: ${outputPath}`));
  console.log(chalk.gray(`  ${totalPackages} packages, ${totalVersions} versions${merged ? ' (merged)' : ''}`));

  return {
    success: true,
    stats: { totalPackages, totalVersions },
    merged,
  };
}
