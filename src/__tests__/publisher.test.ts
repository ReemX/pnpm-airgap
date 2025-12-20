/**
 * Comprehensive tests for publisher and tagging logic
 * Covers all edge cases for version tagging and prerelease detection
 */

import { describe, it, expect } from 'vitest';
import { detectPrereleaseTag, generateVersionTag } from '../core/publisher.js';

describe('detectPrereleaseTag', () => {
  describe('beta versions', () => {
    it('detects -beta suffix', () => {
      expect(detectPrereleaseTag('1.0.0-beta')).toBe('beta');
    });

    it('detects -beta.N suffix', () => {
      expect(detectPrereleaseTag('1.0.0-beta.1')).toBe('beta');
      expect(detectPrereleaseTag('1.0.0-beta.10')).toBe('beta');
      expect(detectPrereleaseTag('2.0.0-beta.0')).toBe('beta');
    });

    it('detects beta in complex versions', () => {
      expect(detectPrereleaseTag('19.0.0-beta-24ae53b69-20240214')).toBe('beta');
    });
  });

  describe('alpha versions', () => {
    it('detects -alpha suffix', () => {
      expect(detectPrereleaseTag('1.0.0-alpha')).toBe('alpha');
    });

    it('detects -alpha.N suffix', () => {
      expect(detectPrereleaseTag('1.0.0-alpha.1')).toBe('alpha');
      expect(detectPrereleaseTag('3.4.0-alpha.0')).toBe('alpha');
    });
  });

  describe('rc versions', () => {
    it('detects -rc suffix', () => {
      expect(detectPrereleaseTag('1.0.0-rc')).toBe('rc');
    });

    it('detects -rc.N suffix', () => {
      expect(detectPrereleaseTag('1.0.0-rc.1')).toBe('rc');
      expect(detectPrereleaseTag('5.3.0-rc.2')).toBe('rc');
    });
  });

  describe('next versions', () => {
    it('detects -next suffix', () => {
      expect(detectPrereleaseTag('1.0.0-next')).toBe('next');
    });

    it('detects -next.N suffix', () => {
      expect(detectPrereleaseTag('14.0.0-next.50')).toBe('next');
    });
  });

  describe('canary versions', () => {
    it('detects -canary suffix', () => {
      expect(detectPrereleaseTag('1.0.0-canary')).toBe('canary');
    });

    it('detects -canary.N suffix', () => {
      expect(detectPrereleaseTag('14.0.0-canary.50')).toBe('canary');
      expect(detectPrereleaseTag('13.5.0-canary.12')).toBe('canary');
    });
  });

  describe('dev versions', () => {
    it('detects -dev suffix', () => {
      expect(detectPrereleaseTag('1.0.0-dev')).toBe('dev');
    });

    it('detects -dev.N suffix', () => {
      expect(detectPrereleaseTag('1.0.0-dev.1')).toBe('dev');
    });
  });

  describe('pre versions', () => {
    it('detects -pre suffix', () => {
      expect(detectPrereleaseTag('1.0.0-pre')).toBe('pre');
    });

    it('detects -pre.N suffix', () => {
      expect(detectPrereleaseTag('1.0.0-pre.1')).toBe('pre');
    });
  });

  describe('nightly versions', () => {
    it('detects -nightly suffix', () => {
      expect(detectPrereleaseTag('1.0.0-nightly')).toBe('nightly');
    });

    it('detects -nightly.date suffix', () => {
      expect(detectPrereleaseTag('1.0.0-nightly.20231220')).toBe('nightly');
    });
  });

  describe('snapshot versions', () => {
    it('detects -snapshot suffix', () => {
      expect(detectPrereleaseTag('1.0.0-snapshot')).toBe('snapshot');
    });
  });

  describe('experimental versions', () => {
    it('detects -experimental suffix', () => {
      expect(detectPrereleaseTag('1.0.0-experimental')).toBe('experimental');
    });

    it('detects -experimental.N suffix', () => {
      expect(detectPrereleaseTag('18.3.0-experimental-abc123')).toBe('experimental');
    });
  });

  describe('generic prerelease versions', () => {
    it('detects numeric prerelease', () => {
      expect(detectPrereleaseTag('1.0.0-0')).toBe('prerelease');
    });

    it('detects semver prerelease with unknown tag', () => {
      expect(detectPrereleaseTag('1.0.0-preview')).toBe('preview');
      expect(detectPrereleaseTag('1.0.0-insiders')).toBe('insiders');
    });

    it('extracts tag from complex prerelease', () => {
      expect(detectPrereleaseTag('1.0.0-custom.1.2.3')).toBe('custom');
    });
  });

  describe('stable versions (should return null)', () => {
    it('returns null for standard semver', () => {
      expect(detectPrereleaseTag('1.0.0')).toBeNull();
      expect(detectPrereleaseTag('0.0.1')).toBeNull();
      expect(detectPrereleaseTag('10.20.30')).toBeNull();
    });

    it('returns null for versions with build metadata only', () => {
      expect(detectPrereleaseTag('1.0.0+build.123')).toBeNull();
    });
  });

  describe('priority and ordering', () => {
    it('detects beta before alpha when both present', () => {
      // This tests the ordering of pattern matching
      // In practice, this wouldn't be a valid version, but tests pattern priority
      expect(detectPrereleaseTag('1.0.0-beta-alpha')).toBe('beta');
    });

    it('matches primary prerelease identifier', () => {
      // 1.0.0-rc-beta is semantically an RC, not a beta
      expect(detectPrereleaseTag('1.0.0-rc-beta')).toBe('rc');
    });
  });

  describe('edge cases', () => {
    it('handles version with multiple dashes', () => {
      expect(detectPrereleaseTag('1.0.0-beta-feature-branch-1')).toBe('beta');
    });

    it('handles React-style versions', () => {
      expect(detectPrereleaseTag('18.3.0-canary-abc123def-20231220')).toBe('canary');
    });

    it('handles Next.js-style versions', () => {
      expect(detectPrereleaseTag('14.0.5-canary.42')).toBe('canary');
    });

    it('handles TypeScript-style RC versions', () => {
      expect(detectPrereleaseTag('5.4.0-dev.20231220')).toBe('dev');
    });

    it('handles Vue-style versions', () => {
      expect(detectPrereleaseTag('3.4.0-alpha.1')).toBe('alpha');
      expect(detectPrereleaseTag('3.4.0-beta.1')).toBe('beta');
      expect(detectPrereleaseTag('3.4.0-rc.1')).toBe('rc');
    });
  });
});

