/**
 * Tests for registry auth resolution.
 *
 * The bug these guard: a bearer-only resolver sends no header to a basic-auth
 * registry, every existence probe 401s, and the pre-check silently degrades to
 * "uncertain" — disabling skip-existing so re-runs re-publish everything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAuthHeader, getAuthToken, clearAuthCache } from '../utils/http.js';

const REGISTRY = 'http://army-server-dev:4873/';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

let tmpDir: string;
let npmrcPath: string;
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

/** Point npm's userconfig at a scratch .npmrc and start from a clean cache. */
function writeNpmrc(contents: string): void {
  fs.writeFileSync(npmrcPath, contents, 'utf8');
  process.env.npm_config_userconfig = npmrcPath;
  clearAuthCache();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-airgap-auth-'));
  npmrcPath = path.join(tmpDir, '.npmrc');
  // The resolver reads several .npmrc locations by design. Redirect ALL of them
  // into the scratch dir — cwd, userconfig, and home (os.homedir() reads
  // USERPROFILE on Windows, HOME elsewhere; `npm config get userconfig`
  // derives from the same). Otherwise the developer's real ~/.npmrc leaks in
  // and supplies credentials the test never wrote.
  process.chdir(tmpDir);
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  process.env.npm_config_userconfig = npmrcPath;
  process.env.npm_config_globalconfig = path.join(tmpDir, 'global.npmrc');
  delete process.env.NPM_TOKEN;
  delete process.env.NODE_AUTH_TOKEN;
  clearAuthCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearAuthCache();
});

describe('getAuthHeader', () => {
  it('builds a Basic header from username + _password (Verdaccio htpasswd default)', async () => {
    writeNpmrc(
      [
        `//army-server-dev:4873/:username=admin`,
        `//army-server-dev:4873/:_password=${b64('s3cret')}`,
        `//army-server-dev:4873/:always-auth=true`,
      ].join('\n')
    );

    await expect(getAuthHeader(REGISTRY)).resolves.toBe(`Basic ${b64('admin:s3cret')}`);
  });

  it('builds a Basic header from a pre-encoded _auth', async () => {
    writeNpmrc(`//army-server-dev:4873/:_auth=${b64('admin:s3cret')}`);

    await expect(getAuthHeader(REGISTRY)).resolves.toBe(`Basic ${b64('admin:s3cret')}`);
  });

  it('builds a Bearer header from _authToken', async () => {
    writeNpmrc(`//army-server-dev:4873/:_authToken=tok123`);

    await expect(getAuthHeader(REGISTRY)).resolves.toBe('Bearer tok123');
  });

  it('prefers _authToken over basic credentials', async () => {
    writeNpmrc(
      [
        `//army-server-dev:4873/:_authToken=tok123`,
        `//army-server-dev:4873/:username=admin`,
        `//army-server-dev:4873/:_password=${b64('s3cret')}`,
      ].join('\n')
    );

    await expect(getAuthHeader(REGISTRY)).resolves.toBe('Bearer tok123');
  });

  it('accepts the key form without a trailing slash', async () => {
    writeNpmrc(`//army-server-dev:4873:_authToken=tok123`);

    await expect(getAuthHeader(REGISTRY)).resolves.toBe('Bearer tok123');
  });

  it('resolves a ${ENV}-style token reference', async () => {
    process.env.MY_REG_TOKEN = 'from-env';
    writeNpmrc('//army-server-dev:4873/:_authToken=${MY_REG_TOKEN}');

    await expect(getAuthHeader(REGISTRY)).resolves.toBe('Bearer from-env');
    delete process.env.MY_REG_TOKEN;
  });

  it('falls back to NPM_TOKEN when the registry has no npmrc entry', async () => {
    writeNpmrc('');
    process.env.NPM_TOKEN = 'env-tok';
    clearAuthCache();

    await expect(getAuthHeader(REGISTRY)).resolves.toBe('Bearer env-tok');
  });

  it('returns null when the registry has no credentials', async () => {
    writeNpmrc('//other-host:4873/:_authToken=nope');

    await expect(getAuthHeader(REGISTRY)).resolves.toBeNull();
  });

  it('ignores a username with no _password', async () => {
    writeNpmrc('//army-server-dev:4873/:username=admin');

    await expect(getAuthHeader(REGISTRY)).resolves.toBeNull();
  });
});

describe('getAuthToken', () => {
  it('returns the bearer token', async () => {
    writeNpmrc('//army-server-dev:4873/:_authToken=tok123');

    await expect(getAuthToken(REGISTRY)).resolves.toBe('tok123');
  });

  it('returns null for a basic-auth registry — it has no bearer token', async () => {
    writeNpmrc(
      [
        `//army-server-dev:4873/:username=admin`,
        `//army-server-dev:4873/:_password=${b64('s3cret')}`,
      ].join('\n')
    );

    await expect(getAuthToken(REGISTRY)).resolves.toBeNull();
  });
});
