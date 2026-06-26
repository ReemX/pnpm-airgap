/**
 * Unpublisher - removes individual package versions from an npm registry
 *
 * Mirrors publisher.ts but in reverse: shells out to `npm unpublish` so the
 * registry (Verdaccio) performs the manifest trim + tarball delete itself,
 * rather than editing storage on disk. Works whether the tool runs on the
 * registry host or remotely over HTTP.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { OperationResult } from '../types.js';
import { Status } from '../types.js';
import { TIMEOUTS, RETRY } from '../constants.js';
import { calculateBackoffDelay, sleep } from '../utils/http.js';
import { debug } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface UnpublishOptions {
  maxRetries?: number;
  dryRun?: boolean;
}

/**
 * Unpublish a single package version from a registry.
 *
 * Uses `npm unpublish <name>@<version> --force` so partial (single-version)
 * unpublish is allowed even when other versions remain.
 */
export async function unpublishVersion(
  name: string,
  version: string,
  registryUrl: string,
  options: UnpublishOptions = {}
): Promise<OperationResult> {
  const { maxRetries = RETRY.MAX_ATTEMPTS, dryRun = false } = options;
  const packageIdentifier = `${name}@${version}`;

  if (dryRun) {
    return { status: Status.SUCCESS, package: packageIdentifier, name, version, dryRun: true };
  }

  // Quote the spec so scoped names (@scope/pkg@ver) survive the shell.
  const spec = `"${name}@${version}"`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await execAsync(`npm unpublish ${spec} --registry ${registryUrl} --force`, {
        timeout: TIMEOUTS.BASE,
      });
      return { status: Status.SUCCESS, package: packageIdentifier, name, version, attempt };
    } catch (unpublishError) {
      lastError = unpublishError as Error;
      const errorMessage = lastError.message || '';

      // Already gone - treat as success (idempotent).
      if (
        errorMessage.includes('404') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('Not Found') ||
        errorMessage.includes('cannot be found')
      ) {
        return {
          status: Status.SKIPPED,
          package: packageIdentifier,
          name,
          version,
          reason: 'Already absent (404)',
        };
      }

      // Auth failure - not retryable, surface clearly.
      if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('EUNAUTHORIZED')) {
        return {
          status: Status.ERROR,
          package: packageIdentifier,
          name,
          version,
          error: `Not authorized to unpublish (run: npm login --registry ${registryUrl})`,
        };
      }

      const retryableErrors = [
        'timeout',
        'ETIMEDOUT',
        'ECONNRESET',
        'ENOTFOUND',
        'ECONNREFUSED',
        'socket hang up',
        'network timeout',
        'EAI_AGAIN',
        '429',
        'too many requests',
      ];
      const isRetryable = retryableErrors.some((e) => errorMessage.toLowerCase().includes(e.toLowerCase()));

      if (isRetryable && attempt < maxRetries) {
        const backoffTime = calculateBackoffDelay(attempt);
        debug(`Retry ${attempt}/${maxRetries} unpublishing ${packageIdentifier} in ${backoffTime}ms`);
        await sleep(backoffTime);
        continue;
      }

      break;
    }
  }

  return {
    status: Status.ERROR,
    package: packageIdentifier,
    name,
    version,
    error: lastError?.message?.split('\n')[0] || 'Unknown error',
    attempt: maxRetries,
  };
}