describe('generateVersionTag', () => {
  describe('basic version tags', () => {
    it('generates tag for simple version', () => {
      expect(generateVersionTag('1.0.0')).toBe('legacy-1-0-0');
    });

    it('generates tag for complex version', () => {
      expect(generateVersionTag('10.20.30')).toBe('legacy-10-20-30');
    });
  });

  describe('prerelease version tags', () => {
    it('generates tag for beta version', () => {
      expect(generateVersionTag('1.0.0-beta.1')).toBe('legacy-1-0-0-beta-1');
    });

    it('generates tag for alpha version', () => {
      expect(generateVersionTag('1.0.0-alpha.0')).toBe('legacy-1-0-0-alpha-0');
    });

    it('generates tag for rc version', () => {
      expect(generateVersionTag('5.3.0-rc')).toBe('legacy-5-3-0-rc');
    });
  });

  describe('edge cases', () => {
    it('handles version with build metadata', () => {
      expect(generateVersionTag('1.0.0+build.123')).toBe('legacy-1-0-0+build-123');
    });

    it('handles complex prerelease', () => {
      expect(generateVersionTag('19.0.0-beta-abc123-20231220')).toBe(
        'legacy-19-0-0-beta-abc123-20231220'
      );
    });

    it('generates unique tags for similar versions', () => {
      const tag1 = generateVersionTag('1.0.0');
      const tag2 = generateVersionTag('1.0.1');
      expect(tag1).not.toBe(tag2);
    });

    it('tag format is valid npm tag', () => {
      const tag = generateVersionTag('1.0.0');
      // npm tags cannot contain @ or be valid semver
      expect(tag).not.toContain('@');
      expect(tag).toMatch(/^[a-z0-9-]+$/);
    });
  });
});

