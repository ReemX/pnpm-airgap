/**
 * Tests for the direct-HTTP publish path: the in-memory tarball reader, the
 * version document sent to the registry, and the full PUT against a stub
 * registry (status handling, orphan detection, legacy tagging, retries).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { readTarball } from '../core/tarball.js';
import { buildVersionManifest, compareVersions, publishPackage } from '../core/publisher.js';
import { clearExistenceCache } from '../core/registry.js';
import { clearAuthCache } from '../utils/http.js';
import { Status } from '../types.js';

let tmpDir: string;

/** Pack `files` (paths relative to the tarball root) into a .tgz. */
async function makeTarball(name: string, files: Record<string, string>, root = 'package'): Promise<string> {
  const src = fs.mkdtempSync(path.join(tmpDir, 'src-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(src, root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const out = path.join(tmpDir, `${name}.tgz`);
  await tar.c({ gzip: true, file: out, cwd: src, portable: true }, [root]);
  return out;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-airgap-publish-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readTarball', () => {
  it('reads package.json and the README without unpacking', async () => {
    const file = await makeTarball('basic', {
      'package.json': JSON.stringify({ name: 'basic', version: '1.0.0' }),
      'README.md': '# hello',
      'lib/index.js': 'module.exports = 1;',
    });
    const contents = await readTarball(fs.readFileSync(file));
    expect(contents.manifest).toEqual({ name: 'basic', version: '1.0.0' });
    expect(contents.readme).toBe('# hello');
    expect(contents.readmeFilename).toBe('README.md');
  });

  it('handles thousands of entries and very long paths (pax/GNU headers)', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'many', version: '2.0.0' }),
    };
    for (let i = 0; i < 3000; i++) files[`icons/icon-${i}.svg`] = `<svg>${i}</svg>`;
    files[`${'deep/'.repeat(40)}file.txt`] = 'x';
    const file = await makeTarball('many', files);
    const contents = await readTarball(fs.readFileSync(file), { readme: false });
    expect(contents.manifest.name).toBe('many');
  });

  it('ignores nested package.json files and accepts a non-"package" root', async () => {
    const file = await makeTarball(
      'oddroot',
      {
        'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '9.9.9' }),
        'package.json': JSON.stringify({ name: 'oddroot', version: '0.1.0' }),
      },
      'oddroot'
    );
    const contents = await readTarball(fs.readFileSync(file));
    expect(contents.manifest.name).toBe('oddroot');
  });

  it('rejects a tarball with no package.json', async () => {
    const file = await makeTarball('empty', { 'index.js': '' });
    await expect(readTarball(fs.readFileSync(file))).rejects.toThrow(/missing name or version/);
  });

  it('rejects data that is not gzip', async () => {
    await expect(readTarball(Buffer.from('not a tarball'))).rejects.toThrow(/Corrupt tarball/);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.10.0', '1.9.0', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
    ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0+build.5', '1.0.0', 0],
  ])('%s vs %s = %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('buildVersionManifest', () => {
  it('produces the dist block and normalizations npm publish sends', () => {
    const data = Buffer.from('tarball-bytes');
    const { manifest, tarballName } = buildVersionManifest(
      {
        manifest: { name: '@scope/cli', version: 'v1.2.3', bin: './bin/cli.js', bundledDependencies: ['a'] },
        readme: '# r',
        readmeFilename: 'README.md',
      },
      data,
      'http://reg:4873'
    );
    expect(tarballName).toBe('@scope/cli-1.2.3.tgz');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest._id).toBe('@scope/cli@1.2.3');
    expect(manifest.bin).toEqual({ cli: 'bin/cli.js' });
    expect(manifest.bundleDependencies).toEqual(['a']);
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.readme).toBe('# r');
    expect(manifest.dist).toEqual({
      integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(data).digest('hex'),
      tarball: 'http://reg:4873/@scope/cli/-/@scope/cli-1.2.3.tgz',
    });
  });
});

// ---------------------------------------------------------------------------
// Stub registry
// ---------------------------------------------------------------------------

interface StubState {
  packuments: Map<string, { versions: Record<string, unknown>; 'dist-tags': Record<string, string> }>;
  putResponses: number[]; // status codes to return for the next PUTs, in order
  puts: Array<{ url: string; auth?: string; body: Record<string, unknown> }>;
}

