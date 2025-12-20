/**
 * Lockfile parsing for pnpm-lock.yaml
 * Supports lockfile versions 5.x, 6.x, and 9.x
 */

import fs from 'fs-extra';
import yaml from 'js-yaml';
import type { LockfilePackage } from '../types.js';
import { DEFAULTS } from '../constants.js';
import { debug } from '../utils/logger.js';
import { isValidVersion } from '../utils/validation.js';

interface LockfileData {
  lockfileVersion: string | number;
  packages?: Record<string, PackageEntry>;
  snapshots?: Record<string, PackageEntry>;
}

interface PackageEntry {
  resolution?: {
    tarball?: string;
    integrity?: string;
  };
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
}

/**
 * Parse package key from lockfile to extract name and version
 * Handles multiple pnpm lockfile formats
 */
export function parsePackageKey(key: string): { name: string; version: string } | null {
  if (!key || typeof key !== 'string') {
    return null;
  }

  // Remove leading slash if present
  let cleanKey = key.replace(/^\//, '');

  // Skip non-registry packages
  const skipPatterns = [
    'file:',
    'link:',
    'git+',
    'git:',
    'github:',
    'bitbucket:',
    'gitlab:',
    '.git',
    'workspace:',
  ];
  if (skipPatterns.some((p) => cleanKey.includes(p))) {
    debug(`Skipping non-registry package: ${key}`);
    return null;
  }

  // Handle aliased packages: alias@npm:real-package@version or @scope/alias@npm:...
  const aliasMatch = cleanKey.match(/^(?:@[^/]+\/)?[^@]+@npm:(.+)$/);
  if (aliasMatch) {
    cleanKey = aliasMatch[1];
    debug(`Resolved alias to: ${cleanKey}`);
  }

  // Remove patch suffix (e.g., package@version_hash=)
  cleanKey = cleanKey.replace(/_[a-zA-Z0-9]+=$/, '');

  // Remove peer dependency suffix
  const peerDepIndex = cleanKey.indexOf('(');
  if (peerDepIndex > 0) {
    cleanKey = cleanKey.substring(0, peerDepIndex);
  }

  // Parse scoped packages: @scope/package@version
  const scopedMatch = cleanKey.match(/^(@[^@/]+\/[^@/]+)[@/](.+)$/);
  if (scopedMatch) {
    const [, name, version] = scopedMatch;
    if (isValidVersion(version)) {
      return { name, version };
    }
  }

  // Parse regular packages: package@version or package/version
  const regularMatch = cleanKey.match(/^([^@/]+)[@/](.+)$/);
  if (regularMatch) {
    const [, name, version] = regularMatch;
    if (isValidVersion(version) && !name.startsWith('@')) {
      return { name, version };
    }
  }

  debug(`Could not parse package key: ${key}`);
  return null;
}

/**
 * Construct tarball URL for npm registry
 */
export function constructTarballUrl(
  name: string,
  version: string,
  registry: string = DEFAULTS.NPM_REGISTRY_URL
): string {
  registry = registry.replace(/\/$/, '');

  if (name.startsWith('@')) {
    const encoded = name.replace('/', '%2f');
    const packagePart = name.split('/')[1];
    return `${registry}/${encoded}/-/${packagePart}-${version}.tgz`;
  }

  return `${registry}/${name}/-/${name}-${version}.tgz`;
}

export interface ParseLockfileOptions {
  registryUrl?: string;
  skipOptional?: boolean;
}

export interface ParseLockfileResult {
  packages: Map<string, LockfilePackage>;
  skipped: {
    nonRegistry: number;
    invalid: number;
    duplicate: number;
    optional: number;
  };
  lockfileVersion: string;
}

/**
 * Parse pnpm lockfile and extract package information
 */
export async function parseLockfile(
  lockfilePath: string,
  options: ParseLockfileOptions = {}
): Promise<ParseLockfileResult> {
  const { registryUrl = DEFAULTS.NPM_REGISTRY_URL, skipOptional = false } = options;

  const content = await fs.readFile(lockfilePath, 'utf8');
  const lockfile = yaml.load(content) as LockfileData;

  const packages = new Map<string, LockfilePackage>();
  const skipped = { nonRegistry: 0, invalid: 0, duplicate: 0, optional: 0 };

  const lockfileVersion = String(lockfile.lockfileVersion || '6.0');
  const majorVersion = parseInt(lockfileVersion.split('.')[0], 10);

  debug(`Parsing lockfile version ${lockfileVersion} (major: ${majorVersion})`);

  // Process packages section
  if (lockfile.packages) {
    for (const [key, value] of Object.entries(lockfile.packages)) {
      if (skipOptional && value?.optional === true) {
        skipped.optional++;
        continue;
      }

      const packageInfo = parsePackageKey(key);
      if (!packageInfo) {
        skipped.nonRegistry++;
        continue;
      }

      const { name, version } = packageInfo;
      const packageId = `${name}@${version}`;

      if (packages.has(packageId)) {
        skipped.duplicate++;
        continue;
      }

      let tarballUrl: string;
      let integrity: string | undefined;

      if (value?.resolution?.tarball) {
        tarballUrl = value.resolution.tarball;
        integrity = value.resolution.integrity;
      } else if (value?.resolution?.integrity) {
        tarballUrl = constructTarballUrl(name, version, registryUrl);
        integrity = value.resolution.integrity;
      } else if (value?.integrity) {
        tarballUrl = constructTarballUrl(name, version, registryUrl);
        integrity = value.integrity;
      } else {
        tarballUrl = constructTarballUrl(name, version, registryUrl);
      }

      packages.set(packageId, {
        name,
        version,
        tarballUrl,
        integrity,
        dev: value?.dev === true,
        optional: value?.optional === true,
      });
    }
  }

  // For v9+, also check snapshots section
  if (majorVersion >= 9 && lockfile.snapshots) {
    for (const [key, value] of Object.entries(lockfile.snapshots)) {
      const packageInfo = parsePackageKey(key);
      if (!packageInfo) continue;

      const { name, version } = packageInfo;
      const packageId = `${name}@${version}`;

      if (packages.has(packageId)) continue;

      packages.set(packageId, {
        name,
        version,
        tarballUrl: constructTarballUrl(name, version, registryUrl),
        integrity: value?.resolution?.integrity,
        dev: value?.dev === true,
        optional: value?.optional === true,
        fromSnapshots: true,
      });
    }
  }

  debug(`Parsed ${packages.size} packages from lockfile`);
  debug(
    `Skipped: ${skipped.nonRegistry} non-registry, ${skipped.invalid} invalid, ${skipped.duplicate} duplicate, ${skipped.optional} optional`
  );

  return { packages, skipped, lockfileVersion };
}
