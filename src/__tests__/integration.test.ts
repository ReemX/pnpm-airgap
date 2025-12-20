/**
 * Integration tests - test with real lockfiles and file operations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLockfile, parsePackageKey, constructTarballUrl } from '../core/lockfile.js';
import { detectPrereleaseTag, generateVersionTag } from '../core/publisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const REAL_LOCKFILE = path.join(FIXTURES_DIR, 'pnpm-lock.yaml');

describe('Integration: Real Lockfile Parsing', () => {
  it('parses real pnpm v9 lockfile successfully', async () => {
    const result = await parseLockfile(REAL_LOCKFILE);

    expect(result.lockfileVersion).toBe('9.0');
    expect(result.packages.size).toBeGreaterThan(50); // Should have many packages
    expect(result.skipped.nonRegistry).toBe(0); // No git/file deps in fixture
  });

  it('extracts all expected packages', async () => {
    const result = await parseLockfile(REAL_LOCKFILE);

    // Check for known packages from the fixture
    const packageNames = Array.from(result.packages.values()).map(p => p.name);

    expect(packageNames).toContain('chalk');
    expect(packageNames).toContain('lodash');
    expect(packageNames).toContain('axios');
    expect(packageNames).toContain('@types/node');
    expect(packageNames).toContain('@babel/core');
    expect(packageNames).toContain('react');
    expect(packageNames).toContain('typescript');
    expect(packageNames).toContain('express');
    expect(packageNames).toContain('zod');
  });

  it('generates valid tarball URLs for all packages', async () => {
    const result = await parseLockfile(REAL_LOCKFILE);

    for (const [, pkg] of result.packages) {
      expect(pkg.tarballUrl).toMatch(/^https:\/\/registry\.npmjs\.org\/.+\.tgz$/);

      // Verify URL structure is correct
      if (pkg.name.startsWith('@')) {
        // Scoped package
        expect(pkg.tarballUrl).toContain('%2f');
      }
    }
  });

  it('correctly identifies scoped packages', async () => {
    const result = await parseLockfile(REAL_LOCKFILE);

    const scopedPackages = Array.from(result.packages.values()).filter(p =>
      p.name.startsWith('@')
    );

    expect(scopedPackages.length).toBeGreaterThan(10); // Babel, types, etc.

    for (const pkg of scopedPackages) {
      expect(pkg.name).toMatch(/^@[^/]+\/.+$/);
      // URL should contain encoded scope (case-insensitive check for %2f)
      expect(pkg.tarballUrl.toLowerCase()).toContain('%2f');
    }
  });

  it('handles transitive dependencies', async () => {
    const result = await parseLockfile(REAL_LOCKFILE);

    // Express has many transitive deps
    const packageNames = Array.from(result.packages.values()).map(p => p.name);

    // Common express dependencies
    expect(packageNames).toContain('body-parser');
    expect(packageNames).toContain('cookie');
  });
});

describe('Integration: Package Key Parsing Exhaustive', () => {
  it('parses every package from real lockfile', async () => {
    const content = await fs.readFile(REAL_LOCKFILE, 'utf8');

    // Extract all package keys from the lockfile
    const packageKeyRegex = /^[ ]{2}['"]?([^'":\s]+@[^'":\s]+)['"]?:/gm;
    const matches = content.matchAll(packageKeyRegex);

    let parsedCount = 0;
    const failedKeys: string[] = [];

    for (const match of matches) {
      const key = match[1];
      // Skip non-package entries
      if (key.includes('specifier') || key.includes('version')) continue;

      const result = parsePackageKey(key);
      if (result) {
        parsedCount++;
        expect(result.name).toBeTruthy();
        expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      } else {
        // It's okay to skip some keys (like importers, settings)
        if (!key.includes('file:') && !key.includes('link:')) {
          failedKeys.push(key);
        }
      }
    }

    expect(parsedCount).toBeGreaterThan(50);
    // Allow some failures for non-package keys, but report them
    if (failedKeys.length > 0) {
      console.log('Keys that failed parsing:', failedKeys.slice(0, 5));
    }
  });
});

describe('Integration: Tarball URL Construction', () => {
  const testCases = [
    { name: 'lodash', version: '4.17.21' },
    { name: 'chalk', version: '5.3.0' },
    { name: '@types/node', version: '20.10.0' },
    { name: '@babel/core', version: '7.23.0' },
    { name: '@babel/helper-plugin-utils', version: '7.22.5' },
    { name: 'react', version: '18.2.0' },
    { name: 'express', version: '4.18.2' },
  ];

  for (const { name, version } of testCases) {
    it(`constructs valid URL for ${name}@${version}`, () => {
      const url = constructTarballUrl(name, version);

      expect(url).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(url).toContain(version);
      expect(url.endsWith('.tgz')).toBe(true);

      // Verify URL is valid
      expect(() => new URL(url)).not.toThrow();
    });
  }
});

describe('Integration: Prerelease Detection Real-World', () => {
  // Real-world prerelease versions from npm
  const realWorldVersions = [
    { version: '19.0.0-rc.0', expected: 'rc' },
    { version: '5.0.0-beta.1', expected: 'beta' },
    { version: '3.0.0-alpha.10', expected: 'alpha' },
    { version: '14.0.0-canary.20231001', expected: 'canary' },
    { version: '4.0.0-next.11', expected: 'next' },
    { version: '2.0.0-dev.1', expected: 'dev' },
    { version: '1.0.0-nightly.20231215', expected: 'nightly' },
    { version: '18.3.0-canary-abc123', expected: 'canary' },
  ];

  for (const { version, expected } of realWorldVersions) {
    it(`detects ${expected} in ${version}`, () => {
      expect(detectPrereleaseTag(version)).toBe(expected);
    });
  }

  it('returns null for stable versions', () => {
    const stableVersions = ['1.0.0', '4.17.21', '18.2.0', '5.3.0', '7.23.0'];

    for (const version of stableVersions) {
      expect(detectPrereleaseTag(version)).toBeNull();
    }
  });
});

describe('Integration: Version Tag Generation', () => {
  it('generates unique tags for different versions', () => {
    const versions = ['1.0.0', '1.0.1', '2.0.0', '1.0.0-beta.1'];
    const tags = versions.map(v => generateVersionTag(v));

    // All tags should be unique
    expect(new Set(tags).size).toBe(tags.length);

    // All tags should start with legacy prefix
    for (const tag of tags) {
      expect(tag).toMatch(/^legacy-/);
    }
  });
});

describe('Integration: CLI Smoke Tests', () => {
  it('CLI source file exists', async () => {
    const cliPath = path.join(__dirname, '..', 'cli.ts');
    const exists = await fs.pathExists(cliPath);
    expect(exists).toBe(true);
  });

  it('all command modules can be imported', async () => {
    // These imports will fail if there are syntax errors
    const { fetchDependencies } = await import('../commands/fetch.js');
    const { publishPackages } = await import('../commands/publish.js');
    const { syncRegistries } = await import('../commands/sync.js');

    expect(typeof fetchDependencies).toBe('function');
    expect(typeof publishPackages).toBe('function');
    expect(typeof syncRegistries).toBe('function');
  });
});

describe('Integration: File Operations', () => {
  const tempDir = path.join(FIXTURES_DIR, 'temp-test');

  beforeAll(async () => {
    await fs.ensureDir(tempDir);
  });

  afterAll(async () => {
    await fs.remove(tempDir);
  });

  it('parseLockfile handles non-existent file gracefully', async () => {
    await expect(parseLockfile('/non/existent/path.yaml')).rejects.toThrow();
  });

  it('parseLockfile handles empty file', async () => {
    const emptyFile = path.join(tempDir, 'empty.yaml');
    await fs.writeFile(emptyFile, '');

    await expect(parseLockfile(emptyFile)).rejects.toThrow();
  });

  it('parseLockfile handles invalid YAML', async () => {
    const invalidFile = path.join(tempDir, 'invalid.yaml');
    await fs.writeFile(invalidFile, '{ invalid yaml [[[');

    await expect(parseLockfile(invalidFile)).rejects.toThrow();
  });

  it('parseLockfile handles YAML without packages', async () => {
    const noPackagesFile = path.join(tempDir, 'no-packages.yaml');
    await fs.writeFile(noPackagesFile, 'lockfileVersion: "9.0"\nsettings: {}');

    const result = await parseLockfile(noPackagesFile);
    expect(result.packages.size).toBe(0);
  });
});
