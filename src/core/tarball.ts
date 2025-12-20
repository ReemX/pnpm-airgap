/**
 * Tarball operations - downloading and extracting package info
 */

import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { PackageInfo, OperationResult } from '../types.js';
import { Status } from '../types.js';
import { TIMEOUTS, SIZES } from '../constants.js';
import { debug } from '../utils/logger.js';
import { generateFilename } from '../utils/files.js';

const execAsync = promisify(exec);

/**
 * Extract package.json from tarball using tar library
 */
export async function getPackageInfo(tarballPath: string): Promise<PackageInfo> {
  const results: { main: PackageInfo | null; fallback: PackageInfo | null } = {
    main: null,
    fallback: null,
  };

  await tar.t({
    file: tarballPath,
    onentry: (entry) => {
      if (
        entry.path === 'package/package.json' ||
        entry.path === 'package.json' ||
        entry.path.endsWith('/package.json')
      ) {
        const chunks: Buffer[] = [];
        let chunkSize = 0;

        entry.on('data', (chunk: Buffer) => {
          chunkSize += chunk.length;
          if (chunkSize > SIZES.BUFFER_1MB) {
            entry.destroy();
            return;
          }
          chunks.push(chunk);
        });

        entry.on('end', () => {
          try {
            if (chunkSize > SIZES.BUFFER_1MB) {
              debug(`Package.json too large in ${path.basename(tarballPath)}`);
              return;
            }

            const parsed = JSON.parse(Buffer.concat(chunks).toString()) as PackageInfo;

            if (entry.path === 'package/package.json' || entry.path === 'package.json') {
              results.main = parsed;
            } else if (!results.main) {
              results.fallback = parsed;
            }
          } catch (parseError) {
            debug(`Failed to parse package.json from ${path.basename(tarballPath)}: ${(parseError as Error).message}`);
          }
        });
      }
    },
  });

  const packageJson = results.main ?? results.fallback;

  if (!packageJson || !packageJson.name || !packageJson.version) {
    throw new Error('Invalid package.json - missing name or version');
  }

  return packageJson;
}

/**
 * Extract package.json using system tar command (for bootstrap mode)
 */
export async function getPackageInfoSimple(tarballPath: string): Promise<PackageInfo> {
  const commands = [
    `tar -xzf "${tarballPath}" -O package/package.json`,
    `tar -xzf "${tarballPath}" -O "*/package.json"`,
    `tar -xzf "${tarballPath}" -O package.json`,
  ];

  for (const command of commands) {
    try {
      const { stdout } = await execAsync(command, {
        timeout: TIMEOUTS.PACKAGE_INFO,
        maxBuffer: SIZES.BUFFER_1MB,
      });

      if (stdout.trim()) {
        const packageJson = JSON.parse(stdout) as PackageInfo;
        if (packageJson.name && packageJson.version) {
          return packageJson;
        }
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Could not extract package.json from ${path.basename(tarballPath)}`);
}

export interface DownloadOptions {
  authToken?: string | null;
}

/**
 * Download a package tarball
 */
export async function downloadTarball(
  tarballUrl: string,
  outputPath: string,
  options: DownloadOptions = {}
): Promise<OperationResult> {
  const { authToken = null } = options;
  const packageId = path.basename(outputPath, '.tgz');

  // Skip if already exists
  if (await fs.pathExists(outputPath)) {
    return {
      status: Status.SKIPPED,
      package: packageId,
      reason: 'Already downloaded',
      path: outputPath,
    };
  }

  try {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await axios({
      method: 'GET',
      url: tarballUrl,
      headers,
      responseType: 'stream',
      timeout: TIMEOUTS.DOWNLOAD * 2,
      validateStatus: (status) => status === 200,
    });

    await fs.ensureDir(path.dirname(outputPath));
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        resolve({
          status: Status.SUCCESS,
          package: packageId,
          path: outputPath,
          size: writer.bytesWritten,
        });
      });
      writer.on('error', async (error) => {
        await fs.unlink(outputPath).catch(() => {});
        reject(error);
      });
    });
  } catch (error) {
    await fs.unlink(outputPath).catch(() => {});
    return {
      status: Status.ERROR,
      package: packageId,
      error: (error as { response?: { status?: number } }).response
        ? `HTTP ${(error as { response: { status: number } }).response.status}`
        : (error as Error).message,
    };
  }
}

/**
 * Download a package from lockfile info
 */
export async function downloadPackage(
  name: string,
  version: string,
  tarballUrl: string,
  outputDir: string,
  options: DownloadOptions = {}
): Promise<OperationResult> {
  const filename = generateFilename(name, version);
  const outputPath = path.join(outputDir, filename);

  const result = await downloadTarball(tarballUrl, outputPath, options);

  return {
    ...result,
    name,
    version,
  };
}