describe('tagging strategy integration', () => {
  /**
   * These tests verify the complete tagging strategy:
   * 1. Prerelease versions get their prerelease tag (beta, alpha, rc, etc.)
   * 2. Stable versions get 'latest' tag
   * 3. Older versions of already-published packages get legacy-X-Y-Z tag
   */

  describe('correct tag selection', () => {
    it('beta versions should NOT get latest tag', () => {
      const tag = detectPrereleaseTag('1.0.0-beta.1');
      expect(tag).toBe('beta');
      expect(tag).not.toBe('latest');
    });

    it('alpha versions should NOT get latest tag', () => {
      const tag = detectPrereleaseTag('1.0.0-alpha.1');
      expect(tag).toBe('alpha');
      expect(tag).not.toBe('latest');
    });

    it('stable versions should get latest (return null from detector)', () => {
      const tag = detectPrereleaseTag('1.0.0');
      expect(tag).toBeNull();
      // In actual code: prereleaseTag || 'latest'
    });

    it('rc versions should get rc tag', () => {
      const tag = detectPrereleaseTag('1.0.0-rc.1');
      expect(tag).toBe('rc');
    });
  });

  describe('version conflict resolution', () => {
    it('generates unique legacy tag when publishing older version', () => {
      // When a newer version exists and we try to publish older
      const tag = generateVersionTag('4.17.20');
      expect(tag).toBe('legacy-4-17-20');
      // This allows publishing without overwriting 'latest'
    });

    it('legacy tags are sortable by version', () => {
      const tags = [
        generateVersionTag('1.0.0'),
        generateVersionTag('1.0.1'),
        generateVersionTag('1.1.0'),
        generateVersionTag('2.0.0'),
      ];

      expect(tags).toEqual([
        'legacy-1-0-0',
        'legacy-1-0-1',
        'legacy-1-1-0',
        'legacy-2-0-0',
      ]);
    });
  });

  describe('real-world package scenarios', () => {
    it('handles lodash version upgrade flow', () => {
      // Publishing 4.17.21 (latest) - should get 'latest' tag
      expect(detectPrereleaseTag('4.17.21')).toBeNull();

      // Later publishing 4.17.20 (older) - should get legacy tag
      expect(generateVersionTag('4.17.20')).toBe('legacy-4-17-20');
    });

    it('handles React version flow', () => {
      // Stable release
      expect(detectPrereleaseTag('18.2.0')).toBeNull();

      // Canary release
      expect(detectPrereleaseTag('18.3.0-canary-abc123')).toBe('canary');

      // Experimental release
      expect(detectPrereleaseTag('18.3.0-experimental-abc123')).toBe('experimental');
    });

    it('handles Next.js version flow', () => {
      // Stable
      expect(detectPrereleaseTag('14.0.4')).toBeNull();

      // Canary
      expect(detectPrereleaseTag('14.0.5-canary.42')).toBe('canary');
    });

    it('handles TypeScript version flow', () => {
      // Stable
      expect(detectPrereleaseTag('5.3.3')).toBeNull();

      // Beta
      expect(detectPrereleaseTag('5.4.0-beta')).toBe('beta');

      // RC
      expect(detectPrereleaseTag('5.4.0-rc')).toBe('rc');

      // Dev
      expect(detectPrereleaseTag('5.4.0-dev.20231220')).toBe('dev');
    });

    it('handles Vue version flow', () => {
      // Stable
      expect(detectPrereleaseTag('3.3.13')).toBeNull();

      // Alpha
      expect(detectPrereleaseTag('3.4.0-alpha.1')).toBe('alpha');

      // Beta
      expect(detectPrereleaseTag('3.4.0-beta.1')).toBe('beta');

      // RC
      expect(detectPrereleaseTag('3.4.0-rc.1')).toBe('rc');
    });
  });
});
