/**
 * Comprehensive tests for lockfile parsing
 * Covers all edge cases for package name formats
 */

import { describe, it, expect } from 'vitest';
import { parsePackageKey, constructTarballUrl } from '../core/lockfile.js';
import { isValidVersion } from '../utils/validation.js';

describe('parsePackageKey', () => {
  describe('regular packages', () => {
    it('parses simple package@version format', () => {
      expect(parsePackageKey('lodash@4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
      });
    });

    it('parses package/version format (pnpm v5 style)', () => {
      expect(parsePackageKey('lodash/4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
      });
    });

    it('parses with leading slash', () => {
      expect(parsePackageKey('/lodash@4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
      });
    });

    it('parses package with hyphen in name', () => {
      expect(parsePackageKey('fs-extra@11.1.0')).toEqual({
        name: 'fs-extra',
        version: '11.1.0',
      });
    });

    it('parses package with numbers in name', () => {
      expect(parsePackageKey('es5-shim@4.5.10')).toEqual({
        name: 'es5-shim',
        version: '4.5.10',
      });
    });

    it('parses package with underscore in name', () => {
      expect(parsePackageKey('my_package@1.0.0')).toEqual({
        name: 'my_package',
        version: '1.0.0',
      });
    });
  });

  describe('scoped packages', () => {
    it('parses @scope/package@version format', () => {
      expect(parsePackageKey('@types/node@20.10.0')).toEqual({
        name: '@types/node',
        version: '20.10.0',
      });
    });

    it('parses @scope/package/version format', () => {
      expect(parsePackageKey('@babel/core/7.23.0')).toEqual({
        name: '@babel/core',
        version: '7.23.0',
      });
    });

    it('parses scoped package with leading slash', () => {
      expect(parsePackageKey('/@types/node@20.10.0')).toEqual({
        name: '@types/node',
        version: '20.10.0',
      });
    });

    it('parses scoped package with hyphen in name', () => {
      expect(parsePackageKey('@typescript-eslint/parser@6.0.0')).toEqual({
        name: '@typescript-eslint/parser',
        version: '6.0.0',
      });
    });

    it('parses scoped package with numbers', () => {
      expect(parsePackageKey('@babel/plugin-transform-runtime@7.23.0')).toEqual({
        name: '@babel/plugin-transform-runtime',
        version: '7.23.0',
      });
    });

    it('parses deeply nested scope names', () => {
      expect(parsePackageKey('@company-name/package-name@1.0.0')).toEqual({
        name: '@company-name/package-name',
        version: '1.0.0',
      });
    });
  });

  describe('prerelease versions', () => {
    it('parses beta version', () => {
      expect(parsePackageKey('react@19.0.0-beta.1')).toEqual({
        name: 'react',
        version: '19.0.0-beta.1',
      });
    });

    it('parses alpha version', () => {
      expect(parsePackageKey('vue@3.4.0-alpha.0')).toEqual({
        name: 'vue',
        version: '3.4.0-alpha.0',
      });
    });

    it('parses rc version', () => {
      expect(parsePackageKey('typescript@5.3.0-rc')).toEqual({
        name: 'typescript',
        version: '5.3.0-rc',
      });
    });

    it('parses canary version', () => {
      expect(parsePackageKey('next@14.0.0-canary.50')).toEqual({
        name: 'next',
        version: '14.0.0-canary.50',
      });
    });

    it('parses version with build metadata', () => {
      expect(parsePackageKey('package@1.0.0+build.123')).toEqual({
        name: 'package',
        version: '1.0.0+build.123',
      });
    });

    it('parses complex prerelease with scoped package', () => {
      expect(parsePackageKey('@vue/compiler-core@3.4.0-alpha.1')).toEqual({
        name: '@vue/compiler-core',
        version: '3.4.0-alpha.1',
      });
    });
  });

  describe('peer dependency suffixes', () => {
    it('strips peer dependency suffix', () => {
      expect(parsePackageKey('ajv@8.12.0(fast-json-stringify@5.8.0)')).toEqual({
        name: 'ajv',
        version: '8.12.0',
      });
    });

    it('strips complex peer dependency suffix', () => {
      expect(parsePackageKey('@babel/plugin-transform-runtime@7.23.0(@babel/core@7.23.0)')).toEqual({
        name: '@babel/plugin-transform-runtime',
        version: '7.23.0',
      });
    });

    it('strips multiple peer dependencies', () => {
      expect(parsePackageKey('eslint-plugin@1.0.0(eslint@8.0.0)(typescript@5.0.0)')).toEqual({
        name: 'eslint-plugin',
        version: '1.0.0',
      });
    });

    it('handles nested parentheses in peer deps', () => {
      expect(parsePackageKey('pkg@1.0.0(dep@2.0.0(nested@3.0.0))')).toEqual({
        name: 'pkg',
        version: '1.0.0',
      });
    });
  });

  describe('aliased packages', () => {
    it('extracts real package from alias', () => {
      expect(parsePackageKey('my-lodash@npm:lodash@4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
      });
    });

    it('handles scoped alias to scoped package', () => {
      expect(parsePackageKey('@my/types@npm:@types/node@20.10.0')).toEqual({
        name: '@types/node',
        version: '20.10.0',
      });
    });

    it('handles alias with complex version', () => {
      expect(parsePackageKey('react-beta@npm:react@19.0.0-beta.1')).toEqual({
        name: 'react',
        version: '19.0.0-beta.1',
      });
    });
  });

  describe('patched packages', () => {
    it('strips patch hash suffix', () => {
      expect(parsePackageKey('lodash@4.17.21_abc123def=')).toEqual({
        name: 'lodash',
        version: '4.17.21',
      });
    });

    it('strips patch hash from scoped package', () => {
      expect(parsePackageKey('@types/node@20.10.0_xyz789=')).toEqual({
        name: '@types/node',
        version: '20.10.0',
      });
    });
  });

  describe('non-registry packages (should return null)', () => {
    it('returns null for file: protocol', () => {
      expect(parsePackageKey('file:../local-package')).toBeNull();
    });

    it('returns null for link: protocol', () => {
      expect(parsePackageKey('link:../linked-package')).toBeNull();
    });

    it('returns null for git+ protocol', () => {
      expect(parsePackageKey('git+https://github.com/user/repo.git')).toBeNull();
    });

    it('returns null for github: shorthand', () => {
      expect(parsePackageKey('github:user/repo')).toBeNull();
    });

    it('returns null for workspace: protocol', () => {
      expect(parsePackageKey('workspace:*')).toBeNull();
    });

    it('returns null for git URLs with .git', () => {
      expect(parsePackageKey('https://github.com/user/repo.git#v1.0.0')).toBeNull();
    });

    it('returns null for bitbucket:', () => {
      expect(parsePackageKey('bitbucket:user/repo')).toBeNull();
    });

    it('returns null for gitlab:', () => {
      expect(parsePackageKey('gitlab:user/repo')).toBeNull();
    });
  });

  describe('invalid inputs', () => {
    it('returns null for null input', () => {
      expect(parsePackageKey(null as unknown as string)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parsePackageKey(undefined as unknown as string)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parsePackageKey('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(parsePackageKey(123 as unknown as string)).toBeNull();
    });

    it('returns null for package without version', () => {
      expect(parsePackageKey('lodash')).toBeNull();
    });

    it('returns null for invalid version format', () => {
      expect(parsePackageKey('lodash@invalid')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles very long package names', () => {
      const longName = 'a'.repeat(100);
      expect(parsePackageKey(`${longName}@1.0.0`)).toEqual({
        name: longName,
        version: '1.0.0',
      });
    });

    it('handles version 0.0.0', () => {
      expect(parsePackageKey('pkg@0.0.0')).toEqual({
        name: 'pkg',
        version: '0.0.0',
      });
    });

    it('handles high version numbers', () => {
      expect(parsePackageKey('pkg@999.999.999')).toEqual({
        name: 'pkg',
        version: '999.999.999',
      });
    });

    it('handles pnpm lockfile v9 format', () => {
      // v9 format sometimes has different separators
      expect(parsePackageKey('/@babel/core@7.23.0')).toEqual({
        name: '@babel/core',
        version: '7.23.0',
      });
    });

    it('handles build metadata versions', () => {
      expect(parsePackageKey('pkg@1.0.0+build.123')).toEqual({
        name: 'pkg',
        version: '1.0.0+build.123',
      });
    });

    it('handles prerelease with build metadata', () => {
      expect(parsePackageKey('pkg@1.0.0-beta.1+build.456')).toEqual({
        name: 'pkg',
        version: '1.0.0-beta.1+build.456',
      });
    });

    it('handles packages with numbers in name', () => {
      expect(parsePackageKey('es6-promise@4.2.8')).toEqual({
        name: 'es6-promise',
        version: '4.2.8',
      });
    });

    it('handles packages with underscores in name', () => {
      expect(parsePackageKey('lodash_merge@1.0.0')).toEqual({
        name: 'lodash_merge',
        version: '1.0.0',
      });
    });

    it('handles scoped packages with underscores', () => {
      expect(parsePackageKey('@my_org/my_pkg@1.0.0')).toEqual({
        name: '@my_org/my_pkg',
        version: '1.0.0',
      });
    });

    it('handles complex real-world pnpm v9 snapshot format', () => {
      // Real pnpm v9 snapshot key with multiple peer deps
      expect(parsePackageKey('@babel/plugin-transform-runtime@7.23.0(@babel/core@7.23.0)')).toEqual({
        name: '@babel/plugin-transform-runtime',
        version: '7.23.0',
      });
    });

    it('handles nested peer dependencies', () => {
      expect(parsePackageKey('postcss-loader@7.3.0(postcss@8.4.31)(webpack@5.89.0)')).toEqual({
        name: 'postcss-loader',
        version: '7.3.0',
      });
    });
  });
});

describe('constructTarballUrl', () => {
  const registry = 'https://registry.npmjs.org';

  describe('regular packages', () => {
    it('constructs URL for simple package', () => {
      expect(constructTarballUrl('lodash', '4.17.21', registry)).toBe(
        'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
      );
    });

    it('constructs URL for package with hyphen', () => {
      expect(constructTarballUrl('fs-extra', '11.1.0', registry)).toBe(
        'https://registry.npmjs.org/fs-extra/-/fs-extra-11.1.0.tgz'
      );
    });
  });

  describe('scoped packages', () => {
    it('constructs URL for scoped package', () => {
      expect(constructTarballUrl('@types/node', '20.10.0', registry)).toBe(
        'https://registry.npmjs.org/@types%2fnode/-/node-20.10.0.tgz'
      );
    });

    it('constructs URL for scoped package with hyphen', () => {
      expect(constructTarballUrl('@typescript-eslint/parser', '6.0.0', registry)).toBe(
        'https://registry.npmjs.org/@typescript-eslint%2fparser/-/parser-6.0.0.tgz'
      );
    });
  });

  describe('registry URL handling', () => {
    it('removes trailing slash from registry', () => {
      expect(constructTarballUrl('lodash', '4.17.21', 'https://registry.npmjs.org/')).toBe(
        'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
      );
    });

    it('works with custom registry', () => {
      expect(constructTarballUrl('lodash', '4.17.21', 'http://localhost:4873')).toBe(
        'http://localhost:4873/lodash/-/lodash-4.17.21.tgz'
      );
    });
  });
});

describe('isValidVersion', () => {
  describe('valid versions', () => {
    it('accepts standard semver', () => {
      expect(isValidVersion('1.0.0')).toBe(true);
      expect(isValidVersion('0.0.1')).toBe(true);
      expect(isValidVersion('10.20.30')).toBe(true);
    });

    it('accepts prerelease versions', () => {
      expect(isValidVersion('1.0.0-beta.1')).toBe(true);
      expect(isValidVersion('1.0.0-alpha.0')).toBe(true);
      expect(isValidVersion('1.0.0-rc.1')).toBe(true);
    });

    it('accepts build metadata', () => {
      expect(isValidVersion('1.0.0+build.123')).toBe(true);
      expect(isValidVersion('1.0.0-beta.1+build.123')).toBe(true);
    });
  });

  describe('invalid versions', () => {
    it('rejects non-semver strings', () => {
      expect(isValidVersion('latest')).toBe(false);
      expect(isValidVersion('next')).toBe(false);
      expect(isValidVersion('1.0')).toBe(false);
      expect(isValidVersion('v1.0.0')).toBe(false);
    });

    it('rejects empty/null values', () => {
      expect(isValidVersion('')).toBe(false);
      expect(isValidVersion(null as unknown as string)).toBe(false);
      expect(isValidVersion(undefined as unknown as string)).toBe(false);
    });
  });
});
