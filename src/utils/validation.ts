/**
 * Validation utilities
 */

import fs from 'fs-extra';

/**
 * Check if a string is a valid URL with http(s) protocol
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate registry URL and throw helpful error if invalid
 */
export function validateRegistryUrl(registryUrl: string): void {
  if (!registryUrl) {
    throw new Error('Registry URL is required');
  }

  if (!isValidUrl(registryUrl)) {
    throw new Error(
      `Invalid registry URL: "${registryUrl}"\n` +
        `URL must start with http:// or https://\n` +
        `Example: http://localhost:4873 or https://registry.npmjs.org`
    );
  }
}

/**
 * Validate that a path exists and is a directory
 */
export async function validateDirectory(dirPath: string, description = 'Directory'): Promise<void> {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${description} path exists but is not a directory: ${dirPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${description} not found: ${dirPath}`);
    }
    throw error;
  }
}

/**
 * Validate that a file exists
 */
export async function validateFile(filePath: string, description = 'File'): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${description} path exists but is not a file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${description} not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Check if a version string is valid semver
 */
export function isValidVersion(version: string): boolean {
  if (!version || typeof version !== 'string') {
    return false;
  }
  const semverPattern = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
  return semverPattern.test(version);
}