let server: http.Server;
let registryUrl: string;
const state: StubState = { packuments: new Map(), putResponses: [], puts: [] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    if (req.method === 'GET') {
      const doc = state.packuments.get(name);
      res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc ?? { error: 'not found' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.puts.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      const status = state.putResponses.shift() ?? 201;
      if (status === 201) {
        const doc = state.packuments.get(name) ?? { versions: {}, 'dist-tags': {} };
        Object.assign(doc.versions, body.versions);
        Object.assign(doc['dist-tags'], body['dist-tags']);
        state.packuments.set(name, doc);
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 201 ? { ok: 'created' } : { error: `stub says ${status}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registryUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  state.packuments.clear();
  state.putResponses = [];
  state.puts = [];
  clearExistenceCache();
  clearAuthCache();
  process.env.npm_config__auth = Buffer.from('admin:pw').toString('base64');
});

describe('publishPackage (HTTP)', () => {
  it('PUTs the npm publish document with the tarball attached', async () => {
    const file = await makeTarball('pub-a', {
      'package.json': JSON.stringify({ name: '@s/pub-a', version: '1.0.0' }),
    });
    const result = await publishPackage(file, registryUrl);

    expect(result.status).toBe(Status.SUCCESS);
    expect(result.tag).toBe('latest');
    expect(state.puts).toHaveLength(1);
    const put = state.puts[0];
    expect(put.url).toBe('/@s%2Fpub-a');
    expect(put.auth).toBe(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
    expect(put.body['dist-tags']).toEqual({ latest: '1.0.0' });
    const attachment = (put.body._attachments as Record<string, { data: string; length: number }>)[
      '@s/pub-a-1.0.0.tgz'
    ];
    expect(Buffer.from(attachment.data, 'base64')).toEqual(fs.readFileSync(file));
  });

  it('tags a version older than latest as legacy instead of moving latest', async () => {
    state.packuments.set('old', { versions: { '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } });
    const file = await makeTarball('old-1', { 'package.json': JSON.stringify({ name: 'old', version: '1.0.0' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.tag).toBe('legacy-1-0-0');
    expect(state.puts[0].body['dist-tags']).toEqual({ 'legacy-1-0-0': '1.0.0' });
  });

  it('gives prereleases their own tag', async () => {
    const file = await makeTarball('pre', { 'package.json': JSON.stringify({ name: 'pre', version: '3.0.0-beta.1' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.tag).toBe('beta');
  });

  it('reports 409 for a version already in the manifest as skipped', async () => {
    state.packuments.set('dup', { versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' } });
    state.putResponses = [409];
    const file = await makeTarball('dup', { 'package.json': JSON.stringify({ name: 'dup', version: '1.0.0' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.status).toBe(Status.SKIPPED);
  });

  it('flags a 409 for a version missing from the manifest as an orphan', async () => {
    state.putResponses = [409];
    const file = await makeTarball('orph', { 'package.json': JSON.stringify({ name: 'orph', version: '1.0.0' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.status).toBe(Status.ERROR);
    expect(result.orphan).toBe(true);
  });

  it('retries a 503 and succeeds', async () => {
    state.putResponses = [503];
    const file = await makeTarball('flaky', { 'package.json': JSON.stringify({ name: 'flaky', version: '1.0.0' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.attempt).toBe(2);
  });

  it('surfaces the registry error message on a non-retryable failure', async () => {
    state.putResponses = [403];
    const file = await makeTarball('denied', { 'package.json': JSON.stringify({ name: 'denied', version: '1.0.0' }) });
    const result = await publishPackage(file, registryUrl);
    expect(result.status).toBe(Status.ERROR);
    expect(result.error).toBe('HTTP 403: stub says 403');
    expect(state.puts).toHaveLength(1);
  });

  it('refuses a private package without contacting the registry', async () => {
    const file = await makeTarball('priv', {
      'package.json': JSON.stringify({ name: 'priv', version: '1.0.0', private: true }),
    });
    const result = await publishPackage(file, registryUrl);
    expect(result.status).toBe(Status.ERROR);
    expect(state.puts).toHaveLength(0);
  });
});
