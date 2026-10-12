/**
 * Tarball operations - downloading and extracting package info
 */

import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import zlib from 'zlib';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { PackageInfo, OperationResult } from '../types.js';
import { Status } from '../types.js';
import { TIMEOUTS, SIZES } from '../constants.js';
import { debug } from '../utils/logger.js';
import { httpAgent, httpsAgent } from '../utils/http.js';
import { generateFilename } from '../utils/files.js';

const execAsync = promisify(exec);

export interface TarballContents {
  /** The package's own package.json (`<root>/package.json`). */
  manifest: PackageInfo;
  /** Top-level README text, if the tarball has one. */
  readme?: string;
  readmeFilename?: string;
}

const MAX_MANIFEST_BYTES = SIZES.BUFFER_1MB;
const MAX_README_BYTES = 4 * SIZES.MB;

/**
 * Read package.json (and the top-level README) out of a .tgz held in memory.
 *
 * Streams the gzip through a minimal ustar/GNU/pax header walker and keeps only
 * the two files it needs; every other entry is skipped without being touched.
 * Nothing is written to disk. This is the whole point: `npm publish <tgz>`
 * unpacks the tarball into a temp dir (twice) just to read package.json, which
 * for a package with 11k tiny files (@tabler/icons) takes minutes on Windows.
 */
export function readTarball(data: Buffer, options: { readme?: boolean } = {}): Promise<TarballContents> {
  const wantReadme = options.readme ?? true;
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let pending: Buffer = Buffer.alloc(0);
    let remaining = 0; // data bytes left in the current entry
    let padding = 0; // zero padding after the current entry's data
    let collect: Buffer[] | null = null;
    let collectKind: 'manifest' | 'fallbackManifest' | 'readme' | null = null;
    let collectName = '';
    let longName: string | null = null;
    let paxPath: string | null = null;
    let readingMeta: 'L' | 'x' | null = null;
    let metaChunks: Buffer[] = [];

    let manifest: PackageInfo | null = null;
    let fallbackManifest: PackageInfo | null = null;
    let readme: { name: string; text: string } | null = null;
    let done = false;

    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      gunzip.removeAllListeners('data');
      gunzip.destroy();
      if (error) return reject(error);
      const pkg = manifest ?? fallbackManifest;
      if (!pkg || !pkg.name || !pkg.version) {
        return reject(new Error('Invalid package.json - missing name or version'));
      }
      resolve({
        manifest: pkg,
        ...(readme && { readme: readme.text, readmeFilename: readme.name }),
      });
    };

    const endEntry = () => {
      if (readingMeta) {
        const text = Buffer.concat(metaChunks).toString('utf8');
        if (readingMeta === 'L') longName = text.replace(/\0+$/, '');
        else {
          const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
          if (m) paxPath = m[1];
        }
        readingMeta = null;
        metaChunks = [];
        return;
      }
      if (collect && collectKind) {
        const body = Buffer.concat(collect).toString('utf8');
        try {
          if (collectKind === 'readme') readme = { name: collectName, text: body };
          else {
            const parsed = JSON.parse(body) as PackageInfo;
            if (collectKind === 'manifest') manifest = parsed;
            else fallbackManifest ??= parsed;
          }
        } catch (error) {
          debug(`Failed to parse ${collectName}: ${(error as Error).message}`);
        }
      }
      collect = null;
      collectKind = null;
      // Stop reading as soon as everything wanted is in hand.
      if (manifest && (readme || !wantReadme)) finish();
    };

    const parseOctal = (buf: Buffer): number => {
      // GNU base-256 encoding for sizes >= 8 GiB
      if (buf[0] & 0x80) {
        let n = 0;
        for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
        return n;
      }
      const str = buf.toString('ascii').replace(/\0.*$/, '').trim();
      return str ? parseInt(str, 8) : 0;
    };

    const onHeader = (header: Buffer): boolean => {
      // Two zero blocks mark the end; one is enough to stop.
      if (header.every((b) => b === 0)) {
        finish();
        return false;
      }
      const type = String.fromCharCode(header[156] || 48);
      const size = parseOctal(header.subarray(124, 136));
      const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const isUstar = header.subarray(257, 262).toString('ascii') === 'ustar';
      const prefix = isUstar ? header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';

      remaining = size;
      padding = (512 - (size % 512)) % 512;

      if (type === 'L' || type === 'x') {
        readingMeta = type;
        metaChunks = [];
        return true;
      }
      if (type === 'g') return true;

      const entryPath = paxPath ?? longName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      paxPath = null;
      longName = null;

      if (type !== '0' && type !== '\0' && type !== '7') return true;

      const parts = entryPath.replace(/^\.\//, '').split('/');
      if (parts.length === 2) {
        const base = parts[1];
        if (base === 'package.json' && size <= MAX_MANIFEST_BYTES) {
          collectKind = parts[0] === 'package' ? 'manifest' : 'fallbackManifest';
        } else if (wantReadme && /^readme(\.|$)/i.test(base) && size <= MAX_README_BYTES && !readme) {
          collectKind = 'readme';
        }
      } else if (parts.length === 1 && parts[0] === 'package.json' && size <= MAX_MANIFEST_BYTES) {
        collectKind = 'manifest';
      }
      if (collectKind) {
        collect = [];
        collectName = parts[parts.length - 1];
      }
      return true;
    };

    gunzip.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (!done) {
        if (remaining > 0) {
          const take = Math.min(remaining, pending.length - offset);
          if (take === 0) break;
          const slice = pending.subarray(offset, offset + take);
          if (readingMeta) metaChunks.push(Buffer.from(slice));
          else if (collect) collect.push(Buffer.from(slice));
          offset += take;
          remaining -= take;
          if (remaining === 0) {
            endEntry();
          }
          continue;
        }
        if (padding > 0) {
          const skip = Math.min(padding, pending.length - offset);
          if (skip === 0) break;
          offset += skip;
          padding -= skip;
          continue;
        }
        if (pending.length - offset < 512) break;
        const header = pending.subarray(offset, offset + 512);
        offset += 512;
        if (!onHeader(header)) break;
        if (remaining === 0) endEntry();
      }
      pending = offset >= pending.length ? Buffer.alloc(0) : pending.subarray(offset);
    });
    gunzip.on('end', () => finish());
    gunzip.on('error', (error) => finish(new Error(`Corrupt tarball: ${error.message}`)));
    gunzip.end(data);
  });
}

/**
 * Extract package.json from a tarball on disk.
 */
export async function getPackageInfo(tarballPath: string): Promise<PackageInfo> {
  const { manifest } = await readTarball(await fs.readFile(tarballPath), { readme: false });
  return manifest;
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
  authHeader?: string | null;
}

/**
 * Download a package tarball
 */
export async function downloadTarball(
  tarballUrl: string,
  outputPath: string,
  options: DownloadOptions = {}
): Promise<OperationResult> {
  const { authHeader = null } = options;
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
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const response = await axios({
      method: 'GET',
      url: tarballUrl,
      headers,
      responseType: 'stream',
      httpAgent,
      httpsAgent,
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
