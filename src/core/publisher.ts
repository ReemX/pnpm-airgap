/**
 * Publisher - handles publishing packages to npm registries
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { OperationResult, PackageInfo } from '../types.js';
import { Status } from '../types.js';
import { SIZES, RETRY, PRERELEASE_PATTERNS, VERSION_TAG_PREFIX } from '../constants.js';
import { calculateTimeout, getFileSizeString } from '../utils/files.js';
import { calculateBackoffDelay, sleep } from '../utils/http.js';
import { debug } from '../utils/logger.js';
import { getPackageInfo } from './tarball.js';

const execAsync = promisify(exec);

/**
 * Detect prerelease tag from version string
 */
export function detectPrereleaseTag(version: string): string | null {
  // First, try to extract the full prerelease identifier from semver format
  // e.g., "1.0.0-preview.1" -> "preview", "2.0.0-beta" -> "beta"
  const semverMatch = version.match(/^\d+\.\d+\.\d+-([a-zA-Z]+)/);
  if (semverMatch) {
    const identifier = semverMatch[1].toLowerCase();

    // Check if it matches any known prerelease pattern
    for (const { pattern, tag } of PRERELEASE_PATTERNS) {
      const patternName = pattern.replace('-', '');
      if (identifier === patternName) {
        return tag;
      }
    }

    // Return the full identifier for unknown tags
    return identifier;
  }

  // Handle numeric-only prerelease (e.g., "1.0.0-0", "1.0.0-123")
  const numericPrerelease = /^\d+\.\d+\.\d+-\d+$/;
  if (numericPrerelease.test(version)) {
    return 'prerelease';
  }

  // Fallback: check for pattern anywhere in version string
  for (const { pattern, tag } of PRERELEASE_PATTERNS) {
    if (version.includes(pattern)) {
      return tag;
    }
  }

  return null;
}

/**
 * Generate version tag for legacy/older versions
 */
export function generateVersionTag(version: string): string {
  return `${VERSION_TAG_PREFIX}-${version.replace(/\./g, '-')}`;
}

export interface PublishOptions {
  packageInfo?: PackageInfo | null;
  maxRetries?: number;
  dryRun?: boolean;
}

/**
 * Publish a single package to registry
 */
export async function publishPackage(
  tarballPath: string,
  registryUrl: string,
  options: PublishOptions = {}
): Promise<OperationResult> {
  const { packageInfo = null, maxRetries = RETRY.MAX_ATTEMPTS, dryRun = false } = options;

  let pkgInfo = packageInfo;
  let packageIdentifier = path.basename(tarballPath, '.tgz');

  try {
    if (!pkgInfo) {
      try {
        pkgInfo = await getPackageInfo(tarballPath);
      } catch (infoError) {
        debug(`Warning: Could not extract package info for ${packageIdentifier}: ${(infoError as Error).message}`);
      }
    }

    if (pkgInfo) {
      packageIdentifier = `${pkgInfo.name}@${pkgInfo.version}`;
    }

    const timeout = await calculateTimeout(tarballPath);
    const prereleaseTag = pkgInfo ? detectPrereleaseTag(pkgInfo.version) : null;
    const tagOption = `--tag ${prereleaseTag || 'latest'}`;

    if (dryRun) {
      return {
        status: Status.SUCCESS,
        package: packageIdentifier,
        name: pkgInfo?.name,
        version: pkgInfo?.version,
        dryRun: true,
        tag: prereleaseTag || 'latest',
      };
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await execAsync(
          `npm publish "${tarballPath}" --registry ${registryUrl} ${tagOption} --provenance false`,
          { timeout, maxBuffer: SIZES.BUFFER_10MB }
        );

        return {
          status: Status.SUCCESS,
          package: packageIdentifier,
          name: pkgInfo?.name,
          version: pkgInfo?.version,
          attempt,
          size: (await getFileSizeString(tarballPath)) as unknown as number,
          tag: prereleaseTag || 'latest',
        };
      } catch (publishError) {
        lastError = publishError as Error;
        const errorMessage = lastError.message || '';

        // Version conflict - try with version-specific tag
        if (
          errorMessage.includes('previously published version') &&
          errorMessage.includes('is higher than') &&
          errorMessage.includes('You must specify a tag')
        ) {
          try {
            const versionTag = pkgInfo ? generateVersionTag(pkgInfo.version) : VERSION_TAG_PREFIX;
            await execAsync(
              `npm publish "${tarballPath}" --registry ${registryUrl} --tag ${versionTag} --provenance false`,
              { timeout, maxBuffer: SIZES.BUFFER_10MB }
            );

            return {
              status: Status.SUCCESS,
              package: packageIdentifier,
              name: pkgInfo?.name,
              version: pkgInfo?.version,
              attempt,
              note: `Published with tag ${versionTag} (older version)`,
              tag: versionTag,
            };
          } catch (retryError) {
            return {
              status: Status.ERROR,
              package: packageIdentifier,
              name: pkgInfo?.name,
              version: pkgInfo?.version,
              error: `Version conflict retry failed: ${(retryError as Error).message.split('\n')[0]}`,
            };
          }
        }

        // Already exists
        if (
          errorMessage.includes('409') ||
          errorMessage.includes('conflict') ||
          errorMessage.includes('cannot publish over')
        ) {
          return {
            status: Status.SKIPPED,
            package: packageIdentifier,
            name: pkgInfo?.name,
            version: pkgInfo?.version,
            reason: 'Already exists (conflict)',
          };
        }

        // Rate limiting - special handling with longer backoff
        if (errorMessage.includes('429') || errorMessage.toLowerCase().includes('too many requests')) {
          if (attempt < maxRetries) {
            const rateLimitBackoff = 30_000 * attempt; // 30s, 60s, 90s
            debug(`Rate limited for ${packageIdentifier}, waiting ${rateLimitBackoff}ms`);
            await sleep(rateLimitBackoff);
            continue;
          }
        }

        // Retryable errors
        const retryableErrors = [
          'timeout',
          'ETIMEDOUT',
          'ECONNRESET',
          'ENOTFOUND',
          'ECONNREFUSED',
          'socket hang up',
          'network timeout',
          'EAI_AGAIN', // DNS lookup timeout
        ];

        const isRetryable = retryableErrors.some((errorType) =>
          errorMessage.toLowerCase().includes(errorType.toLowerCase())
        );

        if (isRetryable && attempt < maxRetries) {
          const backoffTime = calculateBackoffDelay(attempt);
          debug(`Retry ${attempt}/${maxRetries} for ${packageIdentifier} in ${backoffTime}ms`);
          await sleep(backoffTime);
          continue;
        }

        break;
      }
    }

    return {
      status: Status.ERROR,
      package: packageIdentifier,
      name: pkgInfo?.name,
      version: pkgInfo?.version,
      error: lastError?.message?.split('\n')[0] || 'Unknown error',
      attempt: maxRetries,
    };
  } catch (error) {
    return {
      status: Status.ERROR,
      package: packageIdentifier,
      error: (error as Error).message,
    };
  }
}
